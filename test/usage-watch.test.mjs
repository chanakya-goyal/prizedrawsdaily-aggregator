// The Supabase egress alarm. Supabase has no egress API on the Free plan, so usage-watch.mjs
// measures what it CAN read — API requests, counted by pg_stat_statements — and turns them into
// an egress estimate with a calibrated bytes-per-request figure. These pin the arithmetic and the
// thresholds, including the two ways the counter lies: a stats reset, and a first run with no
// previous snapshot.
import { test, expect, describe } from "bun:test";
import { requestRates, assessUsage, toSnapshot, DEFAULTS } from "../lib/usage-watch.mjs";

const T0 = Date.parse("2026-10-01T07:00:00Z");
const DAY = 864e5;
const snap = (dayOffset, { anon = 0, service = 0, auth = 0, storage = 0, reset = "2026-09-30T00:00:00Z" } = {}) => ({
  taken_at: new Date(T0 + dayOffset * DAY).toISOString(),
  rest_anon: anon, rest_service: service, rest_authenticated: auth, storage, stats_reset: reset,
});

describe("requestRates", () => {
  test("per-day rate from consecutive snapshots", () => {
    const r = requestRates([snap(0, { anon: 1000, service: 100 }), snap(1, { anon: 21000, service: 1100 }), snap(2, { anon: 41000, service: 2100 })]);
    expect(r.rest).toBeCloseTo(21000, 0); // (20000 + 1000) per day
    expect(r.anon).toBeCloseTo(20000, 0);
    expect(r.service).toBeCloseTo(1000, 0);
    expect(r.basis).toBe("snapshots");
    expect(r.days).toBeCloseTo(2, 5);
  });

  test("a stats reset between snapshots counts from the reset, never a negative day", () => {
    const r = requestRates([
      snap(0, { anon: 50000 }),
      snap(1, { anon: 5000, reset: "2026-10-01T20:00:00Z" }), // counter restarted at 20:00
    ]);
    expect(r.anon).toBeGreaterThan(0);
    // 5,000 requests in the 11 h since the reset, not spread over the whole day.
    expect(r.anon).toBeCloseTo(5000 / (11 / 24), 0);
    expect(r.resets).toBe(1);
  });

  test("a counter that went backwards without a new reset time is also treated as a reset", () => {
    const r = requestRates([snap(0, { anon: 50000 }), snap(1, { anon: 3000 })]);
    expect(r.anon).toBeCloseTo(3000, 0);
    expect(r.resets).toBe(1);
  });

  test("only snapshots inside the window count", () => {
    const r = requestRates([snap(0, { anon: 0 }), snap(10, { anon: 1_000_000 }), snap(11, { anon: 1_010_000 })], { windowDays: 7, now: T0 + 11 * DAY });
    expect(r.anon).toBeCloseTo(10000, 0);
  });

  test("first run: no previous snapshot, so the rate is the total since the stats reset", () => {
    const r = requestRates([snap(2, { anon: 40000, reset: "2026-10-01T07:00:00Z" })]);
    expect(r.basis).toBe("since-reset");
    expect(r.anon).toBeCloseTo(20000, 0); // 40,000 over the 2 days since the reset
  });

  test("first run with a reset under an hour ago gives no rate rather than a wild one", () => {
    const r = requestRates([snap(0, { anon: 500, reset: new Date(T0 - 10 * 60e3).toISOString() })]);
    expect(r.basis).toBe("none");
    expect(r.rest).toBeNull();
  });
});

describe("assessUsage", () => {
  const rates = (rest, anon = rest, service = 0) => ({ rest, anon, service, authenticated: 0, storage: 0, basis: "snapshots", days: 7, resets: 0 });

  test("defaults: 5 GB quota, 4.2 KB per request, alarm at 50%, red at 80%", () => {
    expect(DEFAULTS.quotaBytes).toBe(5e9);
    expect(DEFAULTS.bytesPerRequest).toBe(4200);
    expect(DEFAULTS.warnAt).toBe(0.5);
    expect(DEFAULTS.redAt).toBe(0.8);
  });

  test("comfortable usage is quiet", () => {
    const a = assessUsage({ rates: rates(5000) }); // 5000 × 30 × 4200 = 0.63 GB = 12.6%
    expect(a.level).toBe("ok");
    expect(a.lines.join(" ")).toContain("12.6%");
  });

  test("50% of the quota warns", () => {
    const a = assessUsage({ rates: rates(20000) }); // 2.52 GB = 50.4%
    expect(a.level).toBe("warn");
  });

  test("80% of the quota goes red", () => {
    const a = assessUsage({ rates: rates(32000) }); // 4.03 GB = 80.6%
    expect(a.level).toBe("red");
  });

  test("the old project's measured load (~24.5k requests/day) would have gone red", () => {
    expect(assessUsage({ rates: rates(24500) }).level).toBe("warn"); // 3.09 GB = 61.7%
    // …and with the September payloads it did go over; the byte figure is configurable:
    expect(assessUsage({ rates: rates(24500), bytesPerRequest: 7000 }).level).toBe("red");
  });

  test("bytes per request and quota are configurable", () => {
    expect(assessUsage({ rates: rates(10000), bytesPerRequest: 9000 }).level).toBe("warn");
    expect(assessUsage({ rates: rates(10000), quotaBytes: 250e9 }).level).toBe("ok");
  });

  test("the line names the site and scraper split and the per-day figure", () => {
    const a = assessUsage({ rates: rates(12000, 11000, 1000) });
    const text = a.lines.join(" ");
    expect(text).toContain("12,000");
    expect(text).toContain("site 11,000");
    expect(text).toContain("scraper 1,000");
  });

  test("not installed yet is a note, never an alarm", () => {
    const a = assessUsage({ missing: "function public.api_request_total() not found" });
    expect(a.level).toBe("note");
    expect(a.lines.join(" ")).toContain("sql/2026-10-09-usage-snapshots.sql");
  });

  test("a failed read is a note, never an alarm", () => {
    const a = assessUsage({ error: "HTTP 503" });
    expect(a.level).toBe("note");
  });

  test("no rate yet is a note", () => {
    const a = assessUsage({ rates: { rest: null, basis: "none" } });
    expect(a.level).toBe("note");
  });
});

describe("toSnapshot", () => {
  test("maps the RPC row to a snapshot row with numbers", () => {
    const s = toSnapshot({ rest_anon: "10", rest_service: "2", rest_authenticated: "1", storage: "3", stats_reset: "2026-10-08T21:58:16Z" }, new Date(T0));
    expect(s).toEqual({ taken_at: new Date(T0).toISOString(), rest_anon: 10, rest_service: 2, rest_authenticated: 1, storage: 3, stats_reset: "2026-10-08T21:58:16Z" });
  });
});
