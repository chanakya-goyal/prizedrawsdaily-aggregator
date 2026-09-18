# PrizeDrawsDaily — Carousel Insights (Channel A daily, Channel B fortnightly)

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
   keyed on `(day, media_id, metric, window)` — safe to re-run):
   ```
   bun carousel/insights.mjs ingest ig_media  ~/Desktop/pdd-today/insights/ig_media.json
   bun carousel/insights.mjs ingest ig_reach  ~/Desktop/pdd-today/insights/ig_reach.json
   bun carousel/insights.mjs ingest fb_posts  ~/Desktop/pdd-today/insights/fb_posts.json
   bun carousel/insights.mjs ingest ig_insights ~/Desktop/pdd-today/insights/ig_insights.json
   ```

   **The Stage E kinds (§11.2).** Prefer these for anything new. They differ from the four above
   in one way that matters: **an absent field writes NO ROW**, where the older kinds store a 0.
   ```
   bun carousel/insights.mjs ingest ig_media_insights  …/ig_media_insights.json
   bun carousel/insights.mjs ingest ig_story_insights  …/ig_story_insights.json
   bun carousel/insights.mjs ingest ig_account         …/ig_account.json
   ```

   ⚠ **Pull Stories the SAME DAY.** Story insights are not retrievable once the Story expires, so
   a missed day is permanently lost. Every story row is pinned to `window='t24'` for that reason,
   and **no Story figure carries a target anywhere** — Story data is diagnostic, never a gate.

   ⚠ **Graph API field names are NOT verified.** The readers do not hard-code them: they walk
   `data[].name` / `data[].values[].value` and store whatever Graph returned. An unrecognised
   response *shape* throws rather than writing zeros. If Meta retires a metric (it has retired
   `impressions` before), the symptom is a missing row, not a silent zero.

   **Each payload should carry `posted_at` and `captured_at`** on the batch object, so the reading
   can be filed against its real age:

   | `window` | age at capture | what it is for |
   |---|---|---|
   | `t24`  | ≤ 36h | the early read; every Story row |
   | `t72`  | 36–120h | **the canonical decision reading** |
   | `t168` | 120–240h | the late accrual |
   | `late` | > 240h | anything after |
   | `legacy` | unknown | the 95 pre-rework rows, and any payload with no timestamps |

   `age_hours` stores the ACTUAL age, so a reading that landed at 61h is never treated as exactly
   72h. Without timestamps a row is `legacy` with `age_hours` null — honest, not guessed.

   **Derived rows** (`source='derived'`) are appended automatically:
   `reel_initial_views = reel_watch_time_total_ms ÷ reel_avg_watch_time_ms` and
   `reel_replays = views − reel_initial_views`, both following from Meta's own definition of
   average watch time. They are **suppressed below 50 views**, because at a handful of views
   rounding in `reel_avg_watch_time_ms` dominates the result. That threshold is design judgement,
   not a measured optimum.

   **Channel B — the retention curve, by hand.** No Graph API field returns skip rate or the
   retention curve; they are charts in Instagram's own professional insights. One sitting per
   fortnight, capped at 8 reels, written with `insertCurve()` — `source='app'`, and every row
   carries an archived screenshot in `evidence_url`. `points` **must** include an explicit reading
   at `t_ms = 3000`: "watch under 3 seconds" is a named input to the abandonment prediction head,
   so a curve without it cannot answer the question it exists for. `insertCurve` refuses one that
   lacks it.

   The cadence is asymmetric on purpose: **Story insights expire in 24 hours and post insights do
   not.** Batching a Story pull loses data; batching a post transcription loses only latency. So
   Channel A runs on the same daily trigger as publishing, unattended — which adds no approval
   gate, and the failure mode that killed this pipeline in July was its single manual gate.
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
| `ig_insights` | `data[].{name, values:[{value, end_time?}], id:"<media_id>/insights/…"}`, or `{media_id, day?, data:[…]}`, or an array of those | per metric: `(day, media_id, name, value)`. An entry whose media cannot be identified is DROPPED rather than filed under a guess. ⚠ A missing value is stored as **0** — the original contract, locked by `insights.test.mjs` and left alone deliberately |
| `ig_media_insights` | as `ig_insights`, plus `posted_at` / `captured_at` on the batch | per metric: `(day, media_id, name, value, source='api', window, age_hours)`. **Absent ⇒ NO ROW.** Present-and-zero ⇒ a row with 0. An unrecognised shape THROWS |
| `ig_story_insights` | as `ig_media_insights` | same, with `window` pinned to `t24` — Story insights expire |
| `ig_account` | `data[].{followers_count, day}` or a bare object | `(day, "account", "followers", n)`. An absent count throws rather than recording a zero-follower account |
| *(derived)* | computed from the rows above | `reel_initial_views`, `reel_replays` with `source='derived'`, suppressed below 50 views |

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
  upserts on `(day, media_id, metric, window)` — the `window` term is what lets an early and a late reading of the same metric coexist instead of the later one silently overwriting the earlier.
- **CLI errors are explicit**: an unknown `kind` or a missing/unreadable file
  exits 1 with a clear message; nothing is silently skipped.
- **Cadence**: there's no cron for this yet (Phase 3 territory) — run it
  on the same DAILY trigger as publishing by saying "pull insights". Weekly is not enough: it
  cannot produce a t72 reading for most posts, and cannot produce a Story reading at all, because
  Story insights expire in 24 hours. Ingest is idempotent (upsert on the PK), so a daily pull is
  safe to re-run and needs no approval gate — and the single manual gate is what killed this
  pipeline in July.
- **Needs** `SUPABASE_SERVICE_ROLE_KEY` in `~/pdd-aggregator/.env` (already set,
  shared with `publish.mjs`/`state.mjs`) — `ingest` writes, `report` reads.
