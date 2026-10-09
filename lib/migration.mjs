// What moves off Supabase Storage, and whether the bucket may then be emptied.
//
// The plan (owner's call, 2026-10-09): move EVERY draw photo and logo to Cloudinary, back each
// one up locally in the same download, then empty the Supabase `draw-images` bucket so the
// Supabase project holds only its database — a fresh storage counter, rather than a bucket
// frozen at 97% of its quota and one stray write away from a 402 on every API.
//
// Pure functions only; migrate-images.mjs does the I/O. Pinned by test/migration.test.mjs.
import { objectPathFromUrl, publicIdOf } from "./storage.mjs";

/**
 * Every row whose image is on the live Supabase bucket, ANY status — active, draft, ended.
 *
 *   move     Map(bucket key → ["draws.<id>" | "operators.<id>"])   rows still on Supabase
 *   onCloud  Map(public_id  → [row refs])                           rows already on Cloudinary
 *   skipped  tallies: dead-project, hotlinked (foreign), empty, already moved
 *
 * onCloud is keyed by public_id, not key: on Cloudinary `x.jpg` and `x.png` are one asset, and
 * a key that was stored under a corrected format must still be recognised as the same image.
 */
export function selectToMove({ draws, operators, sbPrefix, cloudBase }) {
  const move = new Map();
  const onCloud = new Map();
  const skipped = { dead: 0, foreign: 0, empty: 0, alreadyMoved: 0 };
  const push = (m, k, ref) => { if (!m.has(k)) m.set(k, []); m.get(k).push(ref); };
  const consider = (url, ref) => {
    if (!url) { skipped.empty++; return; }
    const sbKey = objectPathFromUrl(url, sbPrefix);
    if (sbKey) { push(move, sbKey, ref); return; }
    const cloudKey = cloudBase ? objectPathFromUrl(url, cloudBase) : null;
    if (cloudKey) { skipped.alreadyMoved++; push(onCloud, publicIdOf(cloudKey), ref); return; }
    if (/kkuuwksgyypicnblwubs|hnmutpztdkzmtdopdjuo/.test(url)) skipped.dead++;
    else skipped.foreign++;
  };
  for (const d of draws) consider(d.image_url, `draws.${d.id}`);
  for (const o of operators) consider(o.logo_url, `operators.${o.id}`);
  return { move, onCloud, skipped };
}

/**
 * May the Supabase bucket be emptied, and of what?
 *
 *   bucket           [{ path, size }]  every object in draw-images now
 *   backup           Map(key → { manifestBytes, sha256, diskBytes, diskSha256 })  the local copy
 *   stillOnSupabase  [row refs]  rows whose URL is STILL on the Supabase base
 *   onCloud          Map(public_id → [row refs])  rows that now load from Cloudinary
 *   cloudOk          Map(public_id → true | "why not")  the Cloudinary copy, checked over GET
 *
 * REFUSES — and returns nothing deletable — when any row still points at Supabase, or when any
 * object a row references lacks a byte-exact local backup or a verified Cloudinary copy. An
 * unreferenced object (an orphan) needs only its backup; one without is kept, not deleted, and
 * does not hold up the rest. All-or-nothing for referenced objects on purpose: a half-emptied
 * bucket with some rows still loading from it is the worst state to be left in.
 */
export function emptyGate({ bucket, backup, stillOnSupabase, onCloud, cloudOk }) {
  const reasons = [];
  if (stillOnSupabase.length) {
    reasons.push(`${stillOnSupabase.length} row(s) still point at the Supabase bucket — run --phase=rewrite first (e.g. ${stillOnSupabase.slice(0, 5).join(", ")})`);
  }
  const deletable = [];
  const kept = [];
  let bytes = 0;
  for (const { path, size } of bucket) {
    const b = backup.get(path);
    const backedUp = !!b && b.manifestBytes === size && b.diskBytes === size && !!b.sha256 && b.diskSha256 === b.sha256;
    // "In use" = some row's URL names this EXACT key, extension included. Keying by the
    // extension-less public_id made an unused twin (op/t.avif beside op/t.webp, one Cloudinary
    // asset) look referenced and be checked against the other twin's size — 2026-10-09.
    if (onCloud.has(path)) {
      if (!backedUp) { reasons.push(`no byte-exact local backup of ${path} (used by ${onCloud.get(path).slice(0, 3).join(", ")})`); continue; }
      const ok = cloudOk.get(path);
      if (ok !== true) { reasons.push(`Cloudinary copy of ${path} not verified: ${ok ?? "never checked"}`); continue; }
      deletable.push(path); bytes += size;
    } else if (backedUp) { deletable.push(path); bytes += size; }
    else kept.push({ path, why: "unreferenced, but no byte-exact local backup" });
  }
  if (reasons.length) return { refuse: true, reasons, deletable: [], kept, bytes: 0 };
  return { refuse: false, reasons, deletable, kept, bytes };
}

/**
 * Wrap an async loader so concurrent callers share ONE in-flight load and all receive the
 * finished result. A failed load is forgotten, so the next caller retries.
 *
 * Why it exists: the migration's Cloudinary lookup used to build its index lazily as
 * `byId = new Map()` followed by `await inventory()`. Every concurrent lookup that arrived
 * during that await saw the empty Map and answered "missing" — on 2026-10-09 the first live
 * verify flagged exactly 8 of 20 freshly-copied images (the pool width). In `rewrite` the
 * same race silently skips rows; in `empty-check` it blocks the gate.
 */
export function onceAsync(load) {
  let p = null;
  return () => {
    p ??= load().catch((e) => { p = null; throw e; });
    return p;
  };
}

/**
 * Which bucket objects do the rows' Cloudinary URLs actually use? `rowKeys` is
 * Map(keyNamedByARowUrl → [row refs]); returns Map(bucketKey → [row refs]).
 *
 *  - a key that exists in the bucket is that object;
 *  - otherwise, if exactly ONE bucket object shares its public_id, it is that object
 *    (op/x.jpg holding PNG bytes is served as op/x.png — the row names .png);
 *  - otherwise every same-public_id object counts as used. Cautious on purpose: this map
 *    decides what emptyGate demands a verified Cloudinary copy for.
 *
 * Twins (op/t.avif + op/t.webp, one Cloudinary asset) are why the exact match comes first:
 * keying by public_id alone made the twin no row uses look referenced — 2026-10-09.
 */
export function usedBucketKeys({ rowKeys, bucket }) {
  const resolve = bucketKeyResolver(bucket);
  const used = new Map();
  for (const [k, refs] of rowKeys) {
    for (const p of resolve(k)) {
      if (!used.has(p)) used.set(p, []);
      used.get(p).push(...refs);
    }
  }
  return used;
}

/** The resolution rule of usedBucketKeys as a reusable function: key a row URL names → bucket keys. */
export function bucketKeyResolver(bucket) {
  const paths = new Set(bucket.map((o) => o.path));
  const byId = new Map();
  for (const p of paths) {
    const id = publicIdOf(p);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(p);
  }
  return (k) => (paths.has(k) ? [k] : byId.get(publicIdOf(k)) || []);
}
