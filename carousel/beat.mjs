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
  const t = manifest.find((m) => m.mood === mood);
  if (!t) throw new Error(`no audio in manifest for mood="${mood}" — check config.json audioMood vs assets/audio/manifest.json`);
  return t;
}

// A Reel's soundtrack. Every Reel in a row gets a different track (the day's two Reels, then the next
// day's), and each pass through the library moves to a later loud 4-bar phrase, so the feed does not hear
// the same clip twice until every phrase of every track has played. Pure: same day + slot, same clip.
export function reelAudio(manifest, i, day) {
  const tracks = manifest.filter((t) => t.bpm && t.durationMs);
  if (!tracks.length) throw new Error("reelAudio: no music tracks with bpm + durationMs in the manifest");
  const k = Math.floor(Date.UTC(...day.split("-").map((n, j) => Number(n) - (j === 1 ? 1 : 0))) / 86400000) * 2 + i;
  const t = tracks[k % tracks.length];
  const phrase = 16 * 60000 / t.bpm;                              // 4 bars of 4 beats
  const onset = t.firstBeatOffsetMs || 0;
  const count = Math.max(1, Math.floor((t.durationMs - 12000 - onset) / phrase) + 1);
  // Only phrases whose 9.6 s clip misses every quiet stretch (manifest quietMs: intros, breakdowns,
  // outros more than 8 dB under the track's median), so no Reel lands in a lull.
  const starts = Array.from({ length: count }, (_, j) => Math.round(onset + j * phrase));
  const loud = starts.filter((a) => !(t.quietMs || []).some(([q0, q1]) => a < q1 && a + 9600 > q0));
  const pool = loud.length ? loud : starts;
  return { ...t, startMs: pool[Math.floor(k / tracks.length) % pool.length] };
}
