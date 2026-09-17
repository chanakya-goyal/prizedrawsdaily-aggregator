import { test, expect, describe } from "bun:test";
import { buildHtml, cleanTitle, fitPrize } from "../render.mjs";

// The page inlines ~1.5MB of base64 woff2, and base64 contains every short ASCII string you
// could think to search for — "confetti" and "glow" both appear inside the font payload. Assert
// against the MARKUP only, or the deletion tests pass and fail for reasons of their own.
const markup = (s, cat = "luxury") => buildHtml(s, cat).replace(/<style>[\s\S]*?<\/style>/g, "");

const band = ["CLOSES THU 18 SEP · £1.99 A TICKET", "Enter · terms · example.com", "Free-entry route and age limits: in those terms."];
// A 1x1 transparent GIF. A draw slide without a photograph is now a hard refusal rather than an
// empty white well, so the fixture has to carry one — which is right: every real draw slide does.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const draw = { type: "draw", stamp: "READ 09:04", n: 3, total: 10, title: "Rolex Daytona", cap: 13995, photo: PIXEL, operator: "Example Comps", rating: "4.2", band };
const count = { type: "count", stamp: "READ 09:04", n: 2, total: 10, index: 1, drawsRendered: 8, title: "Rolex Daytona", cap: 699, operator: "Example Comps", rating: "4.2", band };
const cover = { type: "cover", stamp: "READ 09:04", dateline: "THU 18 SEP 2026 · READ 09:04", headline: "8 DRAWS. HOW MANY TICKETS?", proof: ["a", "b"], band, board: [{ prize: "Rolex Daytona", closes: "THU 18 SEP" }, { more: "+5 more inside" }] };
const closing = { type: "closing", stamp: "READ 09:04", band };
const ALL = [cover, count, draw, closing];

describe("standing chrome — every slide is a valid cold entry point", () => {
  // Instagram gives a carousel a "second chance" from slide 2 when a viewer does not swipe, so
  // a slide that only makes sense after slide 1 is a slide that wastes its best impression.
  for (const s of ALL) {
    test(`${s.type} carries the mark, the band and its role`, () => {
      const h = buildHtml(s, "luxury");
      expect(h).toContain("PRIZEDRAWSDAILY");
      expect(h).toContain('class="band"');
      expect(h).toContain(`data-pdd-role="${s.type}"`);
      for (const line of band) expect(h).toContain(line.slice(0, 24));
    });
  }
  test("the stamp is suppressed on the cover and present elsewhere", () => {
    // On slide 1 a glyph in that slot sits inside Instagram's profile-grid keep-out, so the
    // stamp moves into the dateline instead of being dropped.
    expect(markup(cover)).not.toContain('class="mh-b"');
    for (const s of [count, draw, closing]) expect(markup(s)).toContain('class="mh-b"');
  });
});

describe("what the rework deletes", () => {
  const forbidden = [
    ["18+ · UK ONLY · PLAY RESPONSIBLY", "gambling furniture: prize competitions sit outside Gambling Act 2005 licensing, so the operative code is CAP Section 8 and a gambling warning is simply inaccurate"],
    ["confetti", "decorative layer"],
    ["p-embers", "particle field"],
    ["class=\"glow\"", "glow"],
    ["win-ribbon", "WIN THIS ribbon"],
    ["SWIPE TO SEE ALL", "swipe arrow — research classes arrows as refuted; they read as 'tap'"],
    ["techgrid", "scanline grid"],
    ["data-theme", "per-theme CSS block — scenes are structure and must reach the video surfaces, which token-scraping cannot carry"],
  ];
  for (const [needle, why] of forbidden) {
    test(`no ${needle} (${why.slice(0, 48)})`, () => {
      for (const s of ALL) expect(markup(s)).not.toContain(needle);
    });
  }
});

describe("the odds device is the hero, not a trailing fragment", () => {
  test("the draw slide leads with TICKET CAP and the bare figure", () => {
    const h = buildHtml(draw, "luxury");
    expect(h).toContain("TICKET CAP");
    expect(h).toContain('class="figure">13,995<');
    expect(h).toContain("1 IN 13,995 AT SELL-OUT");
  });
  test("a cap at or under the ceiling draws every ticket and marks exactly one", () => {
    const h = buildHtml(count, "luxury");
    const dots = (h.match(/<i(?: class="hit")?><\/i>/g) || []).length;
    expect(dots).toBe(699);
    expect((h.match(/class="hit"/g) || []).length).toBe(1);
    expect(h).not.toContain("NONE MARKED");   // nothing is clipped, so nothing to correct
  });
  test("above the ceiling it clips to 1,440 and MUST carry the correction row", () => {
    // A partial picture of a cap understates the odds, which is the direction CAP 8.20 cares
    // about, so the annotation is mandatory rather than optional in this state.
    const h = buildHtml({ ...count, cap: 9999 }, "luxury");
    expect((h.match(/<i(?: class="hit")?><\/i>/g) || []).length).toBe(1440);
    expect(h).toContain("1,440 OF 9,999 · NONE MARKED");
  });
});

describe("prize-title cleaning", () => {
  const cases = [
    ["AUTO-DRAW: WIN A MOTOCADDY SE ELECTRIC TROLLEY #13", "MOTOCADDY SE ELECTRIC TROLLEY"],
    ["INSTANT WIN: Win an OGIO All Elements Hybrid Stand Bag #11", "OGIO All Elements Hybrid Stand Bag"],
    ["Win The Ultimate Golf Bundle", "Ultimate Golf Bundle"],
    ["BMW M4 Competition | Dream Car Giveaways", "BMW M4 Competition"],
  ];
  for (const [raw, want] of cases) test(`"${raw.slice(0, 34)}…"`, () => expect(cleanTitle(raw)).toBe(want));
  // `a` before `an` in the alternation turned "Win an OGIO" into "n OGIO".
  test("the article strip never eats a letter of the prize", () => {
    expect(cleanTitle("Win an Apple Watch")).toBe("Apple Watch");
    expect(cleanTitle("WINCHESTER RIFLE")).toBe("WINCHESTER RIFLE");
  });
  test("stripping never leaves a stub", () => {
    // "WIN A" strips to "A", which is not a prize name. Anything under three characters is a
    // sign the cleaner ate the content, so the original is kept.
    expect(cleanTitle("WIN A")).toBe("WIN A");
    expect(cleanTitle("Win")).toBe("Win");
  });
});

describe("the prize-name ladder replaces a binary that fired on half the corpus", () => {
  test("short titles take the top step", () => expect(fitPrize("Rolex Daytona").px).toBe(88));
  test("mid titles step down", () => expect(fitPrize("TAYLORMADE SPIDER TOUR X PUTTER").px).toBe(68));
  test("long titles bottom out at the lead step, never a third line", () => {
    const f = fitPrize("A VERY LONG PRIZE NAME THAT WILL NOT FIT IN TWO LINES AT ANY STEP OF THE LADDER");
    expect(f.px).toBe(56);
    expect(f.clamp).toBe(2);
  });
});
