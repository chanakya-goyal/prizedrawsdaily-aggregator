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
  test("category contradicted by the prize is flagged, naming what it really is", () => {
    const d = base(); d.category = "house-draws"; d.grand_prize = "BMW M4"; d.title = "BMW M4";
    expect(fieldFlags(d).join()).toContain("contradicts");
    expect(fieldFlags(d).join()).toContain("car-draws");
  });
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

describe("category flag — fires on contradiction, never on silence", () => {
  const draw = (over) => ({
    title: "x", grand_prize: "x", category: "cash-prizes", ticket_price: 1, total_entries: 1000,
    image_url: "https://x/y.jpg", entry_url: "https://x.co.uk/product/y",
    description: "A description comfortably over twenty characters long.", ...over,
  });
  const catFlag = (d) => fieldFlags(d).filter((f) => /^category /.test(f));

  // THE BUG THIS REPLACES: the check demanded that the prize text corroborate its category,
  // and treated the absence of a keyword as proof the category was wrong. 241 of 400 drafts
  // were held that way, 211 of them for prizes our keyword lists simply do not describe.
  // Task 6 (2026-08-21) gave the shared CAT_RULES a much longer home-garden/sports-outdoors
  // keyword tail, so "a Dewalt tool kit" and "Trampoline & Enclosure" — the original examples
  // here — now DO carry keyword evidence (home-garden) and are no longer unclassifiable; swapped
  // for fresh examples that still match no keyword under the expanded rules.
  test("an unclassifiable prize is NOT flagged — silence is not contradiction", () => {
    expect(catFlag(draw({ title: "The Ultimate Surprise Hamper Bundle", grand_prize: "Surprise Hamper" }))).toEqual([]);
    expect(catFlag(draw({ title: "Win This Amazing Mystery Bundle #47", grand_prize: "Mystery Bundle", category: "tech-giveaways" }))).toEqual([]);
    expect(catFlag(draw({ title: "The £2 Million Summer Clear-Out #85!", grand_prize: "Summer Clear-Out" }))).toEqual([]);
  });

  test("a prize that clearly reads as ANOTHER category IS flagged", () => {
    expect(catFlag(draw({ title: "£500 CASH!", grand_prize: "£500 Cash", category: "tech-giveaways" }))).toHaveLength(1);
    expect(catFlag(draw({ title: "Win A LEGO Ferrari Daytona SP3!", grand_prize: "LEGO Ferrari", category: "tech-giveaways" }))).toHaveLength(1);
  });

  test("the flag names the category the prize actually reads as", () => {
    expect(catFlag(draw({ title: "£500 CASH!", grand_prize: "£500 Cash", category: "tech-giveaways" }))[0]).toContain("cash-prizes");
  });

  test("a correctly categorised prize is never flagged", () => {
    expect(catFlag(draw({ title: "Win This 2025 BMW M2", grand_prize: "BMW M2", category: "car-draws" }))).toEqual([]);
    expect(catFlag(draw({ title: "Win an iPhone 17 Pro", grand_prize: "iPhone 17 Pro", category: "tech-giveaways" }))).toEqual([]);
  });

  // Drift: CAT_RULES knew these, the duplicated CAT_KW list did not.
  test("vocabulary the assignment rules know is not re-flagged by the check", () => {
    for (const [title, cat] of [
      ["Win 2022 VOLVO XC90 T8 R-DESIGN", "car-draws"],
      ["MINI Cooper Auto + £1,000 Insurance", "car-draws"],
      ["Win this Kia Sportage GT Line S", "car-draws"],
      ["PSA10 MEGA CHARIZARD X EX 125/094", "collectibles"],
    ]) expect(catFlag(draw({ title, grand_prize: title, category: cat }))).toEqual([]);
  });

  // The check never saw entry_url, though the rules that assigned the category did.
  test("evidence in the URL counts, because the assignment rules used it too", () => {
    expect(catFlag(draw({
      title: "Hogwarts™ Castle Bundle", grand_prize: "Hogwarts Castle",
      category: "collectibles", entry_url: "https://x.co.uk/product/lego-hogwarts-castle",
    }))).toEqual([]);
  });

  // Narrow claim: the CONTRADICTION check needs a category to contradict, so silence on that
  // side is not a flag. The separate "no category evidence" hold is asserted below.
  test("a draw with no category set is not flagged as contradicted", () => {
    expect(catFlag(draw({ title: "£500 CASH!", category: null }))).toEqual([]);
  });
});

// No-guess publishing (2026-08-21): with the cash fallback deleted, `inferCategory` returns null
// whenever nothing in the prize text says what the draw is. An uncategorised draw must not reach
// the site, so it is held as a draft until the cowork Claude routine judges it — but once judged,
// the very next scrape re-reads the same page, resolves null again (the rules still can't classify
// it, which is why Claude was needed), and must NOT re-hold the row forever.
describe("fieldFlags — category policy", () => {
  const base = { ticket_price: 1, total_entries: 1000, image_url: "https://x.com/i.jpg", entry_url: "https://x.com/d", description: "A perfectly reasonable description here.", title: "Some Mystery Prize Draw" };
  test("null category → 'no category evidence' flag (draft-holding)", () => {
    expect(fieldFlags({ ...base, category: null })).toContain("no category evidence");
  });
  test("stored category neutralises the null flag", () => {
    expect(fieldFlags({ ...base, category: null }, { hasStoredCategory: true })).not.toContain("no category evidence");
  });
  test("valid category → no category flags", () => {
    const flags = fieldFlags({ ...base, category: "sports-outdoors", title: "Win a set of Cobra irons" });
    expect(flags.filter((f) => /category/.test(f))).toEqual([]);
  });
});
