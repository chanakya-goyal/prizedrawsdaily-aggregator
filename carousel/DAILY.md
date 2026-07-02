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

5. **Publish** — `bun carousel/publish.mjs` (hosts JPEGs, writes `publish.json` with `caption`, `fbCaption`, `heroUrl`, `urls`) → Claude posts via Composio:
   - **Instagram (full carousel):** `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` (`child_image_urls`=urls + `caption`) → `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` (ig_user_id `27332554436394910`).
   - **Facebook — ONE detailed captioned post** (Page "Prize Draws Daily" `1106603652538117`): `FACEBOOK_CREATE_PHOTO_POST` (`page_id`, `url`=`heroUrl`, `message`=`fbCaption`). The caption (prize list + clickable prizedrawsdaily.co.uk link + 18+) posts **inline with the image** — one rich post, NOT caption-less individual photos.
     - **Why one image:** this Composio FB app can't attach multiple photos to a captioned post (`FACEBOOK_CREATE_POST` has no media field; `FACEBOOK_UPLOAD_PHOTOS_BATCH` has no caption field → the old batch recipe produced the caption-less photo pile we're replacing). IG carries the full carousel; FB gets the intro hero + full caption.

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
