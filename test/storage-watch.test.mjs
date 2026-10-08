import { expect, test, describe } from "bun:test";
import { assessStorage } from "../lib/storage-watch.mjs";

// Why this file exists: the bucket hit its ceiling in Aug 2026 and again in Oct 2026, and
// both times the first anyone knew was the dashboard or a 402. This alarm is meant to fire
// weeks earlier. It also has to be able to stay QUIET: after the move, Supabase is frozen
// near its cap on purpose, and an alarm that is red forever is one everybody learns to
// ignore (tripwire.mjs learned that the hard way with issue #21).

const GiB = 1024 ** 3;
const sb = (over) => ({ bytes: 0.5 * GiB, limitBytes: GiB, writeTarget: true, recentWrites: 0, ...over });

describe("assessStorage", () => {
  test("Supabase as the write target alarms at 70% full", () => {
    expect(assessStorage({ supabase: sb({ bytes: 0.69 * GiB }) }).alarm).toBe(false);
    expect(assessStorage({ supabase: sb({ bytes: 0.70 * GiB }) }).alarm).toBe(true);
  });

  test("a FROZEN Supabase bucket near its cap is quiet while nothing writes to it", () => {
    const r = assessStorage({ supabase: sb({ writeTarget: false, bytes: 0.97 * GiB, recentWrites: 0 }) });
    expect(r.alarm).toBe(false);
  });

  test("…but any new object in the frozen bucket alarms: a writer still points at Supabase", () => {
    // The scheduled cowork routine keeps its OWN copy of the env, outside every repo. If
    // it was missed during the switch it keeps writing to the full bucket, silently.
    const r = assessStorage({ supabase: sb({ writeTarget: false, bytes: 0.97 * GiB, recentWrites: 3 }) });
    expect(r.alarm).toBe(true);
    expect(r.lines.join("\n")).toMatch(/still writ/i);
  });

  test("a frozen bucket that is actually over its limit alarms regardless", () => {
    expect(assessStorage({ supabase: sb({ writeTarget: false, bytes: 1.01 * GiB }) }).alarm).toBe(true);
  });

  test("Cloudinary alarms at 70% of its monthly credits", () => {
    const base = { supabase: sb({ writeTarget: false, bytes: 0.9 * GiB }) };
    expect(assessStorage({ ...base, cloudinary: { usedPercent: 69.9 } }).alarm).toBe(false);
    expect(assessStorage({ ...base, cloudinary: { usedPercent: 70 } }).alarm).toBe(true);
  });

  test("a usage read that failed is reported, never an alarm by itself", () => {
    // Same rule as the tripwire: a missing signal must not red the run on its own.
    const r = assessStorage({ supabase: sb(), cloudinary: { error: "429 rate limited" } });
    expect(r.alarm).toBe(false);
    expect(r.lines.join("\n")).toMatch(/could not read/i);
  });

  test("the threshold is adjustable", () => {
    expect(assessStorage({ supabase: sb({ bytes: 0.6 * GiB }), threshold: 0.5 }).alarm).toBe(true);
  });
});
