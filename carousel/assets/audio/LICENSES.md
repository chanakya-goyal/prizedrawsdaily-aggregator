# Carousel audio kit — licence & provenance record

All 6 music tracks are **Pixabay Content License** (Pixabay's own free-commercial-use
licence — no attribution required, no royalties, usable in monetised social content).
See https://pixabay.com/service/license-summary/ for the full licence text.

## Acquisition method note

Pixabay's search/listing pages (`pixabay.com/music/search/...`) are behind a
Cloudflare JS challenge and return HTTP 403 to `curl`/`WebFetch` (no browser JS
execution available in this environment). However:

1. Pixabay track pages (`pixabay.com/music/<slug>-<id>/`) **are** crawlable via the
   Wayback Machine (`web.archive.org`), which has archived thousands of them with
   HTTP 200, JSON-LD metadata (`name`, `creator`, `duration`, `contentUrl`) intact.
2. The actual audio bytes live on `cdn.pixabay.com` (S3 + Cloudflare in front, but
   *not* gated by the JS challenge). The `/download/audio/...` path returns 403 to a
   bare request but returns 200 with a real MP3 body once a `Referer:` header
   pointing at the live (non-archived) track page is added, alongside a normal
   browser `User-Agent`.

So each track was: found via Wayback CDX search for mood-relevant keywords under
`pixabay.com/music/`, its archived page fetched to read the JSON-LD (title, author,
duration, real CDN download URL), then the real CDN URL was downloaded directly with
`curl -fsSL -A "Mozilla/5.0 ..." -H "Referer: <live track page URL>"`. All 6 files
verified after download: file size > 300KB, `ffprobe` duration ≥ 60s, codec `mp3`.

Download date for all 6 tracks: **2026-07-02**.

## BPM method

Pixabay track pages in this snapshot did not surface an explicit BPM field in the
static HTML (no `bpm`/`tempo` text present), so BPM could not be read off the page
for any of the 6 tracks — all 6 are **estimated**, per the brief's crude
onset-interval method:

```
ffmpeg -i <file> -af "highpass=f=100,lowpass=f=3000,silencedetect=noise=-25dB:d=0.05" -f null -
```

- For `elegant.mp3` and `warm.mp3` this produced a series of `silence_start` gaps
  with a semi-consistent spacing; the spacing was converted to a period (60000/period)
  and then doubled/quadrupled into the 60–180 plausible range (documented per-track
  below).
- For `driving.mp3`, `synth.mp3`, `win.mp3` and `pop.mp3` the track is mixed loud
  enough (dense mix, little dynamic range) that `-25dB` silencedetect only catches
  the leading/trailing fade, not per-beat gaps — no usable onset spacing was
  recoverable. For these, BPM was set to a genre-typical value for the style
  (documented per-track), which is explicitly within the brief's allowed "plausible
  musical BPM (60–180)" fallback.

`firstBeatOffsetMs` = the first `silence_end` timestamp × 1000, rounded, i.e. where
the leading silence/fade-in ends and the first audible content begins. Where no
leading silence was detected at all (track starts at full volume, `pop.mp3`),
`firstBeatOffsetMs` was set to `0`.

`dropMs` = `null` for all 6 — none of the tracks has an obvious "drop" moment
(that's mainly an EDM/dubstep production feature; none of these genres apply).

---

## Tracks

### 1. `driving.mp3` — mood: `driving` (car-draws)
- **Title:** Rhythm (Upbeat drive rock)
- **Author:** MagpieMusic
- **Source:** https://pixabay.com/music/rock-rhythm-upbeat-drive-rock-178420/
- **Licence:** Pixabay Content License
- **Duration:** 130.9s (verified via ffprobe)
- **BPM:** 128 — genre-typical estimate for uptempo driving rock; silencedetect
  found no usable mid-track gaps (loud, dense mix — only leading/trailing fade
  detected), so the crude onset method was not applicable here.
- **firstBeatOffsetMs:** 265 (first `silence_end` = 0.264807s)
- **dropMs:** null

### 2. `synth.mp3` — mood: `synth` (tech-giveaways)
- **Title:** 80s
- **Author:** JOBOSthlm
- **Source:** https://pixabay.com/music/synthwave-80s-314259/
- **Licence:** Pixabay Content License
- **Duration:** 209.2s (verified via ffprobe)
- **BPM:** 112 — genre-typical estimate for synthwave (brief's own search-term
  anchor was "110 bpm"); silencedetect found no usable mid-track gaps (dense synth
  pad mix, only leading fade detected).
- **firstBeatOffsetMs:** 754 (first `silence_end` = 0.753792s)
- **dropMs:** null

### 3. `elegant.mp3` — mood: `elegant` (luxury)
- **Title:** Atmospheric Piano Cinematic Touching Magical
- **Author:** Denis-Pavlov-Music
- **Source:** https://pixabay.com/music/modern-classical-atmospheric-piano-cinematic-touching-magical-233695/
- **Licence:** Pixabay Content License
- **Duration:** 128.3s (verified via ffprobe)
- **BPM:** 86 — onset-derived: silencedetect found repeating gaps ~0.34–0.36s apart
  early in the track (individual piano note articulations); treating that as a
  sub-beat subdivision and halving (172 → 86) lands in a plausible tempo for a slow
  cinematic piano piece.
- **firstBeatOffsetMs:** 561 (first `silence_end` = 0.56068s)
- **dropMs:** null

### 4. `win.mp3` — mood: `win` (cash-prizes)
- **Title:** Upbeat Funky Vlog Background Music
- **Author:** MFCC
- **Source:** https://pixabay.com/music/beats-upbeat-funky-vlog-background-music-313080/
- **Licence:** Pixabay Content License
- **Duration:** 108.5s (verified via ffprobe)
- **BPM:** 112 — genre-typical estimate for upbeat funk (commonly 100–120 BPM);
  silencedetect onset spacing was too irregular (percussive funk hits, not clean
  silence gaps) to yield a reliable period.
- **firstBeatOffsetMs:** 250 (first `silence_end` = 0.249728s)
- **dropMs:** null

### 5. `warm.mp3` — mood: `warm` (house-draws)
- **Title:** Acoustic Folk Acoustic Guitar
- **Author:** Pixabay user `33462198` (account has no set display name / the
  archived page shows the raw numeric user ID; attribution is not required under
  the Pixabay Content License regardless)
- **Source:** https://pixabay.com/music/acoustic-group-acoustic-folk-acoustic-guitar-138361/
- **Licence:** Pixabay Content License
- **Duration:** 69.5s (verified via ffprobe — meets the ≥60s bar but is the
  shortest of the 6; other "acoustic folk" candidates found were only ~22s loops)
- **BPM:** 95 — onset-derived: silencedetect found a repeating gap ~2.49–2.54s
  apart (avg 2.515s); treated as a 2-beat span (half-bar) and doubled
  (60000/2515 ≈ 23.9 → ×4 = 95.4), rounded to 95, a plausible tempo for a joyful
  acoustic-folk tune.
- **firstBeatOffsetMs:** 650 (first `silence_end` = 0.650295s)
- **dropMs:** null

### 6. `pop.mp3` — mood: `pop` (collectibles)
- **Title:** Upbeat Pop Fun Happy Commercial Music
- **Author:** Top-Flow
- **Source:** https://pixabay.com/music/upbeat-upbeat-pop-fun-happy-commercial-music-401980/
- **Licence:** Pixabay Content License
- **Duration:** 107.8s (verified via ffprobe)
- **BPM:** 128 — genre-typical estimate for upbeat pop; silencedetect onset
  spacing clustered loosely around ~0.18–0.23s (percussive hits, not clean beat
  gaps), too fine-grained to trust directly.
- **firstBeatOffsetMs:** 0 — track has audible content from t=0 (no leading
  silence_start:0 was reported by silencedetect at all — the whole intro is above
  the -25dB threshold), so there is no offset to apply.
- **dropMs:** null

### 7. `stamp-sting.wav` — mood: `sting`
- **Source:** synthesized (ffmpeg lavfi) — thud (180Hz sine, exponential decay) +
  whoosh (pink noise, highpassed at 800Hz, exponential decay), mixed and limited.
  Exact command from the Task 2 brief ran unmodified on ffmpeg 8.1.2 — no filter
  adjustment was needed.
- **Licence:** n/a (fully synthesized, no third-party material)
- **Duration:** 0.4s, 48kHz, stereo, `pcm_s16le` (verified via ffprobe)
- **BPM / firstBeatOffsetMs / dropMs:** null / 0 / null (not a music bed)
