import { test, expect, beforeEach } from "bun:test";
import { upsertPost, markStatus, recentDrawSlugs, insertMetrics, todayLondon, _setFetch } from "../state.mjs";

let calls;
beforeEach(() => {
  calls = [];
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    return new Response(JSON.stringify([{ date: "2026-07-01", format: "carousel", draw_slugs: ["a", "b"], category: "luxury", status: "published" }]), { status: 200, headers: { "content-type": "application/json" } });
  });
});

test("upsertPost POSTs with on_conflict resolution", async () => {
  await upsertPost({ date: "2026-07-02", format: "carousel", status: "assets_uploaded", category: "luxury", draw_slugs: ["x"] });
  const c = calls[0];
  expect(c.method).toBe("POST");
  expect(c.url).toContain("/rest/v1/carousel_posts");
  expect(c.url).toContain("on_conflict=date%2Cformat");
  expect(c.headers.Prefer).toContain("resolution=merge-duplicates");
  expect(c.body.status).toBe("assets_uploaded");
});

test("markStatus PATCHes by date+format and stamps posted_at on publish", async () => {
  await markStatus("2026-07-02", "carousel", "published", { ig_media_id: "123" });
  const c = calls[0];
  expect(c.method).toBe("PATCH");
  expect(c.url).toContain("date=eq.2026-07-02");
  expect(c.url).toContain("format=eq.carousel");
  expect(c.body.ig_media_id).toBe("123");
  expect(c.body.posted_at).toBeTruthy();
});

test("recentDrawSlugs flattens + dedupes", async () => {
  const slugs = await recentDrawSlugs(7);
  expect(slugs).toEqual(["a", "b"]);
});

test("insertMetrics upserts on day,media_id,metric", async () => {
  await insertMetrics([{ day: "2026-07-01", media_id: "account", metric: "reach", value: 5 }]);
  expect(calls[0].url).toContain("carousel_metrics");
  expect(calls[0].url).toContain("on_conflict=day%2Cmedia_id%2Cmetric");
});

test("todayLondon shape", () => {
  expect(todayLondon()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
