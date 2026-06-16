# PrizeDrawsDaily — Draw Aggregator

Automatically collects live UK prize-draw listings from operator websites and publishes
them to the PrizeDrawsDaily Supabase. Runs daily via GitHub Actions — no manual `/admin`
entry needed.

## How it works

1. A headless browser (Playwright) renders each operator's listing page, finds the
   individual draw pages, and renders each one (so it sees JavaScript-rendered content).
2. An LLM maps each rendered page to our draw fields: title, grand prize, category,
   ticket price, total entries, draw date, image, entry URL, and an original description.
3. **Filters** — a draw is only published if it has a ticket price, a maximum-entries
   number, and a draw date within the next 21 days.
4. **Supervisor** flags suspicious values (typo-sized entry counts, missing images, etc.)
   for closer review.
5. New draws are inserted into Supabase, **deduplicated by `entry_url`** so the same draw
   is never posted twice.

## Run locally

```sh
bun install
bunx playwright install chromium

# Preview only — writes nothing:
GROQ_API_KEY=... DRY_RUN=true bun run.mjs

# Publish as drafts (status='pending', hidden from public, visible in /admin):
GROQ_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=false PUBLISH_STATUS=pending bun run.mjs
```

## Environment variables

| Var | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq API key (LLM extraction) |
| `SUPABASE_URL` | Supabase project URL (has a default) |
| `SUPABASE_SERVICE_ROLE_KEY` | Required to publish (insert) |
| `DRY_RUN` | `"true"` (default) previews; `"false"` publishes |
| `PUBLISH_STATUS` | `"pending"` (draft) or `"active"` (live) |
| `PER_OP` | Draws per operator per run (default 6) |

## Operators

- **Active:** 7Days Performance, UKCC, Dream Car Giveaways, Rev Comps.
- **Blocked (add manually):** Bounty (Cloudflare bot challenge), Jammy (Wordfence block).

Operator config lives in `extractor.mjs` (`OPERATORS`).

## Schedule

`.github/workflows/aggregate.yml` runs daily at 07:00 UTC (08:00 BST), and can be triggered
manually from the **Actions** tab. Required repo secrets: `GROQ_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`.
