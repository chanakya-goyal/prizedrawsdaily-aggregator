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

// Storage is the quota that took the whole project down on 2026-08-19 (402 on every
// service, site served empty pages). It reds EARLY and deliberately: Supabase bills
// the period average, and reducing usage does not lift a restriction — so overshooting
// costs weeks. These tests pin the thresholds and the fail-open behaviour.
describe("evaluateTripwire — storage budget", () => {
  const GB = 1073741824;

  test("comfortable usage is silent", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: 0.32 * GB });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).not.toContain("storage");
  });

  test("crossing the warn line warns but stays green", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: 0.75 * GB });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("storage at 0.75 GB");
    expect(r.warnings.join(" ")).toContain("75%");
  });

  test("crossing the red line trips the run", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: 0.93 * GB });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("93%");
    expect(r.reasons.join(" ")).toContain("site goes down");
  });

  // A telemetry call that fails must never be the thing that reds the daily run.
  test("an unreadable storage figure is ignored entirely", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: null });
    expect(r.tripped).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  test("thresholds are configurable", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: 0.5 * GB, storageRedPct: 40 });
    expect(r.tripped).toBe(true);
  });

  // Guards the boundary: exactly at the line must fire, not sit one byte under it.
  test("exactly on the warn line fires", () => {
    const r = evaluateTripwire({ ...ok, storageBytes: 0.7 * GB });
    expect(r.warnings.join(" ")).toContain("storage");
    expect(r.tripped).toBe(false);
  });
});

describe("evaluateTripwire — status/date disagreement", () => {
  // Measured 2026-08-30: 397 of 759 active rows had a passed draw_date. The alarm counted
  // all 759, so a collapse to ~200 enterable draws would still have printed green against
  // a floor of 150. These warn; they never red the run — correcting them belongs to
  // ended-sweep and apply-stale-dates, not to the daily alarm.
  test("stale-dated active rows warn without tripping", () => {
    const r = evaluateTripwire({ ...ok, staleActive: 397 });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("397");
    expect(r.warnings.join(" ")).toContain("draw_date already passed");
  });

  test("future-dated ended rows warn without tripping", () => {
    const r = evaluateTripwire({ ...ok, futureEnded: 12 });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).toContain("12");
    expect(r.warnings.join(" ")).toContain("expired early");
  });

  test("neither signal is reported when the database agrees with itself", () => {
    const r = evaluateTripwire({ ...ok, staleActive: 0, futureEnded: 0 });
    expect(r.warnings.join(" ")).not.toContain("draw_date");
  });

  // The regression this whole PR exists to prevent: the floor must be compared against the
  // date-guarded count. A caller passing the unguarded 759 would hide a real collapse.
  test("a below-floor enterable count still trips even with plenty of stale rows around", () => {
    const r = evaluateTripwire({ ...ok, activeCount: 120, floor: 150, staleActive: 397 });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toContain("120");
  });
});

// ---- operators that have NEVER produced ----
// stalledOperators requires >=3 live draws, so an operator that produced nothing from the day
// it was added qualifies for no alert at all. 21 sat in that state, some for 100+ days.
describe("deadOperators", () => {
  const base = { activeCount: 500, floor: 150, scrapeOutcome: "success", freshCount: 20 };

  test("warns, never reddens — 21 known-bad operators must not fail the build daily", () => {
    const r = evaluateTripwire({
      ...base,
      deadOperators: [{ slug: "jammy", days: 100, reason: "blocked (503 — refused our IP)" }],
    });
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.warnings.join(" ")).toContain("jammy");
  });

  test("carries the cause, which is what makes it actionable", () => {
    const r = evaluateTripwire({
      ...base,
      deadOperators: [{ slug: "winmore", days: 40, reason: "reachable — parser found nothing (our bug, or no open comps)" }],
    });
    expect(r.warnings.join(" ")).toContain("parser found nothing");
  });

  test("summarises rather than listing all of them", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ slug: `op-${i}`, days: 30, reason: "blocked (403 — refused our IP)" }));
    const w = evaluateTripwire({ ...base, deadOperators: many }).warnings.join(" ");
    expect(w).toContain("21 operator(s)");
    expect(w).toContain("+13 more");
  });

  test("silent when there are none", () => {
    const r = evaluateTripwire({ ...base, deadOperators: [] });
    expect(r.warnings.join(" ")).not.toContain("produced none");
  });
});

// publishableDrafts — the actionable counterpart to expiredDrafts. Measured 2026-09-02:
// 393 enterable-and-active vs 276 enterable-and-draft, and nothing in the pipeline said so.
describe("publishableDrafts", () => {
  const base = { activeCount: 400, floor: 150, scrapeOutcome: "success", freshCount: 5 };

  test("warns when enterable drafts are sitting unpublished", () => {
    const r = evaluateTripwire({ ...base, publishableDrafts: 276 });
    expect(r.warnings.some((w) => w.includes("276 draft(s) are still enterable"))).toBe(true);
  });

  test("never fails the run — holding a draft is a deliberate QA decision", () => {
    const r = evaluateTripwire({ ...base, publishableDrafts: 5000 });
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("is silent at zero, and silent when not measured", () => {
    expect(evaluateTripwire({ ...base, publishableDrafts: 0 }).warnings.some((w) => w.includes("enterable and unpublished"))).toBe(false);
    expect(evaluateTripwire({ ...base, publishableDrafts: null }).warnings.some((w) => w.includes("enterable and unpublished"))).toBe(false);
  });

  test("is distinct from expiredDrafts — one is lost inventory, the other is savable", () => {
    const r = evaluateTripwire({ ...base, expiredDrafts: 155, publishableDrafts: 276 });
    expect(r.warnings.some((w) => w.includes("passed their draw date unpublished"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("still enterable and unpublished"))).toBe(true);
  });
});

// ── "unknown" is not a failure ──────────────────────────────────────────────────────────
// SCRAPE_OUTCOME is set by the workflow (`steps.scrape.outcome`) and by nothing else. The CLI
// defaulted it to the string "unknown" and the check was `!== "success"`, so ANY run outside
// the pipeline reported 🔴 Broken. That matters now the daily QA routine runs tripwire.mjs
// standalone every day: on 2026-09-09 it opened with "🔴 Broken: scrape step outcome was
// 'unknown'" while all four of that day's Action runs had in fact succeeded. An alarm that is
// red every single day is the exact failure this file's own header warns about.
//
// So absence of the measurement is reported as absence — the same rule the file already applies
// to activeCount and freshCount, where null means "not measured" and never reds the run.
describe("evaluateTripwire — an UNOBSERVED scrape outcome", () => {
  const noOutcome = { activeCount: 400, floor: 150, target: 350, freshCount: 20 };

  test("null does not trip — running outside the pipeline is not a broken pipeline", () => {
    const r = evaluateTripwire({ ...noOutcome, scrapeOutcome: null });
    expect(r.tripped).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("the literal string 'unknown' is treated as unobserved, not as a failure", () => {
    expect(evaluateTripwire({ ...noOutcome, scrapeOutcome: "unknown" }).tripped).toBe(false);
  });

  test("an empty string is unobserved too", () => {
    expect(evaluateTripwire({ ...noOutcome, scrapeOutcome: "" }).tripped).toBe(false);
  });

  test("but it says so in the warnings, so a green report never implies the scrape was checked", () => {
    const r = evaluateTripwire({ ...noOutcome, scrapeOutcome: null });
    expect(r.warnings.join(" ")).toMatch(/scrape outcome not checked/i);
  });

  // The protection this must NOT lose. If someone deletes the SCRAPE_OUTCOME line from
  // aggregate.yml, the alarm would silently stop watching the thing it was built to watch.
  test("in CI an unobserved outcome still trips — the workflow lost its wiring", () => {
    const r = evaluateTripwire({ ...noOutcome, scrapeOutcome: null, requireScrapeOutcome: true });
    expect(r.tripped).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/not supplied/i);
  });

  test("a real failure still trips whether or not it is required", () => {
    expect(evaluateTripwire({ ...noOutcome, scrapeOutcome: "failure" }).tripped).toBe(true);
    expect(evaluateTripwire({ ...noOutcome, scrapeOutcome: "skipped", requireScrapeOutcome: true }).tripped).toBe(true);
  });

  test("success is still success, and adds no warning", () => {
    const r = evaluateTripwire({ ...noOutcome, scrapeOutcome: "success", requireScrapeOutcome: true });
    expect(r.tripped).toBe(false);
    expect(r.warnings.join(" ")).not.toMatch(/scrape outcome not checked/i);
  });
});
