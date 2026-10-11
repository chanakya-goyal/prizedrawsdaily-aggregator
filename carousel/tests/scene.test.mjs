import { test, expect, describe } from "bun:test";
import { sceneFor, ALL_SCENE_IDS, sceneBack, sceneMotion, sceneRegion, LANES, SURFACES } from "../scene.mjs";
import { CATEGORIES } from "../../lib/parse.mjs";

describe("the scene table cannot drift from the taxonomy", () => {
  // This is the gate that would have caught the shipped bug: config.json themed six categories
  // against eight in the taxonomy, so sports-outdoors and home-garden — 147 draws, 16% of live
  // inventory — fell through to the fallback and rendered as CAR DRAWS.
  test("every taxonomy category has its own scene", () => {
    expect([...ALL_SCENE_IDS].sort()).toEqual([...CATEGORIES].sort());
  });
  for (const slug of CATEGORIES) {
    test(`${slug} resolves to a distinct, non-neutral scene`, () => {
      const s = sceneFor(slug);
      expect(s.id).toBe(slug);
      expect(s.id).not.toBe("neutral");
    });
  }
  test("an unknown slug is PAPER, never another category's scene", () => {
    expect(sceneFor("does-not-exist").id).toBe("neutral");
    expect(sceneFor(undefined).id).toBe("neutral");
    expect(sceneFor(null).id).toBe("neutral");
  });
});

describe("a scene carries no colour and no text", () => {
  for (const slug of CATEGORIES) {
    test(`${slug} emits no palette token and no data-state colour`, () => {
      const s = sceneFor(slug);
      expect(s.tokens).toEqual({});                       // identity is structure, not colour
      const html = sceneBack(s, "reel-9x16", { animate: true });
      // --closing, --verdict and --deadline are DATA STATES. Spending them on decoration
      // devalues the signal the odds layer depends on.
      for (const t of ["--closing", "--verdict", "--deadline", "--dot-hit"]) expect(html).not.toContain(t);
      // A text node inside the scene subtree would break its "no meaning" exemption.
      expect(html).not.toMatch(/>[^<>]*[A-Za-z]{2,}[^<>]*</);
    });
  }
});

describe("motion is closed by construction", () => {
  test("only the reel animates; the stills and the cover are frozen", () => {
    const s = sceneFor("sports-outdoors");
    expect(sceneMotion(s, "reel-9x16")).toContain("@keyframes");
    for (const surf of ["still-4x5", "reel-cover-9x16", "story-9x16"]) expect(sceneMotion(s, surf)).toBe("");
  });
  test("a periodic field travels exactly one period, so frame 0 and the last frame match", () => {
    // sports drifts 90px on a 90px stripe period; car scrolls 45px on a 45px rule pitch.
    expect(sceneFor("sports-outdoors").amplitudePx).toBe(90);
    expect(sceneMotion(sceneFor("sports-outdoors"), "reel-9x16")).toContain("translateX(-90px)");
    expect(sceneFor("car-draws").amplitudePx).toBe(45);
    expect(sceneMotion(sceneFor("car-draws"), "reel-9x16")).toContain("translateY(-45px)");
  });
  test("every discrete scene stays inside the 25px travel cap", () => {
    for (const slug of CATEGORIES) {
      const s = sceneFor(slug);
      if (s.amplitudeClass === "discrete") expect(s.amplitudePx).toBeLessThanOrEqual(25);
      if (s.amplitudeClass === "envelope") expect(s.amplitudePx).toBe(0);
      if (s.loopMs) { expect(s.loopMs).toBeGreaterThanOrEqual(1800); expect(s.loopMs).toBeLessThanOrEqual(6000); }
    }
  });
  test("the brand rail never animates, on any surface", () => {
    // A moving brand mark reads as an error, and the rail is where the mark lives.
    const html = sceneBack(sceneFor("sports-outdoors"), "reel-9x16", { animate: true });
    const boxes = html.split('class="sc-box');
    const rail = boxes.find((b) => b.includes("top:269px"));
    expect(rail).toBeDefined();
    expect(rail).not.toContain("sc-anim");
  });
});

describe("the reel's outer lanes", () => {
  // The reel used to fill the territory outside Meta's safe box with the photograph, stretched
  // edge to edge under object-fit:cover. The photograph now has a plate inside the box, so
  // these two lanes carry ground and its scene texture instead of an unreadable crop.
  const reel = LANES["reel-9x16"];
  test("they cover exactly the territory outside the safe box", () => {
    const above = reel.find((l) => l.y === 0);
    const below = reel.find((l) => l.y === 1152);
    expect(above).toBeTruthy();
    expect(below).toBeTruthy();
    expect(above.y + above.h).toBe(269);          // the safe box's top edge
    expect(below.y).toBe(269 + 883);              // and its bottom
    expect(below.y + below.h).toBe(1920);         // down to the frame
  });
  test("exactly one lane animates, and it is the insert card — never the brand rail", () => {
    // This used to be INFERRED from ground === "paper", so adding any paper lane silently
    // started animating it. A moving brand mark reads as an error, so the lane declares it.
    const anim = reel.filter((l) => l.anim === true);
    expect(anim.length).toBe(1);
    expect(anim[0]).toMatchObject({ y: 661, h: 346 });
    expect(reel.find((l) => l.ground === "rail").anim).toBeUndefined();
  });
  test("the outer lanes carry standing chrome, not dead ground", () => {
    // Left as paper they were 1,037px of blank frame — 54% of it. The Story frames its subject
    // with these exact rects on rail ground; the Reel now does the same, so the two 9:16
    // surfaces read as one product.
    expect(reel.filter((l) => l.ground === "rail").length).toBe(3);
    expect(reel.filter((l) => l.ground === "paper").length).toBe(1);
    const story = LANES["story-9x16"];
    for (const outer of [{ y: 0, h: 269 }, { y: 1152, h: 768 }]) {
      expect(reel.find((l) => l.y === outer.y && l.h === outer.h).ground).toBe("rail");
      expect(story.find((l) => l.y === outer.y && l.h === outer.h).ground).toBe("rail");
    }
  });
});

describe("surfaces and lanes", () => {
  test("the reel cover carries the rail lane only", () => {
    // buildCoverHtml renders no insert card, so declaring a card lane made the loop assertion
    // read as vacuous rather than as passing.
    expect(LANES["reel-cover-9x16"].length).toBe(1);
    expect(LANES["reel-9x16"].length).toBe(4);
  });
  test("the four 4:5 roles each get a region and nothing else does", () => {
    for (const r of ["cover", "count", "draw", "closing"]) expect(sceneRegion(r)).not.toBeNull();
    expect(sceneRegion("reel-card")).toBeNull();
  });
  test("every still region resolves to one flat tone, so no region edge is visible", () => {
    const html = sceneBack(sceneFor("sports-outdoors"), "still-4x5", { role: "cover" });
    expect(html).toContain("var(--scene-tone)");
    expect(html).not.toContain("rgba(20,22,26");
  });
  test("all four surfaces are declared", () => {
    expect(Object.keys(SURFACES).sort()).toEqual(["reel-9x16", "reel-cover-9x16", "still-4x5", "story-9x16"]);
  });
});
