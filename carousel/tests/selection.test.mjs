import { test, expect } from "bun:test";
import { pickBestCategory } from "../select.mjs";

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
