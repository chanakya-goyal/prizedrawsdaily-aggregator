// carousel/tests/reeltemplate.test.mjs
import { test, expect } from "bun:test";
import { buildReelTimeline, stampHtml, SEEK_RUNTIME } from "../reel-template.mjs";

const sel = { slug: "car-draws", name: "Car Draws", seoKeyword: "UK car competitions" };
const slides = [
  { title: "Land Rover Discovery", price: "5p", closes: "CLOSES TONIGHT", slug: "lr" },
  { title: "Harley Breakout", price: "£8.97", closes: "CLOSES TONIGHT", slug: "hd", cashAlt: "£15,000 TAX-FREE CASH" },
];
const heroes = { lr: null, hd: null };
const audio = { bpm: 120, firstBeatOffsetMs: 0, dropMs: 4000 };

for (const arm of ["A", "B", "C"]) {
  test(`arm ${arm}: contract elements present`, () => {
    const t = buildReelTimeline({ sel, slides, heroes, arm, audioMeta: audio });
    expect(t.html).toContain("__seek");
    expect(t.html).toContain("__ready");
    expect(t.html).toContain("18+ · UK ONLY · PLAY RESPONSIBLY");
    expect(t.html).toContain("stamp-in");            // signature keyframes
    expect(t.html).toContain("stamp-out");           // loop outro
    expect(t.html).not.toMatch(/class="photo[^"]*"[^>]*style="[^"]*scale/); // photos never scale-animated
    expect(t.stampTimesMs.length).toBeGreaterThan(0);
    expect(t.durationMs).toBeGreaterThanOrEqual(3000);
  });
}

test("arm durations", () => {
  const a = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  const b = buildReelTimeline({ sel, slides, heroes, arm: "B", audioMeta: audio });
  expect(a.durationMs).toBeGreaterThanOrEqual(12000);
  expect(a.durationMs).toBeLessThanOrEqual(18000);
  expect(b.durationMs).toBeLessThanOrEqual(8000);
});

test("cuts are beat-quantized", () => {
  const t = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  for (const c of t.cutTimesMs) expect(c % 500).toBe(0); // 120bpm, offset 0 → beats every 500ms
});

test("deterministic output", () => {
  const h1 = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio }).html;
  const h2 = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio }).html;
  expect(h1).toBe(h2);
});

test("stampHtml carries the text", () => {
  expect(stampHtml("JUST 5P A TICKET")).toContain("JUST 5P A TICKET");
  expect(SEEK_RUNTIME).toContain("getAnimations");
});

// ---- motion v2 (hype edit pass) ----
for (const arm of ["A", "B", "C"]) {
  test(`arm ${arm} v2: cut impact kit present (flash + streaks + shake + punch-in per cut)`, () => {
    const t = buildReelTimeline({ sel, slides, heroes, arm, audioMeta: audio });
    const bursts = (t.html.match(/class="burst"/g) || []).length;
    const flashes = (t.html.match(/class="cutflash"/g) || []).length;
    expect(bursts).toBeGreaterThanOrEqual(t.cutTimesMs.length);   // ≥1 streak burst per cut
    expect(flashes).toBeGreaterThanOrEqual(t.cutTimesMs.length);  // ≥1 accent flash per cut
    expect(t.html).toContain("rl-punchin");                        // scene-wrapper punch-in
    expect(t.html).toContain("rl-shakes");                         // merged camera-shake track
    expect(t.html).toContain('class="pbar"');                      // top progress bar
    expect(t.html).toContain("rl-beatpulse");                      // beat pulse keyframes
    expect(t.html).toContain('class="lsweep"');                    // looping light sweep
    expect(t.html).toContain('class="hookdark"');                  // darkened hook open
    expect(t.html).toContain('class="simp"');                      // stamp-landing spark burst
  });
}

test("v2: hook interrupt shows the featured price for single-prize arm B", () => {
  const t = buildReelTimeline({ sel, slides, heroes, arm: "B", audioMeta: audio });
  expect(t.html).toContain("5P?!"); // slides[0] IS the cheapest here, and IS the featured prize
});

// user-reported bug: hook showed the globally-cheapest price ("£1.49?!") while the
// Reel actually featured a different, pricier single prize ("£6.97") — arm B/C only
// ever render slides[0] ("top"), so the hook must use slides[0].price, not min(all).
const mismatch = [
  { title: "Harley Breakout", price: "£6.97", closes: "CLOSES TONIGHT", slug: "hd" },
  { title: "Land Rover Discovery", price: "£1.49", closes: "CLOSES TONIGHT", slug: "lr" },
];
const mismatchHeroes = { hd: null, lr: null };

for (const arm of ["B", "C"]) {
  test(`v2: arm ${arm} hook price = the FEATURED prize (slides[0]), not the cheapest across all slides`, () => {
    const t = buildReelTimeline({ sel, slides: mismatch, heroes: mismatchHeroes, arm, audioMeta: audio });
    expect(t.html).toContain("£6.97?!");     // slides[0]'s price, in the hook
    expect(t.html).not.toContain("£1.49");   // the unfeatured cheaper prize never appears
    expect(t.html).not.toContain(">FROM<");  // single prize on screen — no "FROM" qualifier needed
  });
}

test("v2: arm A hook contextualizes the cheapest price with FROM (multi-prize entry point)", () => {
  const t = buildReelTimeline({ sel, slides: mismatch, heroes: mismatchHeroes, arm: "A", audioMeta: audio });
  expect(t.html).toContain("£1.49?!");  // cheapest across the whole multi-prize selection
  expect(t.html).toContain(">FROM<");   // unambiguous: an entry point, not the one prize on screen
});

test("v2: hook fallback never shows an unlabeled/mismatched bare number", () => {
  const noPriceTop = [
    { title: "Mystery Prize", closes: "CLOSES TONIGHT", slug: "mp" }, // no price at all
    { title: "Harley Breakout", price: "£6.97", closes: "CLOSES TONIGHT", slug: "hd" },
  ];
  const h = { mp: null, hd: null };
  // arm B: top has no price → falls back to the cheapest AVAILABLE price, qualified with FROM
  const b = buildReelTimeline({ sel, slides: noPriceTop, heroes: h, arm: "B", audioMeta: audio });
  expect(b.html).toContain("£6.97?!");
  expect(b.html).toContain(">FROM<");

  // no prices anywhere → the odds/WIN?! fallback, never a bare number
  const none = [{ title: "Mystery Prize", closes: "CLOSES TONIGHT", slug: "mp" }];
  const c = buildReelTimeline({ sel, slides: none, heroes: { mp: null }, arm: "C", audioMeta: audio });
  expect(c.html).toContain("WIN?!");
});

test("v2: urgency chip only when closes label says tonight/tomorrow", () => {
  const yes = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  expect(yes.html).toContain('class="urgechip"'); // slides close TONIGHT
  const no = buildReelTimeline({
    sel,
    slides: [{ title: "Land Rover Discovery", price: "5p", closes: "CLOSES FRI 10 JUL", slug: "lr" }],
    heroes, arm: "A", audioMeta: audio,
  });
  expect(no.html).not.toContain('class="urgechip"');
});

test("v2: arm A scene holds are ≤3s and still beat-quantized", () => {
  const t = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  const bounds = [0, ...t.cutTimesMs, t.durationMs];
  for (let i = 1; i < bounds.length; i++) {
    expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    expect(bounds[i] - bounds[i - 1]).toBeLessThanOrEqual(3000);
  }
});

test("v2: photo layers still carry no scale animation (blur fill only)", () => {
  for (const arm of ["A", "B", "C"]) {
    const t = buildReelTimeline({ sel, slides, heroes, arm, audioMeta: audio });
    // the sharp photo wrapper never gets an inline animation style at all
    expect(t.html).not.toMatch(/class="photo[^"]*"\s+style=/);
    // blur-fill zoom lives on .hf-bg/.cbg wrappers, not the photo
    expect(t.html).not.toMatch(/class="photo[^"]*"[^>]*rl-(bgzoom|cbgzoom)/);
  }
});

test("arm B: ampersand titles are escaped exactly once", () => {
  const t = buildReelTimeline({
    sel: { slug: "car-draws", name: "Car Draws", seoKeyword: "UK car competitions" },
    slides: [{ title: "M&S <Hamper>", price: "5p", closes: "CLOSES TONIGHT", slug: "ms" }],
    heroes: { ms: null },
    arm: "B",
    audioMeta: { bpm: 120, firstBeatOffsetMs: 0, dropMs: 4000 },
  });
  expect(t.html).not.toContain("&amp;amp;");   // double-escape tell
  expect(t.html).not.toContain("&AMP;");
  expect(t.html).toContain("M&amp;S");          // single correct escape survives (any case)
});
