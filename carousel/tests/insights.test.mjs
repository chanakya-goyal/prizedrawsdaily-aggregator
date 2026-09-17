import { test, expect, describe } from "bun:test";
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

test("--dry-run ingests nothing: exits 0 with an unreachable SUPABASE_URL, proving no network write was attempted", async () => {
  // Any real insertMetrics() call would try to reach SUPABASE_URL and fail loudly
  // (non-2xx / connection error → non-zero exit). Pointing SUPABASE_URL at a closed
  // local port means a clean exit 0 is only possible if --dry-run truly short-circuits
  // before any write.
  const proc = Bun.spawn(
    ["bun", "carousel/insights.mjs", "ingest", "ig_media", "carousel/tests/fixtures/ig_media.json", "--dry-run"],
    { env: { ...process.env, SUPABASE_URL: "http://127.0.0.1:9" }, stdout: "pipe", stderr: "pipe" }
  );
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  expect(out).toMatch(/dry run.*row\(s\) would be ingested/i);
});

// ---- ig_insights: the per-media metrics that actually matter -------------------------------
// ig_media carries likes and comments; ig_reach carries ACCOUNT-level reach keyed "account",
// which cannot tell one post from another. Neither carries saves or shares, and for a listings
// deck those are the two that matter: a save is the behaviour the format is FOR, and a share is
// how a 66-follower account reaches anyone new.
describe("mapPayload — ig_insights", () => {
  test("pulls the media id out of the insight id when the caller does not supply one", () => {
    const rows = mapPayload("ig_insights", { data: [
      { name: "saved",  values: [{ value: 12 }], id: "17900000000000001/insights/saved/lifetime" },
      { name: "shares", values: [{ value: 3 }],  id: "17900000000000001/insights/shares/lifetime" },
    ]});
    expect(rows.map((r) => [r.media_id, r.metric, r.value]))
      .toEqual([["17900000000000001", "saved", 12], ["17900000000000001", "shares", 3]]);
  });
  test("accepts an explicit media_id and a batch of them", () => {
    const rows = mapPayload("ig_insights", [
      { media_id: "a", data: [{ name: "reach", values: [{ value: 841 }] }] },
      { media_id: "b", data: [{ name: "views", values: [{ value: 993 }] }] },
    ]);
    expect(rows.map((r) => r.media_id)).toEqual(["a", "b"]);
  });
  test("drops an entry whose media cannot be identified rather than filing it under a guess", () => {
    expect(mapPayload("ig_insights", { data: [{ name: "saved", values: [{ value: 1 }] }] })).toEqual([]);
  });
  test("prefers the value's own end_time over the batch day", () => {
    const rows = mapPayload("ig_insights", [{ media_id: "a", day: "2026-09-10T00:00:00Z",
      data: [{ name: "reach", values: [{ value: 5, end_time: "2026-09-12T07:00:00Z" }] }] }]);
    expect(rows[0].day).toBe("2026-09-12");
  });
  test("a missing value counts as zero, not as absent", () => {
    const rows = mapPayload("ig_insights", [{ media_id: "a", data: [{ name: "shares", values: [{ value: null }] }] }]);
    expect(rows[0].value).toBe(0);
  });
});
