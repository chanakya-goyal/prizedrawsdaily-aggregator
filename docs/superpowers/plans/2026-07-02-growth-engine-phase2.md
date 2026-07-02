# Carousel Growth Engine — Phase 2 (Reach Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the formats that actually reach non-followers — a daily auto-generated motion Reel (NOT a slideshow), a video story, the insights ingest loop — plus the four defects found in Phase 1's first live run.

**Architecture:** Reels are authored as ONE animated HTML timeline (WAAPI/CSS keyframes: kinetic type, live particles, 3-layer parallax, the PRICE-STAMP signature) rendered in the existing Playwright Chromium, captured deterministically frame-by-frame (pause → seek → screenshot, streamed to disk), then encoded by ffmpeg with beat-synced audio. Stories reuse the same capture/encode pipeline. Insights is an *ingest* tool: Claude pulls data via Composio in-session and pipes the JSON in (bun scripts cannot call MCP).

**Tech Stack:** Bun, Playwright Chromium (installed), ffmpeg 8.1.2 + ffprobe (installed at /opt/homebrew/bin), Supabase REST (existing `state.mjs`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-02-carousel-growth-engine-design.md` v2 — this plan implements **§9 Phase 2** (§4.3, §4.4, §4.5, retention from §4.9, Reel-first publish from §6) plus the logged Phase-1 backlog.

## Global Constraints

- Runtime is **Bun** (`bun <file>`, `bun test`, `Bun.file`/`Bun.write`/`Bun.spawn`); never node/npm/jest.
- Budget £0: no new npm deps; audio must be licence-documented royalty-free (or synthesized); ffmpeg/ffprobe binaries at `/opt/homebrew/bin/ffmpeg`, `/opt/homebrew/bin/ffprobe`.
- **Reel encode contract (spec §4.4, verified against 2026 Meta docs):** H.264 (libx264) + AAC ≤48kHz, `yuv420p`, progressive, closed GOP, `-movflags +faststart` (moov atom at FRONT), 1080×1920, duration 3s–90s for our use, ≤300MB, VBR ≤25Mbps. Asserted via ffprobe in tests AND at runtime.
- **Anti-ordinary requirements (spec §4.4, user hard requirement):** no Ken-Burns-slideshow constructions; photos never zoom (the world moves — parallax/specular); cold-open hook in frames 0–36; every Reel/story ends with THE PRICE STAMP (identical motion + sting); beat-quantized cuts; loop-bait outro; persistent compliance footer `18+ · UK ONLY · PLAY RESPONSIBLY`.
- Determinism: frame N of the same timeline must be identical across runs (no `Math.random()` in the reel path without a seeded generator; particle layouts are seeded).
- Chromium re-entry gotcha: **one `chromium.launch()` per process** for heavy work (documented Bun quirk); capture runs in the reel process's single browser; never launch a second browser in the same process after capture.
- All date/countdown math anchored `Europe/London`.
- Publishing stays **Claude-driven via Composio** (scripts prepare assets + state; they never post). IG Reel publish: container `media_type=REELS` + `video_url` + `cover_url` (public URLs, NO query strings) → poll status → `_PUBLISH` with `max_wait_seconds=300`.
- Working dir via `workDir()` (env `PDD_DIR` override). Stage only named files per commit; never `git add -A`. Commit on `main`.
- Interfaces from Phase 1 (all live): `config.mjs` (`CFG`,`GLOBAL`,`catCfg`,`themeOf`,`workDir`), `util.mjs` (`withRetry`,`fetchOk`), `state.mjs` (`upsertPost`,`markStatus`,`getPost`,`recentPosts`,`insertMetrics`,`todayLondon`), `render.mjs` (`buildHtml(slide, theme, particles)`, `renderSlides(slides, theme, particles)` — hard `__ready` gate), `honesty.mjs` (`valueLine`,`altTexts`), `brief.mjs` (`buildBriefing`,`hashtagsFor`), `format.mjs` (`toDrawSlide`,`priceLabel`,`closesLabel(iso, now?)`,`cleanTitle`,`LDN`).

---

### Task 1: First-live-run fixes (honesty v2, min-res gate, caption clobber, fetchimg upgrades)

Four defects found publishing 2026-07-02, all with regression tests.

**Files:**
- Modify: `carousel/honesty.mjs`, `carousel/build.mjs`, `carousel/publish.mjs`, `carousel/fetchimg.mjs`
- Test: `carousel/tests/honesty.test.mjs` (extend), `carousel/tests/fetchimg.test.mjs` (new), `carousel/tests/minres.test.mjs` (new)

**Interfaces:**
- Consumes: `catCfg(slug).valueLineMin`; `cashAlt()` output strings like `"£40,000 TAX-FREE CASH"`.
- Produces: `valueLine(draws, slug) → string` — **SIGNATURE CHANGE** (takes the draws array, not a pre-summed number); `capValue(d) → number` (exported for tests: per-draw `min(total_prize_value, parsed cashAlt when present)`); NEW FILE `carousel/imgcheck.mjs` exporting `dimsFromBuffer(buf) → {w,h}|null` and `minDimOk(path, min=500) → Promise<boolean>`; `upgradeUrl(url) → string` exported from `fetchimg.mjs`.

- [ ] **Step 1: Write failing tests for honesty v2**

Append to `carousel/tests/honesty.test.mjs`:

```js
import { valueLine, capValue } from "../honesty.mjs";

// 2026-07-02 incident: Discovery draw = 2M entries × 5p = £100k ticket revenue,
// but its own cash alternative proves the prize is worth £40k. Per-draw cap.
const D = (tpv, grand, desc) => ({ total_prize_value: tpv, grand_prize: grand || "", prize_description: desc || "" });

test("capValue caps a draw at its parseable cash alternative", () => {
  expect(capValue(D(100000, "Land Rover or £40,000 tax-free cash"))).toBe(40000);
  expect(capValue(D(47830, "Suzuki Jimny"))).toBe(47830);          // no cash alt → revenue stands
  expect(capValue(D(35873, "Harley", "or £15,000 cash alternative"))).toBe(15000);
});

test("valueLine v2 uses per-draw capped sum (2026-07-02 regression)", () => {
  const draws = [
    D(100000, "Land Rover or £40,000 tax-free cash"),  // → 40000
    D(47830, "Jimny"),                                  // → 47830
    D(18757, "Astra"),                                  // → 18757
    D(19746, "S1000RR"),                                // → 19746
    D(35873, "Harley", "or £15,000 cash"),              // → 15000
  ];
  // capped sum = 141,336 → "£141,000+" (car bar 20000 passed) — NOT £222,000+
  expect(valueLine(draws, "car-draws")).toBe("£141,000+");
});

test("valueLine v2 still suppresses below the category bar", () => {
  expect(valueLine([D(900, "LEGO set")], "collectibles")).toBe("");
});
```

- [ ] **Step 2: Run to verify fail** — `bun test carousel/tests/honesty.test.mjs` → FAIL (capValue not exported; valueLine takes a number today).

- [ ] **Step 3: Implement honesty v2**

Replace `valueLine` in `carousel/honesty.mjs` (keep `altTexts` untouched) and export `capValue`:

```js
import { catCfg } from "./config.mjs";
import { cashAlt } from "./format.mjs";

// Parse "£40,000 TAX-FREE CASH" → 40000. cashAlt() already normalises the string.
const cashAltValue = (d) => {
  const s = cashAlt(d.grand_prize, d.prize_description);
  const m = s && s.match(/£([\d,]+)/);
  return m ? Number(m[1].replaceAll(",", "")) : null;
};

// Per-draw claimable value: ticket revenue, capped at the operator's own cash
// alternative when one is stated (the operator's number is the honest ceiling).
export function capValue(d) {
  const revenue = Number(d.total_prize_value) || 0;
  const alt = cashAltValue(d);
  return alt != null ? Math.min(revenue, alt) : revenue;
}

export function valueLine(draws, slug) {
  const total = (Array.isArray(draws) ? draws : []).reduce((a, d) => a + capValue(d), 0);
  if (total < catCfg(slug).valueLineMin || total < 1000) return "";
  return `£${(Math.floor(total / 1000) * 1000).toLocaleString("en-GB")}+`;
}
```

In `carousel/build.mjs` replace the two value lines:

```js
const totalValue = sel.draws.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
const value = valueLine(totalValue, sel.slug);
```
with:
```js
const value = valueLine(sel.draws, sel.slug);
```
(the `totalValue` const is deleted — grep for other uses first; there are none.)

- [ ] **Step 4: Min-resolution gate.** Create `carousel/imgcheck.mjs`:

```js
// Reject tiny images before they become stamp-sized slides (2026-07-02 incident:
// a 150×100 operator thumbnail sailed through to a broken hero).
// Pure header decoding — no image library, no browser.
// PNG: bytes 16-24 big-endian w/h. JPEG: scan SOF markers. WEBP: VP8X/VP8/VP8L.
export function dimsFromBuffer(buf) {
  if (buf.length < 32) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) // PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk segments to SOFn
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
    const fmt = buf.slice(12, 16).toString();
    if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export async function minDimOk(path, min = 500) {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const d = dimsFromBuffer(buf);
  if (!d) return true; // unknown format → let the render gate judge
  return Math.max(d.w, d.h) >= min;
}
```

Write `carousel/tests/minres.test.mjs`:

```js
import { test, expect } from "bun:test";
import { dimsFromBuffer } from "../imgcheck.mjs";

// 1×1 PNG (smallest valid) — base64 of a real 1×1 transparent PNG
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("dimsFromBuffer reads PNG dimensions", () => {
  expect(dimsFromBuffer(PNG1)).toEqual({ w: 1, h: 1 });
});

test("garbage buffer returns null (fails open to the render gate)", () => {
  expect(dimsFromBuffer(Buffer.alloc(64))).toBeNull();
});
```

In `carousel/build.mjs`, in the hero-resolution loop (the `srcPath`/`srcKind` section), gate the auto-fetched pick (user-dropped photos are trusted):

```js
import { minDimOk } from "./imgcheck.mjs";   // ← top of file
// inside the loop, replace: if (auto) { srcPath[d.slug] = auto; srcKind[d.slug] = "auto-fetched"; }
if (auto) {
  if (await minDimOk(auto, 500)) { srcPath[d.slug] = auto; srcKind[d.slug] = "auto-fetched"; }
  else console.log(`  ⚠ ${d.slug}: auto-fetched pick is under 500px — rejected (typographic fallback). Repick in .fetched/${d.slug}/pick.txt`);
}
```

- [ ] **Step 5: Caption clobber fix.** In `carousel/build.mjs`, change the caption write target from `CAPTION.txt` to `CAPTION_FALLBACK.txt` (the log line too: `"--- FALLBACK CAPTION (written to CAPTION_FALLBACK.txt; Claude: write CAPTION.txt + FB_CAPTION.txt from BRIEFING.md) ---"`). In `carousel/publish.mjs`, change the caption read to a chain:

```js
const caption = (await Bun.file(`${OUT}/CAPTION.txt`).text().catch(() => "")).trim()
  || (await Bun.file(`${OUT}/CAPTION_FALLBACK.txt`).text().catch(() => "")).trim();
if (!caption) { console.error("✗ no caption (CAPTION.txt or CAPTION_FALLBACK.txt)"); process.exit(1); }
```

Rebuilds now never destroy an authored caption. Update the two DAILY.md sentences that mention CAPTION.txt being auto-written (rewrite in Task 10; leave a `<!-- see phase2 task 1 -->` marker only if needed — otherwise skip).

- [ ] **Step 6: fetchimg upgrades.** In `carousel/fetchimg.mjs`: (a) find the URL res-upgrade helper (the function stripping Woo `-WxH` suffixes / adding Shopify `?width=`); EXPORT it as `upgradeUrl` if inline. (b) Extend it: strip `-\d{2,4}x\d{2,4}` before the extension for ANY host (Dream Car Giveaways uses WordPress `image-150x100.jpg` thumbs — today's incident), and when a `srcset` candidate list is parsed, always keep the LARGEST descriptor. (c) In the candidate filter, drop candidates whose downloaded buffer decodes under 400px max-dimension via `dimsFromBuffer` **when the draw already has ≥2 candidates over 400px** (never filter down to zero). Write `carousel/tests/fetchimg.test.mjs`:

```js
import { test, expect } from "bun:test";
import { upgradeUrl } from "../fetchimg.mjs";

test("strips WordPress/Woo -WxH thumbnail suffix (DCG 2026-07-02 incident)", () => {
  expect(upgradeUrl("https://dreamcargiveaways.co.uk/wp-content/uploads/2026/06/disco-150x100.jpg"))
    .toBe("https://dreamcargiveaways.co.uk/wp-content/uploads/2026/06/disco.jpg");
});

test("upgrades Shopify width param", () => {
  const u = upgradeUrl("https://cdn.shopify.com/s/files/1/x/prize.jpg?width=300");
  expect(u).toContain("width=1600");
});

test("leaves clean URLs alone", () => {
  expect(upgradeUrl("https://example.com/photo.jpg")).toBe("https://example.com/photo.jpg");
});
```

(Adjust the Shopify assertion to the actual existing behavior found in the file — the test pins current behavior for Shopify, new behavior for the `-WxH` strip. If fetchimg's importable surface would break its CLI `if (import.meta.main)` guard, add one — Bun supports `import.meta.main`.)

- [ ] **Step 7: Run all tests** — `bun test carousel/tests/` → all pass (expect ~33+).

- [ ] **Step 8: Commit**

```bash
git add carousel/honesty.mjs carousel/imgcheck.mjs carousel/build.mjs carousel/publish.mjs carousel/fetchimg.mjs carousel/tests/honesty.test.mjs carousel/tests/minres.test.mjs carousel/tests/fetchimg.test.mjs
git commit -m "fix(carousel): first-live-run hardening — honesty v2 cash-alt caps, min-res gate, caption clobber, thumbnail upgrade"
```

---

### Task 2: Audio kit + beat grid

**Files:**
- Create: `carousel/assets/audio/` (5 tracks + 1 sting + `manifest.json` + `LICENSES.md`), `carousel/beat.mjs`
- Test: `carousel/tests/beat.test.mjs`

**Interfaces:**
- Produces: `carousel/assets/audio/manifest.json` — array of `{file, mood, bpm, firstBeatOffsetMs, dropMs|null, source, licence}`; moods must cover: `driving` (car), `synth` (tech), `elegant` (luxury), `win` (cash), `warm` (house), `pop` (collect) — a mood may serve two categories. `beat.mjs`: `beatGrid({bpm, firstBeatOffsetMs}, durationMs) → number[]` (beat timestamps ms, ≤durationMs); `quantize(tMs, grid) → number` (nearest grid time; empty grid → tMs); `pickAudio(mood) → {file, bpm, firstBeatOffsetMs, dropMs}` (reads manifest; throws with clear message if mood missing). `config.json`: each category gains `"audioMood": "<mood>"`.

- [ ] **Step 1: Write failing beat tests**

```js
// carousel/tests/beat.test.mjs
import { test, expect } from "bun:test";
import { beatGrid, quantize } from "../beat.mjs";

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
```

- [ ] **Step 2: Verify fail, then implement `carousel/beat.mjs`**

```js
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
```

- [ ] **Step 3: Acquire tracks (£0, licence-documented).** For each mood, download ONE track from Pixabay Music (https://pixabay.com/music/ — Pixabay Content Licence: free commercial use, no attribution; many track pages list BPM). Search terms: driving → "energetic drive rock 120 bpm"; synth → "synthwave 110 bpm"; elegant → "elegant piano cinematic"; win → "upbeat funk celebration"; warm → "warm acoustic folk"; pop → "quirky fun pop". Save as `carousel/assets/audio/{mood}.mp3`, each must be >300KB and 60s+ (`ffprobe -show_format` duration check). Record in `LICENSES.md`: track title, author, source URL, licence name, download date. If the page lists BPM use it; otherwise estimate: `ffmpeg -i {file} -filter:a silencedetect …` is NOT a bpm tool — instead run this crude onset-interval estimate and round to a plausible musical BPM (60–180):

```bash
/opt/homebrew/bin/ffmpeg -i carousel/assets/audio/driving.mp3 -af "highpass=f=100,lowpass=f=3000,silencedetect=noise=-25dB:d=0.05" -f null - 2>&1 | grep silence_start | head -20
```

(intervals between successive onsets ≈ beat period; BPM = 60000/period-ms, halve/double into 60–180). `firstBeatOffsetMs` = first `silence_end` value ×1000 rounded. `dropMs` = null unless obvious. **If Pixabay CDN blocks non-browser downloads, report DONE_WITH_CONCERNS listing the failed URLs — the controller will fetch them via Playwright or the human drops files in; do NOT commit placeholder/empty files.**

- [ ] **Step 4: Synthesize the stamp sting (deterministic, £0).**

```bash
/opt/homebrew/bin/ffmpeg -y -f lavfi -i "sine=frequency=180:duration=0.4" -f lavfi -i "anoisesrc=d=0.4:c=pink:a=0.6" \
  -filter_complex "[0]aeval=val(0)*exp(-12*t)[thud];[1]highpass=f=800,aeval=val(0)*exp(-18*t),volume=0.5[whoosh];[thud][whoosh]amix=inputs=2,volume=1.8,alimiter" \
  -ar 48000 -ac 2 carousel/assets/audio/stamp-sting.wav
```

Verify: `ffprobe` shows 0.4s, 48kHz. Add to manifest as `{file:"stamp-sting.wav", mood:"sting", bpm:null, …, source:"synthesized (ffmpeg lavfi)", licence:"n/a"}`. Add to LICENSES.md.

- [ ] **Step 5: Wire config.** Add `"audioMood"` per category in `carousel/config.json`: car-draws `"driving"`, tech-giveaways `"synth"`, luxury `"elegant"`, cash-prizes `"win"`, house-draws `"warm"`, collectibles `"pop"`. Extend `carousel/tests/config.test.mjs`'s first test with `expect(["driving","synth","elegant","win","warm","pop"]).toContain(c.audioMood);`.

- [ ] **Step 6: Run tests, commit**

```bash
bun test carousel/tests/
git add carousel/beat.mjs carousel/tests/beat.test.mjs carousel/assets/audio/ carousel/config.json carousel/tests/config.test.mjs
git commit -m "feat(carousel): audio kit (licensed tracks + synthesized stamp sting) + beat grid"
```

---

### Task 3: `reel-template.mjs` — the animated timeline

The creative core. One HTML document = the whole Reel: scenes, kinetic type, parallax, particles that MOVE, the stamp, the loop outro. All animation is CSS keyframes / WAAPI with **negative-delay-free, deterministic** timing driven by a single timeline (so seeking works).

**Files:**
- Create: `carousel/reel-template.mjs`
- Test: `carousel/tests/reeltemplate.test.mjs`

**Interfaces:**
- Consumes: `themeOf`/`catCfg` (theme tokens + particles + audioMood), `fontFaceCss()` from `fonts.mjs`, styles.css theme blocks (reuse `[data-theme]` custom properties — the reel injects the same `:root`/theme token CSS), `beatGrid`/`quantize`, slide objects from `toDrawSlide` + hero data URLs resolved the same way `build.mjs` does.
- Produces: `buildReelTimeline({ sel, slides, heroes, arm, audioMeta }) → { html, durationMs, stampTimesMs, cutTimesMs, coverText }` where: `slides` = draw slide objects; `heroes` = `{[slug]: dataUrl|null}`; `arm` ∈ `"A"|"B"|"C"`; `audioMeta` = `{bpm, firstBeatOffsetMs, dropMs}`. Durations: A = multi-prize 14–18s (5 prizes), B = single-prize hook ≤8s (top prize only), C = "closing tonight" countdown ~10s. `html` contains `window.__seek(tMs)` (pauses everything on load, seeks all animations + a virtual clock for JS counters) and sets `window.__ready` when fonts+images are loaded. Also exports `stampCss()` and `stampHtml(text)` (shared with story.mjs) and `SEEK_RUNTIME` (the seek/pause script string, shared with capture tests).

**Hard requirements the reviewer must be able to check in the HTML output (spec §4.4):**
1. Cold open (frames 0–36 @30fps = 0–1200ms): full-bleed top-prize hero at t=0; white flash ≤1 frame at ~150ms (quantized); price stamps in scale 3→1 with overshoot + 2-frame chromatic split + body shake by ~500ms; one-line kicker with a TRUE fact by ~900ms.
2. Every cut/slam/stamp time is `quantize(t, beatGrid(audioMeta, durationMs))`.
3. Prize scenes: photo layer has NO scale animation (translate only, ≤0.4× the particle-layer rate; ±1.5° rotate3d sway allowed); one specular sweep per scene; particle field drifts continuously (seeded positions — use a mulberry32 PRNG seeded with `sel.slug.length * 7 + arm.charCodeAt(0)`).
4. THE PRICE STAMP: circular badge, text like `JUST 5P A TICKET`, animation `stamp-in` = scale(3)→1 with `cubic-bezier(.2, 2, .3, 1)`, 3-frame body shake keyframes, expanding ink-ring (border-radius:50%, scale+fade). Identical keyframe NAMES and durations across arms/themes; themed only in color via `var(--accent)`/`var(--gold-2)`.
5. Loop outro: final ~400ms plays `stamp-out` (reverse wind-up) such that the LAST frame's stamp state ≈ frame 0's opening hero (visual loop); URL/handle lower-third slides in over the final scene — NO dead outro card.
6. Persistent footer `18+ · UK ONLY · PLAY RESPONSIBLY` visible in every frame ≥12px.
7. Arm C: flip-clock countdown (see Task 7's `flipClockCss` — defined HERE and exported, story reuses it) ticking real seconds to the earliest close time.

The template author (implementer) has creative freedom WITHIN those constraints — layouts, easings beyond the fixed ones, scene composition. The QA gates (keyframe stills + supervised first publish) judge the taste; the tests below judge the contract.

- [ ] **Step 1: Write the contract tests**

```js
// carousel/tests/reeltemplate.test.mjs
import { test, expect } from "bun:test";
import { buildReelTimeline, stampHtml, SEEK_RUNTIME } from "../reel-template.mjs";

const sel = { slug: "car-draws", name: "Car Draws", seoKeyword: "UK car competitions" };
const slides = [
  { title: "Land Rover Discovery", price: "5p", closes: "CLOSES TONIGHT", slug: "lr" },
  { title: "Harley Breakout", price: "£8.97", closes: "CLOSES TONIGHT", slug: "hd", cashAlt: "£15,000 TAX-FREE CASH" },
];
const heroes = { lr: null, hd: null };
const audio = { bpm: 120, firstBeatOffsetMs: 0, dropMs: 4000 };

for (const arm of ["A", "B", "C"]) {
  test(`arm ${arm}: contract elements present`, () => {
    const t = buildReelTimeline({ sel, slides, heroes, arm, audioMeta: audio });
    expect(t.html).toContain("__seek");
    expect(t.html).toContain("__ready");
    expect(t.html).toContain("18+ · UK ONLY · PLAY RESPONSIBLY");
    expect(t.html).toContain("stamp-in");            // signature keyframes
    expect(t.html).toContain("stamp-out");           // loop outro
    expect(t.html).not.toMatch(/class="photo[^"]*"[^>]*style="[^"]*scale/); // photos never scale-animated
    expect(t.stampTimesMs.length).toBeGreaterThan(0);
    expect(t.durationMs).toBeGreaterThanOrEqual(3000);
  });
}

test("arm durations", () => {
  const a = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  const b = buildReelTimeline({ sel, slides, heroes, arm: "B", audioMeta: audio });
  expect(a.durationMs).toBeGreaterThanOrEqual(12000);
  expect(a.durationMs).toBeLessThanOrEqual(18000);
  expect(b.durationMs).toBeLessThanOrEqual(8000);
});

test("cuts are beat-quantized", () => {
  const t = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio });
  for (const c of t.cutTimesMs) expect(c % 500).toBe(0); // 120bpm, offset 0 → beats every 500ms
});

test("deterministic output", () => {
  const h1 = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio }).html;
  const h2 = buildReelTimeline({ sel, slides, heroes, arm: "A", audioMeta: audio }).html;
  expect(h1).toBe(h2);
});

test("stampHtml carries the text", () => {
  expect(stampHtml("JUST 5P A TICKET")).toContain("JUST 5P A TICKET");
  expect(SEEK_RUNTIME).toContain("getAnimations");
});
```

- [ ] **Step 2: Verify fail, then implement.** Key fixed pieces the implementation MUST contain verbatim (creative freedom around them):

The seek runtime (export as `SEEK_RUNTIME`):

```js
export const SEEK_RUNTIME = `
window.__vt = 0; // virtual clock for JS-driven counters (rAF replaced)
window.__seek = (tMs) => {
  window.__vt = tMs;
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = tMs; }
  for (const el of document.querySelectorAll("[data-counter]")) {
    const { from, to, start, end } = JSON.parse(el.dataset.counter);
    const p = Math.min(1, Math.max(0, (tMs - start) / (end - start)));
    el.textContent = Math.round(from + (to - from) * p).toLocaleString("en-GB");
  }
  for (const el of document.querySelectorAll("[data-countdown]")) {
    const closeMs = Number(el.dataset.countdown);
    const left = Math.max(0, closeMs - (Date.parse(el.dataset.now) + tMs));
    const h = Math.floor(left / 3600000), m = Math.floor(left / 60000) % 60, s = Math.floor(left / 1000) % 60;
    el.textContent = \`\${String(h).padStart(2,"0")}:\${String(m).padStart(2,"0")}:\${String(s).padStart(2,"0")}\`;
  }
};
(async () => {
  try { await document.fonts.ready; } catch {}
  const wait = (im) => (!im || im.complete) ? null : new Promise((r) => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  for (const a of document.getAnimations()) a.pause();
  window.__ready = true;
})();`;
```

The stamp (export `stampCss()` + `stampHtml(text)`):

```js
export const stampCss = () => `
@keyframes stamp-in { 0%{transform:scale(3);opacity:0} 55%{transform:scale(.92);opacity:1} 75%{transform:scale(1.06)} 100%{transform:scale(1)} }
@keyframes stamp-shake { 0%,100%{transform:translate(0,0)} 33%{transform:translate(3px,-2px)} 66%{transform:translate(-3px,2px)} }
@keyframes stamp-ring { 0%{transform:scale(.6);opacity:.9} 100%{transform:scale(1.6);opacity:0} }
@keyframes stamp-out { 0%{transform:scale(1);opacity:1} 100%{transform:scale(3);opacity:0} }
.stamp { position:absolute; z-index:40; width:430px; height:430px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; text-align:center;
  background: radial-gradient(circle at 35% 30%, rgba(255,255,255,.16), transparent 60%), var(--accent);
  border: 10px solid var(--gold-2); box-shadow: 0 24px 60px rgba(0,0,0,.5);
  font-family: var(--font-display), 'Anton', sans-serif; font-size:72px; line-height:.95; color:#fff;
  -webkit-text-stroke: 2px var(--stroke); paint-order: stroke fill;
  transform: rotate(-8deg); }
.stamp-ring { position:absolute; inset:-14px; border-radius:50%; border: 6px solid var(--gold-2); }`;
export const stampHtml = (text) => `<div class="stamp"><div class="stamp-ring"></div><span>${text}</span></div>`;
```

Seeded PRNG for particles (deterministic layouts):

```js
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
```

Structure guidance (not verbatim): build scenes as absolutely-positioned `<section class="scene" style="animation: scene-N ...">` blocks whose visibility windows are driven by opacity keyframes on the single timeline; per-scene inner layers (`.layer-bg`, `.layer-particles`, `.layer-card`, `.layer-text`) get their own translate keyframes at 1.0×/0.4×/0.2× rates; the specular sweep is one rotated gradient strip translating across the card once per scene; token CSS comes from reading `styles.css`'s `:root` + `[data-theme]` blocks (import the CSS text exactly like `render.mjs` does) so themes inherit automatically; typography reuses `.hl`-style gradient text (copy the glossy headline recipe from styles.css class definitions into reel-scoped classes). Fonts: reuse `fontFaceCss()`.

- [ ] **Step 3: Run tests to green** — `bun test carousel/tests/reeltemplate.test.mjs`.

- [ ] **Step 4: Commit** — `git add carousel/reel-template.mjs carousel/tests/reeltemplate.test.mjs && git commit -m "feat(carousel): reel timeline template — kinetic scenes, parallax, price-stamp signature, seek runtime"`

---

### Task 4: `capture.mjs` — deterministic frame capture

**Files:**
- Create: `carousel/capture.mjs`
- Test: `carousel/tests/capture.test.mjs`

**Interfaces:**
- Consumes: `SEEK_RUNTIME` semantics (page exposes `__ready` + `__seek`).
- Produces: `captureFrames(html, { fps = 30, durationMs, outDir, width = 1080, height = 1920 }) → Promise<{ frames: number, dir: string }>` — writes `f00001.png…fNNNNN.png` (1080×1920, dsf 1) streaming to disk, never buffering; hard-fails (throws, browser closed) if `__ready` doesn't fire in 25s or any screenshot fails; total budget guard: throws if capture exceeds 5 minutes.

- [ ] **Step 1: Write the determinism test** (uses a tiny self-contained animated page, not the reel template — keeps the test fast):

```js
// carousel/tests/capture.test.mjs
import { test, expect } from "bun:test";
import { captureFrames } from "../capture.mjs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

const PAGE = `<!doctype html><html><head><style>
@keyframes slide { from { transform: translateX(0) } to { transform: translateX(500px) } }
#box { width:100px; height:100px; background:#f60; animation: slide 1s linear forwards; }
</style></head><body><div id="box"></div><script>
window.__seek = (t) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; } };
(async () => { for (const a of document.getAnimations()) a.pause(); window.__ready = true; })();
</script></body></html>`;

const sha = async (p) => createHash("sha256").update(Buffer.from(await Bun.file(p).arrayBuffer())).digest("hex");

test("capture is deterministic and frames differ over time", async () => {
  const a = await captureFrames(PAGE, { fps: 10, durationMs: 500, outDir: "carousel/tests/tmp/capA" });
  const b = await captureFrames(PAGE, { fps: 10, durationMs: 500, outDir: "carousel/tests/tmp/capB" });
  expect(a.frames).toBe(5);
  const fa = (await readdir(a.dir)).sort(), fb = (await readdir(b.dir)).sort();
  expect(fa).toEqual(fb);
  expect(await sha(`${a.dir}/${fa[0]}`)).toBe(await sha(`${b.dir}/${fb[0]}`));   // deterministic
  expect(await sha(`${a.dir}/${fa[0]}`)).not.toBe(await sha(`${a.dir}/${fa[4]}`)); // animation actually moves
}, 120000);
```

- [ ] **Step 2: Verify fail, implement**

```js
// carousel/capture.mjs — deterministic WAAPI seek-and-capture (spec §4.4).
// One chromium.launch per call; frames streamed to disk at deviceScaleFactor 1.
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";

export async function captureFrames(html, { fps = 30, durationMs, outDir, width = 1080, height = 1920 }) {
  const started = Date.now();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(() => {
      throw new Error("capture: page never became ready (fonts/images failed) — refusing to render a degraded reel");
    });
    const frameMs = 1000 / fps;
    const frames = Math.round(durationMs / frameMs);
    for (let i = 0; i < frames; i++) {
      if (Date.now() - started > 5 * 60000) throw new Error(`capture: exceeded 5-minute budget at frame ${i}/${frames}`);
      await page.evaluate((t) => window.__seek(t), Math.round(i * frameMs));
      await page.screenshot({ path: `${outDir}/f${String(i + 1).padStart(5, "0")}.png`, timeout: 15000, animations: "allow" });
    }
    return { frames, dir: outDir };
  } finally {
    await browser.close();
  }
}
```

(NOTE: `animations: "allow"` — the default `"disabled"` would fast-forward CSS animations and break seeking. The page itself pauses everything.)

- [ ] **Step 3: Run to green** (`bun test carousel/tests/capture.test.mjs` — ~30-60s), **commit** — `git add carousel/capture.mjs carousel/tests/capture.test.mjs && git commit -m "feat(carousel): deterministic frame capture (pause+seek+screenshot, streamed)"`

---

### Task 5: `encode.mjs` — ffmpeg encode + audio + contract assert

**Files:**
- Create: `carousel/encode.mjs`
- Test: `carousel/tests/encode.test.mjs`

**Interfaces:**
- Consumes: frames dir from `captureFrames`; audio manifest entries.
- Produces: `encodeVideo({ framesDir, fps, out, audio }) → Promise<string>` where `audio` = `{ file, trimToOnsetMs = 0, stingFile = null, stingTimesMs = [] }` (paths relative to `carousel/assets/audio/`); output = H.264/AAC/yuv420p/faststart mp4, audio loudness-normalized, sting mixed at each stamp time, audio trimmed/padded to video duration. `assertVideoContract(path, { w = 1080, h = 1920, minDurS = 3, maxDurS = 90 }) → Promise<{durS, w, h, vcodec, acodec, moovFront}>` — throws with a specific message on any violation; `moovFront` verified by scanning the first 64KB for the `moov` atom preceding `mdat`.

- [ ] **Step 1: Write the test** (synthesizes 30 frames via ffmpeg's lavfi so no browser is needed):

```js
// carousel/tests/encode.test.mjs
import { test, expect } from "bun:test";
import { encodeVideo, assertVideoContract } from "../encode.mjs";
import { mkdir } from "node:fs/promises";

const TMP = "carousel/tests/tmp/enc";

test("encode meets the IG contract incl. faststart and sting mix", async () => {
  await mkdir(TMP, { recursive: true });
  // 30 dummy frames (1s @30fps)
  await Bun.spawn(["/opt/homebrew/bin/ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=orange:size=1080x1920:duration=1:rate=30", `${TMP}/f%05d.png`]).exited;
  const out = await encodeVideo({
    framesDir: TMP, fps: 30, out: `${TMP}/test.mp4`,
    audio: { file: "stamp-sting.wav", stingFile: "stamp-sting.wav", stingTimesMs: [200] },
  });
  const c = await assertVideoContract(out, { minDurS: 0.5, maxDurS: 3 });
  expect(c.vcodec).toBe("h264");
  expect(c.acodec).toBe("aac");
  expect(c.w).toBe(1080);
  expect(c.moovFront).toBe(true);
}, 120000);

test("contract catches wrong dimensions", async () => {
  await Bun.spawn(["/opt/homebrew/bin/ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=640x480:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${TMP}/bad.mp4`]).exited;
  await expect(assertVideoContract(`${TMP}/bad.mp4`, {})).rejects.toThrow(/1080|dimension/i);
}, 60000);
```

- [ ] **Step 2: Verify fail, implement**

```js
// carousel/encode.mjs — frames+audio → IG-contract mp4 (spec §4.4 encode contract).
const FF = "/opt/homebrew/bin/ffmpeg", FP = "/opt/homebrew/bin/ffprobe";
const AUDIO_DIR = new URL("./assets/audio/", import.meta.url).pathname;

async function run(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.slice(-400)}`);
  return new Response(p.stdout).text();
}

import { readdir } from "node:fs/promises";

export async function encodeVideo({ framesDir, fps, out, audio }) {
  const frameCount = (await readdir(framesDir)).filter((f) => /^f\d+\.png$/.test(f)).length;
  if (!frameCount) throw new Error(`encode: no frames in ${framesDir}`);
  const durS = frameCount / fps;
  const track = `${AUDIO_DIR}${audio.file}`;
  const inputs = ["-framerate", String(fps), "-i", `${framesDir}/f%05d.png`, "-ss", String((audio.trimToOnsetMs || 0) / 1000), "-i", track];
  let filter = `[1:a]atrim=duration=${durS},loudnorm=I=-16:TP=-1.5[a0]`;
  let amixInputs = ["[a0]"];
  (audio.stingTimesMs || []).forEach((t, i) => {
    inputs.push("-i", `${AUDIO_DIR}${audio.stingFile}`);
    filter += `;[${2 + i}:a]adelay=${t}|${t}[s${i}]`;
    amixInputs.push(`[s${i}]`);
  });
  filter += `;${amixInputs.join("")}amix=inputs=${amixInputs.length}:normalize=0,alimiter,apad=whole_dur=${durS}[aout]`;
  await run([FF, "-y", ...inputs, "-filter_complex", filter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", String(fps * 2), "-flags", "+cgop",
    "-r", String(fps), "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-movflags", "+faststart", "-t", String(durS), out]);
  return out;
}

export async function assertVideoContract(path, { w = 1080, h = 1920, minDurS = 3, maxDurS = 90 } = {}) {
  const probe = JSON.parse(await run([FP, "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path]));
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const durS = Number(probe.format.duration);
  const head = Buffer.from(await Bun.file(path).slice(0, 65536).arrayBuffer());
  const moov = head.indexOf("moov"), mdat = head.indexOf("mdat");
  const moovFront = moov !== -1 && (mdat === -1 || moov < mdat);
  const fail = (m) => { throw new Error(`video contract violation (${path}): ${m}`); };
  if (!v || v.codec_name !== "h264") fail(`vcodec=${v?.codec_name}, want h264`);
  if (v.pix_fmt !== "yuv420p") fail(`pix_fmt=${v.pix_fmt}`);
  if (Number(v.width) !== w || Number(v.height) !== h) fail(`dimensions ${v.width}x${v.height}, want ${w}x${h}`);
  if (!a || a.codec_name !== "aac") fail(`acodec=${a?.codec_name}, want aac`);
  if (Number(a.sample_rate) > 48000) fail(`sample_rate=${a.sample_rate}`);
  if (!(durS >= minDurS && durS <= maxDurS)) fail(`duration ${durS}s outside [${minDurS},${maxDurS}]`);
  if (!moovFront) fail("moov atom not at front (add -movflags +faststart)");
  return { durS, w: Number(v.width), h: Number(v.height), vcodec: v.codec_name, acodec: a.codec_name, moovFront };
}
```

- [ ] **Step 3: Run to green, commit** — `git add carousel/encode.mjs carousel/tests/encode.test.mjs && git commit -m "feat(carousel): ffmpeg encode with beat-sting mix + IG contract assertion"`

---

### Task 6: `reel.mjs` — orchestrator + cover + QA keyframes

**Files:**
- Create: `carousel/reel.mjs`
- Test: manual E2E (below) — unit coverage lives in Tasks 3–5.

**Interfaces:**
- Consumes: everything above; selection/hero resolution copied from `build.mjs`'s photo-priority logic (extract NOTHING — duplicate the ~15-line resolution loop; build.mjs refactor is out of scope).
- Produces: `bun carousel/reel.mjs` reads `selection.json` + picks, resolves `arm` (env `REEL_ARM` ∈ A|B|C, default = `["A","B","C"][dayOfYear % 3]`), theme + audio via config, builds timeline → captures → encodes → writes: `out/reel.mp4` (contract-asserted), `out/cover.jpg` (1080×1920, ≤4 words: `"{PRIZE NOUN} · {price}"` — rendered via a minimal HTML card reusing theme tokens + `stampHtml`), `out/reel-keyframes.png` (composite: frames 1, 16, 37, stamp frame, final frame side-by-side — the §7.5 legibility QA gate artifact), and `out/reel-meta.json` `{arm, durationMs, stampTimesMs, audio: {file, mood}, coverText}`. Exits non-zero on any gate/contract failure. IMPORTANT: cover render happens in the SAME browser session pattern as capture (fresh process = fine; but never a second `chromium.launch()` after capture in-process — do the cover screenshot INSIDE the capture browser before it closes, via a second page, or spawn `capture` and cover in sequence within one launch; simplest: render cover first with its own tiny `captureFrames`-style single screenshot using the same launched browser — implement cover inside `reel.mjs` with ONE browser: page A renders cover (static, `__ready` wait, screenshot), then page B runs the frame loop).

- [ ] **Step 1: Implement `reel.mjs`** per the interface. Skeleton decisions that MUST hold: single `chromium.launch()`; keyframe composite built by a THIRD page in the same browser (like `contact.mjs` does with data-URLs); jpeg-convert the cover via the same canvas trick `publish.mjs` uses (or screenshot `type:"jpeg", quality: 90` directly — allowed). Log every stage with timings.

- [ ] **Step 2: E2E dry run** (uses today's real selection in the archive or a fresh `PDD_DIR`):

```bash
PDD_DIR=/tmp/pdd-reel bun carousel/plan.mjs && PDD_DIR=/tmp/pdd-reel bun carousel/fetchimg.mjs && PDD_DIR=/tmp/pdd-reel REEL_ARM=B bun carousel/reel.mjs && ls -la /tmp/pdd-reel/out/
```

Expected: `reel.mp4` (≤8s, passes contract), `cover.jpg`, `reel-keyframes.png`, `reel-meta.json`; wall-clock ≤4 min for arm B. Then `REEL_ARM=A` (≤6 min). Open `reel.mp4` with `open` and visually confirm: motion is real (particles drift, type slams), no dead frames, stamp lands with the design. **Report the visual result honestly — a compiling mp4 that looks like a slideshow is a FAILURE against spec §4.4.**

- [ ] **Step 3: Commit** — `git add carousel/reel.mjs && git commit -m "feat(carousel): reel orchestrator — arm A/B/C, cover, QA keyframes, contract-gated mp4"`

---

### Task 7: `story.mjs` — countdown video story

**Files:**
- Create: `carousel/story.mjs`
- Modify: `carousel/reel-template.mjs` (export `flipClockCss()` + `countdownHtml(closeIso, nowIso)` if Task 3 kept them internal)
- Test: `carousel/tests/story.test.mjs`

**Interfaces:**
- Produces: `bun carousel/story.mjs` → `out/story.mp4` (1080×1920, 12s, contract-asserted with `maxDurS: 15`): picks the draw closing SOONEST from `selection.json` (min `draw_date`), renders one scene — hero (photo-priority logic) breathing at 1.00→1.02 scale loop (cards MAY scale, only raw photos may not — the breath is on the card layer), flip-clock counting real seconds to the close time (`data-countdown` from the seek runtime; `el.dataset.now` = build-time ISO so seeking is deterministic), "link in bio · @prizedrawsdaily" line (API stories carry NO tappable link — spec §4.5), stamp at ~10s, compliance footer. Exports `buildStoryTimeline({ draw, hero, theme, audioMeta }) → {html, durationMs, stampTimesMs}` for the test.

- [ ] **Step 1: Contract test** (mirrors reeltemplate test): builds the story timeline for a fixture draw, asserts: `__seek`/`__ready` present, `data-countdown` present, `stamp-in` present, duration 12000, compliance footer present, deterministic (two builds identical).

- [ ] **Step 2: Implement; Step 3: E2E** — `PDD_DIR=/tmp/pdd-reel bun carousel/story.mjs && open /tmp/pdd-reel/out/story.mp4` (countdown ticks when scrubbing); **Step 4: run suite + commit** — `git add carousel/story.mjs carousel/reel-template.mjs carousel/tests/story.test.mjs && git commit -m "feat(carousel): countdown video story via the reel pipeline"`

---

### Task 8: `insights.mjs` — ingest + report (Composio-fed)

Scripts cannot call MCP; Claude pulls JSON via Composio in-session and feeds files in. This task builds the deterministic half + the runbook.

**Files:**
- Create: `carousel/insights.mjs`, `carousel/INSIGHTS.md`, `carousel/tests/insights.test.mjs`, fixtures under `carousel/tests/fixtures/`

**Interfaces:**
- Consumes: `state.mjs` (`insertMetrics`, `recentPosts`, `_setFetch` for tests).
- Produces: CLI `bun carousel/insights.mjs ingest <kind> <file.json>` where kind ∈ `ig_media` (payload: `{data: [{id, like_count, comments_count, media_type, media_product_type, timestamp, permalink}]}`), `ig_reach` (`{data: [{name: "reach", values: [{end_time, value}]}]}`), `fb_posts` (`{data: [{id, created_time, reactions: {summary: {total_count}}, comments: {summary: {total_count}}, shares?: {count}}]}`); each maps to `carousel_metrics` rows: ig_media → per-media `likes`/`comments` (day = timestamp's London date, media_id = id); ig_reach → `(day, "account", "reach", value)`; fb_posts → per-post `fb_reactions`/`fb_comments`/`fb_shares`. Plus `bun carousel/insights.mjs report` → joins last-7d `carousel_posts` × `carousel_metrics` and prints a per-day table (date, formats posted, category, account reach, per-post likes/comments). Exported for tests: `mapPayload(kind, json) → rows[]`.

- [ ] **Step 1: Save fixtures** — trim today's real Composio payload shapes into `carousel/tests/fixtures/ig_media.json`, `ig_reach.json`, `fb_posts.json` (3–4 records each, real field names, fake values).

- [ ] **Step 2: Failing tests**

```js
// carousel/tests/insights.test.mjs
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
```

- [ ] **Step 3: Implement** (`mapPayload` pure; CLI wraps it with `insertMetrics(rows)` in batches of 50; `report` uses `recentPosts(7)` + a metrics GET via the same `rest()` pattern — add `recentMetrics(days)` to `state.mjs` mirroring `recentPosts` exactly, plus one mock test in `state.test.mjs`).

- [ ] **Step 4: Write `carousel/INSIGHTS.md`** — the runbook Claude follows in-session: the 3 Composio tool calls with exact args (`INSTAGRAM_GET_IG_USER_MEDIA` fields incl. like_count/comments_count limit 25; `INSTAGRAM_GET_USER_INSIGHTS` metric reach period day since 7 days ago; `FACEBOOK_GET_PAGE_POSTS` with reactions/comments summaries limit 10), save each JSON to `$(workDir)/insights/{kind}.json`, run the 3 ingest commands, then `report`.

- [ ] **Step 5: Suite green, commit** — `git add carousel/insights.mjs carousel/INSIGHTS.md carousel/tests/insights.test.mjs carousel/tests/fixtures/ carousel/state.mjs carousel/tests/state.test.mjs && git commit -m "feat(carousel): insights ingest + weekly report (Composio-fed, deterministic)"`

---

### Task 9: Publish v2 — reel/story hosting, Reel-first rows, retention

**Files:**
- Modify: `carousel/publish.mjs`
- Create: `carousel/cleanup.mjs`
- Test: `carousel/tests/cleanup.test.mjs`

**Interfaces:**
- `publish.mjs` additions: when `out/reel.mp4` exists → upload as `{date}/{slug}/reel.mp4` (`Content-Type: video/mp4`) + `out/cover.jpg` → `cover.jpg`; when `out/story.mp4` exists → `story.mp4`; publish.json gains `reelUrl`, `coverUrl`, `storyUrl`, `reelMeta` (from `reel-meta.json`); write-ahead rows `{format: "reel"|"story", status: "assets_uploaded", hook_archetype: "arm-" + arm}` (only for assets that exist). Idempotency preflight extends to reel: if today's reel row is `published`, skip re-hosting the reel but continue others.
- `cleanup.mjs`: `bun carousel/cleanup.mjs` — for every `carousel_posts` row of TODAY with status `published`, once ALL of today's rows are published (no `pending`/`assets_uploaded`/`container_created` rows remain), DELETE the bucket folder `{date}/{slug}/` objects via storage REST (list → delete each), log what was freed; refuses (exit 1, message) while any row is still in-flight. Exported for tests: `readyForCleanup(rows) → boolean`.

- [ ] **Step 1: Failing test for the cleanup guard**

```js
// carousel/tests/cleanup.test.mjs
import { test, expect } from "bun:test";
import { readyForCleanup } from "../cleanup.mjs";

test("cleanup only when every row is published", () => {
  expect(readyForCleanup([{ status: "published" }, { status: "published" }])).toBe(true);
  expect(readyForCleanup([{ status: "published" }, { status: "assets_uploaded" }])).toBe(false);
  expect(readyForCleanup([])).toBe(false);
});
```

- [ ] **Step 2: Implement both files; run suite. Step 3: Verify hosting dry-path** — with today's real `out/` (already published), `bun carousel/publish.mjs` must exit 2 (already-published preflight — proves we can't double-post while iterating). **Step 4: Commit** — `git add carousel/publish.mjs carousel/cleanup.mjs carousel/tests/cleanup.test.mjs && git commit -m "feat(carousel): reel/story hosting + write-ahead rows + bucket retention"`

---

### Task 10: DAILY.md v3 + supervised first-run protocol + push

**Files:**
- Modify: `carousel/DAILY.md`

**Interfaces:** none (docs + release).

- [ ] **Step 1: Rewrite DAILY.md** to the Phase-2 routine, exact content requirements: (1) daily order: insights ingest (INSIGHTS.md) → plan → fetchimg → ONE composite QA (contact sheet + reel keyframes) → build + reel (arm from rotation table: dayOfYear%3 → A/B/C, overridable by REEL_ARM) + story → Claude writes CAPTION.txt + FB_CAPTION.txt from BRIEFING.md → publish.mjs → **Composio publish order: REEL first** (container `media_type=REELS`, `video_url=reelUrl`, `cover_url=coverUrl`, `caption`, `share_to_feed: true` → poll → `_PUBLISH max_wait_seconds=300` → `state-mark reel published --ig <id>`), then carousel (per-child alt_text route — keep the existing verified recipe), then story (container `media_type=STORIES` + `video_url=storyUrl` → publish → `state-mark story published --ig <id>`; **first story is a SUPERVISED TEST** — if the API rejects STORIES on this Creator account, record the error verbatim in the ledger and drop story from the routine pending the Business-switch decision), then FB: **video post primary** (`FACEBOOK_CREATE_VIDEO_POST` page_id `1106603652538117`, `file_url=reelUrl`, `description=fbCaption` → `state-mark fb_video published --fb <id>`; photo mirror only if video fails) → `bun carousel/cleanup.mjs` → reply sweep. (2) QA gates: reel keyframes — price legible on frames 1/16/37 or the run FAILS; story countdown shows a plausible time. (3) The week-1/2 format experiment table (arm per day + what to eyeball). (4) Keep: veto flow, prime windows, state-mark reference, watchdog note.
- [ ] **Step 2: Full suite** — `bun test carousel/tests/` all green.
- [ ] **Step 3: Commit + push**

```bash
git add carousel/DAILY.md
git commit -m "docs(carousel): DAILY v3 — reel-first publish, story supervision, cleanup, arm rotation"
git pull --rebase origin main && git push origin main
```

---

## Acceptance (after all tasks)

The REAL gate is the next daily run: arm-B reel built from live draws, previewed (keyframes + mp4) under the veto flow, published Reel-first, story supervised-tested, FB video attempted, cleanup runs, insights ingested next session. Spec §2's week-2 go/no-go applies from the first published Reel.

## Phase 3 pointer

learn.mjs/strategy.json/report.mjs, engagement hit-lists, collab pitch drafts, scheduled-run trial — planned after the Reel format experiment has ~1 week of data.
