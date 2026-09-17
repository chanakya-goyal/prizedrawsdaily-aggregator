import { test, expect, describe } from "bun:test";
import { buildReelTimeline, pickDuration, planSegments, CHROME, CHROME_COLLAPSED, CHROME_EXPANDED, SAFE, L_NOTCH, loopClosureFrames } from "../reel-template.mjs";
import { sceneFor } from "../scene.mjs";

// The old Reel was a dark, orange, particle-and-glow montage with a price stamp, a flip clock
// and camera shake — and every element of it sat OUTSIDE Meta's safe box, including the card
// that was supposed to be inside it. So these tests are mostly about geometry and about the
// loop, because those are the two things that were silently wrong before.

const mk = (n, over = {}) => ({
  slug: `d${n}`, title: `Win this Car ${n}`, grand_prize: `Car ${n}`,
  ticket_price: 0.5, total_entries: 100000 + n,
  draw_date: new Date(Date.now() + 36e5 * (20 + n * 10)).toISOString(),
  entry_url: "https://operator.test/x", image_url: `https://cdn.test/${n}.jpg`,
  figures_checked_at: new Date().toISOString(), ...over,
});
const build = (slug = "car-draws", draws = [mk(1), mk(2), mk(3)], audioMeta = { bpm: 112, firstBeatOffsetMs: 202 }) =>
  buildReelTimeline({ sel: { slug, draws }, slides: [], heroes: {}, audioMeta });

// Assert on EXTRACTS, never on the whole page. It inlines ~1.5MB of base64 woff2, so a failed
// toContain against the full string dumps a megabyte of font data instead of the mismatch.
// A keyframe body contains braces of its own, so it is split rather than regexed.
const keyframes = (html, kind) => {
  const out = {};
  for (const chunk of html.split("@keyframes ").slice(1)) {
    const name = chunk.slice(0, chunk.indexOf("{"));
    if (!name.startsWith(kind + "-")) continue;
    const body = chunk.slice(chunk.indexOf("{") + 1, chunk.indexOf("}}") + 1);
    out[name] = body;
  }
  return out;
};
const shorthands = (html) => [...html.matchAll(/animation:((?:[^";}]|\([^)]*\))+)/g)].map((m) => m[1].trim());

describe("chrome geometry is the spec's, to the pixel", () => {
  test("collapsed is the rail plus the band; expanded adds the card", () => {
    expect(CHROME_COLLAPSED).toBe(261);
    expect(CHROME_EXPANDED).toBe(607);
    expect(CHROME.rail).toEqual({ y: 269, h: 116 });
    expect(CHROME.card).toEqual({ y: 661, h: 346 });
    expect(CHROME.band).toEqual({ y: 1007, h: 145 });
  });
  test("the rail starts on the safe box's top edge and the band ends on its bottom", () => {
    expect(CHROME.rail.y).toBe(SAFE.y);
    expect(CHROME.band.y + CHROME.band.h).toBe(SAFE.y + SAFE.h);
  });
  test("the card grows from a floor flush with the band", () => {
    expect(CHROME.card.y + CHROME.card.h).toBe(CHROME.band.y);
  });
  test("the guaranteed clear photograph window is 276px", () => {
    // Between the rail and the top of the expanded insert. Not a lane, and nothing may paint in it.
    expect(CHROME.card.y - (CHROME.rail.y + CHROME.rail.h)).toBe(276);
  });
  test("no chrome reaches into the L-notch", () => {
    for (const c of Object.values(CHROME)) expect(c.y + c.h).toBeLessThanOrEqual(L_NOTCH.y);
  });
});

describe("duration is chosen so the scene returns to phase 0", () => {
  // A scene loops every 1800-6000ms. A reel that is not a whole multiple of it ends mid-drift,
  // the wrap frame differs from frame 0, and the loop visibly jumps.
  for (const slug of ["car-draws", "sports-outdoors", "luxury", "cash-prizes", "home-garden"]) {
    test(slug, () => {
      const loopMs = sceneFor(slug).loopMs;
      const d = pickDuration({ loopMs });
      expect(d % loopMs).toBe(0);
      expect(d / loopMs).toBeGreaterThanOrEqual(2);
      expect(d).toBeGreaterThan(9000);
      expect(d).toBeLessThan(21000);
    });
  }
  test("a motionless scene just takes the target", () => expect(pickDuration({ loopMs: 0 })).toBe(15000));
});

describe("the loop closes by construction", () => {
  test("the first segment starts at exactly 0, never on the nearest beat", () => {
    // Quantising it pushed the opening cut to the first downbeat — 202ms on a 112 BPM bed —
    // which left the opening frames with no photograph at all, and broke the loop with it.
    const segs = planSegments({ durationMs: 14400, drawCount: 3, grid: [202, 737, 1273] });
    expect(segs[0].a).toBe(0);
  });
  test("no cut is emitted at t=0", () => expect(build().cutTimesMs).not.toContain(0));
  test("every card's keyframes start and end collapsed", () => {
    // One animation per element across the whole timeline. The first version used TWO on the
    // same property — open delayed, shut delayed, both fill-mode `both` — and the backwards fill
    // of the LAST one won, so every card was already open at t=0.
    const cards = keyframes(build().html, "card");
    expect(Object.keys(cards).length).toBe(build().drawsUsed);
    for (const [name, body] of Object.entries(cards)) {
      expect(body, name).toMatch(/^0%,[\d.]+%\{height:0\}/);       // collapsed at the start
      expect(body, name).toMatch(/%,100%\{height:0\}$/);            // and at the end
      expect(body, name).toContain("{height:346px}");                // and open in between
    }
  });
  test("exactly one animation is declared per element", () => {
    // A second animation on the same property is what caused the fill-mode bug. Commas inside
    // cubic-bezier(...) are legitimate, so what is asserted is that each shorthand names exactly
    // one animation and carries exactly one fill-mode.
    const sh = shorthands(build().html).filter((a) => /^(shot|card|band)-\d+ /.test(a));
    expect(sh.length).toBe(build().drawsUsed * 3);
    for (const a of sh) {
      expect(a.match(/\bboth\b/g).length, a).toBe(1);
      expect(a.match(/\d+ms/g).length, a).toBe(2);                   // duration and delay, nothing more
    }
  });
  test("segment 0 owns both ends of the timeline, so there is no duplicated home shot", () => {
    const html = build().html;
    const shots = (html.match(/class="shot"/g) || []).length;
    expect(shots).toBe(build().drawsUsed);          // no extra return element
    const s0 = keyframes(html, "shot")["shot-0"];
    expect(s0).toMatch(/^0%,[\d.]+%\{opacity:1\}/);                 // visible from the very start
    expect(s0).toMatch(/%,100%\{opacity:1\}$/);                     // and again at the very end
    // and away in the middle, which is what makes it a return rather than a permanent overlay
    expect(s0).toContain("{opacity:0}");
  });
  test("the wrap point, not the last frame, is what closure means", () => {
    const lc = loopClosureFrames(14400);
    expect(lc.frames).toBe(432);
    expect(lc.lastMs).toBe(14367);                  // one frame short of the duration
    expect(lc.lastMs).toBeLessThan(14400);
  });
});

describe("what the frame carries", () => {
  test("the cap is the hero, with its eyebrow and qualifier", () => {
    const h = build().html;
    expect(h).toContain("TICKET CAP");
    expect(h).toContain("AT SELL-OUT");
    expect(h).toMatch(/class="figure">[\d,]+</);
  });
  test("the prize name carries the CAP 8.17 claim attribute", () => expect(build().html).toContain('data-pdd-claim="prize-name"'));
  test("it declares a draw-carrying role", () => expect(build().html).toContain('data-pdd-role="reel-card"'));
  test("all three conditions lines render per draw", () => {
    const h = build().html;
    expect((h.match(/class="l l1/g) || []).length).toBe(build().drawsUsed);
    expect(h).toContain("Free-entry route");
  });
  test("the read-at stamp comes from stored provenance, never a constant", () => {
    expect(build().stampText).toMatch(/^READ \d{2}:\d{2}$/);
    // No provenance, no stamp. A false provenance claim is worse than none.
    expect(build("car-draws", [mk(1, { figures_checked_at: null })]).stampText).toBe("");
  });
  test("none of the retired furniture survives", () => {
    // Search the MARKUP, not the page: base64 font data contains every short ASCII string you
    // could think to look for, so "flip" and "vign" both match inside it.
    const markup = build().html.replace(/<style>[\s\S]*?<\/style>/g, "");
    for (const dead of ["PLAY RESPONSIBLY", "data-theme", "p-embers", "stamp-ring", "vign", "glow"]) {
      expect(markup, dead).not.toContain(dead);
    }
  });
});

describe("refusals", () => {
  test("a draw with no cap cannot carry the device, so a reel of them is refused", () => {
    expect(() => build("car-draws", [mk(1, { total_entries: null })])).toThrow(/ticket cap and a photograph/);
  });
  test("a draw with no photograph is refused for the same reason", () => {
    expect(() => build("car-draws", [mk(1, { image_url: null })])).toThrow(/ticket cap and a photograph/);
  });
  test("a deck too thin for the insert cycle still renders, with fewer draws", () => {
    // Each draw needs room to open, state its numbers and close; below that the insert is a
    // flicker rather than a beat, so the count is capped rather than the reel refused.
    const tl = build("car-draws", [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8)]);
    expect(tl.drawsUsed).toBeLessThanOrEqual(5);
    expect(tl.drawsUsed).toBeGreaterThanOrEqual(3);
  });
});
