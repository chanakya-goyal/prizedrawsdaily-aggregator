import { test, expect, describe } from "bun:test";
import { fieldFlags, buildHealthReport, reportMarkdown } from "../lib/manager.mjs";
import { templateDescription } from "../lib/describe.mjs";

const base = () => ({
  title: "Win a BMW M4", grand_prize: "BMW M4", category: "car-draws",
  ticket_price: 4.99, total_entries: 10000, draw_date: "2026-07-30T20:00:00+01:00",
  image_url: "https://cdn.test/x.jpg", entry_url: "https://op.test/p/1", description: "x".repeat(40),
});

describe("fieldFlags", () => {
  test("clean draw → no flags", () => expect(fieldFlags(base())).toHaveLength(0));
  test("high ticket flagged", () => { const d = base(); d.ticket_price = 99; expect(fieldFlags(d).join()).toContain(">£50"); });
  test("missing image flagged", () => { const d = base(); d.image_url = ""; expect(fieldFlags(d).join()).toContain("missing/bad image"); });
  test("thin description flagged", () => { const d = base(); d.description = "short"; expect(fieldFlags(d).join()).toContain("thin description"); });
  test("category mismatch flagged", () => { const d = base(); d.category = "house-draws"; d.grand_prize = "BMW M4"; d.title = "BMW M4"; expect(fieldFlags(d).join()).toContain("may not match"); });
  test("car pool too small flagged", () => { const d = base(); d.total_entries = 600; d.ticket_price = 1; expect(fieldFlags(d).join()).toContain("pool only"); });
});

describe("health report", () => {
  const counts = [
    { slug: "a", scraped: 5, inserted: 3, published: 0, heldDraft: 3 },
    { slug: "b", scraped: 0, inserted: 0, published: 0, heldDraft: 0 },
  ];
  const rep = buildHealthReport({ counts, expected: ["a", "b", "c"] });
  test("totals summed", () => expect(rep.totals.scraped).toBe(5));
  test("silent operators detected", () => { expect(rep.silentOperators).toContain("b"); expect(rep.silentOperators).toContain("c"); });
  test("markdown renders", () => expect(reportMarkdown(rep)).toContain("Silent operators"));
});

describe("templateDescription", () => {
  test("non-empty, >=20 chars", () => expect(templateDescription(base()).length).toBeGreaterThanOrEqual(20));
  test("mentions the prize", () => expect(templateDescription(base())).toContain("BMW M4"));
  test("stable across calls (no churn)", () => expect(templateDescription(base())).toBe(templateDescription(base())));
  test("different slugs can pick different frames", () => {
    const seen = new Set();
    for (let i = 0; i < 8; i++) { const d = base(); d.slug = `draw-${i}`; seen.add(templateDescription(d)); }
    expect(seen.size).toBeGreaterThan(1);
  });
});
