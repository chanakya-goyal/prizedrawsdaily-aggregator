import { test, expect } from "bun:test";
import { beatGrid, quantize, pickAudio } from "../beat.mjs";

test("beatGrid generates beats from offset at 60000/bpm intervals", () => {
  const g = beatGrid({ bpm: 120, firstBeatOffsetMs: 250 }, 2100);
  expect(g).toEqual([250, 750, 1250, 1750]); // 500ms interval, capped at duration
});

test("quantize snaps to nearest beat", () => {
  const g = [0, 500, 1000];
  expect(quantize(560, g)).toBe(500);
  expect(quantize(790, g)).toBe(1000);
  expect(quantize(300, [])).toBe(300);
});

test("pickAudio throws on unknown mood", async () => {
  await expect(pickAudio("no-such-mood")).rejects.toThrow(/no audio in manifest/);
});
