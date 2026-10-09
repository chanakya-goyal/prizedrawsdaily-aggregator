// Which Cloudinary files no draw needs any more. cloudinary-sweep.mjs does the I/O; the rules
// are pinned in test/sweep.test.mjs.
//
// WHY: since 2026-10-10 photos are SERVED from the Pages site (lib/pages.mjs) and a photo
// lives only while its draw is live (RETENTION_DAYS=0, lib/retention.mjs). Retention
// nulls a dead draw's row and the next Pages deploy drops the file, but the Cloudinary
// copy it was made from would stay forever. On 2026-10-10 that was 5,770 dead copies
// (691 MB) next to 3,244 live ones. Storage is a Cloudinary credit, so dead copies are
// deleted too.
//
// A Cloudinary file is KEPT when:
//  - any row, live or dead, still points at it directly. Deleting it would break that row.
//    Retention nulls a dead row first, then deletes the file itself;
//  - a live draw (any status but ended/archived) or an operator logo is served from the
//    Pages copy of the same key. That Cloudinary file is the second copy of a live photo.
//    A Pages key keeps both forms, raw `op/d.webp` and image `op/d`, which also covers
//    the migrated twin `.avif`/`.webp` keys that share one image asset;
//  - it was uploaded less than `minAgeMs` ago (default 48h), or its age is unknown. The
//    scrape uploads before it writes the row, so a fresh file with no row yet is normal.
// Everything else is deleted.
import { cloudinaryAssetOf, cloudinaryAssetKey, publicIdOf } from "./storage.mjs";
import { pagesKeyOf } from "./pages.mjs";
import { TERMINAL } from "./retention.mjs";

export const SWEEP_MIN_AGE_MS = 48 * 3600e3;

export function planCloudinarySweep({ inventory, draws = [], operators = [], base, cloud, now = Date.now(), minAgeMs = SWEEP_MIN_AGE_MS }) {
  const keep = new Set();
  const protect = (url, live) => {
    if (typeof url !== "string" || !url) return;
    const a = cloud ? cloudinaryAssetOf(url, cloud) : null;
    if (a) { keep.add(cloudinaryAssetKey(a)); return; } // a row points straight at it
    const k = live ? pagesKeyOf(url, base) : null;
    if (k) { keep.add(`raw:${k}`); keep.add(`image:${publicIdOf(k)}`); }
  };
  for (const d of draws) protect(d.image_url, !TERMINAL.has(d.status));
  for (const o of operators) protect(o.logo_url, true);

  const remove = [];
  let kept = 0, young = 0, bytes = 0;
  for (const a of inventory.values()) {
    if (keep.has(cloudinaryAssetKey(a))) { kept++; continue; }
    const t = Date.parse(a.createdAt || "");
    if (!t || t > now - minAgeMs) { young++; continue; }
    remove.push(a);
    bytes += a.bytes || 0;
  }
  return { remove, kept, young, bytes };
}
