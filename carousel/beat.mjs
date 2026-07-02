// Beat-grid helpers: every reel cut/slam/stamp lands ON a beat (spec §4.4 —
// off-beat cuts are the single biggest auto-generated tell).
export function beatGrid({ bpm, firstBeatOffsetMs = 0 }, durationMs) {
  const step = 60000 / bpm;
  const out = [];
  for (let t = firstBeatOffsetMs; t < durationMs; t += step) out.push(Math.round(t));
  return out;
}

export const quantize = (tMs, grid) =>
  grid.length ? grid.reduce((best, g) => (Math.abs(g - tMs) < Math.abs(best - tMs) ? g : best), grid[0]) : tMs;

export async function pickAudio(mood) {
  const manifest = await Bun.file(new URL("./assets/audio/manifest.json", import.meta.url)).json();
  const t = manifest.find((m) => m.mood === mood) || manifest[0];
  if (!t) throw new Error(`no audio in manifest (mood=${mood}) — run Task 2 acquisition`);
  return t;
}
