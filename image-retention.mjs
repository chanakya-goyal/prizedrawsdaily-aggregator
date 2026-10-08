// Let go of draw photos on the new image provider once their draws have been over for
// RETENTION_DAYS. Runs daily after the ended-sweep (aggregate.yml).
//
// WHY: "stored forever, deleted never" on a fixed-size free bucket caused three storage
// incidents in two months (Aug size, Sep egress, Oct size). Moving to Cloudinary without a
// lifecycle would just restart the same clock on a bigger box. With it, storage tracks the
// LIVE inventory instead of the all-time total, and stays roughly flat.
//
// For each expired row (lib/retention.mjs decides, pinned by test/retention.test.mjs):
//   1. repoint image_url to its Supabase original if one exists (Supabase is a frozen archive,
//      never emptied), else to null — the site renders the category cover for null;
//   2. ONLY after every row using a key has been repointed, delete that key from the provider.
// A row the scrape changed since we read it is left alone, and so is its key.
//
//   DRY_RUN=true (default)   report only
//   RETENTION_DAYS=30        how long after a draw ends its photo is kept
//   RETENTION_MAX=500        cap on rows per run — a selection bug is bounded to this
//
// Refuses to run live unless IMAGE_PROVIDER=cloudinary: it only ever touches Cloudinary
// URLs, and on any other provider there is nothing for it to do.
import { listAllObjects, PUBLIC_PREFIX, IMAGE_PROVIDER, cloudinaryConfig, cloudinaryPublicBase, deleteObjects } from "./lib/storage.mjs";
import { selectExpired, planRetention } from "./lib/retention.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.BUCKET || "draw-images";
const DAYS = Number(process.env.RETENTION_DAYS || 30);
const MAX = Number(process.env.RETENTION_MAX || 500);
const ON_CLOUDINARY = IMAGE_PROVIDER === "cloudinary";
const DRY = process.env.DRY_RUN !== "false" || !ON_CLOUDINARY;

if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const cfg = cloudinaryConfig();
if (!cfg) {
  // Not an error: until the provider is switched on, this step has nothing to do. Exit 0 so
  // the daily workflow stays green.
  console.log(`image-retention: Cloudinary not configured (IMAGE_PROVIDER=${IMAGE_PROVIDER}) — nothing to do.`);
  process.exit(0);
}
if (process.env.DRY_RUN === "false" && !ON_CLOUDINARY) {
  console.log(`image-retention: IMAGE_PROVIDER=${IMAGE_PROVIDER}, not cloudinary — running as a DRY RUN only.`);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function readAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=${select}&order=id&limit=1000&offset=${offset}`, { headers: H });
    if (!r.ok) throw new Error(`${table} read ${r.status} ${(await r.text()).slice(0, 120)}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const creds = { supabaseUrl: URL_, serviceKey: KEY, bucket: BUCKET };
const SB_PREFIX = PUBLIC_PREFIX(creds);
const draws = await readAll("draws", "id,status,draw_date,created_at,image_url");
const operators = await readAll("operators", "id,logo_url");
const { expire, protectedRows } = selectExpired({ draws, operators, cloudBase: cloudinaryPublicBase(cfg), days: DAYS });
const supabaseKeys = new Set((await listAllObjects(creds)).map((f) => f.path));
const plan = planRetention({ expire, supabaseKeys, sbPrefix: SB_PREFIX }).slice(0, MAX);

const toArchive = plan.filter((p) => p.newUrl).length;
console.log(`${DRY ? "DRY RUN" : "LIVE"} · keep window ${DAYS}d · cap ${MAX} rows`);
console.log(`  ${expire.size} key(s) expired · ${plan.length} row(s) this run (${toArchive} back to the Supabase archive, ${plan.length - toArchive} to the category cover) · ${protectedRows} expired row(s) protected by a live row or logo`);
if (DRY) { console.log("\nRe-run with DRY_RUN=false (and IMAGE_PROVIDER=cloudinary) to apply."); process.exit(0); }

// 1. Repoint rows. The `image_url=eq.<what we read>` filter makes a row the scrape has
//    rewritten since our read a no-op instead of an overwrite.
const urlOf = new Map(draws.map((d) => [d.id, d.image_url]));
const blocked = new Set(); // keys with at least one row we could not repoint — never deleted
let repointed = 0, raced = 0, failed = 0;
for (const p of plan) {
  const r = await fetch(`${URL_}/rest/v1/draws?id=eq.${encodeURIComponent(p.id)}&image_url=eq.${encodeURIComponent(urlOf.get(p.id))}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ image_url: p.newUrl }),
  });
  if (!r.ok) { failed++; blocked.add(p.path); continue; }
  const rows = await r.json().catch(() => []);
  if (!rows.length) { raced++; blocked.add(p.path); continue; }
  repointed++;
}

// 2. Delete only keys whose every row in this run was repointed. A key whose rows were split
//    by the cap is held back too — its remaining rows still point at it.
const planned = new Map();
for (const p of plan) planned.set(p.path, (planned.get(p.path) || 0) + 1);
const deletable = [...planned].filter(([path, n]) => !blocked.has(path) && n === expire.get(path).length).map(([path]) => path);
const del = deletable.length ? await deleteObjects(deletable) : { deleted: 0, notFound: 0, failed: [] };

console.log(`repointed ${repointed} · changed since read ${raced} · failed ${failed}`);
console.log(`deleted ${del.deleted} · already gone ${del.notFound} · delete failures ${del.failed.length}`);
for (const f of del.failed.slice(0, 10)) console.log(`  ! ${f}`);
// An undeleted key is harmless (it is retried tomorrow); a failed PATCH is worth a red run.
if (failed) process.exit(1);
