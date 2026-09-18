import { test, expect, describe } from "bun:test";
import { buildBriefing } from "../brief.mjs";
import * as c from "../compliance.mjs";
import { GLOBAL } from "../config.mjs";

const sel = { name: "Luxury", slug: "luxury", seoKeyword: "UK luxury watch competitions", archetype: "price-anchor" };
const slides = [{ title: "Rolex Daytona", price: "£4.97", cap: 799, closes: "CLOSES TONIGHT", odds: "1 IN 799 AT SELL-OUT", cashAlt: "£16,000 TAX-FREE CASH" }];
const b = buildBriefing({ sel, drawSlides: slides, recentOpeners: ["UK luxury draws closing"] });

test("the briefing carries the verified facts, the archetype and the keyword rule", () => {
  expect(b).toContain("Rolex Daytona");
  expect(b).toContain("£4.97");
  expect(b).toContain("1 IN 799 AT SELL-OUT");   // the permitted form, not the retired oddsLabel one
  expect(b).toContain("price-anchor");
  expect(b).toContain("UK luxury watch competitions");
});

test("the briefing carries the ban list and the last-14-day openers", () => {
  expect(b).toContain("don't miss out");
  expect(b).toContain("UK luxury draws closing");
});

// §10.6 requires this explicitly: a caption author who cannot see the fact KEYS cannot satisfy
// the two-figure rule except by luck, and would meet it as a class-A hard fail at L4 instead.
describe("the briefing prints predicate 3 in full", () => {
  test("it names the rule and every fact key", () => {
    expect(b).toContain("two-figure rule");
    for (const k of ["drawsRendered", "caps", "prices", "daysToClose"]) expect(b).toContain(k);
    expect(b).toContain("799");
    expect(b).toContain("Word-numbers");
  });
});

// The briefing is where three retired strings kept being reinstated, because it is an INSTRUCTION
// to a generator: whatever it asks for is what gets written. So it is asserted negatively too.
describe("the briefing cannot ask for a string the gate rejects", () => {
  // The briefing has to NAME the banned phrases — an instruction the model cannot see is not an
  // instruction — so the assertion is that every occurrence sits inside a negative instruction,
  // not that the phrase is absent. That distinction is the whole reason this test exists: the
  // previous briefing asked for "we post TONIGHT'S UK DRAWS every night" as a REQUIREMENT.
  // stripBrand first, for the same reason cadenceOrCoverage does: "#prizedrawsdaily" and
  // "Prize Draws Daily" carry the word `daily` as a NAME. Using the module's own carve-out here
  // rather than a second ad-hoc one is what keeps the two from drifting apart.
  const linesWith = (needle) => b.split("\n").filter((l) => c.stripBrand(l).toLowerCase().includes(needle));
  const NEGATIVE = /\bnever\b|\bno\b|\bnot\b|\bdo not\b|\bforbidden\b/i;

  test("it asks for no cadence claim, and names the ban", () => {
    expect(b).toContain("State NO posting frequency");
    const hits = linesWith("every night");
    expect(hits.length).toBeGreaterThan(0);                       // it is named
    for (const l of hits) expect(l).toMatch(NEGATIVE);            // and only ever forbidden
    expect(b).not.toMatch(/Series line near the end: \*\*we post/i);
  });

  test("every cadence word the briefing mentions is mentioned as a ban", () => {
    for (const w of ["daily", "nightly", "24/7"]) {
      for (const l of linesWith(w)) expect(c.stripBrand(l)).toMatch(NEGATIVE);
    }
  });

  test("the brand name is not read as a cadence claim anywhere in the briefing", () => {
    // PDD is called Prize Draws Daily. If that tripped the predicate, every run would hard-fail.
    expect(c.cadenceOrCoverage("prize draw round-up from Prize Draws Daily.", null)).toBe(false);
    expect(c.cadenceOrCoverage("#prizedrawsdaily #ukcompetition", null)).toBe(false);
    expect(c.cadenceOrCoverage("Prize Draws Daily checks these daily.", null)).toBe(true);
  });

  test("it asks for no social-graph imperative", () => {
    expect(b).not.toContain("One send-CTA");
    expect(b).not.toContain("send this to your comp buddy");
    expect(b).toContain("No ask directed at the reader's social graph");
    for (const l of linesWith('"share"')) expect(l).toMatch(NEGATIVE);
  });

  test("it no longer asks for 18+ or UK only, and says why", () => {
    expect(b).not.toContain("link in bio · 18+ · UK only");
    expect(b).toContain('Do NOT write "18+" or "UK only"');
    for (const l of linesWith("18+")) expect(l).toMatch(NEGATIVE);
    for (const l of linesWith("uk only")) expect(l).toMatch(NEGATIVE);
  });

  test("it still forbids gambling wording", () => {
    expect(b).toContain("Gambling Act 2005");
    expect(b).toContain("CAP Section 8");
  });

  test("it asks for the independence line in the form the gate permits", () => {
    expect(b).toContain("each one above is the");
    expect(b).not.toContain("every one above is the");
  });

  test("it still red-flags operator attribution — the suspension cause", () => {
    expect(b).toContain("NAME THE OPERATOR ON EVERY PRIZE LINE");
    expect(b).toContain("IMPERSONATION");
  });
});

// The briefing's own prose is not a published asset, so it is not held to the asset predicates.
// But the STRINGS it instructs the model to emit are, and this is the cheap check that the
// instruction set is self-consistent: nothing it asks for verbatim may be a banned phrase.
test("no phrase the briefing asks for verbatim is on the deny-list", () => {
  const asks = [...b.matchAll(/"([^"]{4,80})"/g)].map((m) => m[1]);
  const offenders = asks.filter((a) => c.bannedPhraseHit(a, GLOBAL.bannedPhrases).length)
                        .filter((a) => !b.includes(`- "${a}"`));   // the deny-list itself is quoted
  expect(offenders).toEqual([]);
});
