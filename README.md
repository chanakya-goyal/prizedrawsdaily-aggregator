# PrizeDrawsDaily — Draw Aggregator (keyless)

Collects live UK prize-draw listings from operator websites and feeds them into the
PrizeDrawsDaily Supabase. **No LLM in the scraper** — extraction is fully deterministic.
Publishing is deterministic too (two agreeing observations — see below). The only AI is Claude,
run by a separate **cowork routine** that QAs what was published and writes descriptions (see
`manager/PROMPT.md`); it never publishes.

## Architecture

The daily GitHub Action runs the full sweep (`METHODS=api,render,woo,shopify`) through one
code path (`lib/parse.mjs` + `gate.mjs`), inserts new rows as `draft`, then auto-expires
finished comps and reports. The cowork routine (`manager/PROMPT.md`) layers Claude on top the
next morning: it spot-checks published rows against the operators' own pages and improves
descriptions — the one field the scraper never overwrites.

### Publishing: agreement between two independent observations

A first sighting is **never** published. A draft goes live only when a **later run re-scrapes
the same URL and agrees** with what was stored — same ticket price, same cap, same UK draw
day, matching title, clean `fieldFlags`, and an image that provably loads (`lib/verify.mjs`).
Two separate fetches, parsed separately, on different days, reaching the same answer. This
costs no extra requests, because the daily run already re-scrapes everything.

Anything that disagrees stays `draft` with the reason recorded, so the hold list doubles as
the parser's to-do list. A `total_entries` that moves between runs, for example, is not a cap
at all — it's a stock counter — and that row will correctly never publish.

Publishing is **opt-in**: only `AUTO_PUBLISH=true` acts on the verdicts, and the daily Action
is the only place that sets it — every other invocation (local shell, cowork routine, a one-off
`ONLY=…` run) computes and reports the same verdicts but **publishes** nothing. Note that is
specifically about `draft → active`: such a run still inserts new drafts, refreshes existing
ones, corrects live rows and expires finished comps. **`DRY_RUN=true` is the only mode that
writes nothing at all.** Dropping `AUTO_PUBLISH` from the workflow restores fully human-gated
publishing with no code change;
`AUTO_PUBLISH_MAX` bounds how many rows a single run can make live.

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

### Methods

| `method` | How it reads the operator |
|---|---|
| `woo` | WooCommerce Store API, paginated (`per_page=100` + `after=<lookbackDays>`) |
| `shopify` | `products.json`, filtered to products with an available variant |
| `render` | Headless Chromium — the expensive fallback for sites with no usable feed |
| `api` | A platform-specific JSON adapter in `lib/adapters/`, chosen by `apiStyle` |

`method: "api"` is preferred wherever it exists: complete catalogues instead of a link cap,
the operator's own published numbers instead of regex inference, and no browser.

| `apiStyle` | Operators | Endpoint |
|---|---|---|
| `raffle-engine` | 7Days Performance, UKCC (identical platform) | `{base}/api/v2/raffle-draws/GBP` |
| `hydra` | Dream Car Giveaways | `https://api.dreamcargiveaways.co.uk/competitions` |
| `inertia` | Dream Big Competitions | `data-page` attribute on the listing page |

Depth/balance fields: `maxLive` (ceiling on how many live comps we list for one operator —
stops a 300-comp collectibles operator crowding out everything else), `maxPages`,
`lookbackDays`. `apiStyle: "rest_route"` remains the woo sub-variant for hosts that 500 the
pretty `/wp-json/` route.

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
