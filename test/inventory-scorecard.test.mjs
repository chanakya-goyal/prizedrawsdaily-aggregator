import { test, expect, describe } from "bun:test";
import { scoreInventory, evaluateGates } from "../manager/inventory-scorecard.mjs";

// The real shape measured 2026-08-30, before any Section 1 fix landed. Kept as the
// regression anchor: if the index ever reports this state as healthy, the index is broken.
const AUG30 = { active: 759, enterable: 362, staleActive: 397, futureEnded: 12, deadAssets: 6 };

describe("scoreInventory — the metric that matters", () => {
  test("the 2026-08-30 state scores far below 90", () => {
    const { score } = scoreInventory(AUG30);
    expect(score).toBeLessThan(70);
  });

  test("status/date agreement reflects the real 397+12 disagreement", () => {
    const { metrics } = scoreInventory(AUG30);
    const m = metrics.find((x) => x.key === "status_date_agreement");
    // (759 - 397) / (759 + 12) = 0.469
    expect(m.value).toBeCloseTo(0.469, 2);
  });

  test("a clean database scores 100", () => {
    const { score } = scoreInventory({
      active: 362, enterable: 362, staleActive: 0, futureEnded: 0, deadAssets: 0,
      sweptRows: 500, sweepScope: 500, holds: 0, tripwireActive: 362,
      guardedPaths: 4, totalPaths: 4,
    });
    expect(score).toBe(100);
  });

  test("an alarm reporting the unguarded count scores zero on alarm truth", () => {
    // Reporting 759 when 362 are enterable is a 110% overshoot — not 'slightly wrong'.
    const { metrics } = scoreInventory({ ...AUG30, tripwireActive: 759 });
    expect(metrics.find((x) => x.key === "alarm_truth").value).toBe(0);
  });

  test("an alarm reporting the guarded count scores full marks", () => {
    const { metrics } = scoreInventory({ ...AUG30, tripwireActive: 362 });
    expect(metrics.find((x) => x.key === "alarm_truth").value).toBe(1);
  });
});

describe("scoreInventory — unmeasured inputs must not read as failures", () => {
  test("a metric with null inputs is excluded from the denominator, not scored zero", () => {
    const { score, availableWeight } = scoreInventory({
      active: 362, enterable: 362, staleActive: 0, futureEnded: 0, deadAssets: 0,
      // sweep, verdicts, alarm and ingest-guard all unmeasured
    });
    expect(availableWeight).toBe(40); // agreement 30 + asset integrity 10
    expect(score).toBe(100);          // what WAS measured was perfect
  });

  test("availableWeight is reported so a partial score can't be mistaken for a full one", () => {
    const { availableWeight } = scoreInventory(AUG30);
    expect(availableWeight).toBeLessThan(100);
  });


  test("a missing stale-date report excludes verdict coverage instead of scoring it zero", () => {
    // Regression: the first cut computed `holds ?? staleActive`, so an absent report read as
    // "every row held" and the metric scored 0% while its own detail line said "not measured".
    const { metrics, availableWeight } = scoreInventory(AUG30);
    expect(metrics.find((x) => x.key === "verdict_coverage").value).toBe(null);
    // Only agreement (30) and asset integrity (10) have inputs in this fixture.
    expect(availableWeight).toBe(40);
  });

  test("a report with zero holds scores full marks", () => {
    const { metrics } = scoreInventory({ ...AUG30, holds: 0, verdictTotal: 472 });
    expect(metrics.find((x) => x.key === "verdict_coverage").value).toBe(1);
  });

  test("verdict coverage uses the report's own total, not staleActive", () => {
    // The sweep covers active+draft, staleActive counts active only. Mixing them gave
    // "469 of 422 held" — a ratio above 1 that clamped to a meaningless 0%.
    const { metrics } = scoreInventory({ ...AUG30, holds: 469, verdictTotal: 472 });
    const m = metrics.find((x) => x.key === "verdict_coverage");
    expect(m.value).toBeCloseTo(3 / 472, 4);
    expect(m.detail).toContain("of 472");
  });

  test("holds without a report total is unmeasurable, not zero", () => {
    const { metrics } = scoreInventory({ ...AUG30, holds: 469 });
    expect(metrics.find((x) => x.key === "verdict_coverage").value).toBe(null);
  });

  test("all-null inputs yield a null score rather than a misleading 0 or 100", () => {
    expect(scoreInventory({}).score).toBe(null);
  });
});

describe("scoreInventory — ratios stay clamped", () => {
  test("a sweep that read more than its scope does not score above 100%", () => {
    const { metrics } = scoreInventory({ ...AUG30, sweptRows: 1200, sweepScope: 1000 });
    expect(metrics.find((x) => x.key === "sweep_coverage").value).toBe(1);
  });

  test("more dead assets than enterable draws floors at 0, never negative", () => {
    const { metrics } = scoreInventory({ ...AUG30, enterable: 5, deadAssets: 50 });
    expect(metrics.find((x) => x.key === "asset_integrity").value).toBe(0);
  });
});

describe("evaluateGates", () => {
  test("a truncated sweep fails the coverage gate even when everything else passes", () => {
    const gates = evaluateGates({ sweptRows: 1000, sweepScope: 1379, testsPass: true, unbackedBranches: 0, deadKeyRefs: 0 });
    expect(gates.find((g) => g.key === "sweep_read_everything").pass).toBe(false);
    expect(gates.filter((g) => !g.pass)).toHaveLength(1);
  });

  test("all four gates pass on a clean repo", () => {
    const gates = evaluateGates({ sweptRows: 1379, sweepScope: 1379, testsPass: true, unbackedBranches: 0, deadKeyRefs: 0 });
    expect(gates.every((g) => g.pass)).toBe(true);
  });

  test("an unmeasured gate fails rather than passing by default", () => {
    const gates = evaluateGates({});
    expect(gates.some((g) => g.pass)).toBe(false);
  });
});
