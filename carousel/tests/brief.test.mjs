import { test, expect } from "bun:test";
import { buildBriefing } from "../brief.mjs";

const sel = { name: "Luxury", slug: "luxury", seoKeyword: "UK luxury watch competitions", archetype: "price-anchor" };
const slides = [{ title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT", odds: "1 IN 799", cashAlt: "£16,000 TAX-FREE CASH" }];

test("briefing carries facts, archetype, keyword rule, series and bans", () => {
  const b = buildBriefing({ sel, drawSlides: slides, recentOpeners: ["UK luxury draws closing"] });
  expect(b).toContain("Rolex Daytona");
  expect(b).toContain("£4.97");
  expect(b).toContain("1 IN 799");
  expect(b).toContain("price-anchor");
  expect(b).toContain("UK luxury watch competitions");
  expect(b).toContain("TONIGHT'S UK DRAWS");
  expect(b).toContain("don't miss out");            // banned list included…
  expect(b).toContain("UK luxury draws closing");   // …plus recent openers
  expect(b).toContain("18+");
});
