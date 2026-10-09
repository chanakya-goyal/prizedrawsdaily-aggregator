// When a draw photo on the image provider may be let go.
//
// THE ROOT CAUSE THIS EXISTS FOR: three storage incidents in two months (Aug 2026 storage
// size, Sep 2026 egress, Oct 2026 storage size again) came from one design choice — every
// ingest stores a photo and nothing ever removes one. At ~3,700 new draws a month that is
// ~480 MB/month onto a 1 GB free bucket: it fills in about two months whatever else we do.
// Moving to a fresh organisation reset the counter but kept the habit. The fix is a
// lifecycle, not just a bigger box: photos of draws that have been over for a long time go.
//
// "A long time" is RETENTION_DAYS, default 180. Cloudinary storage costs ~1 credit per GB of
// the 25 free each month, so there is no pressure to remove photos early — the owner wants
// ended draws to keep their photos for months — but without ANY lifecycle the account would
// simply fill more slowly. (Migrated photos are not re-dated: a draw that ended a year ago
// has its photo let go on the first retention run after the move. That is intended.)
//
// Pure functions only — image-retention.mjs does the I/O. Every boundary is pinned in
// test/retention.test.mjs, because both directions of a mistake destroy something: too eager
// blanks a LIVE draw's photo, too timid refills the storage.
import { objectPathFromUrl, publicIdOf } from "./storage.mjs";

const DAY = 86400_000;
export const DEFAULT_RETENTION_DAYS = 180;

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
export function isExpired(draw, { now = Date.now(), days = DEFAULT_RETENTION_DAYS } = {}) {
  if (!TERMINAL.has(draw?.status)) return false;
  const t = Date.parse(draw.draw_date || "") || Date.parse(draw.created_at || "");
  if (!t) return false;
  return t < now - days * DAY;
}

/**
 * The photos the provider may let go: photos on `cloudBase` whose draws have ALL expired. A
 * key still used by any non-expired draw, or by an operator logo, survives — compared by
 * Cloudinary asset (publicIdOf), because `op/d.jpg` and `op/d.webp` are one asset there and
 * deleting it for the old row would blank the live one.
 *
 * Returns Map(path → [expired draw ids]) and how many expired rows were protected.
 */
export function selectExpired({ draws, operators, cloudBase, now = Date.now(), days = DEFAULT_RETENTION_DAYS }) {
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
 * Every expired row goes to null. The site renders the category cover (CoverFallback) for a
 * null image_url and falls back to the site og:image, so nothing renders broken.
 *
 * Never back to Supabase: the bucket is emptied after the move, and a row pointing there
 * would also block `migrate-images.mjs --phase=empty-supabase`, which refuses while any row
 * still loads from it.
 */
export function planRetention({ expire }) {
  const plan = [];
  for (const [path, ids] of expire) for (const id of ids) plan.push({ id, path, newUrl: null });
  return plan;
}
