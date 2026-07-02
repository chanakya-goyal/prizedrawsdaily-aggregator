# PrizeDrawsDaily — Daily Carousel + Reel + Story Routine (v3)

A premium daily **Reel + carousel + story** for **@prizedrawsdaily**, cross-posted to FB, built from live UK draws.
**The photos are auto-fetched from each draw's own page** — your daily job is basically "approve".

> **Quick start:** in a Claude Code session in `~/pdd-aggregator`, say **"publish today"**. Claude runs everything,
> shows you one composite preview, and posts on your OK.

The Reel is now the main event (it's the only format that has ever reached anyone on this account — see the
design spec, `docs/superpowers/specs/2026-07-02-carousel-growth-engine-design.md`). Carousel and story ride along.

## What happens (Claude drives this when you say "publish today")

1. **Pull insights** — per `carousel/INSIGHTS.md` (the 3 Composio calls → `bun carousel/insights.mjs ingest …` →
   `bun carousel/insights.mjs report`). Refreshes account reach + per-post likes/comments/FB reactions *before*
   today's selection, so `plan.mjs`'s history-aware picks and the format-experiment read (below) are working off
   current numbers. Ingest is idempotent (upserts on `(day, media_id, metric)`) — re-running it mid-week for a
   same-day pull just reprints the report.

2. **Prep** — `bun carousel/plan.mjs`
   Archives (never deletes) yesterday's `pdd-today` folder into `archive/<date>-<ms>/`, prunes archives older than
   14 days, then auto-picks the strongest category + 5 draws closing **≥1 day out and ≤7 days** (never "ends
   today"), history-aware (no draw repeated within 7 days; category rotated) via `carousel_posts`, plus a few
   **backups** in the same category. Writes `selection.json` (+ `SHOTLIST.txt`, `REF-*` thumbs) with the day's
   caption archetype already rotated in.

3. **Auto-fetch photos** — `bun carousel/fetchimg.mjs`
   Visits each draw's operator page (`entry_url`) and pulls clean product photos into `.fetched/{slug}/`
   (`cand-1..N` + a `pick.txt` best-guess default). Runs ~1–3 min; never hangs (hard per-draw timeout), skips
   blocked sites gracefully and logs why in `.fetched/report.json`.

4. **Build everything** — `bun carousel/build.mjs` (7 carousel slides + `out/BRIEFING.md` + `out/CAPTION_FALLBACK.txt`
   + `out/alt.json`), `bun carousel/reel.mjs` (today's arm — see below) → `out/reel.mp4` + `out/cover.jpg` +
   `out/reel-keyframes.png` + `out/reel-meta.json`, and `bun carousel/story.mjs` (the soonest-closing draw's
   countdown) → `out/story.mp4` + `out/story-meta.json`. All three read the *same* `.fetched/{slug}/pick.txt`
   picks (or your own dropped photo, or fall back to a typographic card) — so a pick.txt edit during QA (next
   step) means re-running whichever of the three actually used that photo.

   **Reel arm rotation:** `REEL_ARM=A|B|C bun carousel/reel.mjs` overrides; otherwise it rotates automatically —
   `["A","B","C"][dayOfYear % 3]` where `dayOfYear` counts days since Jan 1 (UTC-anchored — `Date.parse` of Jan-1,
   timezone-independent). The three
   constructions (spec §4.4):
   - **A — 12–18s themed multi-prize.** Cold open (best prize, price stamp slam-in) → a scene per draw → outro
     stamp loop-back. The "full carousel-in-video" arm.
   - **B — ≤8s single-prize hook.** Giant price/odds question, hard cut to CTA. Easiest full-watch; tests whether
     short beats long for completion-driven reach.
   - **C — "closing tonight" countdown urgency.** Real flip-clock ticking to the *earliest* `draw_date` across
     today's selection (`closeIso`), never synthetic.

5. **ONE composite QA (Claude)** — with slides, reel, and story all built, review in a single pass:
   - `bun carousel/contact.mjs` → `contact.png` (every fetched candidate, grouped by draw) — confirm each
     `pick.txt` chose the cleanest, no-rival-branding shot. Swap a pick (edit `.fetched/{slug}/pick.txt`) or a
     whole draw (swap in a `selection.json.backups` entry) if a page came back blocked/branded (e.g. UKCC) —
     then re-run `build.mjs`/`reel.mjs`/`story.mjs` for whatever used that photo.
   - `out/0X-*.png` slides + `out/reel-keyframes.png` + a look at `out/story.mp4` (or its frame folder) — the
     **QA gates** below.
   - If a draw's page is blocked/branded and no backup helps, fall back to a clean typographic card (no photo).

   **QA gates ("zero-mistake generation", spec §7 — these are Claude visual judgement calls, not code asserts
   unless noted):**
   - **Reel keyframe legibility (hard gate):** the price must be legible on frames **1 (0ms), 16 (500ms), and
     37 (1200ms)** of `reel-keyframes.png` — the cold-open beats. The composite also tiles each scene's midpoint,
     every stamp onset + its landed pose (+467ms), and the final loop frame, so the arm's hook moment (giant
     price / countdown / prize cards) is always visible too. **If the price isn't legible on 1/16/37, the run
     FAILS** — don't publish; fix the source photo/timeline and re-run `reel.mjs`.
   - **Story countdown plausibility:** the flip-clock's time-to-close should read as a real, positive countdown
     against the picked draw's actual `draw_date` — `story.mjs` always auto-picks whichever selected draw closes
     soonest, but eyeball it (hours can tick by between `plan.mjs`'s ≥1-day floor and publish time).
   - **Carousel grid-legibility:** slide 1 (intro) must still read when shrunk to profile-grid size
     (~161×201px) — banner + hook + price should survive; if not, that's a build.mjs re-render, not a code gate.
   - **Honesty (already enforced by `honesty.mjs`, just eyeball the output):** the "£X+ IN PRIZES" line is
     ticket-revenue-based, capped at the operator's own stated cash alternative when one exists, rounded **down**
     to the nearest £1,000, and suppressed entirely below each category's `valueLineMin` in `config.json` — it
     should never read as "prize worth". Every hook/claim (GTD, odds, close time) must be provable from the
     draw's own fields — `brief.mjs`'s facts table is the only source Claude may quote from.

6. **Caption** — Claude reads `out/BRIEFING.md` (verified facts table + today's hook archetype + banned-phrase
   list — includes every opener used in the last 14 days) and writes **both** caption files: the IG caption over
   `out/CAPTION.txt`, and a fuller FB caption (with the real clickable link) to `out/FB_CAPTION.txt`.
   `build.mjs` only ever writes `out/CAPTION_FALLBACK.txt` (a template string, dry-run fallback) — it never
   touches `CAPTION.txt`. `publish.mjs` reads `CAPTION.txt` first, falling back to `CAPTION_FALLBACK.txt`; and
   `FB_CAPTION.txt` first, falling back to the `buildFbCaption` template.

7. **Preview + veto** — the composite QA output (slides, reel keyframes, story) plus both captions go in chat;
   nothing publishes until you say go.

8. **Host everything** — `bun carousel/publish.mjs`:
   - Converts + uploads the 7 slide PNGs to JPEG, and — if they exist and aren't already published today —
     `reel.mp4` + `cover.jpg` and `story.mp4`, all to the public `carousel-slides` Supabase bucket.
   - Writes `out/publish.json`: `caption`, `fbCaption`, `heroUrl`, `urls`, `altTexts`, `reelUrl`, `coverUrl`,
     `storyUrl`, `reelMeta` (`{arm, durationMs, stampTimesMs, audio, coverText}`).
   - Writes idempotent write-ahead `assets_uploaded` rows in `carousel_posts`: `carousel` and `fb_photo` every
     run, `reel`/`story` only when that asset was actually (re-)uploaded this run (a reel/story already marked
     `published` today is skipped, not re-hosted, so its real row is never clobbered — but `reelUrl`/`storyUrl`
     still resolve to the canonical public URL on a skip, so `publish.json` stays complete), and `fb_video`
     whenever `reelUrl` resolved (uploaded or skip-resolved) and today's `fb_video` row isn't already
     `published`.
   - Refuses outright (exit 2) if today's `carousel` row is already `published` — use `state-mark.mjs` to
     override if that's wrong.

9. **Publish via Composio — REEL FIRST**, then carousel, then story (supervised), then FB:
   1. **Reel:** `INSTAGRAM_POST_IG_USER_MEDIA` (`ig_user_id: 27332554436394910`, `media_type: "REELS"`,
      `video_url: publish.json.reelUrl`, `cover_url: publish.json.coverUrl`, `caption`, `share_to_feed: true`)
      → poll the returned container's status until it reports FINISHED (or up to ~5 min) →
      `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` (`max_wait_seconds: 300` — Composio's 60s default intermittently
      errors 9007) → `bun carousel/state-mark.mjs reel published --ig <media_id>`.
   2. **Carousel** — unchanged, verified recipe: preferred route = build one **per-child container** per image
      via `INSTAGRAM_POST_IG_USER_MEDIA` (`is_carousel_item: true`, `image_url`, `alt_text` from
      `publish.json.altTexts[i]`), then create the **parent carousel container** via
      `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` with `children: [<child ids>]` + `caption` →
      `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH`. (`INSTAGRAM_CREATE_CAROUSEL_CONTAINER` exposes NO `alt_text` param
      — only `child_image_urls`; `INSTAGRAM_POST_IG_USER_MEDIA` has `additionalProperties: true`, so `alt_text`
      MAY pass through on per-child containers. If IG rejects it, fall back to the one-call recipe —
      `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` (`child_image_urls` + `caption`) → `_PUBLISH` — alt text then goes
      unattached, a known limitation.) Mark it: `bun carousel/state-mark.mjs carousel published --ig <media_id>`.
   3. **Story — SUPERVISED TEST** (first live run, and every run until proven): `INSTAGRAM_POST_IG_USER_MEDIA`
      (`ig_user_id`, `media_type: "STORIES"`, `video_url: publish.json.storyUrl`) → publish →
      `bun carousel/state-mark.mjs story published --ig <id>`. **If the Graph API rejects `STORIES` on this
      Creator account, record the exact error text verbatim in the session, then run `bun carousel/state-mark.mjs
      story skipped` so `cleanup.mjs`'s published-or-skipped gate can still proceed, and drop story from the
      routine** — don't retry silently — pending a decision on switching to Business (reach was verified identical
      before/after the earlier Business→Creator switch, so that decision is low-risk).
   4. **Facebook:**
      - **PRIMARY — video path** (a reel ran today, so `publish.json.reelUrl` exists and `publish.mjs` wrote an
        `fb_video` `assets_uploaded` write-ahead row): `FACEBOOK_CREATE_VIDEO_POST` (`page_id: 1106603652538117`,
        `file_url: publish.json.reelUrl`, `description: fbCaption`) →
        `bun carousel/state-mark.mjs fb_video published --fb <post_id>` **AND**
        `bun carousel/state-mark.mjs fb_photo skipped` — the photo mirror never posts on a video day, so its
        write-ahead row needs a terminal status too, or `cleanup.mjs` would wait on it forever.
      - **FALLBACK — the video post fails:** `FACEBOOK_CREATE_PHOTO_POST` (`url: heroUrl`, `message: fbCaption`)
        → `bun carousel/state-mark.mjs fb_photo published --fb <post_id>` **AND**
        `bun carousel/state-mark.mjs fb_video skipped` — record the video failure, then close its row so cleanup
        can still proceed.
      - **Carousel-only day (no reel ran):** `publish.mjs` never writes an `fb_video` row at all (there's no
        `reelUrl` to post), so the photo post is simply the primary FB action, unchanged from v2:
        `FACEBOOK_CREATE_PHOTO_POST` → `bun carousel/state-mark.mjs fb_photo published --fb <post_id>`.

10. **Cleanup** — `bun carousel/cleanup.mjs`. Once every `carousel_posts` row for today (`carousel` + `fb_photo`
    + `fb_video`/`reel`/`story` if they ran) reads `published` **or** `skipped` — with at least one row actually
    `published` — deletes today's raw JPEGs/mp4s from the bucket — the platforms already copied the media in at
    ingest. Refuses loudly (exit 1) while anything's still pending (i.e. neither `published` nor `skipped`) —
    that's the point: a slow/retried Composio post can never lose the asset it still needs.

11. **Reply sweep** — ~30–60 min post-publish (session timing allowing — the 7–9pm UK slot ≈ 11:30pm–1:30am IST
    lines up naturally), reply to comments with a question back.

## Format experiment (weeks 1–2) — is the Reel actually working?

The account's only reach ever came from Reels (76–123/day on old-format Reels vs 0–13 on carousel/image days —
see the design spec's §1/§2). `reel.mjs` now runs a **construction experiment**, not a fixed format, to find out
which Reel actually earns that reach at scale, and to prove the Reel format itself is worth automating at all.

**Rotation:** `["A","B","C"][dayOfYear % 3]` (override any single day: `REEL_ARM=A|B|C bun carousel/reel.mjs`).
A sample week:

| Day | Arm | What it is | What to eyeball |
|---|---|---|---|
| 1 | A | 12–18s multi-prize | Does the whole thing hold attention, or does length cost completion? Stamp motif consistent across every scene cut? |
| 2 | B | ≤8s single-prize hook | Is the price legible *instantly* at frame 1? Does a short clip under-deliver reach if IG's algorithm favors longer watch time? |
| 3 | C | Countdown urgency | Is the countdown believably "closing soon" at publish time (not already near-zero, not days away)? Does urgency read as true, not manufactured? |
| 4 | A | (repeats) | — |
| 5 | B | (repeats) | — |
| 6 | C | (repeats) | — |
| 7 | A | (repeats) | — |

**Comparison signal:** day-level account reach (`bun carousel/insights.mjs report` — `ig_reach`) cross-referenced
against which arm posted that day (`carousel_posts.hook_archetype` = `arm-A`/`arm-B`/`arm-C` for `reel` rows,
written automatically by `publish.mjs` from `reel-meta.json`), plus per-post likes/comments (`ig_media`) for the
same posts, holding slot/category as constant as the rotation allows.

**Go/no-go rule (spec §4.4/§2/§9):** only a **format-sized gap (~5–10×)** counts as signal — day-to-day noise
on a 49-follower account is expected and is NOT evidence. If by the end of week 2 no arm construction clearly
beats carousel-era reach by that same order of magnitude, **stop and redesign the format with the user** rather
than continuing to automate a construction that isn't working — don't quietly keep rotating forever on
insufficient data.

## Photo source priority (per draw)
1. **A photo YOU dropped** in `~/Desktop/pdd-today/` (named `1`–`5` or by slug) — always wins. *(Only needed if
   you dislike the auto-fetched one.)*
2. **Auto-fetched** pick from the draw page (rejected if under 500px on its longest side — falls to typographic).
3. **Typographic card** (clean text-only) if neither is available.

## Good to know
- **Override anytime:** drop your own `1.jpg`–`5.jpg` and it beats the auto-fetch. Or edit
  `.fetched/{slug}/pick.txt` to a different candidate — then re-run whichever of `build.mjs`/`reel.mjs`/
  `story.mjs` used that photo.
- **Caption** — Claude authors both from `out/BRIEFING.md` (verified facts + hook archetype + banned phrases):
  IG caption → `out/CAPTION.txt`, FB caption (fuller, real clickable link + "18+ · UK only · Play responsibly")
  → `out/FB_CAPTION.txt`. `caption.mjs`'s `buildCaption`/`buildFbCaption` templates are only used as a
  **fallback for dry runs** where no `out/FB_CAPTION.txt`/`out/CAPTION.txt` exists.
- **Best UK posting time (prime windows):** ~12–1 PM UK (≈ 4:30–5:30 PM IST) or 7–9 PM UK (≈ 11:30 PM–1:30 AM
  IST) — `config.json`'s `global.primeWindowsUK` (`[[12,13],[19,21]]`). Claude nudges the trigger toward one of
  these when timing allows; publishes at trigger time otherwise.
- **Design knobs:** `styles.css` (glow/embers/fonts) · `CARD=cutout bun carousel/build.mjs` for cut-out cards.
- **Needs** `SUPABASE_SERVICE_ROLE_KEY` in `~/pdd-aggregator/.env` (already set) for hosting, cleanup, and state
  writes.
- **Limits:** IG 100 API posts/24h (a Reel + carousel + story is 3 — plenty of headroom). `fetchimg.mjs` never
  hangs (hard timeouts) and skips blocked sites gracefully.

## State & watchdog
- **`carousel_posts`** (Supabase) — one row per `(date, format)` tracking the pipeline: `pending` →
  `assets_uploaded` (written by `publish.mjs` before Composio posts, so a crash mid-post can't cause a
  silent double-publish) → `published` (written by you/Claude via `state-mark.mjs` once Composio confirms the
  post id) → or `skipped` (also via `state-mark.mjs`, when a format is deliberately dropped this run — a rejected
  story, or whichever of `fb_video`/`fb_photo` didn't post — `published` and `skipped` are both terminal for
  `cleanup.mjs`'s gate, see step 10). Formats seen today: `carousel`, `fb_photo`, `reel`, `story`, `fb_video` —
  `publish.mjs` now write-aheads an `assets_uploaded` `fb_video` row itself whenever a reel ran this run (or a
  published reel's URL was resolved via the skip branch), preflighted against an already-`published` `fb_video`
  row exactly like `reel`/`story`. Also stores `category`, `draw_slugs`, `hook_archetype` (plain archetype id for
  carousel/caption; `arm-A`/`arm-B`/`arm-C` for `reel` rows), `seo_keyword`, `caption`, `asset_urls`, `posted_at`.
  History off this table drives selection (`recentDrawSlugs`/`lastCategory` in `plan.mjs` avoid repeating draws/
  categories) and the caption briefing's "banned last-14-day openers".
- **`carousel_metrics`** — daily per-post metrics (reach/likes/comments/FB reactions etc.), keyed by
  `(day, media_id, metric)`, ingested by `insights.mjs` (step 1) — the data source for the format experiment
  above and the future Phase 3 learn/report loop.
- **One-time setup:** run `bun carousel/state-setup.mjs` to check the tables exist; if not, it prints the SQL
  from `carousel/state-schema.sql` to paste into the Supabase SQL editor.
- **`bun carousel/freshness.mjs`** — dead-man's-switch: prints `OK <date>` (exit 0) if a `published` row exists
  within the last 36h, else `STALE …` (exit 1). Uses the public anon key (read-only, RLS-gated) so it can run
  from anywhere, including a scheduled cloud watchdog that nudges you to say "publish today" if the streak is
  at risk.
- **14-day archive:** `plan.mjs` archives (never deletes) the previous day's working folder into
  `archive/<date>-<ms>/` and prunes archive folders older than `archiveDays` (14, in `config.json`).
- **`PDD_DIR`** — override the working directory (default `~/Desktop/pdd-today`, from `config.json`'s
  `global.workDir`). Every script (`plan.mjs`, `fetchimg.mjs`, `build.mjs`, `reel.mjs`, `story.mjs`,
  `publish.mjs`, `contact.mjs`) reads it via `workDir()` in `config.mjs` — used for dry runs / tests so they
  never touch the real daily folder, e.g. `PDD_DIR=/tmp/pdd-test bun carousel/plan.mjs`.

## One-time IG SEO (do this once, from the app)
Change the Instagram **display name** (not the @handle) to **"Prize Draws Daily | UK Competitions"** —
this is the strongest IG-search ranking signal and only you can set it from the Instagram app
(Edit profile → Name). Not something Claude/Composio can do via API.
