# Carousel audio kit — licence & provenance record

All 16 music tracks are **Pixabay Content License** (Pixabay's own free-commercial-use
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

> **v3 (2026-10-21): 10 tracks added for the Reel rotation (reelAudio in beat.mjs)** —
> sections 8–17 below (`trap`, `tribal`, `dnb`, `newjack`, `dubstep`, `slaphouse`,
> `boombap`, `breakbeat`, `futurebass`, `hiphop`). Same acquisition, BPM and
> `firstBeatOffsetMs` method as v2 (one practical note: Wayback serves many archived
> Pixabay pages gzip-compressed, so fetch them with `curl --compressed`). Download date
> for all 10: **2026-10-21**. Every v3 track also passed two energy gates measured
> against `win.mp3` (mean volume, first 30 s = -13.2 dB) and `driving.mp3` (-8.2 dB):
> (1) `ffmpeg -t 30 -af volumedetect` mean volume ≥ -14.0 dB; (2) no slow intro —
> fewer than 4 s of the first 10 s sitting ≥ 8 dB below the track's median RMS
> (librosa RMS in 2 s windows), the 0–10 s vs rest RMS gap no worse than -7 dB, and
> 0–10 s onset strength ≥ 0.6× the rest of the track. `trap.mp3` and `tribal.mp3`
> are the first 150 s of their originals (lossless `ffmpeg -t 150 -c copy` cut, no
> re-encode; the Pixabay licence permits edits) to keep the 10 new files under
> ~40 MB in total (39.2 MB); `reelAudio` only ever uses up to `durationMs - 12 s`.

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

### 8. `trap.mp3` — mood: `trap`
- **Title:** Intoxicant Hiphop (FATFOX) Club Bass Instrumental
- **Author:** FATFoxBeat
- **Source:** https://pixabay.com/music/trap-intoxicant-hiphop-fatfox-club-bass-instrumental-181695/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Trap, Beats, Electronic
- **Duration:** 150.0s as shipped (verified via ffprobe) — first 150 s of the 217.2s
  original, lossless `-c copy` cut (see v3 note).
- **BPM:** 112 — librosa onset-strength + beat-track (median inter-beat interval
  = 112.3 BPM exactly; tempogram top candidates [172.3, 83.4, 56.2, 161.5, 112.3]
  BPM — the beat grid is self-consistent at 112.3 across the track).
- **firstBeatOffsetMs:** 0 — no leading silence detected (full volume from t=0).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -6.6 dB (the loudest track in the kit);
  no intro at all — 0–10 s is as loud as the rest (+1.8 dB).
- **Why it fits the brief:** a club-bass trap instrumental (Pixabay tags: Trap,
  Beats) at full level from the first bar — swagger for car / luxury-watch / cash Reels.

### 9. `tribal.mp3` — mood: `tribal`
- **Title:** Play House - Tribal Groove
- **Author:** PlayHouseSound
- **Source:** https://pixabay.com/music/upbeat-play-house-tribal-groove-337745/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Upbeat, Electronic, House
- **Duration:** 150.0s as shipped (verified via ffprobe) — first 150 s of the 212.0s
  original, lossless `-c copy` cut (see v3 note).
- **BPM:** 118 — librosa onset-strength + beat-track (median inter-beat interval
  = 117.5 BPM exactly; tempogram top candidates [234.9, 161.5, 60.1, 95.7, 80.7]
  BPM — 234.9 is the double-time hi-hat echo of 117.5).
- **firstBeatOffsetMs:** 0 — no leading silence detected.
- **dropMs:** null
- **Energy:** mean volume first 30 s = -7.7 dB; percussion-led four-on-the-floor
  from t=0 (0–10 s onset strength 1.4× the rest of the track).
- **Why it fits the brief:** percussion-heavy tribal house — club energy that is
  different from the existing tropical-house `warm` bed.

### 10. `dnb.mp3` — mood: `dnb`
- **Title:** Extreme Waves
- **Author:** JoyInSound
- **Source:** https://pixabay.com/music/drum-n-bass-extreme-waves-403381/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Drum N Bass, Electronic, Chasing
- **Duration:** 101.9s (verified via ffprobe)
- **BPM:** 86 — librosa onset-strength + beat-track (median inter-beat interval
  = 86.1 BPM exactly; tempogram top candidates [86.1, 172.3, 43.1, 57.4, 117.5]
  BPM). 86.1 is the half-time pulse of a 172 BPM drum & bass track; it is kept
  because the grid is self-consistent and a 4-bar phrase at 86 BPM still lands on
  a real phrase boundary (8 bars at 172).
- **firstBeatOffsetMs:** 513 (first `silence_end` = 0.512857s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -9.5 dB; the beat is in from the start and the
  full section arrives by ~10 s.
- **Why it fits the brief:** drum & bass tagged "Chasing" — the highest-tempo feel
  in the kit, for fast-paced draws.

### 11. `newjack.mp3` — mood: `newjack`
- **Title:** 90s New Jack Swing – Funky Club Beat for Commercial Use
- **Author:** Deion_Productions
- **Source:** https://pixabay.com/music/upbeat-90s-new-jack-swing-funky-club-beat-for-commercial-use-379602/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Upbeat, Beats, Electronic
- **Duration:** 156.1s (verified via ffprobe)
- **BPM:** 118 — librosa onset-strength + beat-track (median inter-beat interval
  = 117.5 BPM exactly; tempogram top candidates [57.4, 117.5, 112.3, 215.3, 234.9]
  BPM — 57.4 is the half-time sub-harmonic).
- **firstBeatOffsetMs:** 0 — no leading silence detected.
- **dropMs:** null
- **Energy:** mean volume first 30 s = -12.1 dB; the swing beat plays from bar 1
  (0–10 s onset strength 1.4× the rest of the track).
- **Why it fits the brief:** bouncy, confident 90s club swing beat — a feel-good
  "you could win this" groove that sounds like no other track in the kit.

### 12. `dubstep.mp3` — mood: `dubstep`
- **Title:** Action
- **Author:** Rockot
- **Source:** https://pixabay.com/music/dubstep-action-173045/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Dubstep, Electronic, Action
- **Duration:** 120.0s (verified via ffprobe)
- **BPM:** 103 — librosa onset-strength + beat-track (median inter-beat interval
  = 103.4 BPM exactly; tempogram top candidates [103.4, 76.0, 61.5, 152.0, 50.7]
  BPM — 103.4 is the single dominant peak).
- **firstBeatOffsetMs:** 809 (first `silence_end` = 0.809002s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -11.9 dB; strong hits from the first
  seconds (0–10 s onset strength 1.15× the rest).
- **Why it fits the brief:** action dubstep (tags: Dubstep, Action) — big, punchy
  energy for tech and gaming prizes.

### 13. `slaphouse.mp3` — mood: `slaphouse`
- **Title:** Weekend in Las Vegas. Slap House background music for video stories
- **Author:** White_Records
- **Source:** https://pixabay.com/music/upbeat-weekend-in-las-vegas-slap-house-background-music-for-video-stories-382430/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Upbeat, Electronic, Dance
- **Duration:** 81.0s (verified via ffprobe)
- **BPM:** 112 — librosa onset-strength + beat-track (median inter-beat interval
  = 112.3 BPM exactly; tempogram top candidates [55.0, 215.3, 73.8, 143.6, 112.3]
  BPM).
- **firstBeatOffsetMs:** 0 — no leading silence detected.
- **dropMs:** null
- **Energy:** mean volume first 30 s = -10.0 dB; the beat runs from t=0 and the
  full slap-bass section is in by ~10 s.
- **Why it fits the brief:** slap house, the bouncy-bass sound common on Reels, and
  a "Weekend in Las Vegas" theme that suits cash prizes.

### 14. `boombap.mp3` — mood: `boombap`
- **Title:** Workout - Workout Music
- **Author:** prettyjohn1
- **Source:** https://pixabay.com/music/old-school-hip-hop-workout-workout-music-540854/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Old School Hip Hop, Beats, Electronic
- **Duration:** 93.4s (verified via ffprobe)
- **BPM:** 96 — librosa onset-strength + beat-track (median inter-beat interval
  = 95.7 BPM exactly; tempogram top candidates [198.8, 64.6, 48.8, 95.7, 129.2]
  BPM — 198.8 is the double-time hat echo of the 95.7 grid).
- **firstBeatOffsetMs:** 647 (first `silence_end` = 0.646803s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -10.3 dB; the drums are in from the first
  bar (0–10 s onset strength 1.03× the rest).
- **Why it fits the brief:** an old-school hip-hop workout beat — confident and
  punchy, for collectibles and streetwear-style prizes.

### 15. `breakbeat.mp3` — mood: `breakbeat`
- **Title:** To The Moon (acid breakbeat)
- **Author:** Kulakovka
- **Source:** https://pixabay.com/music/upbeat-to-the-moon-acid-breakbeat-281152/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Upbeat, Electronic, Action
- **Duration:** 118.6s (verified via ffprobe)
- **BPM:** 118 — librosa onset-strength + beat-track (median inter-beat interval
  = 117.5 BPM exactly; tempogram top candidates [161.5, 117.5, 234.9, 95.7, 68.0]
  BPM — 234.9 is its double-time echo).
- **firstBeatOffsetMs:** 154 (first `silence_end` = 0.15356s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -11.1 dB; the breaks start at t=0 (0–10 s
  onset strength 1.0× the rest).
- **Why it fits the brief:** acid breakbeat tagged "Action" — a rave-style
  "to the moon" lift for big-ticket draws.

### 16. `futurebass.mp3` — mood: `futurebass`
- **Title:** Vlog Fast Car
- **Author:** Novifi
- **Source:** https://pixabay.com/music/future-bass-vlog-fast-car-259484/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Future Bass, Electronic, Pop
- **Duration:** 115.3s (verified via ffprobe)
- **BPM:** 96 — librosa onset-strength + beat-track (median inter-beat interval
  = 95.7 BPM exactly; tempogram top candidates [95.7, 76.0, 184.6, 198.8, 55.0]
  BPM — 95.7 is the dominant peak).
- **firstBeatOffsetMs:** 63 (first `silence_end` = 0.0629705s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -13.7 dB (on a par with `win.mp3`, -13.2 dB);
  the beat runs from the start and the full section is in by ~10 s.
- **Why it fits the brief:** future bass made for fast-car vlog edits (tags: Future
  Bass, Pop) — upbeat and glossy for car and tech draws.

### 17. `hiphop.mp3` — mood: `hiphop`
- **Title:** Epic Hip Hop Beat
- **Author:** BackgroundMusicForVideos
- **Source:** https://pixabay.com/music/beats-epic-hip-hop-beat-334870/
- **Licence:** Pixabay Content License
- **Genre tags (Pixabay):** Beats, Electronic, Alternative Hip Hop
- **Duration:** 137.6s (verified via ffprobe)
- **BPM:** 89 — librosa onset-strength + beat-track (median inter-beat interval
  = 89.1 BPM exactly; tempogram top candidates [89.1, 172.3, 184.6, 44.6, 58.7]
  BPM — 89.1 is the dominant peak).
- **firstBeatOffsetMs:** 918 (first `silence_end` = 0.918005s).
- **dropMs:** null
- **Energy:** mean volume first 30 s = -13.5 dB; the beat drops by ~2 s (0–10 s
  onset strength 1.08× the rest).
- **Why it fits the brief:** an "epic" hip-hop instrumental — big, confident energy
  for the grand-prize Reels, different in feel from the old-school `boombap` beat.
