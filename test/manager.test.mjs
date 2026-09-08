import { test, expect, describe } from "bun:test";
import { fieldFlags, buildHealthReport, reportMarkdown, classifySilent } from "../lib/manager.mjs";
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
  const draw = { ticket_price: 1, total_entries: 1000, image_url: "https://x.com/i.jpg", entry_url: "https://x.com/d", description: "A perfectly reasonable description here.", title: "Some Mystery Prize Draw" };
  test("null category → 'no category evidence' flag (draft-holding)", () => {
    expect(fieldFlags({ ...draw, category: null })).toContain("no category evidence");
  });
  test("stored category neutralises the null flag", () => {
    expect(fieldFlags({ ...draw, category: null }, { hasStoredCategory: true })).not.toContain("no category evidence");
  });
  test("valid category → no category flags", () => {
    const flags = fieldFlags({ ...draw, category: "sports-outdoors", title: "Win a set of Cobra irons" });
    expect(flags.filter((f) => /category/.test(f))).toEqual([]);
  });
});

// ---- silent-operator diagnosis ----
// The old report emitted one flat list, so an operator blocked for a day read exactly like a
// parser broken for months. Each cause has a different owner, so each must be named.
describe("classifySilent", () => {
  test("names an IP refusal as a block, not a broken parser", () => {
    expect(classifySilent(403)).toMatch(/blocked/);
    expect(classifySilent(503)).toMatch(/blocked/);
  });
  test("451 is called out specifically as a geo-block", () => {
    expect(classifySilent(451)).toMatch(/geo-blocked/);
  });
  test("a dead host is unreachable, not blocked", () => {
    expect(classifySilent("unreachable")).toMatch(/unreachable/);
    expect(classifySilent("unreachable")).not.toMatch(/blocked/);
  });
  test("a 200 that yielded nothing points at OUR code", () => {
    expect(classifySilent(200)).toMatch(/parser found nothing/);
  });
});

describe("reportMarkdown silent grouping", () => {
  const report = buildHealthReport({
    expected: ["a", "b", "c", "d"],
    counts: [
      { slug: "a", scraped: 0, silentReason: classifySilent(403) },
      { slug: "b", scraped: 0, silentReason: classifySilent(403) },
      { slug: "c", scraped: 0, silentReason: classifySilent(200) },
      { slug: "d", scraped: 5 },
    ],
  });
  test("only zero-scrape operators are called silent", () => {
    expect(report.silentOperators).toEqual(["a", "b", "c"]);
  });
  test("causes are grouped, largest first, and every silent operator appears", () => {
    const md = reportMarkdown(report);
    expect(md).toContain("Silent operators (0 draws) — 3 total");
    expect(md).toMatch(/blocked \(403[^)]*\)\*\* \(2\): a, b/);
    expect(md).toMatch(/parser found nothing[^*]*\*\* \(1\): c/);
    // A healthy operator must not be listed as silent — check the silent block itself, since
    // "d" legitimately appears in the per-operator table below it (and inside "held-draft").
    const silentBlock = md.slice(md.indexOf("Silent operators"), md.indexOf("| operator |"));
    expect(silentBlock).not.toMatch(/\bd\b/);
  });
  test("an operator with no determined cause is still reported, never dropped", () => {
    const md = reportMarkdown(buildHealthReport({ expected: ["z"], counts: [{ slug: "z", scraped: 0 }] }));
    expect(md).toContain("cause not determined");
    expect(md).toContain("z");
  });
});

// ---- publish funnel ----
// Scraping is only the first third of the pipeline: a run can capture perfectly and still add
// nothing, because the publish cap is the binding constraint. That was invisible in this report.
describe("reportMarkdown publish funnel", () => {
  const withFunnel = (funnel) => reportMarkdown(buildHealthReport({ expected: ["a"], counts: [{ slug: "a", scraped: 3 }], funnel }));

  test("reports the waiting queue alongside what was published", () => {
    const md = withFunnel({ draftsWaiting: 761, publishCap: 50, publishedThisRun: 12 });
    expect(md).toContain("761 draft(s) waiting");
    expect(md).toContain("12 published this run");
  });

  test("says plainly when the cap — not the scrape — is the constraint", () => {
    const md = withFunnel({ draftsWaiting: 761, publishCap: 50, publishedThisRun: 50 });
    expect(md).toContain("publish cap was reached");
  });

  test("stays quiet when the cap was not reached", () => {
    expect(withFunnel({ draftsWaiting: 20, publishCap: 50, publishedThisRun: 3 })).not.toContain("cap was reached");
  });

  test("omits the cap when auto-publish is off", () => {
    const md = withFunnel({ draftsWaiting: 20, publishCap: null, publishedThisRun: 0 });
    expect(md).toContain("20 draft(s) waiting");
    expect(md).not.toContain("cap ");
  });

  test("absent funnel changes nothing — the report still renders", () => {
    const md = reportMarkdown(buildHealthReport({ expected: ["a"], counts: [{ slug: "a", scraped: 3 }] }));
    expect(md).toContain("Aggregator health report");
    expect(md).not.toContain("Publish funnel");
  });
});

// Operators that scrape fine and then shed individual draws because their product pages were
// refused. Reported apart from silence on purpose: the remedy is a different egress IP, not a
// selector, and for months this loss was attributed to the parser instead.
describe("reportMarkdown — refused product pages", () => {
  const withBlocks = (pageBlocks) => reportMarkdown(buildHealthReport({
    counts: [{ slug: "golf-star-competitions", scraped: 100, inserted: 3, published: 1, heldDraft: 2, pageBlocks }],
    expected: ["golf-star-competitions"],
  }));

  test("names the operator, the share refused and the cause", () => {
    const md = withBlocks({ ok: 13, blocked: 87, causes: { "HTTP 403": 80, "challenge/empty": 7 } });
    expect(md).toContain("Product pages refused — 87 page(s) across 1 operator(s)");
    expect(md).toContain("`golf-star-competitions` — 87 of 100 refused (HTTP 403×80, challenge/empty×7)");
  });

  test("says the cause is the IP, so the reader does not go hunting for a selector bug", () => {
    expect(withBlocks({ ok: 1, blocked: 9, causes: { "HTTP 403": 9 } })).toContain("the egress IP, not the parser");
  });

  test("an operator whose pages all read adds no section at all", () => {
    const md = withBlocks({ ok: 100, blocked: 0, causes: {} });
    expect(md).not.toContain("Product pages refused");
  });

  test("the section is absent when nothing reports page blocks — old callers render unchanged", () => {
    expect(withBlocks(null)).not.toContain("Product pages refused");
    expect(reportMarkdown(buildHealthReport({ counts: [{ slug: "a", scraped: 1 }], expected: ["a"] })))
      .not.toContain("Product pages refused");
  });
});
