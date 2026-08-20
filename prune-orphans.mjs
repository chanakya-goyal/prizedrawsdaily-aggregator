// Reclaim dead weight from the `draw-images` bucket: delete objects that NOTHING in the
// database points at any more.
//
// WHY: the bucket only ever grows. Every ingest re-hosts an image, but nothing ever removes
// one, so abandoned bytes accumulate forever — interim `.jpg` uploads whose `.webp` re-encode
// succeeded but whose cleanup DELETE failed, images for draws that were deleted outright,
// and objects left behind when a draw's `image_url` was later repointed somewhere else.
// On 20 Aug 2026 that accumulation cost us the whole project: Supabase restricted
// ilnegxrsalmzpljotgpe with `exceed_storage_size_quota` and every API call — reads, writes,
// even DELETEs — began returning 402. The site served an empty catalogue and broken images.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never deletes an image that any row still
// references, no matter how old the draw is or whether it has ended. Ended draws keep their
// pages, their og:image, and their search-result thumbnails. "Orphan" here means
// *unreferenced*, not *old* — those are very different things and only the first is safe.
//
//   DRY_RUN=true (default) → report what would go, touch nothing.
//   DRY_RUN=false          → actually delete.
//
// Run it with DRY_RUN=true first, every time. Read the number. Then decide.
import { listAllObjects, referencedPaths, classifyOrphans, PUBLIC_PREFIX } from "./lib/storage.mjs";

const URL_ = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
const BUCKET = process.env.BUCKET || "draw-images";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

// An object younger than this is never touched. There is an unavoidable window during ingest
// where the bytes are uploaded but the row referencing them has not been inserted yet; a
// prune running inside that window would delete a perfectly live image and the draw would
// publish with a dead URL. Seven days is far longer than any run.
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS || 7);

// Refuse to run if the reference scan looks too thin to trust. If a table read silently
// returned nothing, every object it referenced would be misclassified as an orphan and this
// script would cheerfully empty the bucket. Below this ratio we assume the scan is broken,
// not that the bucket is genuinely mostly dead.
const MIN_REF_RATIO = Number(process.env.MIN_REF_RATIO || 0.5);

if (!KEY) {
  console.error("✗ needs SUPABASE_SERVICE_ROLE_KEY (in ~/pdd-aggregator/.env)");
  process.exit(1);
}

const MB = (b) => (b / 1048576).toFixed(1) + " MB";
const creds = { supabaseUrl: URL_, serviceKey: KEY, bucket: BUCKET };

console.log(`${DRY ? "DRY RUN" : "LIVE"} — bucket ${BUCKET}`);

// 1. Everything the database still points at, discovered from PostgREST's own schema rather
//    than a hardcoded table list. A hardcoded list is a landmine: the day someone adds a
//    table with an image column, this script starts deleting live images.
console.log("scanning database for referenced images…");
const { paths: referenced, scanned, columns } = await referencedPaths(creds);
console.log(`  ${referenced.size} referenced by ${columns.length} column(s) across ${scanned.length} table(s)`);
console.log(`  ${columns.map((c) => `${c.table}.${c.column}`).join(", ") || "(none)"}`);

// 2. Everything actually in the bucket.
console.log("listing bucket…");
const files = await listAllObjects(creds);
const total = files.reduce((a, f) => a + (f.metadata?.size || 0), 0);
console.log(`  ${files.length} objects, ${MB(total)} (Free-plan quota 1024 MB)`);

if (!files.length) {
  console.log("bucket is empty — nothing to do");
  process.exit(0);
}

// 3. Safety gate before anything is classified.
const ratio = referenced.size / files.length;
if (ratio < MIN_REF_RATIO) {
  console.error(
    `✗ ABORT: only ${(ratio * 100).toFixed(0)}% of objects are referenced ` +
      `(${referenced.size}/${files.length}, floor ${(MIN_REF_RATIO * 100).toFixed(0)}%).`
  );
  console.error("  A reference scan this thin usually means a table read failed, not that the");
  console.error("  bucket is mostly dead. Refusing to delete. Re-run with MIN_REF_RATIO= to override.");
  process.exit(1);
}

// 4. Classify.
const { orphans, youngSkipped } = classifyOrphans(files, referenced, {
  cutoffMs: MIN_AGE_DAYS * 86400_000,
});
const reclaim = orphans.reduce((a, f) => a + (f.metadata?.size || 0), 0);

console.log(`\n${orphans.length} orphan(s), ${MB(reclaim)} reclaimable`);
if (youngSkipped) console.log(`  (${youngSkipped} unreferenced but younger than ${MIN_AGE_DAYS}d — left alone)`);
console.log(`  bucket after: ${MB(total)} → ${MB(total - reclaim)}`);

for (const f of orphans.slice(0, 20)) console.log(`    ${MB(f.metadata?.size || 0).padStart(9)}  ${f.path}`);
if (orphans.length > 20) console.log(`    …and ${orphans.length - 20} more`);

if (DRY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with DRY_RUN=false to apply.");
  process.exit(0);
}
if (!orphans.length) process.exit(0);

// 5. Delete, in bounded parallel. One failure must not sink the sweep — the point is to get
//    under quota, and a stubborn object can be retried next run.
let deleted = 0, freed = 0, failed = 0;
const queue = [...orphans];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let f = queue.pop(); f; f = queue.pop()) {
      try {
        const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${encodeURI(f.path)}`, {
          method: "DELETE",
          headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
        deleted++;
        freed += f.metadata?.size || 0;
      } catch (e) {
        failed++;
        console.warn(`  ✗ ${f.path}: ${(e?.message || e).toString().slice(0, 100)}`);
      }
    }
  })
);

console.log(`\n✓ deleted ${deleted}, freed ${MB(freed)} — bucket ${MB(total)} → ${MB(total - freed)}`);
if (failed) console.log(`  ${failed} failed (safe to re-run)`);
console.log(`\nNOTE: Supabase meters storage as GB-Hrs AVERAGED over the billing period, so a`);
console.log(`reduction now lowers the average only gradually. If the project is already`);
console.log(`restricted, freeing space may not lift it until the next billing cycle — ask`);
console.log(`support to trigger an S3 sync, since deletes can strand data that still bills.`);
console.log(`Public prefix checked: ${PUBLIC_PREFIX(creds)}`);
