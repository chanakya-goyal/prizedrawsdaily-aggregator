import { test, expect, describe } from "bun:test";
import { sbGetAll, sbCount } from "../lib/sb.mjs";

// A fake PostgREST that honours limit/offset, so paging is exercised for real rather than
// asserted against a stub. Records every URL it was called with.
function fakeRest(totalRows, { failAt = null } = {}) {
  const calls = [];
  const all = Array.from({ length: totalRows }, (_, i) => ({ id: i + 1 }));
  const fetchImpl = async (url) => {
    calls.push(url);
    if (failAt != null && calls.length === failAt) {
      return { status: 401, json: async () => ({ message: "JWT expired" }) };
    }
    const limit = Number(new URL(url).searchParams.get("limit"));
    const offset = Number(new URL(url).searchParams.get("offset"));
    return { status: 200, json: async () => all.slice(offset, offset + limit) };
  };
  return { fetchImpl, calls };
}

describe("sbGetAll — paging past the 1000-row cap", () => {
  test("reads every row across multiple pages", async () => {
    // The exact shape of the ended-sweep bug: 2237 rows behind a 1000-row cap.
    const { fetchImpl, calls } = fakeRest(2237);
    const rows = await sbGetAll("draws?select=id", { key: "k", fetchImpl });
    expect(rows).toHaveLength(2237);
    expect(calls).toHaveLength(3);
  });

  test("a single short page ends the loop without a wasted request", async () => {
    const { fetchImpl, calls } = fakeRest(12);
    expect(await sbGetAll("draws?select=id", { key: "k", fetchImpl })).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  test("an exactly-full final page still terminates", async () => {
    // 2000 rows = two full pages; the third must come back empty and stop the loop.
    const { fetchImpl, calls } = fakeRest(2000);
    expect(await sbGetAll("draws?select=id", { key: "k", fetchImpl })).toHaveLength(2000);
    expect(calls).toHaveLength(3);
  });

  test("rows are not duplicated or skipped across page boundaries", async () => {
    const { fetchImpl } = fakeRest(2500);
    const rows = await sbGetAll("draws?select=id", { key: "k", fetchImpl });
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
  });
});

describe("sbGetAll — ordering is load-bearing", () => {
  test("appends order=id when the caller gave none", async () => {
    // Offset paging over an unordered set may skip or repeat rows between requests. Two
    // pre-existing copies of this loop omitted the ORDER BY and were silently lossy.
    const { fetchImpl, calls } = fakeRest(1500);
    await sbGetAll("draws?select=id", { key: "k", fetchImpl });
    expect(calls.every((u) => u.includes("order=id"))).toBe(true);
  });

  test("never overrides an order the caller chose deliberately", async () => {
    // manager/coverage-report.mjs orders by created_at.asc and depends on it.
    const { fetchImpl, calls } = fakeRest(50);
    await sbGetAll("operators?select=id&order=created_at.asc", { key: "k", fetchImpl });
    expect(calls[0]).toContain("order=created_at.asc");
    expect(calls[0]).not.toContain("order=id");
  });

  test("builds a valid query string for a path with no existing params", async () => {
    const { fetchImpl, calls } = fakeRest(1);
    await sbGetAll("operators", { key: "k", fetchImpl });
    expect(calls[0]).toContain("operators?order=id&limit=");
  });
});

describe("sbGetAll — failure is loud, never silent", () => {
  test("a PostgREST error object throws with the status and message", async () => {
    // Degrading to [] would turn a permissions error into 'there is no data' — a silent
    // no-op on the daily cron, which is the failure this fleet exists to prevent.
    const { fetchImpl } = fakeRest(500, { failAt: 1 });
    await expect(sbGetAll("draws?select=id", { key: "k", fetchImpl })).rejects.toThrow(/401.*JWT expired/);
  });

  test("an error on a later page throws rather than returning a partial read", async () => {
    const { fetchImpl } = fakeRest(2500, { failAt: 2 });
    await expect(sbGetAll("draws?select=id", { key: "k", fetchImpl })).rejects.toThrow(/JWT expired/);
  });

  test("the thrown message names the query so the caller knows what failed", async () => {
    const { fetchImpl } = fakeRest(10, { failAt: 1 });
    await expect(sbGetAll("draws?select=id&status=eq.active", { key: "k", fetchImpl }))
      .rejects.toThrow(/draws\?select=id&status=eq\.active/);
  });
});

describe("sbCount", () => {
  const withRange = (range) => async () => ({
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-range" ? range : null) },
  });

  test("parses the total out of content-range", async () => {
    expect(await sbCount("draws?select=id", { key: "k", fetchImpl: withRange("0-0/3529") })).toBe(3529);
  });

  test("a zero count reads as 0, not as missing", async () => {
    expect(await sbCount("draws?select=id", { key: "k", fetchImpl: withRange("*/0") })).toBe(0);
  });

  test("an unreadable count returns null rather than masquerading as zero", async () => {
    expect(await sbCount("draws?select=id", { key: "k", fetchImpl: withRange("*/*") })).toBe(null);
  });

  test("a thrown fetch returns null rather than breaking the run", async () => {
    const boom = async () => { throw new Error("network"); };
    expect(await sbCount("draws?select=id", { key: "k", fetchImpl: boom })).toBe(null);
  });
});
