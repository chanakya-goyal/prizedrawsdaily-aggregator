import { test, expect, describe } from "bun:test";
import { wooPageUrl, shouldStopPaging, WOO_PER_PAGE } from "../extractor.mjs";

// Woo catalogues are ARCHIVES, not inventories: capital-competitions returns 18,616 products
// and gaming-giveaways 9,894, nearly all finished. Since every kept product costs an HTML
// fetch, paging to the end is tens of thousands of requests for a few dozen live draws. The
// `after=` filter bounds it server-side (gaming-giveaways: 9,894 -> ~195 at 90 days).
describe("wooPageUrl", () => {
  const op = { base: "https://x.co.uk" };

  test("requests the API maximum page size", () => {
    expect(WOO_PER_PAGE).toBe(100);
    expect(wooPageUrl(op, { page: 1 })).toContain("per_page=100");
  });
  test("carries the page number and newest-first ordering", () => {
    const u = wooPageUrl(op, { page: 3 });
    expect(u).toContain("page=3");
    expect(u).toContain("orderby=date");
    expect(u).toContain("order=desc");
  });
  test("includes and encodes the after= bound", () => {
    expect(wooPageUrl(op, { page: 1, after: "2026-05-21T00:00:00" })).toContain(`after=${encodeURIComponent("2026-05-21T00:00:00")}`);
  });
  test("omits after= entirely when not given", () => {
    expect(wooPageUrl(op, { page: 1 })).not.toContain("after=");
  });
  test("honours the ?rest_route= form for hosts that 500 the pretty route", () => {
    const u = wooPageUrl({ base: "https://x.co.uk", apiStyle: "rest_route" }, { page: 2 });
    expect(u).toContain("?rest_route=/wc/store/v1/products");
    expect(u).toContain("page=2");
  });
});

describe("shouldStopPaging", () => {
  const base = { returned: 100, liveSoFar: 0, target: 60, page: 1, maxPages: 5, emptyStreak: 0 };

  test("keeps going mid-catalogue", () => {
    expect(shouldStopPaging(base)).toBe(null);
  });
  test("stops on a short page — there is no next one", () => {
    expect(shouldStopPaging({ ...base, returned: 42 })).toBe("last page");
  });
  test("stops once the live target is met", () => {
    expect(shouldStopPaging({ ...base, liveSoFar: 60 })).toBe("target reached");
  });
  test("stops at the page cap", () => {
    expect(shouldStopPaging({ ...base, page: 5, maxPages: 5 })).toBe("page cap");
  });
  // Products come newest-first, so two consecutive dead pages means we are in the archive.
  test("stops after two consecutive pages with no live products", () => {
    expect(shouldStopPaging({ ...base, emptyStreak: 1 })).toBe(null);
    expect(shouldStopPaging({ ...base, emptyStreak: 2 })).toBe("two pages with no live products");
  });
  test("a full page that met the target still stops", () => {
    expect(shouldStopPaging({ ...base, returned: 100, liveSoFar: 99, target: 60 })).toBe("target reached");
  });
});
