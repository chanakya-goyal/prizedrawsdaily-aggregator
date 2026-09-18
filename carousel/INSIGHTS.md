# PrizeDrawsDaily — Carousel Insights (weekly analytics pull)

Pulls IG + FB performance numbers into `carousel_metrics` (Supabase) and prints a
last-7-day report. Scripts here **cannot** call the Composio MCP directly (spec
constraint) — Claude pulls the 3 JSON payloads in-session via Composio, saves
them to files, then feeds those files to `carousel/insights.mjs`, which does the
deterministic mapping + upsert + report.

> **Quick start:** say **"pull insights"** in a Claude Code session in
> `~/pdd-aggregator`. Claude runs the 3 Composio calls below, ingests them, and
> shows you the report.

## What happens (Claude drives this)

1. **Ensure the drop folder exists**: `${workDir()}/insights/` (default
   `~/Desktop/pdd-today/insights/`, override with `PDD_DIR`). Create it if missing.

2. **Run these 3 exact Composio tool calls** and save each response's raw JSON
   to the path shown:

   **a. Instagram media (likes/comments per post)**
   ```
   INSTAGRAM_GET_IG_USER_MEDIA
     ig_user_id: 27332554436394910
     fields: id,like_count,comments_count,media_type,media_product_type,timestamp
     limit: 25
   ```
   → save to `${workDir()}/insights/ig_media.json`

   **b. Instagram account reach (last 7 days)**
   ```
   INSTAGRAM_GET_USER_INSIGHTS
     ig_user_id: 27332554436394910
     metric: ["reach"]
     period: day
     metric_type: time_series
     since: 7-days-ago
   ```
   → save to `${workDir()}/insights/ig_reach.json`

   **c. Facebook page posts (reactions/comments/shares)**
   ```
   FACEBOOK_GET_PAGE_POSTS
     page_id: 1106603652538117
     fields: id,created_time,reactions.summary(true),comments.summary(true),shares
     limit: 10
   ```
   → save to `${workDir()}/insights/fb_posts.json`

3b. **IG per-media insights** — `INSTAGRAM_GET_MEDIA_INSIGHTS` (or the Graph call
   `GET /{ig-media-id}/insights?metric=reach,saved,shares,views`) for each `ig_media_id` in
   `carousel_posts` for the period.
   → save to `${workDir()}/insights/ig_insights.json`

   **This is the pull that matters and it did not exist before.** `ig_media` gives likes and
   comments; `ig_reach` gives ACCOUNT-level reach keyed `"account"`, which cannot tell one post
   from another. Neither carries **saves** or **shares**, and for a daily listings deck those
   are the two behaviours the format is actually for: a save is someone keeping the board, and a
   share is how an account with 66 followers reaches anybody new.

   Accepts the bare Graph response for one media, or a batch — `{media_id, data:[…]}` or an
   array of those. With no `media_id` supplied it reads the id out of each insight's own
   `id` field, which has the form `<media_id>/insights/<metric>/<period>`.

   ⚠ **Views are recorded but must never be reported as a win on their own.** Instagram's own
   definitions (help.instagram.com/202865988324236) count Views as "starts to play or replay",
   include replays in Watch time, and divide watch time INCLUDING replays by INITIAL views to
   get average watch time. The Reel now loops seamlessly by construction, which inflates all
   three without reaching one extra person. On that surface **reach and skip rate are the only
   honest reads.**

3. **Ingest each file** (batches `insertMetrics` upserts 50 rows at a time,
   keyed on `(day, media_id, metric)` — safe to re-run):
   ```
   bun carousel/insights.mjs ingest ig_media  ~/Desktop/pdd-today/insights/ig_media.json
   bun carousel/insights.mjs ingest ig_reach  ~/Desktop/pdd-today/insights/ig_reach.json
   bun carousel/insights.mjs ingest fb_posts  ~/Desktop/pdd-today/insights/fb_posts.json
   bun carousel/insights.mjs ingest ig_insights ~/Desktop/pdd-today/insights/ig_insights.json
   ```
   (paths shown are the default `workDir()` — adjust if `PDD_DIR` is set.)

   Sanity-check a payload before it touches `carousel_metrics` with `--dry-run`
   (parses + maps + prints the row count and up to 3 sample rows, no writes):
   ```
   bun carousel/insights.mjs ingest ig_media ~/Desktop/pdd-today/insights/ig_media.json --dry-run
   ```

4. **Report**:
   ```
   bun carousel/insights.mjs report
   ```
   Prints a per-day table for the last 7 days: date, formats posted
   (`carousel`/`fb_album`/`reel`/…, from `carousel_posts`), category, account
   reach, and per-post likes/comments keyed by `ig_media_id`. If no metrics have
   been ingested yet it prints `no metrics yet` instead of an empty/broken table.

## Payload → row mapping (for reference)

| kind        | source fields                                                              | rows written                                                     |
|-------------|-----------------------------------------------------------------------------|-------------------------------------------------------------------|
| `ig_media`  | `data[].{id, like_count, comments_count, timestamp}`                       | per post: `(day, id, "likes", like_count)`, `(day, id, "comments", comments_count)` |
| `ig_reach`  | `data[].{name:"reach", values:[{end_time, value}]}`                        | per day: `(day, "account", "reach", value)`                       |
| `fb_posts`  | `data[].{id, created_time, reactions.summary.total_count, comments.summary.total_count, shares.count}` | per post: `(day, id, "fb_reactions", …)`, `(day, id, "fb_comments", …)`, `(day, id, "fb_shares", …)` (missing `shares` → 0) |
| `ig_insights` | `data[].{name, values:[{value, end_time?}], id:"<media_id>/insights/…"}`, or `{media_id, day?, data:[…]}`, or an array of those | per metric: `(day, media_id, name, value)`. An entry whose media cannot be identified is DROPPED rather than filed under a guess |

`day` is always the **Europe/London calendar date** of the item's own timestamp
(`timestamp` / `end_time` / `created_time`), matching `state.mjs`'s `todayLondon()`
convention — not the day the pull happened.

> **`ig_reach` caveat:** the Graph API's `end_time` for a `day`-period time-series
> value marks the **end of a Pacific-anchored day bucket**, not a London-midnight
> boundary — so converting it to a London calendar date can attribute a given
> bucket's reach to the day before or after where you'd intuitively expect it.
> Treat any arm-vs-reach comparison (the format-experiment go/no-go in `DAILY.md`)
> as accurate to **±1 day**, not exact.

## Reading a series across a changing deck size

`carousel_posts.draw_slugs` already holds the draws that actually RENDERED, so the deck size per
post is `draw_slugs.length` and needs no column of its own. That matters because a series which
silently mixes full and degraded decks cannot be read: engagement on an eight-draw board is not
comparable to engagement on a four-draw one, and every count on the frame — the counter chip,
the band's draw count, the cover's proof line — is derived from the real number rather than from
the configured one.

⚠ One thing to know about that field: `build.mjs` may SWAP a draw whose artwork reads as a
marketing collage for a backup, and it writes the decision back to `selection.json` before
`publish.mjs` reads it. So `draw_slugs` names what shipped, not what was originally picked.

## Notes

- **Idempotent**: re-running `ingest` for the same file is safe — `insertMetrics`
  upserts on `(day, media_id, metric)`.
- **CLI errors are explicit**: an unknown `kind` or a missing/unreadable file
  exits 1 with a clear message; nothing is silently skipped.
- **Cadence**: there's no cron for this yet (Phase 3 territory) — run it
  manually, e.g. weekly, by saying "pull insights".
- **Needs** `SUPABASE_SERVICE_ROLE_KEY` in `~/pdd-aggregator/.env` (already set,
  shared with `publish.mjs`/`state.mjs`) — `ingest` writes, `report` reads.
