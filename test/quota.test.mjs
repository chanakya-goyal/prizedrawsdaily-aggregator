import { expect, test, describe } from "bun:test";
import { perDay, daysLeft, assessQuotas, DEFAULTS } from "../lib/quota.mjs";

// Why this file exists: every outage so far was a free limit that filled with nobody looking,
// and the old alarms watched only a percentage. A limit at 40% that doubles every few days
// must alarm long before 80%; a limit at 85% that is shrinking must not cry wolf forever.

const days = (vals, start = "2026-10-01") =>
  vals.map((value, i) => ({ day: new Date(Date.parse(`${start}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10), value }));
const metric = (over) => ({ key: "m", label: "Thing", value: 100, limit: 1000, unit: "files", history: [], ...over });

describe("perDay — the trend", () => {
  test("a steady climb reads as its daily step", () => {
    expect(perDay(days([100, 110, 120, 130]))).toBeCloseTo(10, 6);
  });
  test("only the last 7 days count", () => {
    // A burst 10 days ago no longer drives the forecast.
    expect(perDay(days([0, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500]))).toBeCloseTo(0, 6);
  });
  test("needs readings spanning at least a day", () => {
    expect(perDay(days([5]))).toBe(null);
    expect(perDay([])).toBe(null);
  });
});

describe("daysLeft", () => {
  test("flat or shrinking never fills", () => {
    expect(daysLeft(500, 1000, 0)).toBe(Infinity);
    expect(daysLeft(500, 1000, -3)).toBe(Infinity);
  });
  test("room divided by the daily rate", () => {
    expect(daysLeft(400, 1000, 30)).toBe(20);
  });
});

describe("assessQuotas", () => {
  test("low and flat is ok", () => {
    expect(assessQuotas([metric({ history: days([100, 100, 100]) })]).level).toBe("ok");
  });

  test("80% used is a warning, 90% is red", () => {
    expect(assessQuotas([metric({ value: 800 })]).level).toBe("warn");
    expect(assessQuotas([metric({ value: 900 })]).level).toBe("red");
  });

  test("a LOW limit filling fast alarms long before 80%", () => {
    // 400 of 1000, +30 a day: full in 20 days → warn; +100 a day: 6 days → red.
    expect(assessQuotas([metric({ value: 400, history: days([340, 370, 400]) })]).level).toBe("warn");
    expect(assessQuotas([metric({ value: 400, history: days([200, 300, 400]) })]).level).toBe("red");
  });

  test("the defaults are 80/90% and 21/7 days", () => {
    expect([DEFAULTS.warnShare, DEFAULTS.redShare, DEFAULTS.warnDays, DEFAULTS.redDays]).toEqual([0.8, 0.9, 21, 7]);
  });

  test("a metric can set its own thresholds (the egress estimate warns at 50%)", () => {
    expect(assessQuotas([metric({ value: 550, warnShare: 0.5, redShare: 0.8 })]).level).toBe("warn");
  });

  test("a projection opts out of the forecast", () => {
    const r = assessQuotas([metric({ value: 300, forecast: false, history: days([0, 150, 300]) })]);
    expect(r.level).toBe("ok");
    expect(r.rows[0].change).toBe("—");
  });

  test("a self-evicting cache never goes red", () => {
    expect(assessQuotas([metric({ value: 999, warnShare: 0.95, redShare: Infinity, forecast: false })]).level).toBe("warn");
  });

  test("a failed or missing reading is a note, never an alarm", () => {
    const r = assessQuotas([metric({ error: "timeout" }), metric({ key: "n", note: "not set up" }), metric({ key: "o", value: undefined })]);
    expect(r.level).toBe("ok");
    expect(r.rows.every((x) => x.level === "note")).toBe(true);
  });

  test("the worst metric sets the level, and only alarming rows carry a hint", () => {
    const r = assessQuotas([metric({ key: "a", hint: "fix a" }), metric({ key: "b", value: 950, hint: "fix b" })]);
    expect(r.level).toBe("red");
    expect(r.lines.join("\n")).toContain("fix b");
    expect(r.lines.join("\n")).not.toContain("fix a");
  });

  test("bytes print in MB / GB", () => {
    const r = assessQuotas([metric({ unit: "bytes", value: 22e6, limit: 500e6 }), metric({ key: "g", unit: "bytes", value: 1.5e9, limit: 5e9 })]);
    expect(r.rows[0].value).toBe("22 MB");
    expect(r.rows[1].value).toBe("1.50 GB");
  });
});
