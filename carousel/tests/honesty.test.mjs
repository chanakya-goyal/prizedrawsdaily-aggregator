import { test, expect } from "bun:test";
import { valueLine, capValue, altTexts } from "../honesty.mjs";

// 2026-07-02 incident: Discovery draw = 2M entries × 5p = £100k ticket revenue,
// but its own cash alternative proves the prize is worth £40k. Per-draw cap.
const D = (tpv, grand, desc) => ({ total_prize_value: tpv, grand_prize: grand || "", prize_description: desc || "" });

test("value line suppressed below the per-category bar (collectibles £15k incident guard)", () => {
  expect(valueLine([D(1000)], "collectibles")).toBe("");          // real prizes ~£1k → NO claim
  expect(valueLine([D(9000)], "collectibles")).toBe("£9,000+");   // above collectibles bar (8000)
  expect(valueLine([D(15000)], "car-draws")).toBe("");             // below car bar (20000)
  expect(valueLine([D(131000)], "luxury")).toBe("£131,000+");
  expect(valueLine([D(50)], "unknown-cat")).toBe("");              // unknown → Infinity bar → never
});

test("altTexts covers every slide with searchable, honest copy", () => {
  const sel = { name: "Luxury", slug: "luxury", seoKeyword: "UK luxury watch competitions", draws: [{}, {}] };
  const slides = [
    { title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT" },
    { title: "Omega Seamaster", price: "£2", closes: "CLOSES FRI 10 JUL" },
  ];
  const alts = altTexts(sel, slides);
  expect(alts.length).toBe(4);                                  // intro + 2 draws + cta
  expect(alts[0]).toContain("UK luxury watch competitions");
  expect(alts[1]).toContain("Rolex Daytona");
  expect(alts[1]).toContain("£4.97");
  expect(alts[1]).toContain("18+");
  expect(alts[3]).toContain("prizedrawsdaily");
});

test("capValue caps a draw at its parseable cash alternative", () => {
  expect(capValue(D(100000, "Land Rover or £40,000 tax-free cash"))).toBe(40000);
  expect(capValue(D(47830, "Suzuki Jimny"))).toBe(47830);          // no cash alt → revenue stands
  expect(capValue(D(35873, "Harley", "or £15,000 cash alternative"))).toBe(15000);
});

test("capValue ignores a zero-parse cash alt ('£0'/'£000') and falls back to revenue", () => {
  expect(capValue(D(5000, "or £000 cash"))).toBe(5000);
});

test("valueLine v2 uses per-draw capped sum (2026-07-02 regression)", () => {
  const draws = [
    D(100000, "Land Rover or £40,000 tax-free cash"),  // → 40000
    D(47830, "Jimny"),                                  // → 47830
    D(18757, "Astra"),                                  // → 18757
    D(19746, "S1000RR"),                                // → 19746
    D(35873, "Harley", "or £15,000 cash"),              // → 15000
  ];
  // capped sum = 141,336 → "£141,000+" (car bar 20000 passed) — NOT £222,000+
  expect(valueLine(draws, "car-draws")).toBe("£141,000+");
});

test("valueLine v2 still suppresses below the category bar", () => {
  expect(valueLine([D(900, "LEGO set")], "collectibles")).toBe("");
});
