import { test, expect } from "bun:test";
import { reelAudio } from "../beat.mjs";
import manifest from "../assets/audio/manifest.json";

const days = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];
const run = days.flatMap((d) => [0, 1].map((i) => reelAudio(manifest, i, d)));

test("no two Reels in a row share a track", () => {
  for (let j = 1; j < run.length; j++) expect(run[j].file).not.toBe(run[j - 1].file);
  expect(reelAudio(manifest, 0, "2026-10-21")).toEqual(reelAudio(manifest, 0, "2026-10-21"));
});

test("a track comes back at a later phrase, and every clip fits inside its track", () => {
  const seen = new Set(run.map((a) => `${a.file}@${a.startMs}`));
  expect(seen.size).toBe(run.length);
  for (const a of run) expect(a.startMs + 9600).toBeLessThan(a.durationMs);
  // a month of Reels: none starts inside, or runs into, a quiet stretch of its track
  const month = Array.from({ length: 30 }, (_, n) => new Date(Date.UTC(2026, 9, 21 + n)).toISOString().slice(0, 10))
    .flatMap((d) => [0, 1].map((i) => reelAudio(manifest, i, d)));
  for (const a of month) for (const [q0, q1] of a.quietMs || []) expect(a.startMs < q1 && a.startMs + 9600 > q0).toBe(false);
  expect(run.every((a) => a.file.endsWith(".mp3"))).toBe(true); // never the bare sting
});
