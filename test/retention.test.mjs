import { expect, test, describe } from "bun:test";
import { isExpired, selectNecessary, selectExpired, planRetention } from "../lib/retention.mjs";

// Why this file exists: the root cause of three storage incidents in two months was
// "stored forever, deleted never" on a fixed-size free bucket — ~3,700 new draw photos a
// month and nothing ever removed. These functions decide which photos move to the new
// provider and which ones it later lets go. Both decisions destroy something if wrong:
// too eager and a LIVE draw loses its photo; too timid and the new bucket fills exactly
// like the old one. So the boundaries are pinned here, not left to a reading of the code.

const DAY = 86400_000;
const now = Date.parse("2026-10-09T12:00:00Z");
const ago = (d) => new Date(now - d * DAY).toISOString();
const SB = "https://proj.supabase.co/storage/v1/object/public/draw-images/";
const CDN = "https://res.cloudinary.com/pdd/image/upload/v1/";
const DEAD = "https://kkuuwksgyypicnblwubs.supabase.co/storage/v1/object/public/draw-images/";

describe("isExpired", () => {
  const opts = { now, days: 30 };

  test("an ended draw whose date is more than N days past is expired", () => {
    expect(isExpired({ status: "ended", draw_date: ago(31) }, opts)).toBe(true);
  });

  test("an ended draw inside the window is not", () => {
    expect(isExpired({ status: "ended", draw_date: ago(29) }, opts)).toBe(false);
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

describe("selectNecessary — what moves to the new provider", () => {
  const opts = { sbPrefix: SB, now, days: 30 };

  test("live, draft and recently-ended draws move; long-ended ones stay on Supabase", () => {
    const draws = [
      { id: 1, status: "active", draw_date: ago(-5), image_url: `${SB}op/live.webp` },
      { id: 2, status: "draft", draw_date: ago(-9), image_url: `${SB}op/draft.webp` },
      { id: 3, status: "ended", draw_date: ago(10), image_url: `${SB}op/recent.webp` },
      { id: 4, status: "ended", draw_date: ago(60), image_url: `${SB}op/old.webp` },
    ];
    const { paths } = selectNecessary({ draws, operators: [], ...opts });
    expect([...paths.keys()].sort()).toEqual(["op/draft.webp", "op/live.webp", "op/recent.webp"]);
  });

  test("every operator logo moves", () => {
    const { paths } = selectNecessary({
      draws: [],
      operators: [{ id: "o1", logo_url: `${SB}operator-logos/acme.webp` }],
      ...opts,
    });
    expect(paths.get("operator-logos/acme.webp").logos).toEqual(["o1"]);
  });

  test("dead-project, hotlinked, empty and already-moved URLs are not ours to copy", () => {
    const draws = [
      { id: 1, status: "active", image_url: `${DEAD}op/x.webp` },
      { id: 2, status: "active", image_url: "https://operator.co.uk/img.jpg" },
      { id: 3, status: "active", image_url: null },
      { id: 4, status: "active", image_url: `${CDN}op/moved.webp` },
    ];
    const r = selectNecessary({ draws, operators: [], ...opts });
    expect(r.paths.size).toBe(0);
    expect(r.skipped).toEqual({ dead: 1, foreign: 1, empty: 1, expired: 0, alreadyMoved: 1 });
  });

  test("one image shared by several draws is copied once and repoints every row", () => {
    const draws = [
      { id: 1, status: "active", image_url: `${SB}op/shared.webp` },
      { id: 2, status: "active", image_url: `${SB}op/shared.webp` },
    ];
    const { paths } = selectNecessary({ draws, operators: [], ...opts });
    expect(paths.size).toBe(1);
    expect(paths.get("op/shared.webp").draws).toEqual([1, 2]);
  });

  test("a weserv-wrapped Supabase URL is still recognised", () => {
    const wrapped = `https://images.weserv.nl/?url=${encodeURIComponent(`${SB}op/w.webp`)}&w=960`;
    const { paths } = selectNecessary({ draws: [{ id: 1, status: "active", image_url: wrapped }], operators: [], ...opts });
    expect([...paths.keys()]).toEqual(["op/w.webp"]);
  });
});

describe("selectExpired — what the new provider lets go", () => {
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
  test("back to the Supabase copy when one exists, otherwise to null (the category cover)", () => {
    const expire = new Map([["op/had-archive.webp", [1, 2]], ["op/born-on-cdn.webp", [3]]]);
    const plan = planRetention({ expire, supabaseKeys: new Set(["op/had-archive.webp"]), sbPrefix: SB });
    expect(plan).toEqual([
      { id: 1, path: "op/had-archive.webp", newUrl: `${SB}op/had-archive.webp` },
      { id: 2, path: "op/had-archive.webp", newUrl: `${SB}op/had-archive.webp` },
      { id: 3, path: "op/born-on-cdn.webp", newUrl: null },
    ]);
  });

  test("the Supabase URL is encoded the way putObject writes it", () => {
    const plan = planRetention({ expire: new Map([["op/win a car.webp", [1]]]), supabaseKeys: new Set(["op/win a car.webp"]), sbPrefix: SB });
    expect(plan[0].newUrl).toBe(`${SB}op/win%20a%20car.webp`);
  });
});
