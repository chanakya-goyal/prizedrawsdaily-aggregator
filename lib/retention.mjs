// Which draw photos are worth keeping on paid-for (or capped) storage, and which are not.
//
// THE ROOT CAUSE THIS EXISTS FOR: three storage incidents in two months (Aug 2026 storage
// size, Sep 2026 egress, Oct 2026 storage size again) came from one design choice — every
// ingest stores a photo and nothing ever removes one. At ~3,700 new draws a month that is
// ~480 MB/month onto a 1 GB free bucket: it fills in about two months whatever else we do.
// Moving to a fresh organisation reset the counter but kept the habit. The fix is a
// lifecycle, not a bigger box: photos of draws that have been over for a while are let go.
//
// Pure functions only — the scripts (migrate-images.mjs, image-retention.mjs) do the I/O.
// Every boundary here is pinned in test/retention.test.mjs, because both directions of a
// mistake destroy something: too eager blanks a LIVE draw's photo, too timid refills the
// bucket.
import { objectPathFromUrl, publicIdOf } from "./storage.mjs";

const DAY = 86400_000;

/** Statuses after which nobody can enter a draw. Only these ever expire. */
const TERMINAL = new Set(["ended", "archived"]);

/**
 * Has this draw been over for more than `days`?
 *
 * Only a TERMINAL status can expire, never a date alone — DECISIONS.md's standing law: a
 * past draw_date never ends a draw (operators extend them; ~44% of active rows carry a past
 * date at any moment and are perfectly enterable). The age is measured from draw_date, or
 * from created_at for the few ended rows without one. No date at all → not expired: no
 * evidence, no deletion.
 */
export function isExpired(draw, { now = Date.now(), days = 30 } = {}) {
  if (!TERMINAL.has(draw?.status)) return false;
  const t = Date.parse(draw.draw_date || "") || Date.parse(draw.created_at || "");
  if (!t) return false;
  return t < now - days * DAY;
}

/**
 * The images worth moving: every non-expired draw's photo and every operator logo, but only
 * those currently on the live Supabase bucket (`sbPrefix`). Returns
 * Map(path → { draws: [id], logos: [id] }) plus a tally of what was left behind and why.
 *
 * Long-ended draws stay pointing at Supabase. Nothing is deleted there: the bucket simply
 * stops growing once every writer has moved, and those old pages keep their photos.
 */
export function selectNecessary({ draws, operators, sbPrefix, now = Date.now(), days = 30 }) {
  const paths = new Map();
  const skipped = { dead: 0, foreign: 0, empty: 0, expired: 0, alreadyMoved: 0 };
  const add = (url, kind, id) => {
    if (!url) { skipped.empty++; return; }
    const path = objectPathFromUrl(url, sbPrefix);
    if (!path) {
      if (/kkuuwksgyypicnblwubs|hnmutpztdkzmtdopdjuo/.test(url)) skipped.dead++;
      else if (/res\.cloudinary\.com|r2\.dev|r2\.cloudflarestorage/.test(url)) skipped.alreadyMoved++;
      else skipped.foreign++;
      return;
    }
    if (!paths.has(path)) paths.set(path, { draws: [], logos: [] });
    paths.get(path)[kind].push(id);
  };
  for (const d of draws) {
    if (isExpired(d, { now, days })) { skipped.expired++; continue; }
    add(d.image_url, "draws", d.id);
  }
  for (const o of operators) add(o.logo_url, "logos", o.id);
  return { paths, skipped };
}

/**
 * The images the new provider may let go: photos on `cloudBase` whose draws have ALL
 * expired. A key still used by any non-expired draw, or by an operator logo, survives —
 * compared by Cloudinary asset (publicIdOf), because `op/d.jpg` and `op/d.webp` are one
 * asset there and deleting it for the old row would blank the live one.
 *
 * Returns Map(path → [expired draw ids]) and how many expired rows were protected.
 */
export function selectExpired({ draws, operators, cloudBase, now = Date.now(), days = 30 }) {
  const keep = new Set();
  const candidates = [];
  for (const d of draws) {
    const path = objectPathFromUrl(d.image_url, cloudBase);
    if (!path) continue;
    if (isExpired(d, { now, days })) candidates.push({ id: d.id, path });
    else keep.add(publicIdOf(path));
  }
  for (const o of operators) {
    const path = objectPathFromUrl(o.logo_url, cloudBase);
    if (path) keep.add(publicIdOf(path));
  }
  const expire = new Map();
  let protectedRows = 0;
  for (const { id, path } of candidates) {
    if (keep.has(publicIdOf(path))) { protectedRows++; continue; }
    if (!expire.has(path)) expire.set(path, []);
    expire.get(path).push(id);
  }
  return { expire, protectedRows };
}

/**
 * Where each expired row points next: back to its Supabase original when one exists (the
 * bucket is frozen, not emptied, so most migrated photos still have one), otherwise null —
 * the site renders the category cover for a null image_url and falls back to the site
 * og:image, so nothing renders broken.
 */
export function planRetention({ expire, supabaseKeys, sbPrefix }) {
  const plan = [];
  for (const [path, ids] of expire) {
    const newUrl = supabaseKeys.has(path) ? sbPrefix + encodeURI(path) : null;
    for (const id of ids) plan.push({ id, path, newUrl });
  }
  return plan;
}
