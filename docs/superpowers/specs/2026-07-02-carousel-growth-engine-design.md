# Carousel Growth Engine — Design Spec

**Date:** 2026-07-02 · **Status:** Approved by user (autonomy, daily Reel, 6 themes, ffmpeg) · **Owner:** Claude (builder/operator) + Chanakya (veto/QA)

## 1. Problem

The daily carousel publisher (`carousel/`) produces high-quality posts that reach almost nobody, and it has no way to notice or correct that.

Live evidence (pulled 2026-07-02 via Composio):

- @prizedrawsdaily: **49 followers** (flat since 2026-06-25), 33 posts, **481 total reach in 30 days**.
- Every reach spike is a Reel day (Jun 6: 76, Jun 10: 123, Jun 13: 102, Jun 25: 25). Every carousel/image day: 0–13.
- The pipeline's 5 published carousels (Jun 27–Jul 1): 0–2 likes, 0 comments, ~4–5 reach each.
- FB Page: 15 recent posts, all 0 reactions / 0 comments / 0 shares.
- The Business→Creator account switch is **not** the cause (reach identical before/after; fact-checked 2026-06-26).

Code audit findings (2026-07-02):

- **No memory:** no record of past posts anywhere; `plan.mjs:19` does `rm -rf` on the working dir every run; Composio post IDs are discarded; nothing reads performance data.
- **No versioning:** the entire `carousel/` directory is untracked in git — it exists only on this machine.
- Config scattered: category lists/weights/hooks/themes/hashtags duplicated across `select.mjs`, `format.mjs`, `caption.mjs`, `build.mjs`, `styles.css`. Only 2 themes exist for 6 categories.
- Fragility: silent error swallowing (`fetchimg.mjs:62,100,182`), best-effort render readiness (`render.mjs:186`), no retries, TZ-fragile close-date math (`format.mjs:41-49`, `select.mjs:9-11`), hardcoded absolute paths in 5 files, in-source key literal (`select.mjs:3`).
- `ffmpeg` not installed (needed for video). No GitHub Action touches `carousel/`.

## 2. Goals & success metrics

Build a **self-measuring, self-tuning daily publishing system** for IG + FB that Claude operates end-to-end with a human veto.

30-day targets (honest, from a 49-follower base):

| Metric | Now | Target |
|---|---|---|
| 30-day total reach | 481 | 3,000–6,000 |
| Followers | 49 | 120–200 |
| Sends + saves | ~0 | consistently > 0 per week |
| Posting consistency | manual | 7/7 days (carousel + Reel + story) |

Milestone: **1,000 followers** unlocks per-post insights (saves/shares/reach per media) → upgrades the learning loop from day-level attribution to post-level.

## 3. Approved decisions

1. **Autonomy = autopilot-with-veto.** Claude builds everything, posts the preview in chat, and publishes at the UK prime slot unless the user objects. Nothing irreversible before the preview exists.
2. **Daily auto-Reel.** A themed 9:16 slideshow Reel auto-generated from the same slide content, published daily alongside the carousel. Royalty-free audio baked in (trending audio is not available via API). No AI avatars (FB watchbait warning, 2026-06-28).
3. **Six category themes, all attention-maximized.** User directive: *every* category must grab attention and make the viewer crave the prize — no muted themes. Exact look tuned on a rendered preview sheet before going live.
4. **ffmpeg** installed via Homebrew (one-time, free).
5. **Quality bar: zero-mistake generation.** Enforced by hard gates (§7), not intentions.

## 4. Architecture

Existing chain (kept): `plan.mjs → fetchimg.mjs → [Claude visual QA] → build.mjs → publish.mjs → Composio post`.

New components (all in `carousel/`):

### 4.1 `config.json` — single source of truth
One entry per category: display name, visual weight, hook lines, 2 category hashtags, theme tokens (palette, particle type + density, accent font, ribbon/CTA colors), Reel profile (audio mood/file, cut pacing, Ken Burns intensity). Plus global: IG user id, FB page id, Supabase URL/bucket, working dir (env-overridable), prime posting windows. Replaces the 4 scattered maps. Adding/tuning a vibe = one JSON entry + one CSS block.

### 4.2 `log.mjs` + `posts.jsonl` — memory
Append-only record per publish: date/time (UTC + UK), category, draw slugs + titles + prices, caption variant id, hook variant id, formats posted (carousel/reel/story), IG media IDs, FB post ID, slide URLs. `plan.mjs` archives `pdd-today` → `pdd-today/archive/{date}/` instead of `rm -rf`. Selection becomes history-aware: no draw repeated within 7 days; deliberate category rotation (no category twice in a row unless it's the only qualifier).

### 4.3 `insights.mjs` — measurement
Pulls per-post `like_count`/`comments_count` (`INSTAGRAM_GET_IG_USER_MEDIA`), account daily reach (`INSTAGRAM_GET_USER_INSIGHTS`), FB post reactions/comments/shares (`FACEBOOK_GET_PAGE_POSTS`); joins to `posts.jsonl` by media ID/date; appends snapshots to `metrics.jsonl`. Attribution model at this size: day-level (reach on day of/after post X). Runs as part of the daily routine (yesterday's numbers) — no unattended cron dependency.

### 4.4 `reel.mjs` — the reach format
Re-renders the day's slides at 1080×1920 via the existing `render.mjs`/`buildHtml` (parameterized aspect), then ffmpeg-stitches a ~12–18s Reel: per-theme Ken Burns/zoom on each prize, price + close-date text overlays, themed transitions, royalty-free audio track from the theme's audio profile, brand outro (site URL + handle + 18+ line). Output `out/reel.mp4` (H.264, ≤100MB, IG-compliant). Published via `INSTAGRAM_POST_IG_USER_MEDIA` (REELS) + `_PUBLISH`. Audio assets: curated royalty-free tracks stored in `carousel/assets/audio/{mood}.mp3`, licence noted in `assets/audio/LICENSES.md`.

### 4.5 `story.mjs` — daily story
One 1080×1920 story slide: the single most urgent draw ("CLOSES TODAY/TONIGHT"), themed. Published via the same media API (STORIES). Keeps existing followers warm; near-zero marginal cost since it reuses the renderer.

### 4.6 Caption engine v2 (`caption.mjs`)
Every caption engineered for 2026 ranking signals (sends > saves > comments): a question hook (invites comments), an explicit send CTA ("send this to your comp buddy"), price-anchor phrasing ("from 5p"), and the 18+ / play-responsibly line always. 2–3 rotating hook variants per category, variant id logged to `posts.jsonl`. FB caption keeps the fuller body + clickable link (proven recipe).

### 4.7 `learn.mjs` + `strategy.json` — self-improvement
Weekly job: correlates format/category/hook-variant/posting-time against reach + engagement from `metrics.jsonl`; writes `strategy.json` (category rotation weights, preferred time slot, hook-variant weights, reel pacing notes). `plan.mjs`/`caption.mjs` read `strategy.json` (falling back to `config.json` defaults). At 1–3 posts/day this is deliberately simple statistics plus Claude's judgment in the weekly review — a bandit only activates when sample size justifies it. Every strategy change is logged with its reasoning.

### 4.8 `report.mjs` — weekly scorecard
Markdown (optionally rendered PNG) summary: reach trend vs last week, best/worst post with hypothesis, follower delta, sends/saves when available, what `strategy.json` changed and why. Delivered in chat every 7th run.

### 4.9 Robustness fixes (from audit)
- Retries with backoff on Supabase fetch/upload and image downloads.
- `fetchimg` failures logged per-draw (not swallowed); zero-photo draws reported in the preview message.
- Render readiness becomes a **hard gate**: if `__ready` never fires, the run fails loudly — a half-rendered slide can never ship.
- All close-date math anchored to `Europe/London` (fixes the IST-machine day-off bug in `closesLabel` and the runway window in `fetchEndingSoon`).
- Paths/IDs/keys from `config.json`/env only; remove the in-source key literal; `carousel/` committed to git after a secrets sweep (`.env` stays ignored).
- Publish idempotency: before posting, check `posts.jsonl` for today's category/date to prevent double-posts.

## 5. Category design system — "every category is a world"

Design principle (user directive): **temptation-first**. Every theme must stop the scroll and make the viewer want the prize — prize hero dominant, glossy light FX, price-anchor contrast (giant "FROM 5P"), real urgency (true close dates only). Attention-maximized but honest: no fake scarcity, no misleading value claims, 18+ always visible.

| Category | Aura | Palette / type | FX (slides) | Reel motion + audio |
|---|---|---|---|---|
| car-draws | Petrolhead fire | Hot orange #FF6A00 on asphalt black; Anton | Embers + sparks (current signature) | Fast cuts, speed-streak pans; driving beat |
| tech-giveaways | Future lab | Electric blue/cyan; blueprint grid + Tron floor; mono accent | Scanline shimmer | Snappy glitch cuts; synth pulse |
| luxury | Old money | Near-black + champagne gold; silk/marble sheen; thin serif kickers | Slow-drifting gold dust (no confetti) | Languid Ken Burns; piano/strings |
| cash-prizes | Jackpot night | Deep casino green + gold; marquee-bulb glow | Banknote/coin rain | Slot-style count-up on amounts; upbeat win sting |
| house-draws | Dream home at dusk | Twilight navy/teal + glowing amber windows | Soft fireflies/bokeh | Slow warm push-ins; acoustic warmth |
| collectibles | Holo grail | Deep purple/magenta + holographic foil gradients; comic-pop starbursts | Foil sparkle sweep | Playful pop cuts; synthwave |

Implementation: one `[data-theme=…]` block per category in `styles.css` (already fully tokenized via CSS custom properties); particle system in `render.mjs` parameterized by `config.json` (type/density/color); intro, "WIN THIS" ribbon, CTA, captions, and Reel all inherit the theme. Fonts subset as bundled woff2 (like Anton/Oswald today). Known glyph gotcha: `×` missing in Anton — sanitize titles.

**Approval gate:** a rendered **theme preview sheet** (one real slide per category via the actual pipeline) approved by the user before any new theme goes live; iterate like v1→v3.

## 6. Daily & weekly operation

**Daily (triggered by "publish today"; Phase 3 tests scheduled runs):**
1. `insights.mjs` — log yesterday's numbers.
2. `plan.mjs` — strategy-aware category + 5 draws + backups (history-aware, London-anchored).
3. `fetchimg.mjs` → Claude visual QA (pick.txt, backup swaps) — unchanged, load-bearing.
4. `build.mjs` — 7 themed slides + caption variants; `reel.mjs` — themed Reel; `story.mjs` — story slide.
5. **Preview + veto:** slides, Reel, story, captions posted in chat with a one-line summary. Default = publish at the next UK prime slot (12–1pm or 7–9pm UK) unless the user objects.
6. `publish.mjs` — host assets; Claude posts via Composio: IG carousel → IG Reel → IG story → FB photo-post (hero + full caption; Reel crosspost if the FB app supports video — verified during implementation).
7. `log.mjs` — append all returned IDs.
8. Community pass: fetch + reply to new IG comments (Claude-drafted, brand voice).

**Weekly:** `learn.mjs` updates `strategy.json` → `report.mjs` scorecard in chat → Claude proposes next week's experiments (one variable at a time).

## 7. Quality gates ("zero-mistake generation")

1. **Honesty guard:** never present `total_prize_value` (= gross ticket revenue) as prize worth; the "£X+ IN PRIZES" line renders only when a per-category sanity threshold passes (fixes the collectibles £15k incident durably in `build.mjs`).
2. **Compliance:** 18+ · UK only · play responsibly on every slide footer, caption, Reel outro, and story.
3. **Visual QA:** Claude reviews every fetched photo (contact sheet) and every rendered slide/Reel frame before preview; branded/rival imagery → backup draw or typographic card.
4. **Hard render gate:** failed `__ready` or missing fonts/images = failed run, never a degraded post.
5. **Data QA:** price format (£ vs p), London close dates, odds "1 in {cap}" only when entries = cap; no draw closing sooner than `MIN_DAYS`.
6. **Preview veto** before anything goes live (Phase 1–2 always; Phase 3 keeps it for the first unattended week).
7. **Idempotency:** posts.jsonl check prevents double-publishing.

## 8. Testing

- Unit: format helpers (price/closes/odds, London TZ edge at midnight IST), honesty-guard thresholds, history-aware selection, config/theme resolution (`bun test`).
- Golden-render: build all 6 themes against a fixture selection; eyeball sheet + pixel-dimension/aspect assertions; Reel output validated (duration, resolution, codec, audio present) via ffprobe.
- Integration: dry-run mode (`DRY_RUN=1`) exercises the full chain through publish.json without posting; first live Reel published deliberately as a supervised test.
- The learning loop is validated by replaying it against the existing 33 posts + 30-day reach series (it must independently rediscover "Reels ≫ carousels").

## 9. Rollout phases

- **Phase 1 — Foundation + themes (first):** config.json refactor, log/archive (kill `rm -rf`), robustness fixes, git-version `carousel/` (secrets sweep first), 6 themes + preview sheet approval, caption v2.
- **Phase 2 — Reach engine:** ffmpeg install, `reel.mjs`, `story.mjs`, `insights.mjs`, first supervised Reel posts, daily routine v2 (autopilot-with-veto).
- **Phase 3 — Autonomy & learning:** `learn.mjs`/`strategy.json`/`report.mjs`; comment-reply pass; test scheduled unattended runs (risk: Composio MCP may not be reachable headless — supervised trial before trusting it); TikTok/Shorts export files (user posts manually).

## 10. Constraints & out of scope

- **API locks:** per-media insights need ≥1,000 followers; account-level daily reach + per-post like/comment counts work now. No trending audio via API. FB app: no captioned multi-photo post, no albums (proven recipes in DAILY.md stand). IG API cannot like/comment on other accounts' content.
- **Out of scope:** TikTok posting, IG DMs, collab partnerships (Claude drafts outreach; human sends), AI-avatar Reels (dropped 2026-06-28), paid ads.
- **Budget:** £0/month — royalty-free audio, existing free stack (Bun, Playwright, ffmpeg, Supabase free tier, Composio).
- User is IST; audience is UK — all scheduling logic anchored to Europe/London.
