// carousel/tests/story.test.mjs — contract test for the daily countdown STORY
// (mirrors reeltemplate.test.mjs's style/assertions; spec §4.5 — API stories
// carry NO tappable link, reach/warmth only).
import { test, expect } from "bun:test";
import { buildStoryTimeline } from "../story.mjs";

const draw = {
  slug: "land-rover-discovery",
  title: "Win this Land Rover Discovery",
  grand_prize: "Land Rover Discovery",
  prize_description: "A brand new Land Rover Discovery could be yours for just 5p a ticket.",
  ticket_price: 0.05,
  total_entries: 50000,
  image_url: "https://example.com/lr.jpg",
  draw_date: "2026-07-03T19:00:00.000Z",
};
const audioMeta = { bpm: 86, firstBeatOffsetMs: 561, dropMs: null };
const nowIso = "2026-07-03T12:00:00.000Z";

test("contract: seek runtime, ready gate, countdown, stamp, duration, footer", () => {
  const t = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso });
  expect(t.html).toContain("__seek");
  expect(t.html).toContain("__ready");
  expect(t.html).toContain("data-countdown");
  expect(t.html).toContain("stamp-in");
  expect(t.html).toContain("18+ · UK ONLY · PLAY RESPONSIBLY");
  expect(t.durationMs).toBe(12000);
});

test("no tappable link — 'link in bio' text only, never an <a> tag", () => {
  const t = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso });
  expect(t.html.toLowerCase()).toContain("link in bio");
  expect(t.html).toContain("@prizedrawsdaily");
  expect(t.html).not.toMatch(/<a[\s>]/i);
});

test("card breathes 1.00→1.02 on the CARD layer; raw photo never scale-animated", () => {
  const t = buildStoryTimeline({ draw, hero: "data:image/png;base64,AAAA", theme: "default", audioMeta, nowIso });
  expect(t.html).toMatch(/st-breathe[\s\S]*?scale\(1\.02\)/);
  expect(t.html).not.toMatch(/class="photo"[^>]*style="[^"]*scale/);
});

test("flip-clock carries the real close time and build-time now (deterministic seek)", () => {
  const t = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso });
  expect(t.html).toContain(`data-countdown="${Date.parse(draw.draw_date)}"`);
  expect(t.html).toContain(`data-now="${nowIso}"`);
});

test("stamp lands at ~10s", () => {
  const t = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso });
  expect(t.stampTimesMs.length).toBeGreaterThan(0);
  expect(t.stampTimesMs[0]).toBeGreaterThanOrEqual(9000);
  expect(t.stampTimesMs[0]).toBeLessThanOrEqual(10500);
});

test("deterministic: two builds are byte-identical (no Date.now()/Math.random())", () => {
  const a = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso }).html;
  const b = buildStoryTimeline({ draw, hero: null, theme: "default", audioMeta, nowIso }).html;
  expect(a).toBe(b);
});

test("throws without a draw", () => {
  expect(() => buildStoryTimeline({ draw: null, hero: null, theme: "default", audioMeta, nowIso })).toThrow();
});
