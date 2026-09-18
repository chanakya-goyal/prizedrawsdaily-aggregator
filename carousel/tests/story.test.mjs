import { test, expect, describe } from "bun:test";
import { BANDS, GUTTER, SAFE, L_NOTCH, bandRects, assertBands, fitPrize, buildStoryHtml } from "../story.mjs";

// The Story is a STILL now, not a twelve-second timeline. It is delivered to existing followers
// with a 24h life, sits outside the Reels chaining system, has no length cohort and no
// watch-duration head, and does not require audio — so the frame loop, the ffmpeg encode and the
// audio mux were all cost with nothing ranking them.
//
// What replaced them is a band table that closes EXACTLY on Meta's safe box, which is why these
// tests exist: a table with no slack breaks silently the first time one height changes.

const draw = {
  slug: "suzuki-gsx-r", title: "Win this Suzuki GSX-R", grand_prize: "Suzuki GSX-R",
  ticket_price: 1.79, total_entries: 5495, draw_date: new Date(Date.now() + 36e5 * 20).toISOString(),
  entry_url: "https://thegiveawayguys.co.uk/product/suzuki", figures_checked_at: new Date().toISOString(),
};
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const markup = (over = {}) =>
  buildStoryHtml({ draw: { ...draw, ...over }, hero: PIXEL, stamp: "READ FROM OPERATORS 09:04 · 18 SEP", categorySlug: "car-draws" })
    .replace(/<style>[\s\S]*?<\/style>/g, "");

describe("the band table closes exactly on Meta's safe box", () => {
  test("five heights plus four gutters equal the 883px box", () => {
    const sum = BANDS.reduce((a, b) => a + b.h, 0);
    expect(sum).toBe(863);
    expect(sum + (BANDS.length - 1) * GUTTER).toBe(SAFE.h);
    expect(SAFE).toEqual({ x: 65, y: 269, w: 950, h: 883 });
  });
  test("the chain lands flush on the bottom edge", () => {
    expect(bandRects().__end).toBe(SAFE.y + SAFE.h);
    expect(bandRects().__end).toBe(1152);
  });
  test("assertBands() reports nothing", () => expect(assertBands()).toEqual([]));
  test("every band is inside the box and clear of the L-notch", () => {
    for (const b of BANDS) {
      const r = bandRects()[b.id];
      expect(r.y).toBeGreaterThanOrEqual(SAFE.y);
      expect(r.bottom).toBeLessThanOrEqual(SAFE.y + SAFE.h);
      expect(r.bottom).toBeLessThanOrEqual(L_NOTCH.y);
    }
  });
  test("the positions are the spec's, to the pixel", () => {
    const r = bandRects();
    expect([r.dateline.y, r.prize.y, r.photo.y, r.odds.y, r.conditions.y]).toEqual([269, 329, 479, 757, 1007]);
  });
});

describe("the prize name", () => {
  test("a short title takes the top step", () => expect(fitPrize("Suzuki GSX-R").px).toBe(68));
  test("a longer title steps down rather than overflowing", () => {
    expect(fitPrize("VAN CLEEF 18CT YELLOW GOLD ALHAMBRA NECKLACE").px).toBe(56);
  });
  test("an unsettable title is TRUNCATED, never refused", () => {
    // A Story carries exactly one draw, so refusing the title means no Story at all.
    const f = fitPrize("A PRIZE NAME SO LONG THAT IT CANNOT POSSIBLY SET IN TWO LINES AT FIFTY SIX PIXELS EITHER");
    expect(f.truncated).toBe(true);
    expect(f.text.endsWith("…")).toBe(true);
    expect(f.px).toBe(56);
  });
});

describe("what the frame carries", () => {
  test("the odds figure is the hero, with its eyebrow and qualifier", () => {
    const h = markup();
    expect(h).toContain("TICKET CAP");
    expect(h).toContain('class="figure">5,495<');
    expect(h).toContain("1 IN 5,495 AT SELL-OUT");
  });
  test("the prize name carries the CAP 8.17 claim attribute", () => {
    expect(markup()).toContain('data-pdd-claim="prize-name"');
  });
  test("it declares the story role, so it joins the draw-carrying set", () => {
    expect(markup()).toContain('data-pdd-role="story"');
  });
  test("all three conditions lines are present", () => {
    const h = markup();
    expect(h).toContain("CLOSES");
    expect(h).toContain("thegiveawayguys.co.uk");
    expect(h).toContain("Free-entry route");
  });
  test("the sub-line does not claim draws are above it", () => {
    // A Story carries ONE draw and nothing sits above it, so the closing slide's line is simply
    // false here. This is the bug that shipped on the first render.
    const h = markup();
    expect(h).not.toContain("Every draw above");
    expect(h).toContain("This draw is someone else's");
  });
  test("no gambling wording", () => {
    // A prize competition sits outside Gambling Act 2005 licensing; the operative code is CAP
    // Section 8, so "play responsibly" is inaccurate rather than merely unnecessary.
    expect(markup().toLowerCase()).not.toContain("play responsibly");
  });
  test("no [data-theme] — per-category identity is structure, and comes from the scene module", () => {
    expect(markup()).not.toContain("data-theme");
  });
});

describe("refusals", () => {
  test("a draw with no ticket cap is refused rather than rendered without the device", () => {
    expect(() => markup({ total_entries: null })).toThrow(/no ticket cap/);
  });
  test("no draw at all is refused", () => {
    expect(() => buildStoryHtml({ draw: null })).toThrow(/need a draw/);
  });
});
