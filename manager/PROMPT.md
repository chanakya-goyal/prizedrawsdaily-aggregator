# Cowork routine prompt — PrizeDrawsDaily scraper + AI-assist + describer + manager

Paste the section below the line as the task for your scheduled cowork (Claude) routine.

**Routine environment (set once):** a checkout of the `pdd-aggregator` repo with `bun install`
in setup; env vars `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; **Full** network access;
daily schedule (after the ~08:00 UK GitHub render Action).

---

You are the scraper-manager for the PrizeDrawsDaily prize-draw directory, running in a fresh
clone of the prizedrawsdaily-aggregator repo. The environment provides SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY. Work through these steps with Bash; if a step errors, report it
and continue where sensible.

**0. Install deps:** `bun install` (if `bun` is missing: `curl -fsSL https://bun.sh/install | bash`, add it to PATH, retry).

**1. Scrape standard operators** (inserts complete draws as draft, prints a health report):
`DRY_RUN=false METHODS=woo,shopify PUBLISH_STATUS=draft bun run.mjs`
Note any 'silent' operators (0 draws) for your final report.

**2. Premium / AI-assist operators** (car sites etc. whose date/price are countdowns):
Run `bun manager/ai-fetch.mjs`. It prints `{ count, draws: [...] }`; each draw has
`operator_slug, entry_url, title, grand_prize, category (a guess), image_url,
ticket_price (a HINT, often wrong), iso_dates (candidate timestamps), hints (key snippets),
page_text`. For EACH draw, read `hints`/`page_text` and work out:
- **ticket_price** — the real per-ticket price (e.g. "from £0.17"); ignore the ticket_price hint if it conflicts.
- **draw_date** — resolve the close/draw time. Hints look like "Live Draw Today, 22:00" or
  "Automated Draw Tomorrow, 22:00" — turn Today/Tomorrow into an absolute UK date using
  today's date, and confirm against `iso_dates` (pick the matching FUTURE timestamp). Format
  as `2026-06-21T22:00:00+01:00`.
- **total_entries** — ONLY if a maximum ticket count is stated. These sites usually show just
  "% sold" → then leave it out (null is fine).
- **category** — fix a wrong guess (a £300k cash pot is `cash-prizes`, not `house-draws`).
- **prize_description** — a fresh 2–3 sentence British-English blurb (prize, price, close date).
Then insert it:
`bun manager/draw-insert.mjs '{"operator_slug":"...","title":"...","grand_prize":"...","category":"car-draws","ticket_price":0.17,"draw_date":"2026-06-21T22:00:00+01:00","image_url":"...","entry_url":"...","prize_description":"..."}'`
Skip any where you cannot work out a sensible FUTURE draw_date and a real ticket price.

**3. Fetch all current drafts:** `bun manager/drafts-fetch.mjs`.

**4. QA + describe.** For each draft lacking a good description, write one (2–3 sentence
British-English; prize, price, close date; original wording; no emojis/hashtags). Hold a
draft (don't publish) if: ticket_price missing/≤0/over £50; draw_date past or absurd;
total_entries looks like a sold/remaining count; image_url doesn't load; category clearly
wrong; or title is junk.

**5. Apply updates:** `bun manager/draw-update.mjs <id> '<json>'`
- publish a clean draw: `'{"prize_description":"...","status":"active"}'` (add `"category_id":"<uuid>"` if you corrected the category)
- hold a doubtful one: `'{"prize_description":"...","status":"draft"}'`.

**6. Report:** scraped / AI-inserted / published / held (with reasons), the category spread
(cars / cash / tech / house / luxury), and any silent operators (0 draws) to fix.
