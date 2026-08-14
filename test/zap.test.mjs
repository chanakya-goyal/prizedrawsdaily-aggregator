import { test, expect, describe } from "bun:test";
import { detectZap, parseZapRefresh, mergeZap } from "../lib/zap.mjs";

describe("zap competitions (craic-competitions plugin)", () => {
  test("detectZap fires on the real storm-competitions fixture", async () => {
    const html = await Bun.file("test/fixtures/woo/storm-competitions.product.html").text();
    expect(detectZap(html)).toBe(true);
    expect(detectZap("<html><body>plain woo shop</body></html>")).toBe(false);
  });
  test("parseZapRefresh maps the real ajax response to cap + date", () => {
    // captured live 2026-08-14 from stormcompetitions.co.uk admin-ajax zap_competition_ajax_refresh
    const json = { "2493966": { tickets_max: "499", tickets_sold: 0, tickets_remaining: 499, tickets_percentage: 0, tickets_max_user: "100", tickets_days_remaining: 16 } };
    const now = new Date("2026-08-14T06:00:00Z");
    const rows = parseZapRefresh(json, now);
    expect(rows["2493966"].total_entries).toBe(499);
    expect(rows["2493966"].draw_date.slice(0, 10)).toBe("2026-08-30");
  });
  test("parseZapRefresh tolerates junk", () => {
    expect(parseZapRefresh(null, new Date())).toEqual({});
    expect(parseZapRefresh({ x: { tickets_max: "0" } }, new Date()).x).toEqual({});
  });
  test("mergeZap fills only missing fields, never overrides parsed values", () => {
    const draw = { title: "t", total_entries: null, draw_date: null };
    mergeZap(draw, { total_entries: 499, draw_date: "2026-08-30T06:00:00.000Z" });
    expect(draw.total_entries).toBe(499);
    expect(draw.draw_date).toBe("2026-08-30T06:00:00.000Z");
    const parsed = { title: "t", total_entries: 1000, draw_date: "2026-09-01" };
    mergeZap(parsed, { total_entries: 499, draw_date: "2026-08-30" });
    expect(parsed.total_entries).toBe(1000);
    expect(parsed.draw_date).toBe("2026-09-01");
    mergeZap(draw, undefined); // no zap row for this id → no-op
    expect(draw.total_entries).toBe(499);
  });
});
