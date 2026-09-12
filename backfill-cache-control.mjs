#!/usr/bin/env bun
// Backfill `cacheControl` on objects already in Storage.
//
// WHY ------------------------------------------------------------------------
// Every object uploaded before the fix in lib/storage.mjs was stored with
// `cacheControl: "no-cache"`, because none of the three upload sites sent a
// cache-control header and that is Supabase's default. Measured 2026-09-12:
// 5,397 objects / 596 MB in draw-images, 100% of them `no-cache`.
//
// `no-cache` makes images.weserv.nl answer `x-cache-status: BYPASS` — it caches
// nothing and re-downloads the FULL-SIZE original from Supabase on every single
// impression, to serve a 76 KB thumbnail from a 205 KB original. That is how
// 596 MB of images produced 6.37 GB of egress in one billing cycle and put the
// org over its free-tier quota.
//
// lib/storage.mjs fixes every FUTURE upload. This fixes the existing ones.
//
// WHY SQL AND NOT A RE-UPLOAD -------------------------------------------------
// Supabase Storage has no metadata-only update endpoint: changing cacheControl
// through the API means re-uploading the bytes, which would mean DOWNLOADING all
// 596 MB first — 596 MB of the very egress we are trying to save, while already
// over quota. `storage.objects.metadata` is the record the serving layer reads,
// so patching it directly costs zero egress.
//
// That claim is NOT assumed. --verify-one patches a single object, re-fetches it
// and refuses to go further unless the served header actually changed.
//
// GOTCHA ---------------------------------------------------------------------
// `curl -I` / HEAD against Supabase Storage reports `no-cache` even for a
// correctly-cached object. Only a GET shows the true header. This script always
// verifies with GET.
//
// USAGE ----------------------------------------------------------------------
//   bun backfill-cache-control.mjs                 # dry run: report only
//   bun backfill-cache-control.mjs --verify-one    # patch 1 object + prove it works
//   DRY_RUN=false bun backfill-cache-control.mjs   # patch everything
//
// Needs NEW_DB_URL (Postgres) and SUPABASE_URL.

import { SQL } from "bun";
import { UPLOAD_CACHE_CONTROL } from "./lib/storage.mjs";

const DRY = process.env.DRY_RUN !== "false";
const VERIFY_ONE = process.argv.includes("--verify-one");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const DB_URL = process.env.NEW_DB_URL || process.env.SUPABASE_DB_URL || "";

if (!DB_URL) {
  console.error("✗ needs NEW_DB_URL (Postgres connection string)");
  process.exit(1);
}

const sql = new SQL(DB_URL, { max: 2, idleTimeout: 20 });
const publicUrl = (bucket, name) =>
  `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`;

/** The true served cache-control. MUST be a GET — HEAD lies (see GOTCHA above). */
async function servedCacheControl(bucket, name) {
  const r = await fetch(`${publicUrl(bucket, name)}?cc-probe=${Date.now()}`, { method: "GET" });
  // Drain so the socket is released; we only ever need the header.
  await r.arrayBuffer().catch(() => {});
  return r.headers.get("cache-control");
}

const stale = await sql`
  select bucket_id, name, metadata->>'cacheControl' as cc
  from storage.objects
  where metadata->>'cacheControl' is distinct from ${UPLOAD_CACHE_CONTROL}
  order by bucket_id, name`;

if (stale.length === 0) {
  console.log("✓ nothing to do — every object already carries the correct cache-control");
  await sql.end();
  process.exit(0);
}

const byBucket = {};
for (const r of stale) byBucket[r.bucket_id] = (byBucket[r.bucket_id] || 0) + 1;
console.log(`${stale.length} objects need patching -> "${UPLOAD_CACHE_CONTROL}"`);
console.table(Object.entries(byBucket).map(([bucket, n]) => ({ bucket, objects: n })));

// --- prove the mechanism on exactly one object before touching the rest -------
if (VERIFY_ONE || !DRY) {
  const probe = stale[0];
  const before = await servedCacheControl(probe.bucket_id, probe.name);
  console.log(`\nprobe: ${probe.bucket_id}/${probe.name}`);
  console.log(`  served BEFORE: ${before}`);

  await sql`
    update storage.objects
    set metadata = jsonb_set(metadata, '{cacheControl}', ${JSON.stringify(UPLOAD_CACHE_CONTROL)}::jsonb)
    where bucket_id = ${probe.bucket_id} and name = ${probe.name}`;

  let after = null;
  for (const wait of [500, 2000, 5000]) {
    await Bun.sleep(wait);
    after = await servedCacheControl(probe.bucket_id, probe.name);
    if (after === UPLOAD_CACHE_CONTROL) break;
  }
  console.log(`  served AFTER:  ${after}`);

  if (after !== UPLOAD_CACHE_CONTROL) {
    // Roll the probe back so a failed experiment leaves no trace, and stop. The
    // metadata row is not the source of truth for serving on this project, so a
    // full backfill here would be 5,000 writes that change nothing.
    await sql`
      update storage.objects
      set metadata = jsonb_set(metadata, '{cacheControl}', ${JSON.stringify(probe.cc ?? "no-cache")}::jsonb)
      where bucket_id = ${probe.bucket_id} and name = ${probe.name}`;
    console.error(
      `\n✗ the served header did not change. The metadata row is NOT what the\n` +
        `  serving layer reads on this project — probe rolled back, nothing else\n` +
        `  touched. Fall back to re-uploading the bytes with the header instead.`,
    );
    await sql.end();
    process.exit(2);
  }
  console.log("  ✓ mechanism confirmed — the served header follows the metadata row");
}

if (VERIFY_ONE) {
  console.log("\n--verify-one: stopping here. Re-run with DRY_RUN=false to patch the rest.");
  await sql.end();
  process.exit(0);
}

if (DRY) {
  console.log("\nDRY RUN — nothing written. Re-run with DRY_RUN=false to apply.");
  await sql.end();
  process.exit(0);
}

// --- patch the rest in one statement -----------------------------------------
const [{ n }] = await sql`
  with updated as (
    update storage.objects
    set metadata = jsonb_set(metadata, '{cacheControl}', ${JSON.stringify(UPLOAD_CACHE_CONTROL)}::jsonb)
    where metadata->>'cacheControl' is distinct from ${UPLOAD_CACHE_CONTROL}
    returning 1
  ) select count(*)::int as n from updated`;
console.log(`\n✓ patched ${n} objects`);

// --- verify a random sample actually serves the new header --------------------
const sample = await sql`
  select bucket_id, name from storage.objects
  where metadata->>'cacheControl' = ${UPLOAD_CACHE_CONTROL}
  order by random() limit 5`;
let ok = 0;
for (const s of sample) {
  const cc = await servedCacheControl(s.bucket_id, s.name);
  const good = cc === UPLOAD_CACHE_CONTROL;
  if (good) ok++;
  console.log(`  ${good ? "✓" : "✗"} ${s.bucket_id}/${s.name.slice(0, 60)} -> ${cc}`);
}
console.log(`\nverified ${ok}/${sample.length} sampled objects serve the new header`);

const remaining = await sql`
  select count(*)::int as n from storage.objects
  where metadata->>'cacheControl' is distinct from ${UPLOAD_CACHE_CONTROL}`;
console.log(`remaining stale objects: ${remaining[0].n}`);

await sql.end();
process.exit(ok === sample.length ? 0 : 1);
