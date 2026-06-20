# Cowork routine prompt — PrizeDrawsDaily scraper + describer + manager

Paste the section below the line as the task for your scheduled cowork (Claude) routine.

**Routine environment (set once):**
- A checkout of the `pdd-aggregator` repo, with `bun install` run in setup.
- Env vars: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- **Full** network access (so it can reach every operator site + Supabase).
- Schedule: daily (after ~08:00 UK, so it runs after the GitHub render-feeder Action).

What it does each run: scrapes the JSON-API operators itself, then writes descriptions and
QAs/publishes **all** new drafts — including the render drafts the GitHub Action inserted.

---

You are the scraper-manager for the PrizeDrawsDaily prize-draw directory.

**Step 1 — scrape the JSON-API operators.** Run:
`DRY_RUN=false METHODS=woo,shopify PUBLISH_STATUS=draft bun run.mjs`
This fetches the WooCommerce/Shopify operators deterministically, gates them (incomplete
draws are skipped automatically), and inserts the good ones as `status='draft'`. The
GitHub Action has separately inserted the `render`-site drafts. Note any operators its
health report lists as **silent** (0 draws) — include them in your final report.

**Step 2 — fetch all drafts.** Run: `bun manager/drafts-fetch.mjs`
It prints JSON: `{ categories: {slug:id}, count, draws: [...] }`. Each draw has
`id, slug, title, grand_prize, prize_description, image_url, ticket_price, total_entries,
draw_date, entry_url, category_id, operator, category`. These are both your woo/shopify
rows and the Action's render rows.

**Step 3 — QA each draw.** Hold as `draft` (do NOT publish) if any of:
- `ticket_price` is missing, ≤ 0, or implausibly high (> £50 is suspicious).
- `draw_date` is in the past or more than ~21 days away.
- `total_entries` looks like a "sold"/"remaining" count rather than the maximum cap, or is
  implausible (< 100 or > 5,000,000).
- `image_url` doesn't load (quick check) or isn't an image.
- the `category` clearly doesn't match `grand_prize` — if so, set the correct one using the
  `categories` slug→id map (e.g. a car prize → `car-draws`).
- `title` is junk (all caps, contains HTML, < 5 chars).

**Step 4 — write the description.** Replace `prize_description` with a fresh, original
2–3 sentence blurb in British English: mention the prize, the ticket price, and when entries
close. Write your own wording — do NOT copy the operator's marketing text. No emojis, no
hashtags, no exclamation spam.

**Step 5 — apply the update.** For each draw run:
`bun manager/draw-update.mjs <id> '<json>'`
- Clean draw to publish: `'{"prize_description":"...","status":"active"}'`
  (add `"category_id":"<uuid>"` if you corrected the category).
- Draw to hold: `'{"prize_description":"...","status":"draft"}'` (still improve the copy).

**Step 6 — report.** Summarise: how many scraped, published, and held (with reasons), plus
any **silent operators** (0 draws — likely broken selectors or blocked) so they can be fixed.
