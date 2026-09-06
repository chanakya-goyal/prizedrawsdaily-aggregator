// The five-way routing decision (insert / relist / correct / draft / skip) previously lived
// inline in run.mjs with no test coverage at all — the most consequential branching in the repo,
// verified only by watching production. These lock the matrix down.
import { test, expect, describe } from "bun:test";
import { routeDraw, poolValue, categoryPatch } from "../lib/route.mjs";

const NOW = new Date("2026-09-06T12:00:00Z");
const CAT = { "cash-prizes": "cat-cash", "car-draws": "cat-car" };

// A realistic description matters: fieldFlags reports "thin description" without one, and a
// flagged read is refused by correctionDecision — correctly, since a flagged read must never
// overwrite values the public is already being shown.
const DESC = "Enter this cash competition for the chance to win £1,000 paid straight to your bank. "
  + "Tickets are £1 each with 2,000 available, and the draw is held live once the timer ends.";
const fresh = (over = {}) => ({
  title: "Win £1,000 Cash", grand_prize: "£1,000", category: "cash-prizes", description: DESC,
  ticket_price: 1, total_entries: 2000, draw_date: "2026-09-20T20:00:00+01:00",
  image_url: "https://cdn.test/a.jpg", entry_url: "https://op.test/c/a", ...over,
});
const stored = (over = {}) => ({
  id: "row-1", slug: "win-1000-cash-op", status: "draft", category_source: "rule",
  title: "Win £1,000 Cash", grand_prize: "£1,000", prize_description: DESC,
  ticket_price: 1, total_entries: 2000, draw_date: "2026-09-20T20:00:00+01:00",
  image_url: "https://our.storage/a.jpg", created_at: "2026-09-04T12:00:00Z", ...over,
});

describe("poolValue", () => {
  test("is price × cap, rounded", () => expect(poolValue({ ticket_price: 1.005, total_entries: 100 })).toBe(100.5));
  test("treats missing numbers as zero rather than NaN", () => expect(poolValue({})).toBe(0));
  test("clamps a pathological product so the DB never sees it", () => {
    expect(poolValue({ ticket_price: 1e9, total_entries: 1e9 })).toBe(1_000_000_000);
  });
});

describe("categoryPatch", () => {
  test("a rule may set a category", () => {
    expect(categoryPatch(fresh(), stored(), CAT)).toEqual({ category_id: "cat-cash", category_source: "rule" });
  });
  test("a rule must NOT overwrite a judged category — those were decided, not computed", () => {
    for (const src of ["claude", "manual"]) {
      expect(categoryPatch(fresh(), stored({ category_source: src }), CAT).category_id).toBeUndefined();
    }
  });
  test("a fresh read with no category leaves the stored one alone", () => {
    // undefined, not null: undefined keys vanish in JSON.stringify, which is how "don't touch"
    // reaches PostgREST. null would blank the category and drop the draw off its category page.
    const patch = categoryPatch(fresh({ category: null }), stored(), CAT);
    expect(patch.category_id).toBeUndefined();
    expect("category_id" in patch).toBe(true);
  });
});

describe("routeDraw", () => {
  test("an unseen URL is an insert", () => {
    expect(routeDraw(undefined, fresh(), { now: NOW, catMap: CAT }).kind).toBe("insert");
  });

  describe("ended rows", () => {
    test("a genuine relist comes back as a draft", () => {
      const p = routeDraw(stored({ status: "ended", draw_date: "2026-08-01T20:00:00+01:00" }), fresh(), { now: NOW, catMap: CAT });
      expect(p.kind).toBe("relist");
      expect(p.row.status).toBe("draft");
    });
    test("a relist RESETS created_at, or the observation gap would pass instantly", () => {
      // The row keeps its id, so without this stamp created_at still points at the first time we
      // ever saw the URL — months back — on exactly the recurring draws that most need a re-check.
      const p = routeDraw(stored({ status: "ended", draw_date: "2026-08-01T20:00:00+01:00", created_at: "2026-01-01T00:00:00Z" }), fresh(), { now: NOW, catMap: CAT });
      expect(p.row.created_at).toBe(NOW.toISOString());
    });
    test("an ended row that has not been relisted is skipped", () => {
      const p = routeDraw(stored({ status: "ended" }), fresh({ draw_date: "2026-08-01T20:00:00+01:00" }), { now: NOW, catMap: CAT });
      expect(p.kind).toBe("skip");
      expect(p.reason).toBe("not-relisted");
    });
  });

  describe("active rows", () => {
    const live = (over = {}) => stored({ status: "active", ...over });
    test("CORRECT_LIVE=false skips without consulting the decision", () => {
      const p = routeDraw(live(), fresh({ ticket_price: 2 }), { now: NOW, catMap: CAT, correctLive: false });
      expect(p).toMatchObject({ kind: "skip", reason: "correct-live-off" });
    });
    test("no drift means nothing to do", () => {
      expect(routeDraw(live({ total_prize_value: 2000 }), fresh(), { now: NOW, catMap: CAT }).kind).toBe("skip");
    });
    test("a clean disagreement corrects the drifted fields", () => {
      const p = routeDraw(live({ total_prize_value: 2000 }), fresh({ ticket_price: 2 }), { now: NOW, catMap: CAT });
      expect(p.kind).toBe("correct");
      expect(p.row.ticket_price).toBe(2);
    });
    test("a pool-only drift patches ONLY the pool — no unforced rewrite of a public row", () => {
      const p = routeDraw(live({ total_prize_value: 999 }), fresh(), { now: NOW, catMap: CAT });
      expect(p.kind).toBe("correct");
      expect(Object.keys(p.row)).toEqual(["total_prize_value"]);
    });
    test("the cap is checked AFTER the decision, so the same draws consume it", () => {
      const p = routeDraw(live({ total_prize_value: 2000 }), fresh({ ticket_price: 2 }), { now: NOW, catMap: CAT, correctRemaining: 0 });
      expect(p).toMatchObject({ kind: "skip", reason: "correction-cap" });
      expect(p.decision.correct).toBe(true); // it WOULD have corrected — the cap is why it didn't
    });
    test("image_url is never patched on a live row", () => {
      const p = routeDraw(live({ total_prize_value: 2000 }), fresh({ ticket_price: 2 }), { now: NOW, catMap: CAT });
      expect("image_url" in p.row).toBe(false);
    });
  });

  describe("draft rows — the publish gate", () => {
    test("an agreeing second observation is a publish candidate", () => {
      const p = routeDraw(stored(), fresh(), { now: NOW, catMap: CAT, autoPublish: true });
      expect(p.kind).toBe("draft");
      expect(p.candidate).toBe(true);
    });
    test("autoPublish off never publishes, but the verdict is still computed", () => {
      const p = routeDraw(stored(), fresh(), { now: NOW, catMap: CAT, autoPublish: false });
      expect(p.candidate).toBe(false);
      expect(p.verdict.publish).toBe(true);
    });
    test("disagreement holds it as a draft", () => {
      const p = routeDraw(stored(), fresh({ ticket_price: 5 }), { now: NOW, catMap: CAT, autoPublish: true });
      expect(p.candidate).toBe(false);
      expect(p.verdict.reasons.join(" ")).toContain("ticket_price");
    });
    test("a row observed too recently is held — the gap guard for multi-run days", () => {
      const p = routeDraw(stored({ created_at: "2026-09-06T06:00:00Z" }), fresh(), {
        now: NOW, catMap: CAT, autoPublish: true, minObservationGapMs: 18 * 3600e3,
      });
      expect(p.candidate).toBe(false);
      expect(p.verdict.reasons.join(" ")).toContain("between observations");
    });
    test("the same row publishes once the gap has elapsed", () => {
      const p = routeDraw(stored({ created_at: "2026-09-04T12:00:00Z" }), fresh(), {
        now: NOW, catMap: CAT, autoPublish: true, minObservationGapMs: 18 * 3600e3,
      });
      expect(p.candidate).toBe(true);
    });
    test("gap 0 (the single daily run) is unaffected by created_at", () => {
      const p = routeDraw(stored({ created_at: NOW.toISOString() }), fresh(), { now: NOW, catMap: CAT, autoPublish: true });
      expect(p.candidate).toBe(true);
    });
  });

  test("any other status is skipped", () => {
    expect(routeDraw(stored({ status: "archived" }), fresh(), { now: NOW, catMap: CAT }).reason).toBe("not-draft");
  });
});
