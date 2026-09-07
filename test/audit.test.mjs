// The audit writes to LIVE rows, so its failure mode is not "missed a bug" — it is "changed a
// price on a page the public is reading". These tests are mostly about what it must REFUSE.
import { test, expect, describe } from "bun:test";
import { auditDecision, auditPatch, comparableFields, correctableFields, mergeForComparison, readLooksBlocked } from "../lib/audit.mjs";

const NOW = new Date("2026-09-07T09:00:00Z");
const FUTURE = "2026-09-20T20:00:00+01:00";

const row = (o = {}) => ({
  id: "r1", title: "Win a PS5", ticket_price: 0.99, total_entries: 5000,
  draw_date: FUTURE, total_prize_value: 4950, category_id: "cat-tech",
  entry_url: "https://op.test/product/win-a-ps5/",
  image_url: "https://cdn.test/ps5.webp",
  prize_description: "A PlayStation 5 console with an extra controller and three games.",
  ...o,
});
const page = (o = {}) => ({
  title: "Win a PS5", ticket_price: 0.99, total_entries: 5000, draw_date: FUTURE,
  description: "A PlayStation 5 console with an extra controller and three games.",
  category: "tech-giveaways", ...o,
});

describe("comparableFields — the whitelist is the safety mechanism", () => {
  test("render answers everything: the sweep re-reads the same page with the same parser", () => {
    expect([...comparableFields("render")].sort()).toEqual(["draw_date", "ticket_price", "title", "total_entries"]);
  });
  test("woo answers price only — the Store API has no entry cap", () => {
    expect([...comparableFields("woo")]).toEqual(["ticket_price"]);
  });
  test("shopify and api answer nothing we store", () => {
    expect(comparableFields("shopify").size).toBe(0);
    expect(comparableFields("api").size).toBe(0);
    expect(comparableFields(null).size).toBe(0);
  });
});

describe("the catastrophe this module exists to prevent", () => {
  test("a woo row is NOT 'corrected' to a null cap just because the API has no cap", () => {
    // The naive version of this feature would see total_entries 5000 → undefined on every woo
    // row in the catalogue and blank all of them. This is the single most destructive thing
    // the audit could do, so it is the first thing asserted.
    const d = auditDecision(row(), { ticket_price: 0.99 }, { reachable: true, source: "woo" }, { now: NOW });
    expect(d.action).toBe("ok");
    expect(d.fields).toEqual([]);
  });

  test("nor is its date rewritten from a source that cannot see the page", () => {
    const d = auditDecision(row(), { ticket_price: 0.99, draw_date: "2027-01-01T00:00:00Z" },
      { reachable: true, source: "woo" }, { now: NOW });
    expect(d.fields).not.toContain("draw_date");
    expect(d.action).toBe("ok");
  });

  test("a partial woo payload does not flag its way into permanent 'review'", () => {
    // correctionDecision refuses to write when fieldFlags finds anything wrong, and fieldFlags
    // inspects image_url and entry_url — which the sweep's woo payload does not carry. Before
    // mergeForComparison filled those from the stored row, EVERY woo row came back
    // "missing/bad image; bad entry_url", so every verdict was `review` and the audit corrected
    // nothing at all while reporting itself perfectly healthy.
    const d = auditDecision(row(), { ticket_price: 2.5 }, { reachable: true, source: "woo" }, { now: NOW });
    expect(d.action).toBe("correct");
    expect(d.reason).not.toContain("image");
    expect(d.reason).not.toContain("entry_url");
  });

  test("a Cloudflare interstitial can never become a competition's title", () => {
    // The first live measurement proposed exactly this: title "ASTRAL RTX 5080 PC + 15 PC
    // INSTANTS" → "Sorry, you have been blocked", on a row the public was reading.
    for (const t of ["Sorry, you have been blocked", "Just a moment...", "Attention Required! | Cloudflare", "Access denied"]) {
      const d = auditDecision(row(), page({ title: t, ticket_price: 9.99 }), { reachable: true, source: "render" }, { now: NOW });
      expect(d.action, t).toBe("skip");
    }
  });

  test("a draw_date is never written backwards into the past by an audit", () => {
    // Five podium-prize rows wanted 2026-09-11 → 2026-08-26. The site lists on
    // draw_date >= now, so writing that would have deleted live comps from the site.
    const d = auditDecision(row(), page({ draw_date: "2026-08-26T22:59:00+00:00" }), { reachable: true, source: "render" }, { now: NOW });
    expect(d.action).not.toBe("correct");
  });

  test("an entry cap that 'moved' is never auto-written — a cap does not move, a counter does", () => {
    const d = auditDecision(row(), page({ total_entries: 1233 }), { reachable: true, source: "render" }, { now: NOW });
    expect(d.action).not.toBe("correct");
  });

  test("a read that answered nothing comparable is a failed read, not agreement", () => {
    const d = auditDecision(row(), { ticket_price: null }, { reachable: true, source: "woo" }, { now: NOW });
    expect(d.action).toBe("skip");
  });

  test("an unreachable row is never acted on — we do not act on absence of evidence", () => {
    const d = auditDecision(row(), page({ ticket_price: 99 }), { reachable: false, source: "render" }, { now: NOW });
    expect(d.action).toBe("skip");
  });
});

describe("auditDecision — the cases it should catch", () => {
  test("agreement is left alone", () => {
    expect(auditDecision(row(), page(), { reachable: true, source: "render" }, { now: NOW }).action).toBe("ok");
  });

  test("a render disagreement is REPORTED, never written — text parses are not writable", () => {
    // Auditing 956 live rows proposed 9 render corrections and all 9 were wrong. Render values
    // are inferred from prose, so they are reported for a human/weekly pass instead.
    const d = auditDecision(row(), page({ ticket_price: 1.99 }), { reachable: true, source: "render" }, { now: NOW });
    expect(d.action).toBe("review");
    expect(d.fields).toContain("ticket_price");
    expect(d.reason).toContain("structured");
  });

  test("a woo price change IS caught — the API price is what the customer is charged", () => {
    const d = auditDecision(row(), { ticket_price: 2.5 }, { reachable: true, source: "woo" }, { now: NOW });
    expect(d.action).toBe("correct");
    expect(d.fields).toContain("ticket_price");
  });

  test("a stale derived pool is corrected on a woo row — the inputs are structured", () => {
    const d = auditDecision(row({ total_prize_value: 12345 }), { ticket_price: 0.99 }, { reachable: true, source: "woo" }, { now: NOW });
    expect(d.action).toBe("correct");
    expect(d.fields).toContain("total_prize_value");
  });

  test("the same stale pool on a RENDER row is only reported", () => {
    const d = auditDecision(row({ total_prize_value: 12345 }), page(), { reachable: true, source: "render" }, { now: NOW });
    expect(d.action).toBe("review");
  });

  test("a flagged fresh read is REVIEWED, never written", () => {
    // £150 a ticket trips the range flag. The page probably did not change; our parse probably
    // broke. Acting on it would overwrite a good row.
    const d = auditDecision(row(), page({ ticket_price: 150 }), { reachable: true, source: "render" }, { now: NOW });
    expect(d.action).toBe("review");
    expect(d.fields).toContain("ticket_price");
  });

  test("a clock-time nudge is not a date change — operators move 8:45pm to 9pm", () => {
    const d = auditDecision(row(), page({ draw_date: "2026-09-20T21:30:00+01:00" }), { reachable: true, source: "render" }, { now: NOW });
    expect(d.fields).not.toContain("draw_date");
  });
});

describe("mergeForComparison", () => {
  test("carries stored values for every field the source cannot answer", () => {
    const m = mergeForComparison(row(), { ticket_price: 2 }, comparableFields("woo"));
    expect(m.ticket_price).toBe(2);
    expect(m.total_entries).toBe(5000);
    expect(m.draw_date).toBe(FUTURE);
    expect(m.title).toBe("Win a PS5");
  });
  test("a comparable field that came back null falls back to stored rather than blanking it", () => {
    const m = mergeForComparison(row(), { ticket_price: null, total_entries: 6000 }, comparableFields("render"));
    expect(m.ticket_price).toBe(0.99);
    expect(m.total_entries).toBe(6000);
  });
});

describe("auditPatch — what actually reaches the database", () => {
  test("patches only the drifted field, and keeps the derived pool consistent", () => {
    const p = auditPatch(row(), page({ ticket_price: 1.99 }), ["ticket_price"], comparableFields("render"));
    expect(p.ticket_price).toBe(1.99);
    expect(p.total_prize_value).toBe(9950); // 1.99 × 5000
    expect(p.total_entries).toBeUndefined();
    expect(p.draw_date).toBeUndefined();
  });
  test("never touches image_url — the stored image is proven-reachable on our own storage", () => {
    const p = auditPatch(row(), page({ ticket_price: 1.99 }), ["ticket_price"], comparableFields("render"));
    expect(p).not.toHaveProperty("image_url");
    expect(p).not.toHaveProperty("status");
    expect(p).not.toHaveProperty("category_id");
  });
  test("a pool-only drift rewrites the pool and nothing else", () => {
    const p = auditPatch(row({ total_prize_value: 1 }), page(), ["total_prize_value"], comparableFields("render"));
    expect(Object.keys(p)).toEqual(["total_prize_value"]);
    expect(p.total_prize_value).toBe(4950);
  });
});
