#!/usr/bin/env bun
// Backfill `cacheControl` on objects already in Storage.
//
// WHY ------------------------------------------------------------------------
// Every object uploaded before the fix in lib/storage.mjs was stored with
// `cacheControl: "no-cache"`, because none of the three upload sites sent a
// cache-control header and that is Supabase's default. Measured 2026-09-12:
// 5,402 objects / 596 MB in draw-images, 100% of them `no-cache`.
//
// `no-cache` makes images.weserv.nl answer `x-cache-status: BYPASS` — it caches
// nothing and re-downloads the FULL-SIZE original from Supabase on every single
// impression, to serve a 76 KB thumbnail from a 205 KB original. That is how
// 596 MB of images produced 6.37 GB of egress in one billing cycle.
//
// lib/storage.mjs fixes every FUTURE upload. This fixes the existing ones.
//
// WHY RE-UPLOAD, AND NOT SOMETHING CHEAPER -----------------------------------
// Supabase has no metadata-only update. Two cheaper routes were TESTED and BOTH
// FAILED on this project (2026-09-12), so do not retry them:
//
//   1. Patching `storage.objects.metadata->>'cacheControl'` in Postgres. The row
//      changes, the served header does NOT — the serving layer does not read it.
//   2. `POST /storage/v1/object/copy` with a cache-control header (and
//      `copyMetadata:false`). The copy is created with `cacheControl:"no-cache"`.
//
// What DOES work is sending `cache-control` on a normal upload — verified: such
// an object serves `public, max-age=31536000` on GET and flips weserv from
// BYPASS to MISS. So the bytes have to go back up.
//
// That costs one download per object. Which is why scope matters:
//
//   --scope=live (default)  images on status=active draws   1,580 obj / ~179 MB
//   --scope=referenced      any draw, incl. ended/draft      5,368 obj / ~595 MB
//   --scope=all             + orphans nothing references         +34 obj
//
// The live set is the one crawlers and visitors actually hit repeatedly, so it
// carries almost all of the benefit. At the ~200 MB/day this bug was burning,
// 179 MB of downloads pays for itself in under a day. Run `live` first, and the
// rest after the billing cycle rolls over if you want to be careful.
//
// GOTCHA ---------------------------------------------------------------------
// `curl -I` / HEAD against Supabase Storage reports `no-cache` even for a
// correctly-cached object. Only a GET shows the true header. This script always
// verifies with GET.
//
// USAGE ----------------------------------------------------------------------
//   bun backfill-cache-control.mjs                        # dry run, live scope
//   bun backfill-cache-control.mjs --scope=referenced     # dry run, wider
//   DRY_RUN=false bun backfill-cache-control.mjs          # do it
//
// Needs only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (both already in .env).
// Safe to interrupt and re-run: anything already carrying the header is skipped.

import { listAllObjects, objectPathFromUrl, PUBLIC_PREFIX, uploadHeaders, UPLOAD_CACHE_CONTROL } from "./lib/storage.mjs";

const supabaseUrl = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const bucket = process.env.BUCKET || "draw-images";
const DRY = process.env.DRY_RUN !== "false";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const scopeArg = (process.argv.find((a) => a.startsWith("--scope=")) || "--scope=live").split("=")[1];
// Prove the whole path on one real object before committing to 1,580 of them.
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "--limit=0").split("=")[1]) || 0;

if (!serviceKey) { console.error("✗ needs SUPABASE_SERVICE_ROLE_KEY (in ~/pdd-aggregator/.env)"); process.exit(1); }
if (!["live", "referenced", "all"].includes(scopeArg)) { console.error(`✗ unknown --scope=${scopeArg}`); process.exit(1); }

const creds = { supabaseUrl, serviceKey, bucket };
const prefix = PUBLIC_PREFIX(creds);
const MB = (b) => (b / 1048576).toFixed(1);
const objectUrl = (path) => `${supabaseUrl}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
const publicUrl = (path) => `${supabaseUrl}/storage/v1/object/public/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;

async function withRetry(fn, label, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await Bun.sleep(500 * 2 ** i); }
  }
  throw new Error(`${label}: ${(last?.message || last || "").toString().slice(0, 160)}`);
}

/**
 * The true served cache-control.
 *
 * Two traps, both hit for real on 2026-09-12:
 *  1. MUST be a GET. HEAD reports `no-cache` even for a correctly-cached object.
 *  2. Supabase's CDN IGNORES the query string when building its cache key, so a
 *     `?bust=` param does NOT force a fresh response — a re-uploaded object keeps
 *     serving the OLD header (cf-cache-status: HIT) for ~15-30s until the CDN
 *     revalidates. Checking immediately after upload reports a false failure, so
 *     this polls rather than trusting the first answer.
 */
async function servedCacheControl(path, { waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await fetch(publicUrl(path));
    await r.arrayBuffer().catch(() => {});
    const cc = r.headers.get("cache-control");
    if (cc === UPLOAD_CACHE_CONTROL || Date.now() >= deadline) return cc;
    await Bun.sleep(5000);
  }
}

// --- work out what to touch --------------------------------------------------
console.log(`scope=${scopeArg} · ${DRY ? "DRY RUN" : "LIVE"} · scanning ${bucket}…`);
const all = await listAllObjects(creds);

let wanted = new Set(all.map((f) => f.path));
if (scopeArg !== "all") {
  const rest = `${supabaseUrl}/rest/v1/draws?select=image_url,status&image_url=not.is.null`;
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${rest}&limit=1000&offset=${offset}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) { console.error(`✗ draws read failed ${r.status}`); process.exit(1); }
    const page = await r.json();
    if (!Array.isArray(page)) { console.error("✗ draws read returned no array"); process.exit(1); }
    rows.push(...page);
    if (page.length < 1000) break;
  }
  wanted = new Set();
  for (const row of rows) {
    if (scopeArg === "live" && row.status !== "active") continue;
    const p = objectPathFromUrl(row.image_url, prefix);
    if (p) wanted.add(p);
  }
}

let todo = all.filter((f) => wanted.has(f.path) && f.metadata?.cacheControl !== UPLOAD_CACHE_CONTROL);
if (LIMIT > 0) todo = todo.slice(0, LIMIT);
const done = all.filter((f) => f.metadata?.cacheControl === UPLOAD_CACHE_CONTROL).length;
const bytes = todo.reduce((a, f) => a + Number(f.metadata?.size || 0), 0);

console.log(`  ${all.length} objects in bucket · ${done} already correct`);
console.log(`  ${todo.length} to re-upload -> "${UPLOAD_CACHE_CONTROL}"`);
console.log(`  one-time download cost: ~${MB(bytes)} MB of egress`);

if (todo.length === 0) { console.log("\n✓ nothing to do"); process.exit(0); }
if (DRY) { console.log("\nDRY RUN — nothing written. Re-run with DRY_RUN=false to apply."); process.exit(0); }

// --- re-upload ---------------------------------------------------------------
// Guard rails, because this OVERWRITES production images: an object is only
// written back when the download returned 200, an image content-type, and a byte
// count that matches the size Storage has on record. Anything else (a 402 quota
// page, a truncated body, an HTML error) is skipped and reported — never
// uploaded over a good image.
let okCount = 0, skipped = 0, failed = 0, downloaded = 0;
const problems = [];

async function processOne(f) {
  const expected = Number(f.metadata?.size || 0);
  const type = f.metadata?.mimetype || "application/octet-stream";

  const buf = await withRetry(async () => {
    const r = await fetch(objectUrl(f.path), {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`download ${r.status}`);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) throw new Error(`download content-type ${ct || "(none)"}`);
    return new Uint8Array(await r.arrayBuffer());
  }, `get ${f.path}`);

  if (expected > 0 && buf.byteLength !== expected) {
    problems.push(`${f.path}: got ${buf.byteLength}B, expected ${expected}B — NOT re-uploaded`);
    skipped++;
    return;
  }
  if (buf.byteLength === 0) { problems.push(`${f.path}: empty body — NOT re-uploaded`); skipped++; return; }
  downloaded += buf.byteLength;

  await withRetry(async () => {
    const r = await fetch(objectUrl(f.path), {
      method: "POST",
      headers: uploadHeaders({ serviceKey, contentType: type }),
      body: buf,
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`upload ${r.status} ${(await r.text()).slice(0, 120)}`);
  }, `put ${f.path}`);
  okCount++;
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      try { await processOne(f); }
      catch (e) { failed++; problems.push(`${f.path}: ${(e?.message || e).toString().slice(0, 120)}`); }
      const seen = okCount + skipped + failed;
      if (seen % 100 === 0) console.log(`  …${seen}/${todo.length} (${MB(downloaded)} MB pulled)`);
    }
  }),
);

console.log(`\nre-uploaded ${okCount} · skipped ${skipped} · failed ${failed} · pulled ${MB(downloaded)} MB`);
if (problems.length) {
  console.log("problems (first 15):");
  for (const p of problems.slice(0, 15)) console.log(`  ✗ ${p}`);
}

// --- verify what the CDN actually serves now ---------------------------------
const sample = todo.slice(0, 5);
let verified = 0;
console.log("\nverifying served headers (GET, never HEAD; CDN takes ~15-30s to revalidate):");
for (const f of sample) {
  const cc = await servedCacheControl(f.path, { waitMs: 90_000 });
  const good = cc === UPLOAD_CACHE_CONTROL;
  if (good) verified++;
  console.log(`  ${good ? "✓" : "✗"} ${f.path.slice(0, 58)} -> "${cc}"`);
}
console.log(`\nverified ${verified}/${sample.length} sampled objects serve the new header`);
if (verified < sample.length) {
  console.error("✗ some objects still serve the old header — do NOT assume the run worked");
  process.exit(1);
}
console.log("✓ done. Re-run with --scope=referenced to cover ended/draft draws too.");
