# PrizeDrawsDaily — Daily Carousel Routine

A premium daily IG carousel + FB crosspost for **@prizedrawsdaily**, built from live UK draws.
**The photos are now auto-fetched from each draw's own page** — your daily job is basically just "approve".

> **Quick start:** in a Claude Code session in `~/pdd-aggregator`, say **"publish today"**. Claude runs everything, shows you a preview, and posts on your OK.

## What happens (Claude drives this when you say "publish today")

1. **Prep** — `bun carousel/plan.mjs`
   Auto-picks the strongest category + 5 draws closing **≥1 day out and ≤7 days** (never "ends today"),
   plus a few **backups**. Writes `~/Desktop/pdd-today/selection.json` (+ `SHOTLIST.txt`, `REF-*` thumbs).

2. **Auto-fetch photos** — `bun carousel/fetchimg.mjs`
   Visits each draw's operator page (`entry_url`) and pulls clean product photos into
   `~/Desktop/pdd-today/.fetched/{slug}/` (`cand-1..N` + `pick.txt`). Runs ~1–3 min.

3. **Visual QA (Claude)** — Claude looks at the candidates and sets `pick.txt` to the cleanest,
   no-branding shot per draw. If a draw's page is blocked/branded (e.g. **UKCC**), Claude swaps in a
   **backup** draw or falls back to a clean **typographic card**.

4. **Build → preview** — `bun carousel/build.mjs` → 7 slides in `~/Desktop/pdd-today/out/`. You eyeball them.
   Build also writes `out/BRIEFING.md` (verified facts table + hook archetype + banned phrases) and a
   fallback `out/CAPTION.txt`. **Claude reads `BRIEFING.md` and writes the final IG caption over
   `CAPTION.txt`**, plus a fuller FB caption (with the clickable link) — publish.mjs picks both up.

5. **Publish** — `bun carousel/publish.mjs` (hosts JPEGs, writes `publish.json` with `caption`, `fbCaption`, `heroUrl`, `urls`, `altTexts`) → Claude posts via Composio:
   - **Instagram (full carousel):** `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` (`child_image_urls`=urls + `caption`) → `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` (ig_user_id `27332554436394910`).
   - **Facebook — ONE detailed captioned post** (Page "Prize Draws Daily" `1106603652538117`): `FACEBOOK_CREATE_PHOTO_POST` (`page_id`, `url`=`heroUrl`, `message`=`fbCaption`). The caption (prize list + clickable prizedrawsdaily.co.uk link + 18+) posts **inline with the image** — one rich post, NOT caption-less individual photos.
     - **Why one image:** this Composio FB app can't attach multiple photos to a captioned post (`FACEBOOK_CREATE_POST` has no media field; `FACEBOOK_UPLOAD_PHOTOS_BATCH` has no caption field → the old batch recipe produced the caption-less photo pile we're replacing). IG carries the full carousel; FB gets the intro hero + full caption.
   - `publish.mjs` records a write-ahead state row (`assets_uploaded`) before Composio posts, and **refuses to
     re-publish** if today's carousel is already marked `published` (exits with an error — use `state-mark.mjs`
     to override if that's wrong). **After Composio confirms the posts**, mark them published:
     ```
     bun carousel/state-mark.mjs carousel published --ig <media_id>
     bun carousel/state-mark.mjs fb_photo published --fb <post_id>
     ```

## Photo source priority (per draw)
1. **A photo YOU dropped** in `~/Desktop/pdd-today/` (named `1`–`5` or by slug) — always wins. *(Only needed if you dislike the auto-fetched one.)*
2. **Auto-fetched** pick from the draw page.
3. **Typographic card** (clean text-only) if neither is available.

## Good to know
- **Override anytime:** drop your own `1.jpg`–`5.jpg` and it beats the auto-fetch. Or edit `.fetched/{slug}/pick.txt` to a different candidate.
- **Caption** auto (both in `caption.mjs`): IG = `buildCaption` (minimalist, "link in bio", 5 hashtags); FB = `buildFbCaption` (fuller, prize list + real clickable link + "18+ · UK only · Play responsibly").
- **Best UK posting time:** ~12–1 PM UK (≈ **4:30–5:30 PM IST**) or 7–9 PM UK. Claude checks live UK time.
- **Design knobs:** `styles.css` (glow/embers/fonts) · `CARD=cutout bun carousel/build.mjs` for cut-out cards.
- **Needs** `SUPABASE_SERVICE_ROLE_KEY` in `~/pdd-aggregator/.env` (already set) for hosting.
- **Limits:** IG 100 API posts/24h (plenty). fetchimg never hangs (hard timeouts) and skips blocked sites gracefully.

## State & watchdog
- **`carousel_posts`** (Supabase) — one row per `(date, format)` tracking the pipeline: `pending` →
  `assets_uploaded` (written by `publish.mjs` before Composio posts, so a crash mid-post can't cause a
  silent double-publish) → `published` (written by you/Claude via `state-mark.mjs` once Composio confirms
  the IG/FB post IDs). Also stores `category`, `draw_slugs`, `hook_archetype`, `seo_keyword`, `caption`,
  `asset_urls`, `posted_at`. History off this table drives selection (`recentDrawSlugs`/`lastCategory` in
  `plan.mjs` avoid repeating draws/categories) and the caption briefing's "banned last-14-day openers".
- **`carousel_metrics`** — daily per-post metrics (reach/likes/saves/etc.), keyed by `(day, media_id, metric)`,
  for the future Phase 3 learn/report loop.
- **One-time setup:** run `bun carousel/state-setup.mjs` to check the tables exist; if not, it prints the
  SQL from `carousel/state-schema.sql` to paste into the Supabase SQL editor.
- **`bun carousel/freshness.mjs`** — dead-man's-switch: prints `OK <date>` (exit 0) if a `published` row
  exists within the last 36h, else `STALE …` (exit 1). Uses the public anon key (read-only, RLS-gated) so
  it can run from anywhere, including a scheduled cloud watchdog that nudges you to say "publish today"
  if the streak is at risk.
- **14-day archive:** `plan.mjs` archives (never deletes) the previous day's working folder into
  `archive/<date>-<ms>/` and prunes archive folders older than `archiveDays` (14, in `config.json`).
- **`PDD_DIR`** — override the working directory (default `~/Desktop/pdd-today`, from `config.json`'s
  `global.workDir`). Every script (`plan.mjs`, `fetchimg.mjs`, `build.mjs`, `publish.mjs`) reads it via
  `workDir()` in `config.mjs` — used for dry runs / tests so they never touch the real daily folder,
  e.g. `PDD_DIR=/tmp/pdd-test bun carousel/plan.mjs`.

## One-time IG SEO (do this once, from the app)
Change the Instagram **display name** (not the @handle) to **"Prize Draws Daily | UK Competitions"** —
this is the strongest IG-search ranking signal and only you can set it from the Instagram app
(Edit profile → Name). Not something Claude/Composio can do via API.
