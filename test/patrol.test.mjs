import { test, expect, describe } from "bun:test";
import { weekParity, inSample } from "../patrol.mjs";

describe("patrol rotation — stateless half-catalogue per week", () => {
  test("parity flips week to week", () => {
    expect(weekParity(new Date("2026-08-23"))).not.toBe(weekParity(new Date("2026-08-30")));
  });
  test("a given id is sampled exactly once per fortnight", () => {
    const id = "3247f98b-762c-4a46-b144-9b2a928f5f53";
    expect(inSample(id, 0) !== inSample(id, 1)).toBe(true);
  });
  test("roughly half of ids fall in each parity", () => {
    const n = 1000, ids = Array.from({ length: n }, (_, i) => `id-${i}-${i * 7919}`);
    const a = ids.filter((x) => inSample(x, 0)).length;
    expect(a).toBeGreaterThan(n * 0.35); expect(a).toBeLessThan(n * 0.65);
  });
});
