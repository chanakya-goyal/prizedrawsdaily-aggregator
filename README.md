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
bun test                                  # 95 deterministic unit/fixture tests

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
| `FLARESOLVERR_URL` | FlareSolverr endpoint for `fetcher:"flaresolverr"` operators (default `http://localhost:8191/v1`) |
| `SCRAPER_API_URL` / `SCRAPER_API_KEY` | Managed scraper for `fetcher:"api"` operators (dormant unless both set) |

## Operators

`operators.json` is the source of truth — one declarative entry per operator
(`name`, `slug`, `base`, `method`, plus optional `listing`, `drawMatch`, `exclude`,
`selectors`, `patterns`, `category`, `enabled`). To exclude one, set `"enabled": false`.

Optional per-operator acquisition fields (default absent = plain keyless fetch):

| Field | Purpose |
|---|---|
| `fetcher` | `"plain"` (default) · `"flaresolverr"` (route through a FlareSolverr proxy to clear Cloudflare) · `"api"` (managed scraper) · `"stealth"` |
| `fetcherOpts` | Tool-specific knobs, e.g. `{ "render": true, "premium": true }` for the `api` fetcher |
| `insecureTLS` | `true` to accept a misconfigured TLS cert (scoped to that operator only) |
| `drawUrlTemplate` | For `aiAssist` SPAs whose links live in the data blob — e.g. `"/competitions/{slug}"`; `ai-fetch.mjs` mines slugs and synthesises draw URLs |

**Add an operator:** `bun probe.mjs <url> --slug <slug> --name "<Name>"` classifies the
site (woo / shopify / render / aiAssist / blocked) and prints a paste-ready JSON entry →
paste it into `operators.json` and add the matching `operators` DB row → `bun capture.mjs
<slug>` → `ONLY=<slug> DRY_RUN=true bun run.mjs` to eyeball → add `selectors` if
`draw_date`/`total_entries` don't resolve. For a Cloudflare site, run a local FlareSolverr
(`FLARESOLVERR_URL=http://localhost:8191/v1`) and `probe.mjs` retries through it. The daily
health report lists **silent operators** (0 draws) so you know which ones need tuning.

## Schedule

`.github/workflows/aggregate.yml` runs the render feeder daily at 07:00 UTC (08:00 BST),
and can be triggered from the **Actions** tab. Required repo secrets: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. The cowork routine is scheduled separately (see
`manager/PROMPT.md`).

⚠️ The workflow's test gate is `bun run test:scraper` (= `bun test test/`) on purpose:
everything in `test/` must stay **offline-deterministic** (no network, no Chromium, no
ffmpeg) because a failing gate skips the day's scrape — carousel suites doing exactly that
silently stopped all scraping for 10+ days in Aug 2026. Inserts flush every ~25 rows
mid-run, so a job-timeout kill only loses the tail of a sweep, never the whole thing.

## Tripwire

The last workflow step runs `manager/tripwire.mjs`: if the scrape step didn't succeed or
live inventory drops under `TRIPWIRE_FLOOR` (workflow env, currently 350), it opens (or
comments on) a GitHub issue labelled `tripwire` and turns the run red. Raise the floor as
steady-state inventory grows — target is ~80% of stable live count.

## Discovery engine

`discovery/` finds new UK operators and onboards them behind a human gate:

```
sources (seeds.txt · crosslink mining · competitor sitemaps · SerpApi local-only)
  → dedupe vs operators.json + skip list + rejected.json
  → deterministic platform probe (live purchasable products or it doesn't count)
  → trust screen (RDAP domain age · company number · T&Cs · Trustpilot · socials)
  → discovery/QUEUE.md + queue.json  (evidence + paste-ready config per candidate)
```

- `bun discovery/run.mjs` — build the queue (also runs weekly via
  `.github/workflows/discovery.yml`, which publishes the queue as the run summary +
  artifact and never writes to the DB).
- `bun discovery/approve.mjs <slug>` — insert the operator DB row (as **unverified**:
  `review_status` null until editorial review) + append the `operators.json` entry.
- `bun discovery/reject.mjs <slug> "<reason>"` — record it in `discovery/rejected.json`
  so it never resurfaces.
- `SERPAPI_KEY` in the local env adds the Google-SERP source; it is deliberately absent
  from CI.
