import { test, expect } from "bun:test";
import { CFG, catCfg, themeOf, workDir, GLOBAL } from "../config.mjs";

test("all six categories present with full identity", () => {
  for (const slug of ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury", "collectibles"]) {
    const c = catCfg(slug);
    expect(c.name).toBeTruthy();
    expect(c.visualWeight).toBeGreaterThan(0);
    expect(c.theme).toBeTruthy();
    expect(c.hashtags.length).toBe(2);
    expect(c.hook).toMatch(/^WIN /);
    expect(["embers", "golddust", "fireflies", "holo", "none"]).toContain(c.particles.type);
    expect(c.valueLineMin).toBeGreaterThan(0);
    expect(["driving", "synth", "elegant", "win", "warm", "pop"]).toContain(c.audioMood);
  }
});

test("unknown slug falls back safely", () => {
  const c = catCfg("mystery-boxes");
  expect(c.visualWeight).toBe(0.6);
  expect(c.theme).toBe("default");
  expect(c.hashtags).toEqual(["#ukraffle", "#livedraws"]);
  expect(c.valueLineMin).toBe(Infinity);
});

test("live themes preserved", () => {
  expect(themeOf("car-draws")).toBe("default");
  expect(themeOf("tech-giveaways")).toBe("tech");
});

test("workDir expands ~ and honours PDD_DIR", () => {
  expect(workDir()).not.toContain("~");
  process.env.PDD_DIR = "/tmp/pdd-test";
  expect(workDir()).toBe("/tmp/pdd-test");
  delete process.env.PDD_DIR;
});

test("global ids present", () => {
  expect(GLOBAL.igUserId).toBe("27332554436394910");
  expect(GLOBAL.fbPageId).toBe("1106603652538117");
  expect(CFG.categories["luxury"]).toBeTruthy();
});
