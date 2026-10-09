import { expect, test, describe } from "bun:test";
import { assessStorage } from "../lib/storage-watch.mjs";

// Why this file exists: the bucket hit its ceiling in Aug 2026 and again in Oct 2026, and
// both times the first anyone knew was the dashboard or a 402. This alarm is meant to fire
// weeks earlier — and to go quiet again once the problem is gone, because an alarm that is
// always on is one everybody learns to ignore (tripwire.mjs learned that with issue #21).
// After the move the Supabase bucket is EMPTIED, so the plain percentage rule works again.

const GiB = 1024 ** 3;
const sb = (over) => ({ bytes: 0.1 * GiB, limitBytes: GiB, writeTarget: true, recentWrites: 0, ...over });

describe("assessStorage", () => {
  test("Supabase alarms at 70% full", () => {
    expect(assessStorage({ supabase: sb({ bytes: 0.69 * GiB }) }).alarm).toBe(false);
    expect(assessStorage({ supabase: sb({ bytes: 0.70 * GiB }) }).alarm).toBe(true);
  });

  test("…whether or not it is still the write target — a full project is a 402 on every API", () => {
    // During the transition the bucket sits at ~98% until it is emptied. That IS the risk,
    // so it stays red until --phase=empty-supabase has run.
    const r = assessStorage({ supabase: sb({ writeTarget: false, bytes: 0.97 * GiB }) });
    expect(r.alarm).toBe(true);
    expect(r.lines.join("\n")).toMatch(/empty-supabase/);
  });

  test("an emptied bucket with nothing new in it is quiet", () => {
    expect(assessStorage({ supabase: sb({ writeTarget: false, bytes: 0.01 * GiB }) }).alarm).toBe(false);
  });

  test("any new object in draw-images after the switch alarms: a writer still points at Supabase", () => {
    // The scheduled cowork routine keeps its OWN copy of the env, outside every repo. If
    // it was missed during the switch it keeps writing to Supabase, silently.
    const r = assessStorage({ supabase: sb({ writeTarget: false, recentWrites: 3 }) });
    expect(r.alarm).toBe(true);
    expect(r.lines.join("\n")).toMatch(/still writ/i);
  });

  test("new objects are expected while Supabase IS the write target", () => {
    expect(assessStorage({ supabase: sb({ writeTarget: true, recentWrites: 300 }) }).alarm).toBe(false);
  });

  test("Cloudinary alarms at 70% of its monthly credits", () => {
    const base = { supabase: sb({ writeTarget: false }) };
    expect(assessStorage({ ...base, cloudinary: { usedPercent: 69.9 } }).alarm).toBe(false);
    expect(assessStorage({ ...base, cloudinary: { usedPercent: 70 } }).alarm).toBe(true);
  });

  test("a usage read that failed is reported, never an alarm by itself", () => {
    // Same rule as the tripwire: a missing signal must not red the run on its own.
    const r = assessStorage({ supabase: sb(), cloudinary: { error: "429 rate limited" } });
    expect(r.alarm).toBe(false);
    expect(r.lines.join("\n")).toMatch(/could not read/i);
  });

  test("the warning states the measured days left, not a remembered growth rate", () => {
    const r = assessStorage({ supabase: sb({ bytes: 0.98 * GiB, recentBytes: 40 * 1048576, recentWindowH: 48 }) });
    // 2% of 1 GiB ≈ 20.5 MB left at 20 MB/day → 1 day.
    expect(r.lines[0]).toMatch(/~20 MB\/day it is full in ~1 day/);
  });

  test("a provider switched on without working credentials alarms", () => {
    // run.mjs treats a failed upload as "keep the operator's URL" — graceful for one image,
    // but with broken credentials EVERY new draw silently hotlinks again (the bug rehost
    // exists to prevent). Nothing else would notice.
    const r = assessStorage({ supabase: sb({ writeTarget: false }), config: { provider: "cloudinary", error: "missing CLOUDINARY_API_SECRET" } });
    expect(r.alarm).toBe(true);
    expect(r.lines.join("\n")).toMatch(/hotlink/i);
  });

  test("the threshold is adjustable", () => {
    expect(assessStorage({ supabase: sb({ bytes: 0.6 * GiB }), threshold: 0.5 }).alarm).toBe(true);
  });
});
