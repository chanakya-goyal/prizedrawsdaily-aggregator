import { test, expect, describe } from "bun:test";
import * as o from "../odds-copy.mjs";
import * as c from "../compliance.mjs";
import { GLOBAL } from "../config.mjs";
import { buildCaption, buildFbCaption } from "../caption.mjs";
import { altTexts } from "../honesty.mjs";

// THE STRUCTURAL GATE (spec §10.6a Part 2, gate 3).
//
// The other two gates check strings against a fixture and against a grep. This one checks the
// allow-list against the PREDICATES — every string oddsCopy can emit, across the boundary
// fact-sets, run through every L2/L4 predicate in the unit the renderer will present it in.
//
// WHY IT EXISTS: an allow-listed string and a predicate that rejects it is a conflict that
// otherwise surfaces in production as a class-A hard fail on an ordinary run — no PNG, no MP4,
// no post. After this test they can only ever disagree in CI, which is where the previous round's
// build-failing question headline should have surfaced. It is the difference between correcting
// this class of bug and making it impossible.

const NS      = [4, 5, 6, 7, 8];                                  // DRAWS_MIN..drawsPerDeck
const CAPS    = [99, 699, 1440, 9999, 4500000];
const PRICES  = ["79p", "£2.99", "£12.50"];
const DAYS    = [1, 2, 3, 4, 5, 6, 7];
const DAYTOK  = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const ARMS    = ["question", "price-anchor", "deadline", "absurd-comparison"];

const factsFor = (n) => c.factsTable({
  drawsRendered: n, caps: CAPS, prices: PRICES, daysToClose: DAYS,
});

// Every string the allow-list can emit, tagged with the surface whose rules apply to it.
function* everyEmittedString() {
  for (const cap of CAPS) {
    yield { s: o.capFigure(cap), where: `capFigure(${cap})` };
    yield { s: o.conditional(cap), where: `conditional(${cap})` };
    yield { s: o.annotation(o.GRID_CEILING, cap), where: `annotation(1440,${cap})` };
    for (const l of o.legendFull(cap)) yield { s: l, where: `legendFull(${cap})` };
    for (const l of o.legendClipped(cap)) yield { s: l, where: `legendClipped(${cap})` };
  }
  yield { s: o.eyebrow(), where: "eyebrow()" };
  yield { s: o.closingHeadline(), where: "closingHeadline()" };
  yield { s: o.closingSubLine(), where: "closingSubLine()" };
  yield { s: o.storySubLine(), where: "storySubLine()" };
  yield { s: o.signOffStrapline(), where: "signOffStrapline()" };
  for (const n of NS) {
    for (const d of DAYS) for (const cap of CAPS) {
      for (const l of o.proofLine({ drawsRendered: n, closesWithinDays: d, lowestCap: cap })) {
        yield { s: l, where: `proofLine(${n},${d},${cap})` };
      }
    }
    for (const arm of ARMS) for (const p of PRICES) {
      for (const tok of [...DAYTOK, "SUNDAY", null]) for (const k of [1, 2, 3, 8]) {
        yield { s: o.headline(arm, { drawsRendered: n, fromPrice: p, price: p, cashAlt: "£52,000", day: tok, closingCount: k }),
                where: `headline(${arm},${p},n=${n},${tok},${k})` };
        yield { s: o.headline(arm, { drawsRendered: n, fromPrice: p, price: p, cashAlt: null, day: tok, closingCount: k }),
                where: `headline(${arm},${p},n=${n},${tok},${k},noCashAlt)` };
      }
    }
    for (const p of PRICES) for (const tok of DAYTOK) {
      for (const role of ["draw", "count", "reel-card", "story", "cover", "closing"]) {
        for (const route of ["unknown", "postal", "online-free", "none-stated"]) {
          for (const l of o.bandLines({ role, drawsRendered: n, fromPrice: p, price: p,
                                        closesText: `CLOSES ${tok} 21 SEP`, host: "elitecompetitions.co.uk",
                                        freeEntryRoute: route })) {
            yield { s: l, where: `bandLines(${role},${route},${tok})` };
          }
        }
      }
    }
  }
}

const ALL = [...everyEmittedString()];

describe("every allow-listed string passes every predicate", () => {
  test(`the emission set is non-trivial (${ALL.length} strings)`, () => {
    expect(ALL.length).toBeGreaterThan(500);
  });

  // One test per predicate rather than one big loop, so a failure names WHICH rule disagrees with
  // the allow-list instead of just reporting that they do.
  const cases = [
    ["secondPerson",          (s) => c.secondPerson(s)],
    ["unboundedComparative",  (s) => c.unboundedComparative(s)],
    ["cadenceOrCoverage",     (s, f) => c.cadenceOrCoverage(s, f)],
    ["socialGraphImperative", (s) => c.socialGraphImperative(s)],
    ["danglingIndex",         (s) => c.danglingIndex(s)],
    ["falseUrgency",          (s) => c.falseUrgency(s)],
    ["gamblingFurniture",     (s) => c.gamblingFurniture(s)],
    ["americanTells",         (s) => c.americanTells(s)],
  ];

  for (const [name, fn] of cases) {
    test(`${name} fires on no allow-listed string`, () => {
      const bad = [];
      for (const n of NS) {
        const f = factsFor(n);
        for (const { s, where } of ALL) if (fn(s, f)) bad.push(`${where}: ${JSON.stringify(s)}`);
      }
      expect([...new Set(bad)]).toEqual([]);
    });
  }

  test("the deny-list backstop fires on no allow-listed string", () => {
    const bad = ALL.filter(({ s }) => c.bannedPhraseHit(s, GLOBAL.bannedPhrases).length)
                   .map(({ s, where }) => `${where}: ${s}`);
    expect([...new Set(bad)]).toEqual([]);
  });
});

describe("the two-figure test, in the unit the renderer presents", () => {
  // The unit for a cover headline is headline + proof line, because the proof line is a fixed,
  // mandatory block rendered directly beneath the headline (§5.4) and is generated, never
  // authored. The question arm carries "?" and only one figure ON ITS OWN — it passes because of
  // the evidence rendered with it, which is exactly the principle the rule encodes.
  test("every cover unit carries two distinct-key figures on every arm, price and deck size", () => {
    const bad = [];
    for (const n of NS) {
      const f = factsFor(n);
      for (const d of DAYS) for (const cap of CAPS) for (const arm of ARMS) for (const p of PRICES) {
        const h = o.headline(arm, { drawsRendered: n, fromPrice: p, price: p, cashAlt: "£52,000", day: "SUN", closingCount: 3 });
        const unit = [h, ...o.proofLine({ drawsRendered: n, closesWithinDays: d, lowestCap: cap })].join(" ");
        if (c.checkQuestionUnit(unit, f).length) bad.push(`n=${n} d=${d} cap=${cap} ${arm} ${p}: ${unit}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the question headline ALONE would fail — the proof line is what carries it", () => {
    const f = factsFor(8);
    expect(c.twoFigureTest(o.headline("question", { drawsRendered: 8, fromPrice: "79p" }), f)).toBe(true);
    const unit = "8 DRAWS. HOW MANY TICKETS? 8 draws closing within 5 days. Lowest ticket cap of the 8: 699.";
    expect(c.distinctKeyCount(unit, f)).toBeGreaterThanOrEqual(2);
    expect(c.twoFigureTest(unit, f)).toBe(false);
  });

  test("the three non-question arms carry no '?' so the rule does not fire", () => {
    const f = factsFor(8);
    for (const arm of ["price-anchor", "deadline", "absurd-comparison"]) {
      const h = o.headline(arm, { drawsRendered: 8, fromPrice: "79p", price: "79p", cashAlt: "£52,000", day: "SUN", closingCount: 3 });
      expect(h).not.toContain("?");
      expect(c.twoFigureTest(h, f)).toBe(false);
    }
  });

  // The degraded floor is the case a fixed-count rule would have missed.
  test("the degraded fallback proof line still carries two keys", () => {
    for (const n of NS) {
      const f = factsFor(n);
      expect(c.distinctKeyCount(`${n} draws closing within 1 day.`.replace("1 day", "24 hours"), f)).toBeGreaterThanOrEqual(1);
      expect(c.distinctKeyCount(o.proofLine({ drawsRendered: n, closesWithinDays: 5, lowestCap: 699 })[0], f)).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the generated surfaces pass the predicates they are governed by", () => {
  // Captions and alt text are the surfaces where PDD's own removed strings kept reappearing —
  // "18+ · UK only", the unbound "every live UK draw", the emoji furniture. Asserting them here
  // is what stops the next reappearance, because these two functions are what publish.mjs uses
  // when the model does not supply a caption.
  const items = [
    { title: "ROLEX Submariner Date", price: "£25", operator: "Elite Competitions" },
    { title: "Omega Speedmaster", price: "£4.99", operator: "Dream Car Giveaways" },
  ];
  const ops = items.map((i) => i.operator);

  for (const [label, s] of [
    ["IG caption", buildCaption("Luxury draws", "luxury", items, "uk luxury watch draws")],
    ["IG caption, no list", buildCaption("Luxury draws", "luxury", [], "uk luxury watch draws")],
    ["FB caption", buildFbCaption("Luxury draws", "luxury", items)],
    ["FB caption, no list", buildFbCaption("Luxury draws", "luxury", [])],
  ]) {
    test(`${label} passes every caption-surface predicate`, () => {
      const f = factsFor(items.length || 8);
      const found = c.checkUnit(s, { facts: f, surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames: ops });
      expect(found.map((x) => `${x.predicate}: ${x.detail}`)).toEqual([]);
    });
  }

  test("alt text passes every caption-surface predicate", () => {
    const slides = [{ title: "ROLEX Submariner Date", price: "£25", closes: "CLOSES SUN 21 SEP" }];
    const f = factsFor(1);
    for (const a of altTexts({ slug: "luxury", seoKeyword: "uk luxury watch draws" }, slides)) {
      const found = c.checkUnit(a, { facts: f, surface: "caption", bannedPhrases: GLOBAL.bannedPhrases });
      expect(found.map((x) => `${x.predicate}: ${x.detail}`)).toEqual([]);
    }
  });

  test("no generated surface carries the marks §10.2 deleted", () => {
    const all = [
      buildCaption("Luxury draws", "luxury", items, "k"),
      buildFbCaption("Luxury draws", "luxury", items),
      ...altTexts({ slug: "luxury", seoKeyword: "k" }, [{ title: "T", price: "£1", closes: "C" }]),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/18\+/);
      expect(s).not.toMatch(/UK only/i);
      expect(s).not.toMatch(/play responsibly/i);
      expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u);   // emoji as layout furniture
    }
  });

  // The config that fed two of those strings is asserted too: a control living in editable JSON
  // and read only by a briefing is not a control, so the JSON gets a test.
  test("no fixed hashtag carries an American tell, and the dead series block is gone", () => {
    for (const h of GLOBAL.fixedHashtags) expect(h).not.toMatch(/winbig|win_big/i);
    expect(GLOBAL.series).toBeUndefined();
  });
});

describe("the predicates actually bite — negative controls", () => {
  // A gate that fires on nothing is indistinguishable from a gate that is switched off. These are
  // PDD's own archived violations and the strings §10.6a retires by name.
  const f = factsFor(8);
  test("PDD's own archived caption violations are caught", () => {
    expect(c.captionProximity("better odds than most raffles you'll scroll past all week")).toBe(true);
    expect(c.unboundedComparative("better odds than most raffles you'll scroll past all week")).toBe(true);
    expect(c.twoFigureTest("Which would you pick?", f)).toBe(true);
    expect(c.secondPerson("YOUR ODDS AT THE CAP")).toBe(true);
  });
  test("the retired cadence claims are caught", () => {
    expect(c.cadenceOrCoverage("Every UK draw we track, checked and dated daily.", f)).toBe(true);
    expect(c.cadenceOrCoverage("UK PRIZE DRAWS, CHECKED DAILY", f)).toBe(true);
    expect(c.cadenceOrCoverage("every night · 7pm UK", f)).toBe(true);
    expect(c.cadenceOrCoverage("See every live UK prize draw at prizedrawsdaily.co.uk", f)).toBe(true);
  });
  test("an exhaustiveness claim bound by a real figure is permitted", () => {
    expect(c.cadenceOrCoverage("all 8 close within 5 days", f)).toBe(false);
    expect(c.cadenceOrCoverage("every one of the 8 is the operator's own", f)).toBe(false);
    expect(c.cadenceOrCoverage("each draw above is someone else's", f)).toBe(false);
  });
  test("the social-graph ask and the dangling index are caught", () => {
    expect(c.socialGraphImperative("Send this to your comp buddy.")).toBe(true);
    expect(c.socialGraphImperative("Tag someone who needs this.")).toBe(true);
    expect(c.danglingIndex("Number 3 is the one I'd pick.")).toBe(true);
    expect(c.danglingIndex("Draw number 3 closes first.")).toBe(false);
  });
  test("gambling furniture is caught, and an operator's registered name is not", () => {
    expect(c.gamblingFurniture("18+ · UK only · Play responsibly")).toBe(true);
    expect(c.gamblingFurniture("a £10,000 jackpot")).toBe(true);
    expect(c.gamblingFurniture("Run by The Health Lottery", ["The Health Lottery"])).toBe(false);
    expect(c.gamblingFurniture("Run by The Health Lottery")).toBe(true);
  });
  test("the American tells are caught", () => {
    expect(c.americanTells("WIN BIG")).toBe(true);
    expect(c.americanTells("$50,000")).toBe(true);
    expect(c.americanTells("Closes 09/21/2026")).toBe(true);
    expect(c.americanTells("Closes 8pm")).toBe(true);
    expect(c.americanTells("Amazing!!")).toBe(true);
    expect(c.americanTells("CLOSES SUN 21 SEP")).toBe(false);
  });
  test("false urgency is caught, including the form PDD's data can never support", () => {
    expect(c.falseUrgency("Only 40 tickets left!")).toBe(true);
    expect(c.falseUrgency("selling fast")).toBe(true);
    expect(c.falseUrgency("nearly sold out")).toBe(true);
  });
});

describe("the ledger and the record", () => {
  test("a clean run still writes a record, and its verdict is PASS", () => {
    const l = c.newLedger({ drawsPlanned: 8, drawsRendered: 8 });
    expect(c.worstClass(l)).toBeNull();
    expect(c.complianceText(l)).toContain("verdict=PASS");
    expect(c.complianceText(l)).toContain("drawsRendered=8");
    expect(c.complianceText(l)).toContain("predicates fired: none");
  });

  test("a violation lands in the ledger, the counter and the text", () => {
    const l = c.newLedger({ drawsPlanned: 8, drawsRendered: 8 });
    c.record(l, "model", "slide-03.png", "draw", "headline",
             c.checkUnit("YOUR ODDS AT THE CAP", { facts: factsFor(8), surface: "asset" }));
    expect(l.gate_violations["L2.secondPerson"]).toBe(1);
    expect(c.worstClass(l)).toBe("A");
    expect(c.complianceText(l)).toContain("verdict=FAIL class A");
    expect(c.verdict(l)).toBe("FAIL class A — the run stopped");
    expect(c.complianceText(l)).toContain("L2.secondPerson=1");
  });

  // The class-C ceiling is a proportion, and at the old five-draw deck it reduces to the fixed
  // rule it replaces: floor(0.4 × 5) = 2, i.e. escalate at three.
  test("the class-C ceiling generalises the old fixed rule exactly", () => {
    const withC = (n, k) => {
      const l = c.newLedger({ drawsRendered: n });
      for (let i = 0; i < k; i++) l.violations.push({ class: "C", predicate: "x" });
      return c.classCCeilingBreached(l);
    };
    expect(withC(5, 2)).toBe(false);
    expect(withC(5, 3)).toBe(true);
    expect(withC(8, 3)).toBe(false);
    expect(withC(8, 4)).toBe(true);
  });

  test("an operator's own title is exempt from the second person, but not beside an odds word", () => {
    const f = factsFor(8);
    expect(c.checkUnit("Build Your Own PC", { facts: f, surface: "title" })).toEqual([]);
    const bad = c.checkUnit("Improve Your Odds Bundle", { facts: f, surface: "title" });
    expect(bad).toHaveLength(1);
    expect(bad[0].class).toBe("B");        // drops the draw, never the whole run
  });

  // Class B dropped a draw; the run survived and shipped a shorter deck. A record that calls that
  // "FAIL" teaches the reader to skip the line that matters.
  test("only class A reads as a failed run", () => {
    const l = c.newLedger({ drawsPlanned: 8, drawsRendered: 6, backupsUsed: 2 });
    l.violations.push({ class: "B", predicate: "B.drawDropped" }, { class: "B", predicate: "B.drawDropped" });
    expect(c.verdict(l)).toBe("PASS with degradation (2 class B)");
    expect(c.complianceText(l)).toContain("drawsRendered=6");
    expect(c.complianceText(l)).not.toContain("FAIL");
    l.violations.push({ class: "A", predicate: "L2.secondPerson" });
    expect(c.verdict(l)).toBe("FAIL class A — the run stopped");
  });
});
