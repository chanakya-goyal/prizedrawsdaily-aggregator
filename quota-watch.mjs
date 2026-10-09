// The guardian: read every free limit the site depends on, keep one reading a day, forecast
// each, and say in one table whether a human is needed. Rules: lib/quota.mjs. Writes
// quota-watch.md, the issue body the workflow posts under the `quota-alarm` label.
//
//   bun quota-watch.mjs     # exit 0 ok · 2 warn (issue, run green) · 1 red (issue, run fails)
//
// Replaces storage-watch.mjs and usage-watch.mjs (their rules live on in lib/storage-watch.mjs
// and lib/usage-watch.mjs, which this calls). Needs sql/2026-10-10-quota-guardian.sql applied
// once for the database size, the egress counter and the history. Without it those readings
// are notes, never alarms, and the rest still works.
//
// Writes only its own readings (one quota_snapshots row per limit per day, one usage_snapshots
// row). Everything else is read-only.
import { listBuckets, listBucketDeep, cloudinaryConfig, cloudinaryUsage, IMAGE_PROVIDER } from "./lib/storage.mjs";
import { assessStorage } from "./lib/storage-watch.mjs";
import { requestRates, assessUsage, toSnapshot, DEFAULTS as EGRESS } from "./lib/usage-watch.mjs";
import { pagesSite } from "./lib/pages.mjs";
import { assessQuotas } from "./lib/quota.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const creds = { supabaseUrl: URL_, serviceKey: KEY };
const today = new Date().toISOString().slice(0, 10);
const short = (e) => (e?.message || String(e)).slice(0, 120);

async function rest(path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 100)}`);
  return text ? JSON.parse(text) : null;
}
const SETUP = "run sql/2026-10-10-quota-guardian.sql once in the Supabase SQL editor";
const notInstalled = (e) => /PGRST202|PGRST205|42883|42P01|HTTP 404/.test(short(e));

const metrics = [];
const alarms = []; // configuration faults: always red, whatever the numbers say
const details = [];

// ── Cloudflare Pages: files on the site that serves every public photo ────────────────
try {
  const r = await fetch(`${pagesSite()}manifest.json`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  const files = Object.keys((await r.json()).files || {}).length + 3; // + _headers, 404.html, manifest.json
  metrics.push({ key: "pages_files", label: "Cloudflare Pages files", value: files, limit: 20_000, unit: "files",
    hint: "One file per live draw. Check image-retention ran (RETENTION_DAYS=0), then split the photos across a second Pages project (PAGES.md)." });
} catch (e) { metrics.push({ key: "pages_files", label: "Cloudflare Pages files", error: short(e) }); }

// ── Cloudinary: credits over a rolling 30 days ────────────────────────────────────────
let config = null;
try { if (IMAGE_PROVIDER === "cloudinary" && !cloudinaryConfig()) config = { provider: IMAGE_PROVIDER, error: "no CLOUDINARY_URL set" }; }
catch (e) { config = { provider: IMAGE_PROVIDER, error: short(e) }; }
try {
  if (config || !cloudinaryConfig()) throw new Error(config ? config.error : "not configured");
  const u = await cloudinaryUsage();
  metrics.push({ key: "cloudinary_credits", label: "Cloudinary credits (30 days)", value: Number(u.credits?.usage), limit: Number(u.credits?.limit), unit: "credits",
    hint: "Transformations should be ~0 (uploads are raw). Bandwidth should be small (rows served from Pages: check publish-images ran). Storage: check cloudinary-sweep ran." });
  details.push(`Cloudinary: storage ${(u.storage?.usage / 1e6).toFixed(0)} MB · bandwidth ${(u.bandwidth?.usage / 1e6).toFixed(0)} MB · transformations ${u.transformations?.usage ?? "?"}`);
} catch (e) { metrics.push({ key: "cloudinary_credits", label: "Cloudinary credits (30 days)", error: short(e) }); }

// ── Supabase database size ────────────────────────────────────────────────────────────
try {
  const bytes = Number(await rest("rpc/database_size", { method: "POST", body: "{}" }));
  metrics.push({ key: "supabase_db", label: "Supabase database", value: bytes, limit: 500e6, unit: "bytes",
    hint: "Draws are text, ~1 KB each. Find the table that grew: carousel_metrics, usage_snapshots, quota_snapshots." });
} catch (e) { metrics.push({ key: "supabase_db", label: "Supabase database", ...(notInstalled(e) ? { note: `not set up: ${SETUP}` } : { error: short(e) }) }); }

// ── Supabase file storage, plus the misconfiguration checks of the old storage watch ──
try {
  let bytes = 0, recentWrites = 0, recentBytes = 0;
  const since = Date.now() - 48 * 3600e3;
  for (const b of await listBuckets(creds)) {
    const files = await listBucketDeep({ ...creds, bucket: b.name });
    bytes += files.reduce((a, f) => a + (f.metadata?.size || 0), 0);
    if (b.name === "draw-images") {
      const fresh = files.filter((f) => (Date.parse(f.created_at || f.updated_at || "") || 0) > since);
      recentWrites = fresh.length;
      recentBytes = fresh.reduce((a, f) => a + (f.metadata?.size || 0), 0);
    }
  }
  const limit = 1e9; // Free plan "1 GB", read as decimal so the alarm errs early
  metrics.push({ key: "supabase_storage", label: "Supabase file storage", value: bytes, limit, unit: "bytes",
    hint: "Photos must never land here. Check IMAGE_PROVIDER in the GitHub secrets and the cowork routine." });
  // threshold 2: levels are the guardian's job; keep only the configuration alarms.
  const { lines } = assessStorage({ supabase: { bytes, limitBytes: limit, writeTarget: IMAGE_PROVIDER === "supabase", recentWrites, recentBytes, recentWindowH: 48 }, threshold: 2, config });
  alarms.push(...lines.filter((l) => l.startsWith("🔴")));
} catch (e) { metrics.push({ key: "supabase_storage", label: "Supabase file storage", error: short(e) }); }

// ── Supabase data transfer: a month projected from the API request counter ────────────
try {
  const rows = await rest("rpc/api_request_total", { method: "POST", body: "{}" });
  const row = Array.isArray(rows) ? rows[0] : rows;
  await rest("usage_snapshots", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(toSnapshot(row)) });
  const since = new Date(Date.now() - (EGRESS.windowDays + 1) * 864e5).toISOString();
  const history = await rest(`usage_snapshots?select=*&taken_at=gte.${encodeURIComponent(since)}&order=taken_at.asc`);
  const u = assessUsage({ rates: requestRates(history), bytesPerRequest: Number(process.env.USAGE_BYTES_PER_REQUEST || EGRESS.bytesPerRequest) });
  if (u.monthlyBytes == null) throw Object.assign(new Error("no rate yet (first reading)"), { soft: true });
  metrics.push({ key: "supabase_egress", label: "Supabase data transfer (month, projected)", value: u.monthlyBytes, limit: EGRESS.quotaBytes, unit: "bytes",
    forecast: false, warnShare: EGRESS.warnAt, redShare: EGRESS.redAt,
    hint: "Is the site's edge cache serving (x-vercel-cache: HIT on a repeat hit)? Did a deploy or a crawler surge multiply page renders? Then the Supabase dashboard's Usage → Egress for the real figure (this is an estimate)." });
  details.push(...u.lines.map((l) => `Egress: ${l.replace(/^\S+\s/, "")}`).slice(0, 1));
} catch (e) {
  metrics.push({ key: "supabase_egress", label: "Supabase data transfer (month, projected)", ...(notInstalled(e) ? { note: `not set up: ${SETUP}` } : e.soft ? { note: e.message } : { error: short(e) }) });
}

// ── GitHub Actions cache (the staged Pages site lives there) ──────────────────────────
try {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) throw Object.assign(new Error("only measured inside GitHub Actions"), { soft: true });
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/cache/usage`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  metrics.push({ key: "gh_cache", label: "GitHub Actions cache", value: j.active_caches_size_in_bytes, limit: 10 * 1024 ** 3, unit: "bytes",
    forecast: false, warnShare: 0.95, redShare: Infinity, hint: "GitHub evicts the oldest caches by itself; nothing breaks. Worth a look only if runs slow down." });
} catch (e) { metrics.push({ key: "gh_cache", label: "GitHub Actions cache", ...(e.soft ? { note: e.message } : { error: short(e) }) }); }

// ── Keep today's readings, then read the history back for the forecast ───────────────
const readings = metrics.filter((m) => !m.error && !m.note).map((m) => ({ day: today, metric: m.key, value: m.value, limit_value: m.limit }));
let historyNote = "";
try {
  if (readings.length) await rest("quota_snapshots?on_conflict=day,metric", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(readings) });
  const since = new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10);
  const hist = await rest(`quota_snapshots?select=day,metric,value&day=gte.${since}&order=day.asc`);
  for (const m of metrics) m.history = hist.filter((h) => h.metric === m.key);
} catch (e) {
  historyNote = notInstalled(e) ? `Forecasts start once the history table exists: ${SETUP}.` : `History not saved (${short(e)}); forecasts skipped this run.`;
}

// ── Decide and report ─────────────────────────────────────────────────────────────────
const res = assessQuotas(metrics);
const level = alarms.length ? "red" : res.level;
const head = { ok: "✅ Every free limit is clear.", warn: "🟡 A free limit needs attention soon.", red: "🔴 A free limit needs attention now." }[level];
const body = [
  `## Free limits — ${today}`,
  "",
  head,
  "",
  ...alarms.map((l) => `- ${l}`),
  ...(alarms.length ? [""] : []),
  ...res.lines,
  "",
  "Forecasts use the last 7 days of daily readings: 🔴 at 90% or under 7 days to full, 🟡 at 80% or under 21 days.",
  ...(historyNote ? ["", `ℹ️ ${historyNote}`] : []),
  ...(details.length ? ["", "<details><summary>Measurements</summary>", "", ...details.map((d) => `- ${d}`), "", "</details>"] : []),
].join("\n");

await Bun.write("quota-watch.md", body + "\n");
console.log(body);
process.exit({ red: 1, warn: 2 }[level] ?? 0);
