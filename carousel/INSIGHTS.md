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

3. **Ingest each file** (batches `insertMetrics` upserts 50 rows at a time,
   keyed on `(day, media_id, metric)` — safe to re-run):
   ```
   bun carousel/insights.mjs ingest ig_media  "$(workDir)/insights/ig_media.json"
   bun carousel/insights.mjs ingest ig_reach  "$(workDir)/insights/ig_reach.json"
   bun carousel/insights.mjs ingest fb_posts  "$(workDir)/insights/fb_posts.json"
   ```
   (`$(workDir)` = the same folder from step 1, e.g. `~/Desktop/pdd-today/insights`.)

4. **Report**:
   ```
   bun carousel/insights.mjs report
   ```
   Prints a per-day table for the last 7 days: date, formats posted
   (`carousel`/`fb_photo`/`reel`/…, from `carousel_posts`), category, account
   reach, and per-post likes/comments keyed by `ig_media_id`. If no metrics have
   been ingested yet it prints `no metrics yet` instead of an empty/broken table.

## Payload → row mapping (for reference)

| kind        | source fields                                                              | rows written                                                     |
|-------------|-----------------------------------------------------------------------------|-------------------------------------------------------------------|
| `ig_media`  | `data[].{id, like_count, comments_count, timestamp}`                       | per post: `(day, id, "likes", like_count)`, `(day, id, "comments", comments_count)` |
| `ig_reach`  | `data[].{name:"reach", values:[{end_time, value}]}`                        | per day: `(day, "account", "reach", value)`                       |
| `fb_posts`  | `data[].{id, created_time, reactions.summary.total_count, comments.summary.total_count, shares.count}` | per post: `(day, id, "fb_reactions", …)`, `(day, id, "fb_comments", …)`, `(day, id, "fb_shares", …)` (missing `shares` → 0) |

`day` is always the **Europe/London calendar date** of the item's own timestamp
(`timestamp` / `end_time` / `created_time`), matching `state.mjs`'s `todayLondon()`
convention — not the day the pull happened.

## Notes

- **Idempotent**: re-running `ingest` for the same file is safe — `insertMetrics`
  upserts on `(day, media_id, metric)`.
- **CLI errors are explicit**: an unknown `kind` or a missing/unreadable file
  exits 1 with a clear message; nothing is silently skipped.
- **Cadence**: there's no cron for this yet (Phase 3 territory) — run it
  manually, e.g. weekly, by saying "pull insights".
- **Needs** `SUPABASE_SERVICE_ROLE_KEY` in `~/pdd-aggregator/.env` (already set,
  shared with `publish.mjs`/`state.mjs`) — `ingest` writes, `report` reads.
