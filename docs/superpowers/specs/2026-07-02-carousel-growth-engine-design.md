# Carousel Growth Engine — Design Spec (v2)

**Date:** 2026-07-02 · **Status:** v2 — user-approved design, hardened by a 4-lens adversarial review (API reality, anti-ordinary creative bar, growth strategy, ops robustness; 39 verified findings folded in) · **Owner:** Claude (builder/operator) + Chanakya (veto/QA + human-only growth actions)

## 1. Problem

The daily carousel publisher (`carousel/`) produces high-quality posts that reach almost nobody, and it has no way to notice or correct that.

Live evidence (pulled 2026-07-02 via Composio):

- @prizedrawsdaily: **49 followers** (flat since 2026-06-25), 33 posts, **481 total reach in 30 days**.
- Every reach spike is a Reel day (Jun 6: 76, Jun 10: 123, Jun 13: 102, Jun 25: 25). Every carousel/image day: 0–13.
- The pipeline's 5 published carousels (Jun 27–Jul 1): 0–2 likes, 0 comments, ~4–5 reach each.
- FB Page: 15 recent posts, all 0 reactions / 0 comments / 0 shares.
- The Business→Creator switch is **not** the cause (reach identical before/after; fact-checked 2026-06-26).

Code audit findings (2026-07-02):

- **No memory:** no record of past posts anywhere; `plan.mjs:19` does `rm -rf` on the working dir every run; Composio post IDs are discarded; nothing reads performance data.
- **No versioning:** the entire `carousel/` directory is untracked in git — it exists only on this machine.
- Config scattered across `select.mjs`/`format.mjs`/`caption.mjs`/`build.mjs`/`styles.css`; only 2 themes exist for 6 categories.
- Fragility: silent error swallowing (`fetchimg.mjs`), best-effort render readiness, no retries, TZ-fragile close-date math, hardcoded paths/IDs, in-source key literal.
- `ffmpeg` was absent (now installed: 8.1.2). No GitHub Action touches `carousel/`.

## 2. Goals & success metrics

Build a **self-measuring, self-tuning daily publishing system** for IG + FB that Claude operates end-to-end with a human veto, producing output that is **never template-ordinary** (user hard requirement).

30-day targets (honest, from a 49-follower base):

| Metric | Now | Target | Caveat |
|---|---|---|---|
| 30-day total reach | 481 | 3,000–6,000 | **Assumes the auto-Reel performs at the account's historical Reel level (76–123/day). The historical baseline came from a different format, so this is unproven → week-2 go/no-go checkpoint on Reel construction (§4.4).** |
| Followers | 49 | **100–150** | ~0.5–1% cold follow conversion on a utility account → ~30–60 organic; the rest depends on the human-lane actions (§6b: outbound engagement, collabs). |
| Sends + saves | ~0 | > 0 weekly | Measured via **account-level** `shares`/`saves` (total_value, weekly window) in `INSTAGRAM_GET_USER_INSIGHTS`; per-media saves stay locked until 1k followers. If Composio doesn't expose them, reword to observable metrics. |
| Posting consistency | manual | 7/7 days | Protected by the dead-man's-switch nudge (§4.10). |

Milestone: **1,000 followers** unlocks per-media insights → learning upgrades from day-level to post-level attribution. Metric names post-Nov-2025: use `views` (never `impressions`/`plays`); follower delta from `followers_count` on `INSTAGRAM_GET_USER_INFO` (the daily `follower_count` insight needs ≥100 followers).

## 3. Approved decisions

1. **Autonomy = autopilot-with-veto.** Claude builds everything, posts the preview in chat, publishes after a short veto window. Nothing irreversible before the preview exists.
2. **Daily auto-Reel** — the reach lever. Not a slideshow (§4.4). Royalty-free audio baked in (trending audio unavailable via API). No AI avatars.
3. **Six category themes, all attention-maximized** — via one brand skeleton + per-theme craft details (§5), preview-sheet approval before live.
4. **ffmpeg** installed (done, 8.1.2).
5. **Zero-mistake generation** enforced by hard gates (§7).
6. **State lives in Supabase** (the project's existing instance), not git flat-files (§4.2).
7. **Growth has a human lane** (§6b): 15–20 min/day of outbound engagement + collab pitches that the API cannot automate — Claude preps everything, the human executes on their phone.

## 4. Architecture

Existing chain (kept): `plan.mjs → fetchimg.mjs → [Claude visual QA] → build.mjs → publish.mjs → Composio post`.

### 4.1 `config.json` — single source of truth
Per category: display name, visual weight, hook archetype bank (comper-vernacular, data-checkable — e.g. "GTD tonight — no rollover", "odds 1 in 500, do the maths"; a hook may only render when the draw fields prove it), 2 category hashtags, theme tokens (palette, particle profile, display font, craft-detail list §5), Reel profile (audio track ref, pacing). Global: IG/FB IDs, Supabase URL/bucket, paths (env-overridable), prime windows, series branding ("TONIGHT'S UK DRAWS — every night, 7pm UK"), banned-phrase list for captions.

### 4.2 State: Supabase tables (source of truth)
- **`carousel_posts`** — one row per (date, format): status write-ahead state machine `pending → container_created → published`, updated **immediately after each Composio call** (container IDs recorded before `_PUBLISH` so orphans are resumable). Columns: date, format, category, draw_slugs, hook/caption archetype ids, keyword target, ig_container_id, ig_media_id, fb_post_id, asset URLs, posted_at.
- **`carousel_metrics`** — snapshot rows (per-post like/comment counts, daily account reach, account-level weekly shares/saves, FB post insights).
- Why not git-tracked jsonl: this repo has a documented main-vs-feature-branch divergence gotcha; flat-file state on a branch = double-posts; Supabase is machine/branch-independent, durable, and readable by future scheduled cloud runs. `pdd-today` outputs + any local jsonl mirrors are **gitignored**.
- `plan.mjs` archives `pdd-today` → `pdd-today/archive/{date}/` (no more `rm -rf` of history), **pruned to 14 days**. Selection is history-aware via `carousel_posts`: no draw repeated within 7 days; deliberate category rotation.

### 4.3 `insights.mjs` — measurement (windowed backfill, self-healing)
Every run: pull last **7 days** of daily account reach, re-snapshot per-post like/comment counts for all posts <14 days old, account-level weekly `shares`/`saves`, and **FB per-post insights** (`FACEBOOK_GET_POST_INSIGHTS` — available now) — upsert by (date|media_id). Missed days heal automatically; UTC/London off-by-one is harmless under upsert. Attribution honesty: daily reach = trend only; **per-post like/comment counts are the post-level signal**; format effects come from deliberate contrast days (§4.7).

### 4.4 `reel.mjs` — the reach format (NOT a slideshow)
**Construction (v1): "WAAPI seek-and-capture."** Each Reel is authored as ONE animated HTML timeline in the existing Playwright Chromium — kinetic typography (prize-name words slam in with overshoot easing), live drifting particles, 3-layer parallax (background / particle field / prize card at different rates), price count-ups — then captured deterministically: pause all animations (`document.getAnimations().forEach(a => a.pause())`), seek `currentTime = frameIdx × (1000/fps)`, screenshot per frame at **deviceScaleFactor 1, 1080×1920, frames streamed to disk (never buffered in memory)**, encode with ffmpeg. Hard render budget ≤4 min; fallback construction if capture proves flaky = static stills + ffmpeg layered overlay motion (parallax strips, specular sweep, drawtext stamps) — never bare zoompan.

**Anti-ordinary requirements (all verified against the creative review):**
- **Cold open (frames 0–36):** best prize photo full-bleed at frame 0 → 1-frame white flash → ticket price rubber-stamps in (scale 3→1, overshoot, 2-frame chromatic split + body shake) → one-line comper-vernacular kicker tied to a TRUE fact ("A £70K DEFENDER. CLOSES TONIGHT 10PM."). Audio's first transient lands at frame 0 (trim to first onset).
- **Beat sync:** `assets/audio/manifest.json` hand-annotates each track once ({bpm, firstBeatOffsetMs, dropMs}); every cut/slam/stamp quantizes to the beat grid; biggest prize reveal lands on the drop.
- **Photos never zoom** (operator shots are contain-fitted; zooming magnifies blur): the WORLD moves — particle drift 1.0×, card float 0.4× with ±1.5° 3D sway, text 0.2×, one specular sweep per slide. Cutout heroes may scale ≤1.03×.
- **Signature device — THE PRICE STAMP (account-level branding):** every Reel, carousel slide 1, and story ends its reveal with the same circular badge ("JUST 89p A TICKET") slamming in — identical motion (scale 3→1 overshoot, 3-frame shake, expanding ink-ring ripple) and the SAME 0.4s stamp/whoosh sting mixed at the stamp timestamp, themed in category accent but identical in position/motion. Motion branding + audio branding in one reusable element.
- **Loop-bait outro:** final 0.4s = the stamp winding back up so the last frame matches frame 0 (seamless loop → rewatches count); URL/handle rides a lower-third over the final prize, compliance line is a persistent small footer — no dead outro card.
- **Dedicated cover:** 1080×1920, max 4 words ("DEFENDER · 99p") + hero + theme accent, passed as `cover_url`; grid tiles must read as one system (same headline position + stamp motif).

**Format-viability experiment (weeks 1–2):** parameterize construction and rotate across days — **A:** 12–18s themed multi-prize; **B:** ≤8s single-prize hook (giant price/odds question, hard cut to CTA — easiest completion); **C:** "closing tonight" countdown urgency. Compare via §4.3 signals holding slot/category as constant as rotation allows; go/no-go conclusions only at format-sized gaps (~5–10×). This experiment IS the week-2 checkpoint for the §2 reach target.

**Encode contract (verified against 2026 Meta specs):** H.264 + AAC ≤48kHz, yuv420p, progressive, closed GOP, `-movflags +faststart` (moov atom front), 1080×1920, 3s–15min, ≤300MB, VBR ≤25Mbps — asserted via ffprobe in the golden-render test. **Publish flow:** upload via container (`media_type=REELS`, public URL with NO query string — Supabase public bucket qualifies) → poll container status every 10s (max 5 min) until FINISHED → `_PUBLISH` with `max_wait_seconds=300` (Composio's 60s default intermittently fails with error 9007); on ERROR re-encode once (`-preset slow`) then fail loudly. Container ID recorded in state before polling.

### 4.5 `story.mjs` — daily story (video, not a static slide)
API stories carry **no stickers** (no link/poll/countdown) — so the story is reach/warmth only ("link in bio" + handle), designed accordingly. To be non-ordinary at zero marginal cost, the story reuses the Reel pipeline: 10–15s video with an animated flip-clock countdown to the real close time, the prize card breathing (1.00→1.02 loop), stamp at the end. **Supervised first live test in Phase 2** (Stories-on-Creator via API is not 100% settled in vendor docs; fallback = switch account to Business — reach was proven identical).

### 4.6 Caption engine v2 — Claude writes, config briefs
No template strings posted verbatim (they repeat within days at daily cadence and read botlike). `caption.mjs` emits a **fact briefing** (prizes, prices, true close times, verified odds) + a hook **archetype id** (question / price-anchor / deadline / absurd-comparison) + style guide + banned-phrase list ("don't miss out", "amazing prizes", any opener used in the last 14 days per `carousel_posts`). **Claude writes the caption at build time** from the briefing; every caption must contain one concrete verifiable detail ("a 992 GT3 for less than a Freddo"). Archetype id (not the string) is logged for learning. The compliance line stays fixed/templated. Send-CTA phrasing rotates, never verbatim-daily.

**IG SEO block (was missing entirely):** (1) one-time manual display-name change → "Prize Draws Daily | UK Competitions" (user does this in-app); (2) caption opens with the category keyword naturally ("UK car competitions closing this week…") before the hook; (3) build.mjs generates descriptive keyword `alt_text` per slide, passed in every container (verify Composio exposes the param; fall back to raw Graph call); (4) Reel first-frame overlay includes the searchable phrase; (5) keyword target logged per post. Hashtags 3–5, rotated (repetitive daily hashtag blocks risk distribution suppression); `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` preflight in publish (3 posts/day vs 100/24h cap — no throttle risk).

### 4.7 `learn.mjs` + `strategy.json` — honest learning
**Pre-decided from 2026 known practice, frozen for month 1** (not "learned" from n=7): 7–9pm UK slot, sends-CTA captions, hook in first 3 words / first frame, 3–5 hashtags, keyword-led captions, Reels as growth format. **Month-1 learning scope = exactly two questions:** (a) which Reel construction (A/B/C), (b) which categories over/under-perform. **Minimum-evidence rule:** no `strategy.json` weight change on n<8 per cell or without a ≥2× day-level reach difference; otherwise log "insufficient data". Identification: per-post like/comment counts for within-day comparisons + **deliberate contrast days** (one Reel-only and one carousel-only day per week in month 1). Variant LOGGING everywhere now (cheap, builds the dataset); variant WEIGHTING waits for per-media insights at 1k followers. Every change logged with reasoning. Periodically re-probe per-media insights to detect the 1k unlock.

### 4.8 `report.mjs` — weekly scorecard
Reach trend, best/worst post + hypothesis, follower delta, account-level sends/saves, experiment status vs the go/no-go rule, what strategy changed and why, **Supabase bucket usage** (canary), human-lane scoreboard (§6b actions done/skipped).

### 4.9 Robustness fixes (from audit + review)
Retries with backoff (Supabase, image downloads); fetchimg failures logged per-draw and surfaced in the preview; hard render gate (failed `__ready` = failed run); all close-date math anchored `Europe/London`; paths/IDs/keys from config/env only (remove in-source key literal); `carousel/` committed to git after a secrets sweep (state files + outputs gitignored); **retention:** local archive 14 days; day's JPEGs + reel.mp4 **deleted from the bucket after the platforms confirm publish** (they copy media at ingest; URLs kept as strings in state for provenance — free tier is 1GB shared with the site's re-hosted draw images).

### 4.10 Dead-man's switch + slot mechanics
- **Publish timing:** publish at trigger time, with the system nudging the trigger into a prime window. IST/UK alignment is favorable: 12–1pm UK ≈ 4:30–5:30pm IST; 7–9pm UK ≈ 11:30pm–1:30am IST → default nudge at ~4:15pm IST (or user preference). If triggered early, the session self-schedules a wakeup and publishes at the slot (works while the session stays open); Phase 3 evaluates fully scheduled runs.
- **Watchdog:** a scheduled cloud agent checks `carousel_posts` freshness daily (Supabase = readable from the cloud) and sends a nudge if >24h stale ("streak at risk — say publish today").
- **Catch-up rule:** after missed days, post 1 today; never batch-post backlog.

## 5. Category design system — one skeleton, six crafts

Design principle: **temptation-first, never template.** The review's verdict on v1's theme boards: four of six were mood-board clichés (Tron grid, banknote rain — which also reads scammy in a gambling-adjacent niche, champagne-marble, holo-comic-bursts), and six unrelated worlds fragment the grid. **Inverted model: one constant brand skeleton** (framed prize card + podium + WIN THIS ribbon + footer lockup + THE PRICE STAMP) **across all themes; each theme earns distinctness through 2–3 high-craft details:**

| Category | Display face | Craft details (in config.json, reviewed on preview sheet) |
|---|---|---|
| car-draws | Anton (earned) | Embers + sparks (current signature); speed-streak parallax in Reels |
| tech-giveaways | Space Grotesk + JetBrains Mono data line | Chromatic-aberration headline (±2px red/cyan), repeating-gradient scanlines; price/odds rendered like a spec sheet. Tron floor removed |
| luxury | Playfair Display italic kickers | Hairline 1px gold border, gold gradient via background-clip:text, 4%-opacity SVG feTurbulence film grain, NO particles |
| cash-prizes | Anton (earned) | Amount as CSS 3D flip-clock digits (rotateX flaps). Banknote rain removed |
| house-draws | Fraunces | Twilight navy/teal, glowing amber windows, soft fireflies/bokeh |
| collectibles | Bungee | Moving holo sheen (conic-gradient masked to card, animated background-position). Starbursts removed |

All fonts OFL/Google, subset to woff2; re-check the `×` glyph per face. Captions, ribbon, CTA, Reel pacing/audio inherit the theme. **Approval gate:** rendered preview sheet (one real slide per category) approved by the user before any theme ships; grid check — the 9 most recent tiles must read as one system.

**Follow-reason (the round-up trap):** a themed feed of today's draws is the website as pixels — it answers "why look?" not "why follow?". Fixes: the daily Reel is a **named series at a fixed slot** ("TONIGHT'S UK DRAWS — every night, 7pm"); Reel outro + caption CTA hierarchy is **follow-first** ("we post the draws closing tonight, every night — follow so you don't miss yours"), site URL second. Phase 3 adds the weekly **"Free entry by post — verified from each operator's T&Cs"** format (legal premise: only free-draw-route competitions have postal routes; skill-question comps are exempt under the Gambling Act 2005 — every claim verified per-operator before posting). It's high-value, community-native, and nobody automates it.

## 6. Daily & weekly operation

**Session time budget: ≤10 minutes.** (a) fetchimg parallelized, hard 60s/draw timeout, instant typographic-card fallback; (b) ONE composite QA sheet (photos + slides + 4 Reel keyframes) for a single Claude review; (c) publish sequence scripted as a batch (poll inside the script, not interactive MCP turns); (d) comment-reply pass every 2–3 days, folded into the routine.

**Daily ("publish today", nudged into a prime window):**
1. `insights.mjs` windowed backfill.
2. `plan.mjs` — strategy-aware, history-aware selection (Supabase state).
3. `fetchimg.mjs` → single composite QA sheet → Claude picks/swaps.
4. `build.mjs` (slides + covers + alt text) · `reel.mjs` (experiment-arm construction) · `story.mjs`.
5. **Preview + veto:** composite preview + Claude-written caption in chat; publishes after the veto window.
6. Publish, **Reel first** (highest value), then carousel, then story, then FB — write-ahead state after every call. FB: **video post is the primary FB action** (`FACEBOOK_CREATE_VIDEO_POST`, direct mp4 URL, caption in description — lands as a feed video, not a true FB Reel; `/video_reels` isn't exposed by the Composio app and is out of £0 scope). Photo mirror continues only because it's free — zero QA attention.
7. Reply sweep ~30–60 min post-publish when session timing allows (7pm UK ≈ 11:30pm IST aligns); reply with a question back.

**Weekly:** `learn.mjs` (scoped per §4.7) → `report.mjs` → next week's single-variable experiment. Human shares the free-postal-entry piece into 2–3 UK comping FB groups where rules allow (value-first; read rules; never naked promo — a ban from MSE-adjacent communities is a real loss).

### 6b. The human lane (Claude preps, human executes — ~15–20 min/day)
The verified biggest follower driver at 49 followers, impossible via API:
- **Outbound engagement:** Claude generates a daily hit-list (5–10 fresh posts from operators, comping accounts, #comping/#ukcompetitions, with suggested comment angles); user comments from the brand account, ideally around the account's own post time.
- **Collabs:** Claude drafts 2–3 one-line pitches/week to small operators ("we feature your draw to UK compers daily — want it as an IG Collab post?"); user DMs them; accepted partners go in the container's `collaborators` param (max 3) → the post lands in both feeds. One accepted collab likely outperforms a month of solo posting at this size.
- If the user opts out of this lane, the §2 follower target drops to the organic-only ~30–60 range — stated, not hidden.

## 7. Quality gates ("zero-mistake generation")

1. **Honesty guard:** `total_prize_value` = gross ticket revenue, never presented as prize worth; "£X+ IN PRIZES" renders only past a per-category sanity threshold.
2. **Truth-checkable copy:** hooks/claims (GTD, odds, close times, free-entry routes) render only when draw data/T&Cs prove them.
3. **Compliance:** 18+ · UK only · play responsibly on every asset, persistent footer in Reels/stories.
4. **Visual QA:** one composite sheet per day (photos + slides + Reel keyframes); branded/rival imagery → backup draw or typographic card.
5. **Hook legibility gate:** Reel frames 0/15/36 reviewed as stills — price must be legible on all three or the run fails.
6. **Grid legibility gate:** slide 1 downscaled to 161×201 must still read; otherwise the intro auto-drops to headline + price + hero only.
7. **Hard render gate:** failed `__ready`/fonts/images = failed run. ffprobe asserts the Reel encode contract.
8. **Data QA:** £ vs p, London-anchored dates, odds "1 in {cap}" only when entries=cap, `MIN_DAYS` runway floor.
9. **Preview veto** before anything goes live.
10. **Idempotency:** per-(date, format) write-ahead state; re-triggers skip published formats and resume orphaned containers.

## 8. Testing

- Unit (`bun test`): format helpers (London TZ midnight edges), honesty/truth guards, history-aware selection, config/theme resolution, beat-grid quantizer.
- Golden-render: all 6 themes against a fixture selection (preview sheet); Reel validated via ffprobe (codec/duration/resolution/audio/faststart); frame-capture determinism (two runs → identical frame hashes).
- Integration: `DRY_RUN=1` full chain through publish.json without posting; supervised first live Reel AND first live story (Creator-account API test); FB video post tested day 1 of Phase 2.
- Learning replay: `learn.mjs` against the existing 33 posts + 30-day reach series must rediscover "Reels ≫ carousels" — and must output "insufficient data" for hook variants (validating the minimum-evidence rule).

## 9. Rollout phases

- **Phase 1 — Foundation + identity:** config.json; Supabase state tables + write-ahead log lib; robustness/retention fixes; git-version `carousel/` (secrets sweep; state gitignored); theme system v2 + preview sheet approval; caption briefing system + IG SEO plumbing (alt text, keyword captions; user changes display name); watchdog nudge agent.
- **Phase 2 — Reach engine:** `reel.mjs` (WAAPI seek-and-capture, beat sync, stamp, cold open, covers, A/B/C arms); `story.mjs` video story; `insights.mjs` backfill + FB insights; publish state machine (Reel-first); supervised first Reel/story; FB video test; series branding live.
- **Phase 3 — Autonomy & learning:** `learn.mjs`/`strategy.json`/`report.mjs`; engagement hit-list + collab pitch generators; weekly free-postal-entry format (T&C verification pass); scheduled unattended-run trial (Composio-headless risk — supervised first); wakeup-based slot publishing.

**Week-2 go/no-go:** if no Reel construction (A/B/C) beats carousel-era reach by a format-sized margin, stop and redesign the format with the user rather than automating a dud.

## 10. Constraints & out of scope

- Per-media insights locked <1,000 followers; account-level reach/likes/comments + FB post insights available now. No trending audio via API. API stories: no stickers/links. FB via Composio: no captioned multi-photo, no albums, no true FB Reels (feed video posts only). IG API cannot engage other accounts' content (hence the human lane). Reel/cover URLs must be public, query-string-free.
- Out of scope: TikTok posting (manual lane later), IG DMs, AI-avatar Reels, paid ads, `/video_reels` raw-Graph integration.
- Budget £0/month. User is IST; audience is UK; all schedule logic `Europe/London`.
- Royalty-free audio licences recorded in `assets/audio/LICENSES.md`; baked-in audio carries low but nonzero copyright-match risk — prefer tracks with explicit social-use licences.
