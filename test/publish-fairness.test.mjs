// The cap was not bounding risk — it was choosing winners. Spent first-come over a roster order
// that never changes, it went to whoever was scraped first, every run, forever. Measured
// 9 Sep 2026 on the JSON sweep: the first half of the roster held 361 live draws, the last half
// 155, with the SAME number of drafts dying in the queue. click-competitions sits at position
// 58/59 with 26 dead drafts and 0 live, while its own log lines read "verified — publishing".
//
// These tests pin the three fixes: spend the budget on the most urgent draw, rotate the roster
// so the shortfall lands somewhere new each run, and stop keeping drafts that already died.
import { test, expect, describe } from "bun:test";
import { deadDraftDecision, byPublishUrgency } from "../lib/verify.mjs";
import { rotateRoster, rosterOffset } from "../lib/shard.mjs";

const NOW = new Date("2026-09-09T12:00:00Z");
const iso = (d) => new Date(NOW.getTime() + d * 864e5).toISOString();

describe("deadDraftDecision", () => {
  test("ends a draft whose own draw date has passed", () => {
    const v = deadDraftDecision({ status: "draft", draw_date: iso(-3) }, NOW);
    expect(v.end).toBe(true);
    expect(v.reason).toContain("3d ago");
  });

  test("leaves an enterable draft alone", () => {
    expect(deadDraftDecision({ status: "draft", draw_date: iso(2) }, NOW).end).toBe(false);
  });

  // The whole asymmetry: a live row is ON the site, so removing it on a bad date parse is
  // visible damage and needs the operator's own evidence. A draft is not and never was.
  test("NEVER ends an active row, however stale — that needs the operator's own evidence", () => {
    const v = deadDraftDecision({ status: "active", draw_date: iso(-40) }, NOW);
    expect(v.end).toBe(false);
    expect(v.reason).toContain("operator's own evidence");
  });

  test("never ends an already-ended row, and never guesses without a date", () => {
    expect(deadDraftDecision({ status: "ended", draw_date: iso(-9) }, NOW).end).toBe(false);
    expect(deadDraftDecision({ status: "draft", draw_date: null }, NOW).end).toBe(false);
    expect(deadDraftDecision({ status: "draft", draw_date: "not a date" }, NOW).end).toBe(false);
    expect(deadDraftDecision(null, NOW).end).toBe(false);
  });

  test("a draw closing later today is still enterable — the boundary is the timestamp, not the day", () => {
    expect(deadDraftDecision({ status: "draft", draw_date: iso(0.4) }, NOW).end).toBe(false);
    expect(deadDraftDecision({ status: "draft", draw_date: iso(-0.01) }, NOW).end).toBe(true);
  });
});

describe("byPublishUrgency", () => {
  const c = (d) => ({ row: { draw_date: d == null ? null : iso(d) } });

  test("the draw closing soonest wins the next unit of the cap", () => {
    const sorted = [c(20), c(1), c(7)].sort(byPublishUrgency);
    expect(sorted.map((x) => x.row.draw_date)).toEqual([iso(1), iso(7), iso(20)]);
  });

  test("an undated row can never displace a dated one", () => {
    const sorted = [c(null), c(30), c(null), c(2)].sort(byPublishUrgency);
    expect(sorted[0].row.draw_date).toBe(iso(2));
    expect(sorted[1].row.draw_date).toBe(iso(30));
    expect(sorted.slice(2).every((x) => x.row.draw_date === null)).toBe(true);
  });

  test("survives malformed rows rather than throwing mid-flush", () => {
    expect(() => [{}, null, c(3), { row: { draw_date: "nonsense" } }].sort(byPublishUrgency)).not.toThrow();
  });

  // The bug in one assertion: the last operator scraped holds the most urgent draw and must
  // still win, because nothing about arrival order says anything about which draw matters.
  test("arrival order does not decide — the last-scraped operator can still take the cap", () => {
    const early = { row: { draw_date: iso(25) }, slug: "scraped-first" };
    const late = { row: { draw_date: iso(1) }, slug: "scraped-last" };
    expect([early, late].sort(byPublishUrgency)[0].slug).toBe("scraped-last");
  });
});

describe("rotateRoster", () => {
  const R = ["a", "b", "c", "d", "e"];

  test("rotates without losing or duplicating an operator", () => {
    for (let k = 0; k < 12; k++) {
      const out = rotateRoster(R, k);
      expect(out.length).toBe(R.length);
      expect([...out].sort()).toEqual([...R].sort());
    }
  });

  test("offset 0 is the file order, and the offset wraps", () => {
    expect(rotateRoster(R, 0)).toEqual(R);
    expect(rotateRoster(R, 2)).toEqual(["c", "d", "e", "a", "b"]);
    expect(rotateRoster(R, 5)).toEqual(R);
    expect(rotateRoster(R, 7)).toEqual(rotateRoster(R, 2));
  });

  test("negative and non-integer offsets stay in range instead of producing junk", () => {
    expect(rotateRoster(R, -1)).toEqual(["e", "a", "b", "c", "d"]);
    expect(rotateRoster(R, 2.9)).toEqual(rotateRoster(R, 2));
  });

  test("every operator reaches the front — nobody is permanently last", () => {
    const fronts = new Set(Array.from({ length: R.length }, (_, k) => rotateRoster(R, k)[0]));
    expect(fronts.size).toBe(R.length);
  });

  test("degenerate rosters are returned unharmed, as a copy", () => {
    expect(rotateRoster([], 3)).toEqual([]);
    expect(rotateRoster(["only"], 3)).toEqual(["only"]);
    const src = ["a", "b"]; expect(rotateRoster(src, 1)).not.toBe(src);
  });
});

describe("rosterOffset", () => {
  // A day-based offset would give all three of the day's JSON runs the same front of the list,
  // which is the thing being fixed. It must advance per RUN.
  test("advances between the day's runs, not once a day", () => {
    const a = rosterOffset(new Date("2026-09-09T01:00:00Z"));
    const b = rosterOffset(new Date("2026-09-09T13:00:00Z"));
    const c = rosterOffset(new Date("2026-09-09T19:00:00Z"));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("is stable inside one run, so a retry does not reshuffle mid-flight", () => {
    expect(rosterOffset(new Date("2026-09-09T13:00:00Z")))
      .toBe(rosterOffset(new Date("2026-09-09T13:45:00Z")));
  });

  test("a bad clock yields 0 rather than NaN — file order, never an empty roster", () => {
    expect(rosterOffset(new Date("nope"))).toBe(0);
    expect(rotateRoster(["a", "b", "c"], rosterOffset(new Date("nope")))).toEqual(["a", "b", "c"]);
  });
});
