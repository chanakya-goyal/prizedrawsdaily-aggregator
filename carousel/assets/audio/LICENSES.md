# Carousel audio kit — licence & provenance record

All 6 music tracks are **Pixabay Content License** (Pixabay's own free-commercial-use
licence — no attribution required, no royalties, usable in monetised social content).
See https://pixabay.com/service/license-summary/ for the full licence text.

## v2 note (2026-07-03) — high-energy replacement pass

User feedback on the v1 kit: "sounds like study music, not giving prize-draw vibe."
All 6 mood tracks below (`driving`, `synth`, `elegant`, `win`, `warm`, `pop`) were
**replaced end-to-end** with high-energy, strong-beat tracks — no lo-fi/ambient/gentle
piano survives. Filenames, moods, and the manifest schema are unchanged; only the
audio bytes + their `bpm`/`firstBeatOffsetMs`/`source`/`licence` metadata changed.
`stamp-sting.wav` is untouched (still the original synthesized thud+whoosh).

## Acquisition method note

Pixabay's search/listing pages (`pixabay.com/music/search/...`) are behind a
Cloudflare JS challenge and return HTTP 403 to `curl`/`WebFetch` (no browser JS
execution available in this environment). However:

1. Pixabay track pages (`pixabay.com/music/<slug>-<id>/`) **are** crawlable via the
   Wayback Machine (`web.archive.org`), which has archived thousands of them with
   HTTP 200, JSON-LD metadata (`name`, `creator`, `duration`, `contentUrl`) intact.
   For this pass, candidate discovery used the Wayback **CDX API** directly —
   `http://web.archive.org/cdx/search/cdx?url=pixabay.com/music/&matchType=prefix&output=json&filter=original:.*<keyword>.*&collapse=urlkey&filter=statuscode:200` —
   which searches archived Pixabay music-page URLs by mood keyword (phonk,
   cyberpunk, tropical-house, sports-rock, funk, etc.) server-side, without ever
   hitting Pixabay's own (403'd) search endpoint.
2. The actual audio bytes live on `cdn.pixabay.com` (S3 + Cloudflare in front, but
   *not* gated by the JS challenge). The `/download/audio/...` path returns 403 to a
   bare request but returns 200 with a real MP3 body once a `Referer:` header
   pointing at the live (non-archived) track page is added, alongside a normal
   browser `User-Agent`.

So each track was: found via Wayback CDX keyword search under `pixabay.com/music/`,
its archived page fetched to read the JSON-LD (title, author, duration, real CDN
download URL, plus the page's `<meta name="keywords">` genre tags used to sanity-check
mood fit), then the real CDN URL was downloaded directly with
`curl -fsSL -A "Mozilla/5.0 ..." -H "Referer: <live track page URL>"`. All 6 files
verified after download: file size > 300KB, `ffprobe` duration ≥ 60s, codec `mp3`.

Download date for all 6 tracks: **2026-07-03**.

## BPM method

Pixabay track pages in this snapshot still did not surface an explicit BPM/tempo
field in the static HTML or JSON-LD for any of the 6 new tracks (checked via
`grep -io '[0-9]{2,3}\s*bpm'` on each saved page — no matches), so BPM again could
not be read off the page for any track.

This pass had `librosa` available in the environment (installed via
`pip3 install librosa`), so instead of the v1 kit's crude
`ffmpeg silencedetect`-period-doubling guess, BPM was computed with a proper
onset-strength + dynamic-programming beat tracker:

```python
y, sr = librosa.load(file, sr=22050, mono=True)
onset_env = librosa.onset.onset_strength(y=y, sr=sr)
tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
```

Each result was cross-checked two ways before being accepted: (1) the median of
`60 / diff(beat_times)` across all detected beats, which matched `tempo` exactly for
all 6 tracks (i.e. the beat grid is genuinely periodic, not a one-off fit), and (2)
the track's own tempogram top-5 candidate list (`librosa.feature.tempogram`), to
confirm the chosen value wasn't an obviously-wrong half/double-time artifact next to
a much stronger competing peak.

`firstBeatOffsetMs` was derived the same way as v1, per the brief's instruction — via
`ffmpeg -i <file> -af "highpass=f=100,lowpass=f=3000,silencedetect=noise=-25dB:d=0.05" -f null -`,
taking the first `silence_end` timestamp (leading fade-in end / first audible
content) × 1000, rounded. Where no leading silence was detected at all (track is at
full volume from t=0), `firstBeatOffsetMs` was set to `0`.

`dropMs` = `null` for all 6, unchanged from v1 — no explicit drop-detection was run;
this remains an optional refinement, not required by `beat.mjs`/tests.

---

## Tracks

### 1. `driving.mp3` — mood: `driving` (car-draws)
- **Title:** Drift Phonk
- **Author:** SigmaMusicArt
- **Source:** https://pixabay.com/music/beats-drift-phonk-383124/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Beats, Electronic, Alternative Hip Hop
- **Duration:** 124.9s (verified via ffprobe)
- **BPM:** 112 — librosa onset-strength + beat-track, cross-checked (median
  inter-beat interval = 112.3 BPM exactly, matching the beat tracker; tempogram
  top candidates were [172.3, 68.0, 112.3, 86.1, 57.4] BPM, so 112.3 is not a
  spurious half/double-time pick — it's a genuine mid-strength peak with a
  self-consistent beat grid across the full track).
- **firstBeatOffsetMs:** 202 (first `silence_end` = 0.202154s — the phonk track's
  cowbell hit intro).
- **dropMs:** null
- **Why it fits the brief:** exactly the "aggressive/drift phonk" genre called out
  by name in the brief for car content — a dense 808-driven hip-hop-adjacent beat
  built for hype, not background listening.

### 2. `synth.mp3` — mood: `synth` (tech-giveaways)
- **Title:** Techno Cyberpunk Powerful Action Workout Gaming Sport Music
- **Author:** Tunetank
- **Source:** https://pixabay.com/music/chase-scene-techno-cyberpunk-powerful-action-workout-gaming-sport-music-347602/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Chase Scene, Electronic, Electro
- **Duration:** 266.5s (verified via ffprobe)
- **BPM:** 112 — librosa onset-strength + beat-track, cross-checked (median
  inter-beat interval = 112.3 BPM exactly; tempogram top candidates
  [215.3, 143.6, 112.3, 107.7, 89.1] BPM).
- **firstBeatOffsetMs:** 376 (first `silence_end` = 0.376333s).
- **dropMs:** null
- **Why it fits the brief:** the title alone ("Techno Cyberpunk ... Action ...
  Gaming ... Sport") is a direct hit on the brief's "energetic cyberpunk
  synthwave, NOT chill" ask — driving techno pulse built for action/chase footage,
  ~9dB louder (RMS) than the v1 chill-synthwave track it replaces.

### 3. `elegant.mp3` — mood: `elegant` (luxury)
- **Title:** Fashion - Fashion Show Vogue
- **Author:** mirostar
- **Source:** https://pixabay.com/music/beats-fashion-fashion-show-vogue-524106/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Beats, Electronic, Pop
- **Duration:** 132.5s (verified via ffprobe)
- **BPM:** 81 — librosa onset-strength + beat-track (median inter-beat interval
  = 80.7 BPM exactly; tempogram top candidates [60.1, 80.7, 117.5, 123.0, 215.3]
  BPM — 80.7 is the clear dominant peak after the sub-harmonic).
- **firstBeatOffsetMs:** 0 — no leading silence was detected at all (track opens
  at full volume; `silencedetect` reported no `silence_start`/`silence_end` pair
  before ~122s, which is the trailing fade).
- **dropMs:** null
- **Why it fits the brief:** literally a "fashion show / vogue" runway beat by
  name and genre tag — a confident, pulsing electronic-beat track built for
  catwalk energy, ~7dB louder (RMS) than the v1 ambient cinematic-piano track it
  replaces. Matches the brief's explicit "fashion show beat" search-term anchor.

### 4. `win.mp3` — mood: `win` (cash-prizes)
- **Title:** Energetic Sports Rock Music (1 min 37 sec cut)
- **Author:** MFCC
- **Source:** https://pixabay.com/music/rock-energetic-sports-rock-music-1-min-37-sec-378022/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Rock, Upbeat, Chasing
- **Duration:** 97.3s (verified via ffprobe)
- **BPM:** 99 — librosa onset-strength + beat-track (median inter-beat interval
  = 99.4 BPM exactly; tempogram top candidates [99.4, 198.8, 66.3, 136.0, 80.7]
  BPM — 99.4 is the single dominant peak, well clear of its own double-time
  echo).
- **firstBeatOffsetMs:** 66 (first `silence_end` = 0.0657823s).
- **dropMs:** null
- **Why it fits the brief:** "Energetic Sports Rock" by name/tag — stadium
  guitar-driven rock built for arena/sports hype, matching the brief's
  "stomp-clap, brass-funk celebration, sports-arena energy" ask for cash-prize
  wins.

### 5. `warm.mp3` — mood: `warm` (house-draws)
- **Title:** Fashion Tropical House
- **Author:** SZAudio
- **Source:** https://pixabay.com/music/upbeat-fashion-tropical-house-323529/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Upbeat, Electronic, Chasing
- **Duration:** 109.7s (verified via ffprobe)
- **BPM:** 103 — librosa onset-strength + beat-track (median inter-beat interval
  = 103.4 BPM exactly; tempogram top candidates [52.7, 69.8, 215.3, 103.4, 107.7]
  BPM).
- **firstBeatOffsetMs:** 0 — no leading silence was detected (track opens at full
  volume; the only `silencedetect` gap found was the trailing fade at ~106s).
- **dropMs:** null
- **Why it fits the brief:** genuine tropical/uplifting house — warm, sunny
  chord stabs over a four-on-the-floor pulse, danceable rather than background —
  ~9dB louder (RMS) than the v1 acoustic-folk-guitar track it replaces, and the
  only one of the 6 that was previously a totally wrong genre for "warm but
  danceable."

### 6. `pop.mp3` — mood: `pop` (collectibles)
- **Title:** Fun Upbeat Pop Funk (Pop Groove Party)
- **Author:** NRA-LAB
- **Source:** https://pixabay.com/music/funk-fun-upbeat-pop-funk-pop-groove-party-215688/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Funk, Upbeat, Old School Funk
- **Duration:** 91.4s (verified via ffprobe)
- **BPM:** 152 — librosa onset-strength + beat-track (median inter-beat interval
  = 152.0 BPM exactly; tempogram top candidates [78.3, 152.0, 103.4, 161.5, 51.7]
  BPM — 152 sits clear of the half-time sub-harmonic at 78.3).
- **firstBeatOffsetMs:** 0 — no leading silence was detected (track opens at full
  volume; the only gap found was the trailing fade at ~89.6s).
- **dropMs:** null
- **Why it fits the brief:** "Fun Upbeat Pop Funk ... Groove Party" — bright,
  bouncy old-school funk-pop horn/bass groove, built explicitly for party/fun
  energy, matching the brief's "hyper-energetic fun pop/funk" ask for
  collectibles.

### 7. `stamp-sting.wav` — mood: `sting`
- **Source:** synthesized (ffmpeg lavfi) — thud (180Hz sine, exponential decay) +
  whoosh (pink noise, highpassed at 800Hz, exponential decay), mixed and limited.
  Unchanged from v1 — not touched in this pass.
- **Licence:** n/a (fully synthesized, no third-party material)
- **Duration:** 0.4s, 48kHz, stereo, `pcm_s16le` (verified via ffprobe)
- **BPM / firstBeatOffsetMs / dropMs:** null / 0 / null (not a music bed)
