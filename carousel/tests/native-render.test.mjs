import { test, expect } from "bun:test";
import { slideHtml, SAFE, L_NOTCH } from "../native.mjs";
import { SAFE as STORY_SAFE, L_NOTCH as STORY_NOTCH } from "../story.mjs";
import { SAFE as REEL_SAFE, L_NOTCH as REEL_NOTCH } from "../reel-template.mjs";
import { nativeDeck, SITE } from "../native-copy.mjs";

// Markup only: the page inlines base64 fonts, which contain every short string by chance.
const markup = (s) => slideHtml(s).replace(/<style>[\s\S]*?<\/style>/g, "");
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const d = (slug, name) => ({ slug, title: `Win this BMW M4 + £2,000 Cash`, grand_prize: "BMW M4", ticket_price: 0.89,
  draw_date: "2026-09-23T21:00:00+01:00", operators: { name } });
const deck = nativeDeck({ sel: { slug: "car-draws", date: "x" }, draws: [d("a", "Dream Car Giveaways"), d("b", "7Days Performance")],
  photoOf: () => PIXEL, now: new Date("2026-09-21T10:00:00+01:00") });

test("Meta's safe box and reply notch are the same numbers in every 9:16 renderer", () => {
  expect(SAFE).toEqual(STORY_SAFE); expect(SAFE).toEqual(REEL_SAFE);
  expect(L_NOTCH).toEqual(STORY_NOTCH); expect(L_NOTCH).toEqual(REEL_NOTCH);
});
test("every frame carries the site watermark", () => {
  for (const s of [deck.cover, ...deck.prizes, deck.end]) expect(markup(s)).toContain(SITE);
});
test("every prize frame names its operator on the pill, never as an @handle, and marks the photo", () => {
  for (const p of deck.prizes) {
    const h = markup(p);
    expect(h).toContain(`via ${p.slug === "a" ? "Dream Car Giveaways" : "7Days Performance"}`);
    expect(h).not.toMatch(/@\w/);
    expect(h).toContain(`© ${SITE}`);
  }
});
test("every text element is tagged for the layout gate", () => {
  const h = markup(deck.prizes[0]);
  for (const t of ["price", "lead", "closes", "operator", "cash", "mark"]) expect(h).toContain(`data-t="${t}"`);
});
test("operator text is escaped", () => {
  const evil = nativeDeck({ sel: { slug: "car-draws", date: "x" }, draws: [d("e", "<b>Evil</b> & Co")], photoOf: () => PIXEL });
  expect(markup(evil.prizes[0])).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
});
