// Delete the Cloudinary files no draw needs any more: copies of photos whose draws are over,
// and leftovers no row points at. Rules: lib/sweep.mjs. Runs daily after image retention.
//
//   DRY_RUN=true (default)   report only
//   SWEEP_MAX=1000           cap on files deleted per run
//   SWEEP_MIN_AGE_HOURS=48   a file younger than this is never judged (the scrape uploads
//                            before it writes the row). Lower only when no scrape is running.
//   SWEEP_MAX_SHARE=0.25     refuse when the plan would delete more than this share of the
//                            account. A day's normal work is a few percent, so a bigger plan
//                            means the database read went wrong, not that the files are dead.
//                            Raise it only for a deliberate one-off clean-up.
//
// Brakes, in order: the database must read back at least 100 draws; the plan must stay under
// SWEEP_MAX_SHARE; at most SWEEP_MAX files go per run. Each file is deleted with its own
// resource type, because raw and image assets are deleted through different endpoints.
import { cloudinaryConfig, cloudinaryInventory, deleteObjects, IMAGE_PROVIDER } from "./lib/storage.mjs";
import { pagesBase } from "./lib/pages.mjs";
import { planCloudinarySweep, SWEEP_MIN_AGE_MS } from "./lib/sweep.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.env.DRY_RUN !== "false";
const MAX = Number(process.env.SWEEP_MAX || 1000);
const MAX_SHARE = Number(process.env.SWEEP_MAX_SHARE || 0.25);
const MIN_AGE_MS = process.env.SWEEP_MIN_AGE_HOURS ? Number(process.env.SWEEP_MIN_AGE_HOURS) * 3600e3 : SWEEP_MIN_AGE_MS;

if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const cloud = cloudinaryConfig();
if (!cloud || IMAGE_PROVIDER !== "cloudinary") {
  console.log(`cloudinary-sweep: Cloudinary not the provider (IMAGE_PROVIDER=${IMAGE_PROVIDER}) — nothing to do.`);
  process.exit(0);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
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

const draws = await readAll("draws", "id,status,image_url");
const operators = await readAll("operators", "id,logo_url");
if (draws.length < 100) {
  console.error(`✗ refusing: only ${draws.length} draws read back. With no rows every file looks unused.`);
  process.exit(1);
}
const inventory = await cloudinaryInventory();
const { remove, kept, young, bytes } = planCloudinarySweep({ inventory, draws, operators, base: pagesBase(), cloud, minAgeMs: MIN_AGE_MS });
const MB = (b) => `${(b / 1e6).toFixed(0)} MB`;
console.log(`${DRY ? "DRY RUN" : "LIVE"} · ${inventory.size} file(s) on Cloudinary · keep ${kept} · too new to judge ${young} · no draw needs ${remove.length} (${MB(bytes)})`);

if (remove.length > inventory.size * MAX_SHARE) {
  console.error(`✗ refusing: ${remove.length} of ${inventory.size} files (${((100 * remove.length) / inventory.size).toFixed(0)}%) is over SWEEP_MAX_SHARE=${MAX_SHARE}. If this is a deliberate one-off clean-up, re-run with a higher SWEEP_MAX_SHARE.`);
  process.exit(1);
}
const batch = remove.slice(0, MAX);
if (DRY) {
  console.log(`would delete ${batch.length} now${remove.length > batch.length ? `, ${remove.length - batch.length} on later runs (SWEEP_MAX=${MAX})` : ""}. Re-run with DRY_RUN=false to apply.`);
  process.exit(0);
}
const out = batch.length ? await deleteObjects(batch) : { deleted: 0, notFound: 0, failed: [] };
console.log(`deleted ${out.deleted} · already gone ${out.notFound} · failures ${out.failed.length} · left for later runs ${remove.length - batch.length}`);
for (const f of out.failed.slice(0, 10)) console.log(`  ! ${f}`);
// A file that failed to delete is retried tomorrow: worth a look, not a red run.
