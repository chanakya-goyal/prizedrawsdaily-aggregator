import { test, expect, describe } from "bun:test";
import { pickBestCategory, londonDayBounds } from "../select.mjs";

const draw = (slug, cat, value = 1000) => ({ slug, total_prize_value: value, categories: { slug: cat, name: cat } });
const POOL = [
  draw("car1", "car-draws"), draw("car2", "car-draws"), draw("car3", "car-draws"), draw("car4", "car-draws"),
  draw("lux1", "luxury", 5000), draw("lux2", "luxury", 5000), draw("lux3", "luxury", 5000),
];

test("excludeSlugs removes recently-featured draws before scoring", () => {
  const pick = pickBestCategory(POOL, 3, null, { excludeSlugs: new Set(["lux1", "lux2", "lux3"]) });
  expect(pick.slug).toBe("car-draws"); // luxury left with 0 draws → car wins
});

test("avoidCategory soft-penalises yesterday's category", () => {
  // luxury outscores cars on weight+value normally; the ×0.5 penalty flips it.
  const pick = pickBestCategory(POOL, 3, null, { avoidCategory: "luxury" });
  expect(pick.slug).toBe("car-draws");
});

test("avoidCategory still wins when it is the only qualifier", () => {
  const only = [draw("lux1", "luxury"), draw("lux2", "luxury"), draw("lux3", "luxury")];
  const pick = pickBestCategory(only, 3, null, { avoidCategory: "luxury" });
  expect(pick.slug).toBe("luxury");
});

test("no opts → unchanged behavior", () => {
  const pick = pickBestCategory(POOL, 3);
  expect(pick.slug).toBe("luxury"); // higher weight×value
  expect(pick.draws.length).toBe(3);
});

// ---- the calendar window ---------------------------------------------------------------------
// A rolling floor answers "nothing closing today or tomorrow" only approximately: at 20:03 on a
// Friday, minDays=2 starts the window at 20:03 on Sunday and silently drops every draw closing
// Sunday MORNING, even though Sunday is neither today nor tomorrow. These bounds are what make the
// calendar instruction exact, and the BST offset is the part that goes wrong unnoticed.
describe("londonDayBounds", () => {
  test("a September (BST, UTC+1) day starts at 23:00 UTC the previous day", () => {
    const { start, end } = londonDayBounds("2026-09-21");
    expect(start.toISOString()).toBe("2026-09-20T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-21T22:59:59.999Z");
  });

  test("a January (GMT, UTC+0) day starts at midnight UTC", () => {
    const { start, end } = londonDayBounds("2026-01-15");
    expect(start.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-15T23:59:59.999Z");
  });

  test("the bounds are exactly one day apart and never overlap the neighbours", () => {
    for (const d of ["2026-03-29", "2026-10-25", "2026-06-01", "2026-12-31"]) {
      const { start, end } = londonDayBounds(d);
      expect(end - start).toBe(86399999);
    }
    // Consecutive days abut with no gap and no overlap — a gap would drop draws, an overlap would
    // let a neighbouring day's draw into a window that excluded it.
    const a = londonDayBounds("2026-09-21"), b = londonDayBounds("2026-09-22");
    expect(b.start - a.end).toBe(1);
  });

  test("a whole London day is covered, including its first and last minute", () => {
    const { start, end } = londonDayBounds("2026-09-21");
    const inLondon = (d) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    expect(inLondon(start)).toBe("2026-09-21");
    expect(inLondon(end)).toBe("2026-09-21");
    expect(inLondon(new Date(start.getTime() - 1))).toBe("2026-09-20");
    expect(inLondon(new Date(end.getTime() + 1))).toBe("2026-09-22");
  });
});

// An instant-win POOL is many small prizes behind one headline: its photo is a poster or a collage,
// and on 11 Oct three of five car-deck picks were pools that the visual check then had to reject.
// A single prize with instant wins ADDED after a "+" is still one prize and stays eligible.
import { isPrizePool } from "../select.mjs";
test("isPrizePool: pools out, single prizes with add-on instant wins in", () => {
  for (const t of ["License To Win – £250,000+ in Prizes!", "INSTANT WIN – RANGE ROVER SPORT AND MORE (3)",
                   "Huge Construction Instant Wins – 10,000 Prizes – £500,000 Prize Fund", "Prize Drop *Prize Every Time* #2",
                   "Cash Is King Instant Wins – £250,000 Prize Fund – 5,000 Prizes – ALL CASH"]) {
    expect(isPrizePool({ title: t })).toBe(true);
  }
  for (const t of ["Audi Q2 or £10,000 Cash + 100 x £100 Breeze Cash Instant Wins!!", "Toyota Yaris 1.6T GR Circuit AWD or £18,000 Cash + £15K Instant Wins",
                   "£5,000 Cash + 30 Mystery Instant Wins!", "Win £1000 Tax Free Cash for just 1p!", "Win 2023 Ford Puma ST Performance + £1,000"]) {
    expect(isPrizePool({ title: t })).toBe(false);
  }
});
test("pickBestCategory never puts a pool on the deck", () => {
  const D = (slug, title) => ({ slug, title, categories: { slug: "car-draws", name: "Car Draws" }, total_prize_value: 1000 });
  const pick = pickBestCategory([D("a", "BMW M4"), D("p", "INSTANT WIN – RANGE ROVER AND MORE"), D("b", "Audi RS3"), D("c", "Ford Puma ST")], 3);
  expect(pick.draws.map((d) => d.slug)).toEqual(["a", "b", "c"]);
  expect(pick.pool.map((d) => d.slug)).not.toContain("p");
});
