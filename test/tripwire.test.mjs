import { test, expect, describe } from "bun:test";
import { evaluateTripwire } from "../manager/tripwire.mjs";

const ok = { activeCount: 400, floor: 150, target: 350, scrapeOutcome: "success", freshCount: 20 };

describe("evaluateTripwire — hard failures (red)", () => {
  test("healthy run does not trip", () => {
    const r = evaluateTripwire(ok);
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  test("scrape failure trips regardless of count", () => {
    const r = evaluateTripwire({ ...ok, activeCount: 900, scrapeOutcome: "failure" });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("scrape step");
  });
  test("skipped scrape trips (the Aug-2026 failure mode)", () => {
    expect(evaluateTripwire({ ...ok, scrapeOutcome: "skipped" }).tripped).toBe(true);
  });
  test("inventory under the floor trips with both numbers in the reason", () => {
    const r = evaluateTripwire({ ...ok, activeCount: 149, floor: 150 });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("149");
    expect(r.reasons.join(" ")).toContain("150");
  });
  test("unknown count with a good scrape does not trip on the floor", () => {
    expect(evaluateTripwire({ ...ok, activeCount: null }).tripped).toBe(false);
  });
  test("zero new draws in 24h trips — a scrape that ran but produced nothing", () => {
    const r = evaluateTripwire({ ...ok, freshCount: 0 });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("last 24h");
  });
  test("unknown freshCount does not trip (a failed count must not red the run)", () => {
    expect(evaluateTripwire({ ...ok, freshCount: null }).tripped).toBe(false);
  });
  test("minFresh is configurable", () => {
    expect(evaluateTripwire({ ...ok, freshCount: 4, minFresh: 5 }).tripped).toBe(true);
    expect(evaluateTripwire({ ...ok, freshCount: 5, minFresh: 5 }).tripped).toBe(false);
  });
});

describe("evaluateTripwire — targets and watch signals (green)", () => {
  // The regression this file exists to prevent: Aug 15-18 2026 went red four days running
  // because 230 active was under an aspirational 350 floor, while the scrape was succeeding.
  test("below target but above floor warns WITHOUT tripping", () => {
    const r = evaluateTripwire({ ...ok, activeCount: 230, floor: 150, target: 350 });
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.warnings.join(" ")).toContain("230");
    expect(r.warnings.join(" ")).toContain("350");
  });
  test("at or above target produces no warning", () => {
    expect(evaluateTripwire({ ...ok, activeCount: 350, target: 350 }).warnings).toEqual([]);
  });
  test("under the floor reports as broken, not merely below target", () => {
    const r = evaluateTripwire({ ...ok, activeCount: 100, floor: 150, target: 350 });
    expect(r.tripped).toBe(true);
    expect(r.warnings.join(" ")).not.toContain("below the target");
  });
  test("drafts that expired unpublished warn but never break the build", () => {
    const r = evaluateTripwire({ ...ok, expiredDrafts: 79 });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("79");
    expect(r.warnings.join(" ")).toContain("unpublished");
  });
  test("no expired drafts produces no warning", () => {
    expect(evaluateTripwire({ ...ok, expiredDrafts: 0 }).warnings).toEqual([]);
  });
});

describe("evaluateTripwire — per-category and per-operator signals", () => {
  // A total-inventory check cannot see cars collapsing while cash grows: the site sat at
  // 5 live car draws against 86 cash-prizes and the aggregate looked healthy throughout.
  test("a category under its floor warns without tripping", () => {
    const r = evaluateTripwire({ ...ok, byCategory: { "car-draws": 5, "cash-prizes": 86 }, categoryFloors: { "car-draws": 10 } });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("5 live car-draws");
  });
  test("a category at or above its floor is quiet", () => {
    const r = evaluateTripwire({ ...ok, byCategory: { "car-draws": 40 }, categoryFloors: { "car-draws": 10 } });
    expect(r.warnings.join(" ")).not.toContain("car-draws");
  });
  test("a category missing entirely counts as zero", () => {
    const r = evaluateTripwire({ ...ok, byCategory: {}, categoryFloors: { "house-draws": 2 } });
    expect(r.warnings.join(" ")).toContain("only 0 live house-draws");
  });

  // "Silent operator" was only ever a log line, so operators stayed dark for months. The
  // actionable signal is inventory-but-no-new-rows: the parser broke under us.
  test("an operator with inventory but no new rows warns by name", () => {
    const r = evaluateTripwire({ ...ok, stalledOperators: [{ slug: "seven-days-perf", live: 12, daysQuiet: 5 }] });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("seven-days-perf");
    expect(r.warnings.join(" ")).toContain("12 live");
  });
  test("no stalled operators produces no warnings", () => {
    expect(evaluateTripwire({ ...ok, stalledOperators: [] }).warnings).toEqual([]);
  });
  test("these signals never turn the run red on their own", () => {
    const r = evaluateTripwire({
      ...ok,
      byCategory: { "car-draws": 0 }, categoryFloors: { "car-draws": 10 },
      stalledOperators: [{ slug: "x", live: 9, daysQuiet: 5 }],
      expiredDrafts: 40,
    });
    expect(r.tripped).toBe(false);
    expect(r.warnings.length).toBe(3);
  });
});
