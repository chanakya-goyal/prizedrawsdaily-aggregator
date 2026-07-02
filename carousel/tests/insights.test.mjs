import { test, expect } from "bun:test";
import { mapPayload } from "../insights.mjs";

test("ig_media maps to per-media likes/comments rows with London day", async () => {
  const rows = mapPayload("ig_media", await Bun.file("carousel/tests/fixtures/ig_media.json").json());
  const likes = rows.find((r) => r.metric === "likes");
  expect(likes.media_id).toMatch(/^\d+$/);
  expect(likes.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof likes.value).toBe("number");
});

test("ig_reach maps to account rows", async () => {
  const rows = mapPayload("ig_reach", await Bun.file("carousel/tests/fixtures/ig_reach.json").json());
  expect(rows.every((r) => r.media_id === "account" && r.metric === "reach")).toBe(true);
});

test("fb_posts maps reactions/comments/shares, missing keys → 0", async () => {
  const rows = mapPayload("fb_posts", await Bun.file("carousel/tests/fixtures/fb_posts.json").json());
  expect(rows.filter((r) => r.metric === "fb_shares").every((r) => typeof r.value === "number")).toBe(true);
});

test("unknown kind throws", () => {
  expect(() => mapPayload("tiktok", {})).toThrow(/unknown kind/i);
});
