import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as o from "../odds-copy.mjs";

// THE GREP GATE (spec §10.6a Part 2, gate 2).
//
// No file under carousel/ other than odds-copy.mjs may COMPOSE an odds string. It is the cheapest
// of the three controls and the one that would have caught every string in §10.6a 1.3 — including
// the two that were live when it was written: format.mjs's `oddsLabel()` and a hand-rolled
// duplicate in build.mjs, both building `1 IN {n}` outside the allow-list, both reaching the
// caption briefing.
//
// WHAT "COMPOSE" MEANS, AND WHY THE NAIVE GATE IS WRONG.
// A flat grep for ODDS / 1 IN / TICKET CAP flags 33 sites in this repository and every one is a
// false positive: the import specifier "./odds-copy.mjs", the `odds` role attribute, prose error
// messages ("carries no ticket cap — the odds lockup cannot render"), and test names. A gate that
// cries wolf 33 times is a gate somebody deletes. What distinguishes composition is that a FIGURE
// is being joined to the token — an interpolation or a digit, directly after it. That is exactly
// what both real offenders did and what no false positive does.
//
// Tests are handled the other way round, and more strictly rather than less: a test may name an
// odds string, but if it names one carrying a figure that string must be one odds-copy.mjs can
// actually emit. So a frozen expectation is provably tied to the allow-list instead of hand-typed.

const TOKENS = [/\bODDS\b/gi, /\b1 IN\b/gi, /\bTICKET CAP\b/gi, /\bSELL-OUT\b/gi, /\bTICKETS MAX\b/gi];
const COMPOSES = /^.{0,12}?(\$\{|\d)/s;          // a figure joined within 12 chars of the token
// `-` and `_` are word boundaries, so \bODDS\b matches inside `--odds-pad` and `./odds-copy.mjs`.
// A token continuing into a longer identifier is a NAME, never a composed claim.
const IDENT_TAIL = /^[-_]/;

// odds-copy.mjs IS the allow-list. compliance.mjs holds the predicates, whose job is to match
// these tokens. brief.mjs is exempt for a stated reason: §10.6a REQUIRES it to print the run's
// verified-facts table, and its output is BRIEFING.md — an internal instruction file, never a
// published asset.
const EXEMPT_SRC = new Set(["odds-copy.mjs", "compliance.mjs", "brief.mjs"]);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const literals = (src) => [
  ...stripComments(src).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g),
].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

// Every place the token appears with a figure joined to it.
function composingHits(lit) {
  const out = [];
  for (const re of TOKENS) {
    re.lastIndex = 0;
    for (const m of lit.matchAll(re)) {
      const tail = lit.slice(m.index + m[0].length);
      if (!IDENT_TAIL.test(tail) && COMPOSES.test(tail)) out.push(m[0]);
    }
  }
  return out;
}

function* files(dir, base = "") {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "tmp" || e === "fixtures" || e === "assets") continue;
    const p = join(dir, e);
    const rel = base ? `${base}/${e}` : e;
    if (statSync(p).isDirectory()) yield* files(p, rel);
    else if (e.endsWith(".mjs")) yield [rel, p];
  }
}

// Whether the allow-list can emit this exact string. Structural rather than enumerated: the
// figures are recovered FROM the string and fed back through every template that takes them, so
// the check holds at any ticket cap rather than only at the boundary caps a fixture lists.
function emittable(lit) {
  const s = lit.trim();
  const nums = [...new Set((s.match(/\d[\d,]*/g) || []).map((x) => Number(x.replace(/,/g, ""))).filter(Number.isFinite))];
  const cand = new Set([o.eyebrow(), o.closingHeadline(), o.closingSubLine(), o.storySubLine(), o.signOffStrapline()]);
  for (const n of nums) {
    cand.add(o.capFigure(n));
    cand.add(o.conditional(n));
    cand.add(o.annotation(o.GRID_CEILING, n));
    for (const l of [...o.legendFull(n), ...o.legendClipped(n)]) cand.add(l);
  }
  for (const a of nums) for (const b of nums) for (const c2 of nums) {
    for (const l of o.proofLine({ drawsRendered: a, closesWithinDays: b, lowestCap: c2 })) cand.add(l);
  }
  const prices = s.match(/£\d[\d,]*(?:\.\d+)?|\d+p/g) || [];
  for (const n of nums) for (const p of [...prices, "79p"]) for (const tok of o.DAY_TOKENS) for (const k of nums.concat([2, 3])) {
    for (const arm of ["question", "price-anchor", "deadline", "absurd-comparison"]) {
      cand.add(o.headline(arm, { drawsRendered: n, fromPrice: p, price: p, cashAlt: prices[0] || null, day: tok, closingCount: k }));
    }
  }
  return cand.has(s);
}

const scanned = [];
const composing = [];
const unmoored = [];
for (const [rel, abs] of files("carousel")) {
  scanned.push(rel);
  const isTest = rel.startsWith("tests/");
  if (!isTest && EXEMPT_SRC.has(rel)) continue;
  if (isTest && (rel.endsWith("odds-copy.test.mjs") || rel.endsWith("allowlist-conformance.test.mjs") || rel.endsWith("odds-literal-gate.test.mjs"))) continue;
  for (const lit of literals(readFileSync(abs, "utf8"))) {
    const hits = composingHits(lit);
    if (!hits.length) continue;
    if (isTest) {
      // A frozen expectation is fine; a hand-typed odds string is not.
      if (!emittable(lit)) unmoored.push(`${rel}: ${JSON.stringify(lit.slice(0, 90))} [${hits.join(",")}]`);
    } else {
      composing.push(`${rel}: ${JSON.stringify(lit.slice(0, 90))} [${hits.join(",")}]`);
    }
  }
}

describe("no odds literal outside the allow-list", () => {
  test("the scanner actually reached the pipeline", () => {
    // A gate that silently scans nothing passes forever.
    expect(scanned.length).toBeGreaterThan(20);
    for (const f of ["render.mjs", "story.mjs", "reel-template.mjs", "reel.mjs", "build.mjs", "format.mjs", "caption.mjs", "odds-copy.mjs"]) {
      expect(scanned).toContain(f);
    }
    // The structural check must actually recognise the module's own output.
    expect(emittable("1 IN 5,495 AT SELL-OUT")).toBe(true);
    expect(emittable("1,440 OF 9,999 · NONE MARKED")).toBe(true);
    expect(emittable("Lowest ticket cap of the 8: 699.")).toBe(true);
    // The retired oddsLabel() form. It is one word short of the permitted string, and that word
    // is the one doing the CAP 8.20 work — so it must NOT be recognised.
    expect(emittable("1 IN 799")).toBe(false);
    expect(emittable("1 IN 799 AT SELLOUT")).toBe(false);
  });

  test("the scanner can tell a literal from a comment", () => {
    expect(literals('// ODDS in a comment\nconst a = "safe";')).toEqual(["safe"]);
    expect(literals('const a = "1 IN 699";')).toEqual(["1 IN 699"]);
    expect(literals('const url = "https://x.co/y"; // not a comment opener')).toEqual(["https://x.co/y"]);
  });

  // The two real offenders, and the false positives that made the naive gate unusable.
  test("the rule separates composition from mention", () => {
    expect(composingHits("1 IN ${n}")).toEqual(["1 IN"]);                              // format.mjs, as it was
    expect(composingHits("1 IN ${capOf(d).toLocaleString('en-GB')}")).toEqual(["1 IN"]); // build.mjs, as it was
    expect(composingHits("1 IN 699 AT SELL-OUT")).toEqual(["1 IN"]);
    expect(composingHits("./odds-copy.mjs")).toEqual([]);
    expect(composingHits("odds")).toEqual([]);
    expect(composingHits("carries no ticket cap — the odds lockup cannot render")).toEqual([]);
    expect(composingHits('story: draw "${draw.slug}" carries no ticket cap — the odds lockup cannot render')).toEqual([]);
    expect(composingHits("the draw slide leads with TICKET CAP and the bare figure")).toEqual([]);
    expect(composingHits("--odds-pad:${ODDS_PAD}px")).toEqual([]);      // a CSS custom property name
    expect(composingHits("./odds-copy.mjs")).toEqual([]);
  });

  test("no source file composes an odds string outside odds-copy.mjs", () => {
    expect(composing).toEqual([]);
  });

  // Stricter than exempting tests: a test may assert an odds string only if the allow-list can
  // actually emit it, so an expectation cannot drift from the module it is meant to pin.
  test("every odds figure a test asserts is one odds-copy.mjs can emit", () => {
    expect(unmoored).toEqual([]);
  });

  test("the exemption list cannot rot", () => {
    for (const e of EXEMPT_SRC) expect(scanned).toContain(e);
  });
});
