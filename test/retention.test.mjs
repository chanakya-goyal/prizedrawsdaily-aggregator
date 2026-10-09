import { expect, test, describe } from "bun:test";
import { isExpired, selectExpired, planRetention, DEFAULT_RETENTION_DAYS } from "../lib/retention.mjs";

// Why this file exists: the root cause of three storage incidents in two months was
// "stored forever, deleted never" on a fixed-size free bucket — ~3,700 new draw photos a
// month and nothing ever removed. These functions decide which photos the image provider
// later lets go. Both directions of a mistake destroy something: too eager and a LIVE draw
// loses its photo; too timid and the storage fills exactly like the old bucket. So the
// boundaries are pinned here, not left to a reading of the code.

const DAY = 86400_000;
const now = Date.parse("2026-10-09T12:00:00Z");
const ago = (d) => new Date(now - d * DAY).toISOString();
const SB = "https://proj.supabase.co/storage/v1/object/public/draw-images/";
const CDN = "https://res.cloudinary.com/pdd/image/upload/v1/";

describe("isExpired", () => {
  const opts = { now, days: 30 };

  test("an ended draw whose date is more than N days past is expired", () => {
    expect(isExpired({ status: "ended", draw_date: ago(31) }, opts)).toBe(true);
  });

  test("an ended draw inside the window is not", () => {
    expect(isExpired({ status: "ended", draw_date: ago(29) }, opts)).toBe(false);
  });

  test("the default window is 180 days — photos are not removed early", () => {
    // With everything on Cloudinary, storage is ~1 credit/GB of 25 free a month. The owner
    // wants ended draws to keep their photos for months, so the default is generous.
    expect(DEFAULT_RETENTION_DAYS).toBe(180);
    expect(isExpired({ status: "ended", draw_date: ago(179) }, { now })).toBe(false);
    expect(isExpired({ status: "ended", draw_date: ago(181) }, { now })).toBe(true);
  });

  test("an ACTIVE draw is never expired, however old its date", () => {
    // DECISIONS.md: a past draw_date alone never ends a draw. ~44% of active rows carry a
    // past date at any moment because operators extend draws — they are live and enterable.
    expect(isExpired({ status: "active", draw_date: ago(400) }, opts)).toBe(false);
    expect(isExpired({ status: "draft", draw_date: ago(400) }, opts)).toBe(false);
  });

  test("an ended draw with no date falls back to when the row was created", () => {
    expect(isExpired({ status: "ended", draw_date: null, created_at: ago(90) }, opts)).toBe(true);
    expect(isExpired({ status: "ended", draw_date: null, created_at: ago(3) }, opts)).toBe(false);
  });

  test("an ended draw with no date at all is kept — no evidence, no deletion", () => {
    expect(isExpired({ status: "ended" }, opts)).toBe(false);
    expect(isExpired({ status: "ended", draw_date: "not a date" }, opts)).toBe(false);
  });

  test("archived counts as ended", () => {
    expect(isExpired({ status: "archived", draw_date: ago(31) }, opts)).toBe(true);
  });
});

describe("selectExpired — what the provider lets go", () => {
  const opts = { cloudBase: CDN, now, days: 30 };

  test("an expired draw's Cloudinary image is selected", () => {
    const draws = [{ id: 1, status: "ended", draw_date: ago(45), image_url: `${CDN}op/old.webp` }];
    const { expire } = selectExpired({ draws, operators: [], ...opts });
    expect([...expire.keys()]).toEqual(["op/old.webp"]);
    expect(expire.get("op/old.webp")).toEqual([1]);
  });

  test("a key still used by a live draw survives, even when an expired row shares it", () => {
    // Relists reuse an image key. Deleting it because the OLD listing expired would
    // blank the photo on the live relisting.
    const draws = [
      { id: 1, status: "ended", draw_date: ago(45), image_url: `${CDN}op/relist.webp` },
      { id: 2, status: "active", draw_date: ago(-3), image_url: `${CDN}op/relist.webp` },
    ];
    const r = selectExpired({ draws, operators: [], ...opts });
    expect(r.expire.size).toBe(0);
    expect(r.protectedRows).toBe(1);
  });

  test("protection is by Cloudinary asset, not by extension", () => {
    // op/d.jpg and op/d.webp are ONE Cloudinary asset; deleting it for the expired .jpg
    // row would kill the live .webp row's image too.
    const draws = [
      { id: 1, status: "ended", draw_date: ago(45), image_url: `${CDN}op/d.jpg` },
      { id: 2, status: "active", image_url: `${CDN}op/d.webp` },
    ];
    expect(selectExpired({ draws, operators: [], ...opts }).expire.size).toBe(0);
  });

  test("an operator logo is never expired, and protects a draw that reuses it", () => {
    const draws = [{ id: 1, status: "ended", draw_date: ago(45), image_url: `${CDN}operator-logos/acme.webp` }];
    const operators = [{ id: "o1", logo_url: `${CDN}operator-logos/acme.webp` }];
    expect(selectExpired({ draws, operators, ...opts }).expire.size).toBe(0);
  });

  test("rows on Supabase or anywhere else are not this job's business", () => {
    const draws = [
      { id: 1, status: "ended", draw_date: ago(400), image_url: `${SB}op/archive.webp` },
      { id: 2, status: "ended", draw_date: ago(400), image_url: "https://operator.co.uk/x.jpg" },
    ];
    expect(selectExpired({ draws, operators: [], ...opts }).expire.size).toBe(0);
  });

  test("a recently-ended draw keeps its image", () => {
    const draws = [{ id: 1, status: "ended", draw_date: ago(5), image_url: `${CDN}op/recent.webp` }];
    expect(selectExpired({ draws, operators: [], ...opts }).expire.size).toBe(0);
  });
});

describe("planRetention — where each expired row points next", () => {
  test("every expired row goes to null (the category cover), never back to Supabase", () => {
    // The Supabase bucket is emptied after the move. A row repointed there would load a
    // deleted object — and would block --phase=empty-supabase, which refuses while any
    // row still points at the bucket.
    const expire = new Map([["op/a.webp", [1, 2]], ["op/b.webp", [3]]]);
    expect(planRetention({ expire })).toEqual([
      { id: 1, path: "op/a.webp", newUrl: null },
      { id: 2, path: "op/a.webp", newUrl: null },
      { id: 3, path: "op/b.webp", newUrl: null },
    ]);
  });
});
