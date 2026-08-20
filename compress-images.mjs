// One-time backfill: re-encode everything already sitting in the `draw-images` bucket to
// webp at w<=1280, in place.
//
// WHY: images were re-hosted at full original resolution (avg 964KB, worst case 12MB) and
// blew the Supabase free-tier 1GB storage quota — 2.43GB / 243%, grace period ending
// 19 Aug 2026, after which the project 402s and the site goes down. The site never serves
// these bytes directly (see lib/compress.mjs for the full reasoning), so re-encoding is
// pure win: ~30x smaller, no visible change. lib/rehost.mjs now compresses at ingest, so
// this script only has to clear the accumulated backlog.
//
//   DRY_RUN=true (default) → report what would change, touch nothing.
//   DRY_RUN=false          → re-encode and overwrite.
//
// IN-PLACE, SAME OBJECT PATH — deliberately. Writing `.webp` paths instead would mean
// PATCHing ~2900 draws.image_url rows (plus operator logos and guide covers) and would
// 404 every already-indexed og:image URL and external cache. Overwriting the same key with
// `Content-Type: image/webp` keeps every URL valid at zero DB cost; browsers and weserv both
// honour the content-type header over the file extension. So yes — after this runs, an
// object named `.png` legitimately holds webp bytes. That quirk is confined to this legacy
// set; NEW ingests get a proper `.webp` extension from rehost.mjs.
//
// Safe to interrupt and re-run: shouldSkip() ignores anything already webp or already small.
import { fetchWebp, shouldSkip, WEBP_W, WEBP_Q } from "./lib/compress.mjs";

const URL_ = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
const BUCKET = process.env.BUCKET || "draw-images";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const MIN_BYTES = Number(process.env.MIN_BYTES || 250_000);

if (!KEY) { console.error("✗ needs SUPABASE_SERVICE_ROLE_KEY (in ~/pdd-aggregator/.env)"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MB = (b) => (b / 1048576).toFixed(1) + " MB";
const PUBLIC = `${URL_}/storage/v1/object/public/${BUCKET}/`;

// Supabase drops the occasional connection mid-run (ECONNRESET on a plain list call). A
// transient socket error must not abort a 2000-file sweep, so every storage call retries
// with backoff before giving up.
async function withRetry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < tries - 1) await Bun.sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${label}: ${(last?.message || last || "").toString().slice(0, 120)}`);
}

// The storage list API is per-prefix and paginated; folder entries come back with id === null.
async function list(prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await withRetry(async () => {
      const r = await fetch(`${URL_}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(`returned ${JSON.stringify(j).slice(0, 160)}`);
      return j;
    }, `list ${prefix}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// Bucket layout is exactly one level deep: <operator-slug>/<draw-slug>.<ext>
async function walk() {
  const files = [];
  for (const top of await list("")) {
    if (top.id !== null) { files.push({ ...top, path: top.name }); continue; }
    for (const f of await list(`${top.name}/`)) {
      if (f.id !== null) files.push({ ...f, path: `${top.name}/${f.name}` });
    }
  }
  return files;
}

async function overwrite(path, buf) {
  await withRetry(async () => {
    const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "image/webp", "x-upsert": "true" },
      body: buf,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  }, "upload", 3);
}

console.log(`${DRY ? "DRY RUN" : "LIVE"} — scanning ${BUCKET}…`);
const files = await walk();
const before = files.reduce((a, f) => a + (f.metadata?.size || 0), 0);
const todo = files.filter((f) => !shouldSkip(f, { minBytes: MIN_BYTES }));
const skipped = files.length - todo.length;
const skippedBytes = files.filter((f) => shouldSkip(f, { minBytes: MIN_BYTES })).reduce((a, f) => a + (f.metadata?.size || 0), 0);

console.log(`  ${files.length} objects, ${MB(before)} total`);
console.log(`  ${todo.length} to re-encode (${MB(before - skippedBytes)}) · ${skipped} already webp/small (${MB(skippedBytes)})`);
console.log(`  target: w<=${WEBP_W}, webp, q=${WEBP_Q}\n`);

if (!todo.length) { console.log("Nothing to do."); process.exit(0); }

if (DRY) {
  // Sample rather than fetch all of them — enough to project the total honestly without
  // hammering weserv on a run that changes nothing.
  const sample = todo.filter((_, i) => i % Math.max(1, Math.floor(todo.length / 12)) === 0).slice(0, 12);
  let sBefore = 0, sAfter = 0, ok = 0;
  for (const f of sample) {
    const buf = await fetchWebp(PUBLIC + encodeURI(f.path));
    if (!buf) { console.log(`  ⚠ proxy miss: ${f.path.slice(0, 66)}`); continue; }
    sBefore += f.metadata.size; sAfter += buf.byteLength; ok++;
    console.log(`  ${(f.metadata.size / 1024).toFixed(0).padStart(6)}KB → ${(buf.byteLength / 1024).toFixed(0).padStart(5)}KB  (${(f.metadata.size / buf.byteLength).toFixed(1)}x)  ${f.path.slice(0, 52)}`);
  }
  const ratio = ok ? sBefore / sAfter : 1;
  console.log(`\nsampled ${ok}/${sample.length} · mean ${ratio.toFixed(1)}x`);
  console.log(`PROJECTED: ${MB(before)} → ~${MB(skippedBytes + (before - skippedBytes) / ratio)}  (quota 1024 MB)`);
  console.log("\nRe-run with DRY_RUN=false to apply.");
  process.exit(0);
}

// Fixed pool of workers pulling off a shared cursor — keeps exactly CONCURRENCY requests in
// flight regardless of how much the per-file time varies (a 12MB source is far slower than
// a 300KB one).
let cursor = 0, done = 0, saved = 0, converted = 0, missed = 0, failed = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const f = todo[i];
    done++;
    const buf = await fetchWebp(PUBLIC + encodeURI(f.path));
    if (!buf) { missed++; console.log(`  ⚠ proxy miss, left as-is: ${f.path.slice(0, 62)}`); continue; }
    // Never let a re-encode make a file BIGGER (tiny/already-optimised sources can).
    if (buf.byteLength >= f.metadata.size) { missed++; continue; }
    try {
      await overwrite(f.path, buf);
      converted++; saved += f.metadata.size - buf.byteLength;
      if (converted % 25 === 0) console.log(`  … ${done}/${todo.length} · ${converted} re-encoded · ${MB(saved)} freed`);
    } catch (e) {
      // One bad object must never sink the run — the whole point is to get under quota.
      failed++; console.log(`  ! ${f.path.slice(0, 56)}: ${(e.message || "").slice(0, 70)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n✓ re-encoded ${converted} · proxy miss/no-gain ${missed} · failed ${failed}`);
console.log(`✓ freed ${MB(saved)} — bucket ${MB(before)} → ${MB(before - saved)} (quota 1024 MB)`);
