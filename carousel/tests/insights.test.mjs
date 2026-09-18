import { test, expect, describe } from "bun:test";
import { mapPayload, windowFor, ageHours, derivedRows, DERIVED_MIN_VIEWS } from "../insights.mjs";

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

// ---- Stage E: the reading's age, the strict-absence rule, and the derived rows ---------------
describe("windowFor — the reading's age is part of its identity", () => {
  test("the buckets are assigned from ACTUAL age, not from when we meant to look", () => {
    expect(windowFor(0)).toBe("t24");
    expect(windowFor(36)).toBe("t24");
    expect(windowFor(37)).toBe("t72");
    expect(windowFor(61)).toBe("t72");     // a reading at 61h is not treated as exactly 72h
    expect(windowFor(120)).toBe("t72");
    expect(windowFor(121)).toBe("t168");
    expect(windowFor(240)).toBe("t168");
    expect(windowFor(241)).toBe("late");
  });
  test("an unknown age is 'legacy', never a guessed bucket", () => {
    expect(windowFor(NaN)).toBe("legacy");
    expect(windowFor(undefined)).toBe("legacy");
    expect(windowFor(null)).toBe("legacy");
  });
  test("ageHours refuses a nonsense interval rather than returning a negative", () => {
    expect(ageHours("2026-09-18T00:00:00Z", "2026-09-19T00:00:00Z")).toBe(24);
    expect(ageHours("2026-09-19T00:00:00Z", "2026-09-18T00:00:00Z")).toBeNull();
    expect(ageHours("not a date", Date.now())).toBeNull();
  });
});

describe("mapPayload — ig_media_insights applies the strict absence rule", () => {
  const payload = (values) => ([{ media_id: "m1", posted_at: "2026-09-16T12:00:00Z",
    captured_at: "2026-09-18T12:00:00Z", data: [{ name: "saved", values }] }]);

  test("present-and-zero writes a row with value 0", () => {
    const rows = mapPayload("ig_media_insights", payload([{ value: 0 }]));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0);
  });

  // The whole point of the new kind. A missing reel_avg_watch_time_ms stored as 0 is a reel that
  // looks like total abandonment — a number somebody would then act on.
  test("ABSENT writes no row at all", () => {
    expect(mapPayload("ig_media_insights", payload([{ value: null }]))).toEqual([]);
    expect(mapPayload("ig_media_insights", payload([{}]))).toEqual([]);
    expect(mapPayload("ig_media_insights", payload([{ value: "" }]))).toEqual([]);
  });

  test("the row carries its own provenance: source, window and the real age", () => {
    const [r] = mapPayload("ig_media_insights", payload([{ value: 12 }]));
    expect(r.source).toBe("api");
    expect(r.age_hours).toBe(48);
    expect(r.window).toBe("t72");
  });

  test("an unrecognised response shape throws rather than writing zeros", () => {
    expect(() => mapPayload("ig_media_insights", { nope: true })).toThrow(/unrecognised response shape/i);
    expect(() => mapPayload("ig_media_insights", [{ media_id: "m1" }])).toThrow(/no data\[\] array/i);
  });

  test("the old ig_insights contract is untouched — a missing value is still 0 there", () => {
    const rows = mapPayload("ig_insights", [{ media_id: "a", data: [{ name: "shares", values: [{ value: null }] }] }]);
    expect(rows[0].value).toBe(0);
  });

  test("a metric whose media cannot be identified is dropped, never filed under a guess", () => {
    expect(mapPayload("ig_media_insights", [{ data: [{ name: "saved", values: [{ value: 1 }] }] }])).toEqual([]);
  });
});

describe("mapPayload — ig_story_insights", () => {
  // Story insights are not retrievable once the Story expires, so they are pulled the same day at
  // t24 only and a missed day is permanently lost. Nothing may depend on them as a gate.
  test("every story row is pinned to t24, whatever its computed age", () => {
    const rows = mapPayload("ig_story_insights", [{ media_id: "s1", posted_at: "2026-09-10T12:00:00Z",
      captured_at: "2026-09-18T12:00:00Z", data: [{ name: "taps_forward", values: [{ value: 7 }] }] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].window).toBe("t24");
    expect(rows[0].metric).toBe("taps_forward");
  });
});

describe("mapPayload — ig_account", () => {
  test("the follower count lands on 'account' so the Trial Reels gate is observable", () => {
    const [r] = mapPayload("ig_account", { data: [{ followers_count: 66, day: "2026-09-18T00:00:00Z" }] });
    expect(r).toMatchObject({ media_id: "account", metric: "followers", value: 66 });
  });
  test("an absent count throws rather than recording a zero-follower account", () => {
    expect(() => mapPayload("ig_account", { followers_count: null })).toThrow(/refusing to write a zero/i);
  });
});

describe("derivedRows — quotients, suppressed where rounding would swamp them", () => {
  const g = (views) => ([
    { day: "2026-09-18", media_id: "r1", window: "t72", age_hours: 48, metric: "reel_watch_time_total_ms", value: 120000 },
    { day: "2026-09-18", media_id: "r1", window: "t72", age_hours: 48, metric: "reel_avg_watch_time_ms", value: 1200 },
    { day: "2026-09-18", media_id: "r1", window: "t72", age_hours: 48, metric: "views", value: views },
  ]);

  test("above the floor, both quotients are written and tagged 'derived'", () => {
    const out = derivedRows(g(140));
    expect(out.map((r) => r.metric).sort()).toEqual(["reel_initial_views", "reel_replays"]);
    expect(out.every((r) => r.source === "derived")).toBe(true);
    expect(out.find((r) => r.metric === "reel_initial_views").value).toBe(100);   // 120000 / 1200
    expect(out.find((r) => r.metric === "reel_replays").value).toBe(40);          // 140 − 100
  });

  test("below 50 views nothing is written — the figure is n/a, not zero", () => {
    expect(derivedRows(g(49))).toEqual([]);
    expect(derivedRows(g(12))).toEqual([]);
    expect(DERIVED_MIN_VIEWS).toBe(50);
  });

  test("a missing input produces no quotient, and never a division by zero", () => {
    expect(derivedRows(g(140).filter((r) => r.metric !== "views"))).toEqual([]);
    expect(derivedRows(g(140).map((r) => r.metric === "reel_avg_watch_time_ms" ? { ...r, value: 0 } : r))).toEqual([]);
  });

  test("replays can never be negative, however the platform's own figures disagree", () => {
    const out = derivedRows(g(60));   // initial 100 > views 60
    expect(out.find((r) => r.metric === "reel_replays").value).toBe(0);
  });

  test("rows are grouped by window, so a t24 reading never borrows a t168 denominator", () => {
    const mixed = [...g(140), { day: "2026-09-18", media_id: "r1", window: "t24", metric: "views", value: 900 }];
    const out = derivedRows(mixed);
    expect(out.every((r) => r.window === "t72")).toBe(true);
  });
});
