import { test, expect, describe } from "bun:test";
import * as o from "../odds-copy.mjs";

// THE FROZEN FIXTURE (spec §10.6a Part 2, gate 1).
//
// Every string in §10.6a Part 1 is a CONSTANT, so the cheap control is that it cannot be written
// anywhere else — and that changing one here requires changing a reviewed fixture. This file is
// that fixture. It is deliberately character-for-character: a paraphrase is a new claim, and two
// of the strings below were already paraphrased once into an unbound exhaustiveness claim that no
// predicate was in place to catch.

// §4.7's boundary caps: the shortest clipped cap, §4.2's median, a five-digit case, and the
// measured maximum in live inventory.
const CAPS = [1441, 9999, 13995, 4500000];

describe("the device table is frozen", () => {
  test("eyebrow", () => expect(o.eyebrow()).toBe("TICKET CAP"));

  test("hero figure is the bare cap, en-GB grouped", () => {
    expect(o.capFigure(699)).toBe("699");
    expect(o.capFigure(9999)).toBe("9,999");
    expect(o.capFigure(4500000)).toBe("4,500,000");
  });

  test("the conditional carries AT SELL-OUT on every surface", () => {
    expect(o.conditional(699)).toBe("1 IN 699 AT SELL-OUT");
    expect(o.conditional(4500000)).toBe("1 IN 4,500,000 AT SELL-OUT");
  });

  // "At sell-out" is load-bearing: the stored cap is the MAXIMUM tickets, so the odds it implies
  // are the worst case. Stating them unqualified would overstate the chance — the direction CAP
  // 8.20 actually cares about.
  test("no odds string states the odds unqualified", () => {
    for (const c of CAPS) expect(o.conditional(c)).toContain("AT SELL-OUT");
  });

  test("the full legend is exactly its three declared lines", () => {
    expect(o.legendFull(9999)).toEqual([
      "Each dot is one ticket.",
      "Odds at sell-out: 1 in 9,999.",
      "We do not know which ticket wins.",
    ]);
  });

  // The clipped legend drops the middle line: above the ceiling the grid is not the whole cap, so
  // a bare odds sentence beside a partial picture invites the reader to count the dots and believe
  // the answer. This asserts the line count so a later edit cannot orphan the annotation's own
  // defence — "Each dot is one ticket." sitting immediately beneath it.
  test("the clipped legend is exactly its two declared lines", () => {
    for (const c of CAPS) {
      expect(o.legendClipped(c)).toEqual([
        "Each dot is one ticket.",
        "We do not know which ticket wins.",
      ]);
      expect(o.legendClipped(c)).toHaveLength(2);
      expect(o.legendClipped(c)[0]).toBe("Each dot is one ticket.");
    }
  });
});

describe("the annotation cannot reintroduce a build-failing string", () => {
  // Measured at JetBrains Mono 700's exact 26.4px per glyph at 44px against §4.8's 871.2px slot.
  // The previous form, "{shown} OF {cap} SHOWN · NONE MARKED", was dead at BOTH ends: 34 glyphs =
  // 897.6px at the median cap, over the slot by 26.4px. The word SHOWN cost six glyphs the slot
  // does not have, and since the clipped sheet is the device's DEFAULT appearance — roughly three
  // days in four — that string guaranteed a class-A failure on the ordinary run.
  const SLOT_GLYPHS = 33;
  const PER_GLYPH = 26.4;

  const EXPECTED = {
    1441:    "1,440 OF 1,441 · NONE MARKED",
    9999:    "1,440 OF 9,999 · NONE MARKED",
    13995:   "1,440 OF 13,995 · NONE MARKED",
    4500000: "1,440 OF 4,500,000 · NONE MARKED",
  };

  for (const c of CAPS) {
    test(`annotation at cap ${c} is exact and inside the slot`, () => {
      const s = o.annotation(o.GRID_CEILING, c);
      expect(s).toBe(EXPECTED[c]);
      expect(s.length).toBeLessThanOrEqual(SLOT_GLYPHS);
      expect(s.length * PER_GLYPH).toBeLessThanOrEqual(871.2);
    });
  }

  // A proof, not a sample: the only variable is {cap}, §3.5's T4 caps it at 9 glyphs, and a
  // 10-glyph cap (≥10,000,000) drops the draw at the figure node before the annotation is
  // composed. So the fixed cost of 23 glyphs + 9 = 32 is the bounded worst case.
  test("no legal cap can produce an annotation over 33 glyphs", () => {
    for (const c of [1441, 9999, 99999, 999999, 9999999]) {
      expect(String(c).length).toBeLessThanOrEqual(9);
      expect(o.annotation(o.GRID_CEILING, c).length).toBeLessThanOrEqual(SLOT_GLYPHS);
    }
  });

  test("NONE MARKED names no colour", () => {
    // Encoding-agnostic by design: it stays true whether the marker is a green dot, and on §8's
    // still surfaces where the per-category accent is dropped altogether.
    for (const c of CAPS) expect(o.annotation(o.GRID_CEILING, c)).not.toMatch(/green|colour|color|red|blue/i);
  });

  test("the retired 34-glyph form is not what we emit", () => {
    expect(o.annotation(o.GRID_CEILING, 9999)).not.toContain("SHOWN ·");
  });
});

describe("the cover strings are frozen", () => {
  test("the proof line is §10.6a 1.2's exact two lines", () => {
    expect(o.proofLine({ drawsRendered: 8, closesWithinDays: 5, lowestCap: 699 })).toEqual([
      "8 draws closing within 5 days.",
      "Lowest ticket cap of the 8: 699.",
    ]);
  });

  // "Lowest ticket cap of the 8" is the only comparative permitted anywhere in the system, and its
  // defence is that the scope token is a DIGIT the reader can count against the slides that follow.
  test("the comparative always carries its digit scope token", () => {
    for (const n of [4, 5, 6, 7, 8]) {
      const [, l2] = o.proofLine({ drawsRendered: n, closesWithinDays: 3, lowestCap: 699 });
      expect(l2).toContain(`of the ${n}:`);
    }
  });

  test("a one-day window reads within 24 hours, never 'within 1 days'", () => {
    expect(o.proofLine({ drawsRendered: 5, closesWithinDays: 1, lowestCap: 99 })[0])
      .toBe("5 draws closing within 24 hours.");
  });

  test("the four headline arms are frozen", () => {
    const facts = { drawsRendered: 8, fromPrice: "79p", cashAlt: "£52,000", price: "79p", day: "SUN", closingCount: 3 };
    expect(o.headline("question", facts)).toBe("8 DRAWS. HOW MANY TICKETS?");
    expect(o.headline("price-anchor", facts)).toBe("8 DRAWS. FROM 79p.");
    expect(o.headline("deadline", facts)).toBe("THREE OF THESE CLOSE SUN.");
    expect(o.headline("absurd-comparison", facts)).toBe("£52,000 FOR A 79p TICKET.");
  });

  test("the deadline arm takes the three-letter day token and never a full name or a clock", () => {
    for (const d of o.DAY_TOKENS) {
      expect(o.headline("deadline", { drawsRendered: 8, fromPrice: "79p", day: d, closingCount: 3 })).toBe(`THREE OF THESE CLOSE ${d}.`);
    }
    // A full weekday name measures 1,012.35px against the 895px well and wraps the long form to
    // four line boxes, so it is not a permitted token and the arm falls back rather than renders it.
    expect(o.headline("deadline", { drawsRendered: 8, fromPrice: "79p", day: "SUNDAY", closingCount: 3 })).toBe("8 DRAWS. FROM 79p.");
    // Fewer than two closing on the modal day is no deadline to state.
    expect(o.headline("deadline", { drawsRendered: 8, fromPrice: "79p", day: "SUN", closingCount: 1 })).toBe("8 DRAWS. FROM 79p.");
    expect(o.headline("deadline", { drawsRendered: 8, fromPrice: "79p", day: null, closingCount: 3 })).toBe("8 DRAWS. FROM 79p.");
  });

  test("the rendered arm is logged as a template id, never as the request", () => {
    const f = { drawsRendered: 8, fromPrice: "79p", price: "79p" };
    expect(o.headlineArm("question", f)).toBe("question:only");
    expect(o.headlineArm("deadline", { ...f, day: "SUN", closingCount: 3 })).toBe("deadline:long");
    expect(o.headlineArm("deadline", { ...f, day: "SUN", closingCount: 1 })).toBe("price-anchor:long");
    expect(o.headlineArm("absurd-comparison", { ...f, cashAlt: "£52,000" })).toBe("absurd-comparison:long");
    expect(o.headlineArm("absurd-comparison", { ...f, cashAlt: null })).toBe("price-anchor:long");
  });

  // absurd-comparison runs only where cashAlt parses; otherwise it falls back to price-anchor and
  // the substitution is COUNTED (§10.8) rather than silent, which is why the fallback is asserted.
  test("absurd-comparison falls back to price-anchor when cashAlt does not parse", () => {
    const facts = { drawsRendered: 8, fromPrice: "79p", cashAlt: null, price: "79p" };
    expect(o.headline("absurd-comparison", facts)).toBe("8 DRAWS. FROM 79p.");
    expect(o.headline("absurd-comparison", facts)).toBe(o.headline("price-anchor", facts));
  });

  // The question arm has ONE form and it carries a figure. The bare "HOW MANY TICKETS?" is banned
  // by name (§10.6a 1.3) because it carries no verified figure on the frame itself.
  test("the question arm interpolates the deck size, never a literal", () => {
    for (const n of [4, 5, 6, 7, 8]) {
      expect(o.headline("question", { drawsRendered: n, fromPrice: "79p" })).toBe(`${n} DRAWS. HOW MANY TICKETS?`);
    }
    expect(o.headline("question", { drawsRendered: 8, fromPrice: "79p" })).not.toBe("HOW MANY TICKETS?");
  });
});

describe("the standing strings assert a method, never a frequency", () => {
  // Two rendered strings claimed a checking frequency the spec's own evidence contradicts —
  // §10.4's window is 48 hours and the pipeline was 76 days dark. This is the defect logged four
  // times; these assertions are what stop the fifth.
  test("no standing string claims a cadence", () => {
    const all = [
      o.closingHeadline(), o.closingSubLine(), o.storySubLine(), o.signOffStrapline(),
      o.eyebrow(), ...o.legendFull(9999), ...o.legendClipped(9999),
    ];
    for (const s of all) expect(s).not.toMatch(/\b(daily|nightly|always|24\/7|round the clock)\b/i);
  });

  test("the closing sub-line uses each, not every", () => {
    expect(o.closingSubLine()).toBe("Each draw above is someone else's. We read the numbers and print them.");
    expect(o.closingSubLine()).not.toMatch(/\bevery\b/i);
  });

  test("the Story's sub-line states the right number, since nothing sits above it there", () => {
    expect(o.storySubLine()).toBe("This draw is someone else's. We read the numbers and print them.");
    expect(o.storySubLine()).not.toContain("above");
  });

  test("the closing headline is the independence claim", () => {
    expect(o.closingHeadline()).toBe("WE LIST DRAWS. WE RUN NONE.");
  });
});

describe("the banned strings are unreachable", () => {
  // §10.6a 1.3, by name. Every one of these shipped or was specified at some point.
  const BANNED = [
    "YOUR ODDS AT THE CAP", "TICKETS MAX", "ODDS IF IT SELLS OUT", "one of them wins",
    "Shortest odds", "SHORTEST ODDS TODAY?", "CHECKED DAILY", "every night",
    "IF ALL 13,995 TICKETS SELL", "Your odds", "1 is yours", "Best odds tonight",
  ];
  test("no exported string contains a banned phrase at any boundary cap", () => {
    const emitted = [];
    for (const c of [99, 699, 1441, 9999, 13995, 4500000]) {
      emitted.push(o.capFigure(c), o.conditional(c), o.annotation(o.GRID_CEILING, c),
                   ...o.legendFull(c), ...o.legendClipped(c), o.eyebrow());
    }
    for (const n of [4, 8]) {
      emitted.push(...o.proofLine({ drawsRendered: n, closesWithinDays: 3, lowestCap: 699 }));
      for (const a of ["question", "price-anchor", "deadline", "absurd-comparison"]) {
        emitted.push(o.headline(a, { drawsRendered: n, fromPrice: "79p", cashAlt: "£52,000", price: "79p" }));
      }
    }
    emitted.push(o.closingHeadline(), o.closingSubLine(), o.storySubLine(), o.signOffStrapline());
    for (const s of emitted) {
      for (const b of BANNED) expect(s.toLowerCase()).not.toContain(b.toLowerCase());
    }
  });

  test("the ceiling and grid constants are the ones the annotation is proved against", () => {
    expect(o.GRID_CEILING).toBe(1440);
    expect(o.GRID_COLS).toBe(60);
    expect(o.GRID_ROWS_MAX).toBe(24);
    expect(o.GRID_COLS * o.GRID_ROWS_MAX).toBe(o.GRID_CEILING);
  });
});

describe("the conditions band", () => {
  test("a draw-carrying role gets three lines and names the host", () => {
    const b = o.bandLines({ role: "draw", closesText: "CLOSES SUN 21 SEP", price: "79p", host: "elitecompetitions.co.uk", freeEntryRoute: "unknown" });
    expect(b).toHaveLength(3);
    expect(b[0]).toBe("CLOSES SUN 21 SEP · 79p A TICKET");
    expect(b[1]).toBe("Enter · terms · elitecompetitions.co.uk");
  });

  test("a deck-level role gets three lines and names no single host", () => {
    const b = o.bandLines({ role: "cover", drawsRendered: 8, fromPrice: "79p" });
    expect(b).toHaveLength(3);
    expect(b[0]).toBe("8 DRAWS IN THIS POST · TICKETS FROM 79p");
    expect(b[1]).toBe("Enter · terms · each operator's own site.");
  });

  // `unknown` is the LAWFUL default and is never a failure of any class: it neither asserts nor
  // denies a free-entry route, so CAP 3.7 holds on day one against a column 100% unpopulated.
  test("all four free-entry states render, and unknown asserts nothing", () => {
    const f = (r) => o.bandLines({ role: "draw", closesText: "C", price: "79p", host: "h", freeEntryRoute: r })[2];
    expect(f("unknown")).toBe("Free-entry route and age limits: in those terms.");
    expect(f("postal")).toBe("Free postal entry route and age limits: in those terms.");
    expect(f("online-free")).toBe("Free online entry route and age limits: in those terms.");
    expect(f("none-stated")).toBe("No free entry route stated. Age limits: in those terms.");
    expect(f(undefined)).toBe(f("unknown"));
  });

  test("no band line carries gambling furniture or a territory claim", () => {
    for (const role of ["draw", "count", "reel-card", "story", "cover", "closing"]) {
      for (const l of o.bandLines({ role, drawsRendered: 8, fromPrice: "79p", closesText: "C", price: "79p", host: "h", freeEntryRoute: "unknown" })) {
        expect(l).not.toMatch(/play responsibly|gamble|18\+|UK only|UK ONLY/i);
      }
    }
  });
});
