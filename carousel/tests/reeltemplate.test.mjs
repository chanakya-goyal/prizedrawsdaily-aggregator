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
