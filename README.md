# PrizeDrawsDaily — Draw Aggregator (keyless)

Collects live UK prize-draw listings from operator websites and feeds them into the
PrizeDrawsDaily Supabase. **No LLM in the scraper** — extraction is fully deterministic.
The only AI is Claude, run by a separate **cowork routine** that writes descriptions and
publishes (see `manager/PROMPT.md`).

## Architecture (render-feeder hybrid)

Two feeders write `draft` rows into Supabase via the **same** code (`lib/parse.mjs` +
`gate.mjs`); the cowork routine then describes/QA's/publishes **all** drafts.

- **GitHub Action (`METHODS=render`)** — browser-only feeder: renders the `render`-method
  operators with Playwright (with a try-harder pass for soft JS challenges), extracts
  fields, gates them, inserts drafts. No AI, no API key.
- **Cowork routine (`METHODS=woo,shopify`)** — scrapes the JSON-API operators (plain
  `fetch`, no browser), inserts drafts, then runs Claude to write descriptions, validate
  every field, and publish clean rows (`draft → active`).

## How extraction works (no LLM)

1. **Fetch:** WooCommerce Store API (`/wp-json/wc/store/v1/products`), Shopify
   (`/products.json`), or a Playwright render.
2. **Parse (`lib/parse.mjs`):** JSON-LD / og-tags / built-in & per-operator CSS selectors /
   a regex library extract title, price, **total_entries** (max cap — sold/remaining counts
   are vetoed), **draw_date** (UK formats, draw-time preferred over close-time), image, category.
3. **Gate (`gate.mjs`):** `requiredGate` (skip draws missing a required field) →
   `schemaGate` (mirror the site's zod) → `businessGate` (price>0, entries credible,
   draw within 21 days). Missing required field ⇒ **skipped**; suspicious ⇒ held **draft**.
4. **Insert** as `draft` with a deterministic template description (the cowork routine
   rewrites it), deduplicated by `entry_url`.

## Run locally

```sh
bun install
bunx playwright install chromium
bun test                                  # 89 deterministic unit/fixture tests

# Preview only — writes nothing:
DRY_RUN=true bun run.mjs                                   # all operators
DRY_RUN=true METHODS=woo,shopify ONLY=rev-comps bun run.mjs   # one operator

# Insert drafts (needs the service key):
SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=false METHODS=render bun run.mjs
```

## Environment variables

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (has a default) |
| `SUPABASE_SERVICE_ROLE_KEY` | Required to insert/publish |
| `DRY_RUN` | `"true"` (default) previews; `"false"` writes |
| `METHODS` | Comma list to filter by method: `render` (Action) or `woo,shopify` (cowork) |
| `PUBLISH_STATUS` | `"draft"` (default) or `"active"` — normally left as draft; cowork publishes |
| `PER_OP` | Draws per operator per run (default 5) |
| `ONLY` | Comma list of operator slugs (testing) |

## Operators

`operators.json` is the source of truth — one declarative entry per operator
(`name`, `slug`, `base`, `method`, plus optional `listing`, `drawMatch`, `exclude`,
`selectors`, `patterns`, `category`, `enabled`). To exclude one, set `"enabled": false`.

**Add an operator:** add a JSON entry → `bun capture.mjs <slug>` (saves a fixture) →
`ONLY=<slug> DRY_RUN=true bun run.mjs` to eyeball → add `selectors` if `draw_date`/
`total_entries` don't resolve. The daily health report lists **silent operators**
(0 draws) so you know which ones need tuning.

## Schedule

`.github/workflows/aggregate.yml` runs the render feeder daily at 07:00 UTC (08:00 BST),
and can be triggered from the **Actions** tab. Required repo secrets: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. The cowork routine is scheduled separately (see
`manager/PROMPT.md`).
