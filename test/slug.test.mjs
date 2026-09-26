import { test, expect, describe } from "bun:test";
import { uniqueSlug } from "../lib/slug.mjs";

// 2026-09-27: a relisted long-titled prize (Trade Tool Giveaways' Ninja Crispi air fryer) hung
// the whole JSON sweep at 100% CPU. The base slug was already 120 chars, so `${base}-2` sliced
// back to 120 WAS the base — still taken — and the collision loop never ended.
describe("uniqueSlug", () => {
  const long = "a".repeat(120);

  test("a free slug is returned unchanged", () => {
    expect(uniqueSlug("ninja-trade-tool-giveaways", new Set())).toBe("ninja-trade-tool-giveaways");
  });

  test("a taken short slug gets -2, then -3", () => {
    expect(uniqueSlug("x", new Set(["x"]))).toBe("x-2");
    expect(uniqueSlug("x", new Set(["x", "x-2"]))).toBe("x-3");
  });

  test("a taken slug already at the length cap terminates and keeps the suffix", () => {
    const s = uniqueSlug(long, new Set([long]));
    expect(s).not.toBe(long);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith("-2")).toBe(true);
  });

  test("many collisions at the cap stay unique and within the cap", () => {
    const taken = new Set([long]);
    for (let i = 0; i < 15; i++) {
      const s = uniqueSlug(long, taken);
      expect(taken.has(s)).toBe(false);
      expect(s.length).toBeLessThanOrEqual(120);
      taken.add(s);
    }
  });
});
