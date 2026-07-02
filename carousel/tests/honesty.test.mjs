import { test, expect } from "bun:test";
import { valueLine, altTexts } from "../honesty.mjs";

test("value line suppressed below the per-category bar (collectibles £15k incident guard)", () => {
  expect(valueLine(1000, "collectibles")).toBe("");          // real prizes ~£1k → NO claim
  expect(valueLine(9000, "collectibles")).toBe("£9,000+");   // above collectibles bar (8000)
  expect(valueLine(15000, "car-draws")).toBe("");             // below car bar (20000)
  expect(valueLine(131000, "luxury")).toBe("£131,000+");
  expect(valueLine(50, "unknown-cat")).toBe("");              // unknown → Infinity bar → never
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
