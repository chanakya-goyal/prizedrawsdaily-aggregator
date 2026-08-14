import { test, expect, describe } from "bun:test";
import { evaluateTripwire } from "../manager/tripwire.mjs";

describe("evaluateTripwire", () => {
  test("healthy run does not trip", () => {
    const r = evaluateTripwire({ activeCount: 400, floor: 350, scrapeOutcome: "success" });
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  test("scrape failure trips regardless of count", () => {
    const r = evaluateTripwire({ activeCount: 900, floor: 350, scrapeOutcome: "failure" });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("scrape step");
  });
  test("skipped scrape trips (the Aug-2026 failure mode)", () => {
    expect(evaluateTripwire({ activeCount: 400, floor: 350, scrapeOutcome: "skipped" }).tripped).toBe(true);
  });
  test("inventory under floor trips with both numbers in the reason", () => {
    const r = evaluateTripwire({ activeCount: 349, floor: 350, scrapeOutcome: "success" });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("349");
    expect(r.reasons.join(" ")).toContain("350");
  });
  test("unknown count with a good scrape does not trip on the floor", () => {
    expect(evaluateTripwire({ activeCount: null, floor: 350, scrapeOutcome: "success" }).tripped).toBe(false);
  });
});
