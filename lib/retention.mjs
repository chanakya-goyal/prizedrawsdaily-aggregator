// When a draw photo on the image provider may be let go.
//
// THE ROOT CAUSE THIS EXISTS FOR: three storage incidents in two months (Aug 2026 storage
// size, Sep 2026 egress, Oct 2026 storage size again) came from one design choice — every
// ingest stores a photo and nothing ever removes one. At ~3,700 new draws a month that is
// ~480 MB/month onto a 1 GB free bucket: it fills in about two months whatever else we do.
// Moving to a fresh organisation reset the counter but kept the habit. The fix is a
// lifecycle, not just a bigger box: photos of draws that have been over for a long time go.
//
// "A long time" is RETENTION_DAYS, default 0: since 2026-10-10 a photo is kept only while its
// draw is live (the owner's decision). The draw ROW and its page stay. Ended pages are indexed
// and still bring search clicks; with no photo they show the category cover. In GSC's top 100
// pages over 28 days, 29 of ~98 draw-page clicks went to draws that ended over a month earlier:
// ~2% of the site's clicks, earned by the prize name, not the photo. Meanwhile every kept
// photo costs one of the Pages free plan's 20,000 files (lib/pages.mjs): at 180 days the site
// could take ~100 new draws a day, at 0 about 2,400. A relisted draw gets its photo back from
// the next scrape. (Migrated photos are not re-dated: a draw that ended a year ago has its
// photo let go on the first retention run after the move. That is intended.)
//
// Pure functions only — image-retention.mjs does the I/O. Every boundary is pinned in
// test/retention.test.mjs, because both directions of a mistake destroy something: too eager
// blanks a LIVE draw's photo, too timid refills the storage.
import { cloudinaryAssetOf, cloudinaryAssetKey } from "./storage.mjs";
import { pagesBase, pagesKeyOf } from "./pages.mjs";

const DAY = 86400_000;
export const DEFAULT_RETENTION_DAYS = 0;

/** Statuses after which nobody can enter a draw. Only these ever expire. */
export const TERMINAL = new Set(["ended", "archived"]);

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
 * The photos the provider may let go: Cloudinary assets whose draws have ALL expired. An
 * asset still used by any non-expired draw, or by an operator logo, survives.
 *
 * Compared by ASSET (cloudinaryAssetOf), because the account holds two forms that map a
 * URL to an asset differently: on the migrated image assets `op/d.jpg` and `op/d.webp` are
 * ONE asset (deleting it for the old row would blank the live one), while on the raw assets
 * every upload since 2026-10-09 uses, the extension is part of the public_id and they are two.
 *
 * Photos SERVED from the Pages site (lib/pages.mjs) expire by the same rule, under a
 * `pages:` key. They have no asset to delete: publish-images.mjs deploys only what rows
 * still point at, so the photo leaves the site on its next run once its rows are null.
 *
 *   expire  Map(key → [expired draw ids])
 *   assets  Map(key → { resourceType, publicId, path })  what deleteObjects is given;
 *           Cloudinary keys only
 */
export function selectExpired({ draws, operators, cloud, base = pagesBase(), now = Date.now(), days = DEFAULT_RETENTION_DAYS }) {
  const keep = new Set();
  const assets = new Map();
  const candidates = [];
  const keyOf = (url) => {
    const onPages = pagesKeyOf(url, base);
    if (onPages) return { key: `pages:${onPages}`, asset: null };
    const a = cloud ? cloudinaryAssetOf(url, cloud) : null;
    return a ? { key: cloudinaryAssetKey(a), asset: a } : null;
  };
  for (const d of draws) {
    const k = keyOf(d.image_url);
    if (!k) continue;
    if (isExpired(d, { now, days })) { candidates.push({ id: d.id, key: k.key }); if (k.asset) assets.set(k.key, k.asset); }
    else keep.add(k.key);
  }
  for (const o of operators) {
    const k = keyOf(o.logo_url);
    if (k) keep.add(k.key);
  }
  const expire = new Map();
  let protectedRows = 0;
  for (const { id, key } of candidates) {
    if (keep.has(key)) { protectedRows++; continue; }
    if (!expire.has(key)) expire.set(key, []);
    expire.get(key).push(id);
  }
  for (const key of [...assets.keys()]) if (!expire.has(key)) assets.delete(key);
  return { expire, assets, protectedRows };
}

/**
 * Every expired row goes to null. The site renders the category cover (CoverFallback) for a
 * null image_url and falls back to the site og:image, so nothing renders broken.
 *
 * Never back to Supabase: the bucket is emptied after the move, and a row pointing there
 * would also block the empty gate (`migrate-images.mjs --phase=empty-check`), which refuses while any row
 * still loads from it.
 */
export function planRetention({ expire }) {
  const plan = [];
  for (const [key, ids] of expire) for (const id of ids) plan.push({ id, key, newUrl: null });
  return plan;
}
