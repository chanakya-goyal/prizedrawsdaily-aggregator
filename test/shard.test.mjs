// The one property that matters: the shards must PARTITION the roster. An operator that lands
// in no shard is simply never scraped again, and the only symptom is one more name on the
// silent list — the same silent-inventory-loss failure as a method no workflow claims.
import { test, expect, describe } from "bun:test";
import { shardOf, shardConfig, shardedPublishCap } from "../lib/shard.mjs";

const roster = Array.from({ length: 307 }, (_, i) => ({ slug: `op-${i}` }));

describe("shardOf — every operator in exactly one shard", () => {
  for (const count of [1, 2, 3, 4, 5, 8, 16]) {
    test(`partitions cleanly into ${count}`, () => {
      const shards = Array.from({ length: count }, (_, i) => shardOf(roster, i, count));
      const seen = shards.flat().map((o) => o.slug);
      expect(seen.length).toBe(roster.length);                    // none lost
      expect(new Set(seen).size).toBe(roster.length);             // none duplicated
      expect([...seen].sort()).toEqual(roster.map((o) => o.slug).sort());
    });
  }

  test("shards stay within one operator of each other in size", () => {
    const sizes = Array.from({ length: 7 }, (_, i) => shardOf(roster, i, 7).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test("count 1 is the whole roster, unchanged", () => {
    expect(shardOf(roster, 0, 1)).toHaveLength(roster.length);
  });

  test("round-robin, not contiguous slices — adjacent entries are added together and look alike", () => {
    expect(shardOf([0, 1, 2, 3, 4, 5], 0, 2)).toEqual([0, 2, 4]);
    expect(shardOf([0, 1, 2, 3, 4, 5], 1, 2)).toEqual([1, 3, 5]);
  });

  test("a nonsense index is clamped, never allowed to select nothing", () => {
    expect(shardOf(roster, 9, 3).length).toBeGreaterThan(0);
    expect(shardOf(roster, -1, 3).length).toBeGreaterThan(0);
  });
});

describe("shardConfig — a workflow typo must not take out a scrape", () => {
  test("defaults to the whole roster", () => {
    expect(shardConfig({})).toEqual({ index: 0, count: 1 });
  });
  test("reads a valid pair", () => {
    expect(shardConfig({ SHARD_INDEX: "2", SHARD_COUNT: "4" })).toEqual({ index: 2, count: 4 });
  });
  test("clamps an out-of-range index rather than throwing", () => {
    expect(shardConfig({ SHARD_INDEX: "9", SHARD_COUNT: "3" })).toEqual({ index: 2, count: 3 });
  });
  test("garbage falls back to a single shard", () => {
    expect(shardConfig({ SHARD_COUNT: "banana" })).toEqual({ index: 0, count: 1 });
    expect(shardConfig({ SHARD_COUNT: "0" })).toEqual({ index: 0, count: 1 });
    expect(shardConfig({ SHARD_COUNT: "-4" })).toEqual({ index: 0, count: 1 });
  });
});

describe("shardedPublishCap — N shards must not publish N times the budget", () => {
  test("divides the per-process cap across concurrent shards", () => {
    // AUTO_PUBLISH_MAX is counted per process, so 4 shards each honouring 12 would put 48 rows
    // live against a budget of 12.
    expect(shardedPublishCap(12, 4)).toBe(3);
    expect(shardedPublishCap(50, 5)).toBe(10);
  });
  test("one shard is unchanged", () => {
    expect(shardedPublishCap(14, 1)).toBe(14);
  });
  test("never rounds down to zero — that would switch publishing off silently", () => {
    expect(shardedPublishCap(3, 8)).toBe(1);
  });
  test("leaves a disabled cap alone", () => {
    expect(shardedPublishCap(0, 4)).toBe(0);
  });
});
