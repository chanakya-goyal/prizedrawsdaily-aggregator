import { test, expect, describe } from "bun:test";
import { CFG, GLOBAL, catCfg, drawsPerDeck, configProblems, CATEGORY_KEYS } from "../config.mjs";
import { ALL_SCENE_IDS } from "../scene.mjs";
import { CATEGORIES } from "../../lib/parse.mjs";
import { pickAudio } from "../beat.mjs";

// THIS TEST IS THE REASON THE DRIFT HAPPENED, so it is rewritten from an ENUMERATION into a
// DERIVATION. The old version hardcoded the six category slugs, which meant the taxonomy could
// grow to eight — 147 draws, 16% of live inventory — and nothing here could fail. It also
// asserted `theme` and `particles`, which are the two keys being retired.
//
// Every assertion below derives its expectation from the taxonomy or from the file itself, so a
// ninth category cannot be added to lib/parse.mjs without this going red until config.json
// catches up. That couples the scraper's taxonomy to the social pipeline on purpose: the
// coupling already existed, it was just invisible.

describe("the category set cannot drift from the taxonomy", () => {
  test("config.json, scene.mjs and lib/parse.mjs agree exactly", () => {
    const cfgSlugs = Object.keys(CFG.categories).sort();
    expect(cfgSlugs).toEqual([...CATEGORIES].sort());
    expect(cfgSlugs).toEqual([...ALL_SCENE_IDS].sort());
  });
  test("configProblems() reports nothing", () => {
    expect(configProblems()).toEqual([]);
  });
});

describe("every entry carries the full six-key identity, and only those six", () => {
  // Exact key set, not a presence check. A PARTIAL entry used to be indistinguishable from a
  // complete one because catCfg merged a fallback over it, so a category could silently inherit
  // the fallback's weight and an Infinity value-line floor. This is the load-bearing assertion.
  for (const slug of CATEGORIES) {
    test(slug, () => {
      const c = CFG.categories[slug];
      expect(c).toBeDefined();
      expect(Object.keys(c).sort()).toEqual([...CATEGORY_KEYS].sort());
      expect(c.name).toBeTruthy();
      expect(c.seoKeyword).toBeTruthy();
      expect(c.visualWeight).toBeGreaterThan(0);
      expect(c.visualWeight).toBeLessThanOrEqual(1);
      expect(c.valueLineMin).toBeGreaterThanOrEqual(1000);
      expect(Array.isArray(c.hashtags)).toBe(true);
    });
  }
  test("the retired keys are gone from every entry", () => {
    // theme belonged to the dark palette, particles to the ember fields, hook to the six
    // "WIN A DREAM CAR" constants the cover headline now generates from real figures.
    for (const [slug, c] of Object.entries(CFG.categories))
      for (const dead of ["theme", "particles", "hook"])
        expect(c[dead], `${slug}.${dead}`).toBeUndefined();
  });
  test("global carries no hook constant either", () => {
    expect(GLOBAL.hook).toBeUndefined();
  });
});

describe("hashtags", () => {
  test("every tag is lowercase alphanumeric and none collides with a global fixed tag", () => {
    for (const [slug, c] of Object.entries(CFG.categories))
      for (const h of c.hashtags) {
        expect(h, `${slug}: ${h}`).toMatch(/^#[a-z0-9]+$/);
        expect(GLOBAL.fixedHashtags, `${slug}: ${h}`).not.toContain(h);
      }
  });
});

describe("audio", () => {
  // The Reel throws at render time on an unknown mood, which is a late and expensive place to
  // find a typo. This is a pure static join against the shipped manifest.
  for (const slug of CATEGORIES) {
    test(`${slug} -> ${CFG.categories[slug].audioMood}`, async () => {
      const t = await pickAudio(CFG.categories[slug].audioMood);
      expect(t.bpm).toBeGreaterThan(0);
      expect(t.file).toMatch(/\.mp3$/);
    });
  }
});

describe("the unknown-slug fallback is a tripwire, not a default", () => {
  test("weight 0, so the picker can never choose it", () => {
    // It used to be 0.6 — a real weight — and because the adequacy term dominates the score,
    // an unconfigured bucket could win a whole deck.
    const c = catCfg("mystery-boxes");
    expect(c.visualWeight).toBe(0);
    expect(c.valueLineMin).toBe(Infinity);
    expect(c.name).toBe("mystery-boxes");
  });
  test("a known slug is returned verbatim, with nothing merged over it", () => {
    const c = catCfg("luxury");
    expect(c).toBe(CFG.categories.luxury);
    expect(Object.keys(c).sort()).toEqual([...CATEGORY_KEYS].sort());
  });
});

describe("deck size", () => {
  test("is an authored constant at or above the four-draw floor", () => {
    expect(drawsPerDeck()).toBe(GLOBAL.drawsPerDeck);
    expect(drawsPerDeck()).toBeGreaterThanOrEqual(4);
  });
});
