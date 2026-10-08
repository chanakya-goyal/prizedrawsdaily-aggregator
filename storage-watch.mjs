// Daily storage alarm: measure where images live and say, in plain English, whether a human
// is needed. Exits 1 when one is, after writing storage-watch.md (the issue body the
// workflow posts under the `storage-alarm` label).
//
// WHY: the free Supabase bucket filled in Aug 2026 and again in Oct 2026, and both times the
// first signal was the dashboard or a 402 on every API. Nothing in the pipeline was watching
// the one number that takes the whole site down. The rules (and why a frozen bucket is
// judged on new writes, not on percentage) live in lib/storage-watch.mjs.
//
//   bun storage-watch.mjs                 # print + write storage-watch.md, exit 1 on alarm
//   STORAGE_ALARM_AT=0.7                  # threshold (default 70%)
//   SUPABASE_STORAGE_LIMIT_BYTES=…        # default 1 GiB (Free plan "1 GB")
//
// Read-only everywhere: lists buckets and asks Cloudinary for usage. Never writes a row or
// an object.
import { listBuckets, listBucketDeep, cloudinaryConfig, cloudinaryUsage, IMAGE_PROVIDER } from "./lib/storage.mjs";
import { assessStorage } from "./lib/storage-watch.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const LIMIT = Number(process.env.SUPABASE_STORAGE_LIMIT_BYTES || 1024 ** 3);
const THRESHOLD = Number(process.env.STORAGE_ALARM_AT || 0.7);
const RECENT_H = 48;
const creds = { supabaseUrl: URL_, serviceKey: KEY };
const MB = (b) => `${(b / 1048576).toFixed(1)} MB`;

let bytes = 0;
let recentWrites = 0;
let recentBytes = 0;
const perBucket = [];
const since = Date.now() - RECENT_H * 3600e3;
for (const b of await listBuckets(creds)) {
  const files = await listBucketDeep({ ...creds, bucket: b.name });
  const size = files.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  bytes += size;
  perBucket.push(`${b.name}: ${files.length} objects, ${MB(size)}`);
  // Only draw-images is frozen by the move. carousel-slides is written and cleaned up daily
  // by the carousel on purpose, so its fresh objects are not a "missed writer" signal.
  if (b.name === "draw-images") {
    const fresh = files.filter((f) => (Date.parse(f.created_at || f.updated_at || "") || 0) > since);
    recentWrites = fresh.length;
    recentBytes = fresh.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  }
}

// Is the switched-on provider actually usable? (lib/storage-watch.mjs explains why this alarms.)
let config = null;
try {
  if (IMAGE_PROVIDER === "cloudinary" && !cloudinaryConfig()) config = { provider: IMAGE_PROVIDER, error: "no CLOUDINARY_URL set" };
} catch (e) { config = { provider: IMAGE_PROVIDER, error: (e.message || String(e)).slice(0, 120) }; }

let cloudinary = null;
let cldDetail = "";
try {
  if (!config && cloudinaryConfig()) {
    const u = await cloudinaryUsage();
    const c = u.credits || {};
    cloudinary = {
      usedPercent: Number(c.used_percent ?? (c.limit ? (100 * c.usage) / c.limit : 0)),
      creditsUsed: c.usage, creditsLimit: c.limit,
    };
    cldDetail = `storage ${MB(u.storage?.usage || 0)} · bandwidth ${MB(u.bandwidth?.usage || 0)} · transformations ${u.transformations?.usage ?? "?"}`;
  }
} catch (e) {
  cloudinary = { error: (e.message || String(e)).slice(0, 120) };
}

const { alarm, lines } = assessStorage({
  supabase: { bytes, limitBytes: LIMIT, writeTarget: IMAGE_PROVIDER === "supabase", recentWrites, recentBytes, recentWindowH: RECENT_H },
  cloudinary,
  threshold: THRESHOLD,
  config,
});

const body = [
  `## Image storage — ${new Date().toISOString().slice(0, 10)}`,
  "",
  ...lines.map((l) => `- ${l}`),
  "",
  `Write target: \`${IMAGE_PROVIDER}\``,
  "",
  "<details><summary>Measurements</summary>",
  "",
  ...perBucket.map((l) => `- ${l}`),
  cldDetail ? `- Cloudinary: ${cldDetail}` : "- Cloudinary: not configured",
  `- draw-images objects created in the last ${RECENT_H}h: ${recentWrites}`,
  "",
  "</details>",
].join("\n");

await Bun.write("storage-watch.md", body + "\n");
console.log(body);
if (alarm) process.exit(1);
