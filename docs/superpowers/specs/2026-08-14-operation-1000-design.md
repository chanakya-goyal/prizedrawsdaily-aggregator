# Operation 1000 — scale live draws from ~395 to 1000+

**Date:** 2026-08-14 · **Status:** approved by user

## Goal

Hold **1000+ live (`status='active'`) draws** on PrizeDrawsDaily at steady state, up from 395
today, without paid services (keyless philosophy stays). Two workstreams: (1) repair and deepen
the existing aggregator, (2) a new **discovery engine** that finds and onboards new UK
prize-draw operators on a human-approve loop.

## Diagnosis (2026-08-14, measured)

- Active draws: **395** · drafts: 3 · ended: 2,093. 95 operators in DB, 93 configured,
  90 enabled — but only **31 operators produce any live draw**.
- **Root cause of the collapse:** the daily GitHub Action (`aggregate.yml`) runs `bun test`
  as a gate before scraping. The **carousel** test files (same repo) need ffmpeg + Playwright
  Chromium, which don't exist at that point in CI → tests fail → **the scrape step has been
  skipped on every run since at least 2026-08-04** while auto-expire kept ending draws.
  The scraper itself is healthy: 261 tests pass locally; FlareSolverr already runs as a
  service container; woo/shopify full-catalog sweep is already in the workflow.
- Secondary gaps (predate the outage): 41 operators stalled (incl. seven-days-perf, botb,
  rev-comps, ukcc), 18 configured-but-never-scraped, 5 woo ops broken on the WooCommerce
  Lottery plugin markup (diagnosed 2026-06-23, fix never built), slow-SPA render ops
  time out at 45s, XHR-grid SPAs (diamond-draws, radiance-rewards) have no parseable DOM,
  render ops capped at `PER_OP=5` per run.

## Steady-state math

Draws end continuously, so 1000 is a flow equilibrium, not a one-off scrape:
~90 producing operators × ~11 avg live ≈ 1000. Revival of the 59 silent operators at the
current 12.7 avg ≈ +590 → ~985. Discovery pushes configured operators toward ~120 as buffer.

## Phase 0 — Unblock the pipeline (highest leverage, smallest change)

- Split test scripts: `test:scraper` (= `bun test test/`) vs `test:carousel`. The workflow's
  gate runs **scraper tests only**; carousel tests never gate scraping again.
- Manually dispatch the Action; verify drafts insert; confirm FlareSolverr ops actually solve.
- Clear the resulting draft flood through the existing cowork describe/QA/publish routine
  (`manager/PROMPT.md`). Publishing policy is unchanged: drafts publish via cowork QA,
  **no auto-publish** — protects the "is X legit" trust brand.

## Phase 1 — Revive the 59 silent operators

After the first clean run, re-run `manager/coverage-report.mjs`; many stalled ops self-heal.
For the rest, in descending expected yield:

1. **WooCommerce Lottery plugin support** in `lib/parse.mjs` (+ fixtures): the 5 silent woo
   ops whose markup the parser misses.
2. **Render depth:** raise render `PER_OP` 5 → 15 (`aggregate.yml` env), and a longer
   per-operator render timeout tier (`"slow": true` → 90s) for TWD, winner-winner-chicken-dinner,
   ignite-comps, etc.
3. **XHR-grid SPAs:** per-operator JSON endpoint support (probe the network calls once,
   store `api` endpoint pattern in `operators.json`; parse like woo/shopify).
4. **skipped-operators.csv sweep:** re-probe every `added=n` row; FlareSolverr rows move into
   `operators.json` (fetcher already exists), recovered hosts (east-anglia pattern) re-enter.
5. Individual diagnosis of whatever remains stalled, with probe evidence per op.

Out of scope (still skipped, documented): non-ticket models (bubbl, good-life-plus),
empty shells, operators requiring paid scraping APIs.

## Phase 2 — Discovery engine (`discovery/` module, same repo)

Keyless-first pipeline that turns the open UK prize-draw market into an approval queue:

- **Sources:** SerpApi (user's key; queries like "win a car competition site:*.co.uk"),
  competitor aggregators' operator lists/sitemaps (competitionshowroom.com etc.), directory
  sites (Loquax and similar), WooCommerce competition-theme/plugin footprints, cross-link and
  social mining from the 93 known operator sites, Trustpilot "competitions" category.
- **Pipeline (deterministic, no LLM):** candidate URL → normalize + dedupe vs DB operators,
  operators.json, skip-list, and previously rejected → **auto-probe** (platform detect:
  woo store API / shopify products.json / render; count live draws; sample ticket price) →
  **trust screen** (domain age via RDAP, company number in footer, T&Cs page exists,
  Trustpilot score if present, live socials) → emit `discovery/queue.json` +
  human-readable `discovery/QUEUE.md` with evidence and a ready-made `operators.json` entry
  + site-DB operator row per candidate.
- **Approval gate (human):** `bun discovery/approve.mjs <slug>` inserts the operator row into
  Supabase and appends the config entry; next daily run scrapes it. `reject.mjs <slug> <reason>`
  records it so it never resurfaces. Nothing reaches the site without approval.
- **Cadence:** weekly GitHub Action (`discovery.yml`, workflow_dispatch + cron) for the
  keyless sources; SerpApi source runs locally/cowork (key stays out of CI).

## Phase 3 — Hold steady state + tripwires

- **Loud failure:** the outage went unnoticed 10+ days. Add a final workflow step that
  auto-opens/updates a GitHub issue when the scrape step fails or when live active count
  drops below a floor (start: 350, raise as inventory grows). Coverage report already
  writes to the step summary; the issue links it.
- **Weekly review loop:** coverage report → top-N stalled ops get probe evidence attached →
  fixes land as Phase-1-style patches.
- Success criterion: `active >= 1000` sustained across 7 consecutive daily runs.

## Architecture notes

- No new services, no new repo. Discovery is a sibling module reusing `lib/fetcher.mjs`
  (incl. FlareSolverr path) and platform detection logic shared with `probe-candidates.mjs`
  (fold/replace that script into `discovery/`).
- Everything stays deterministic/no-LLM except the existing cowork describe/publish routine.
- Testing: fixture-based unit tests per new parser (Lottery plugin markup, XHR-grid JSON),
  probe + trust-screen tests with recorded fixtures; `bun test test/` stays the CI gate.

## Rejected alternatives

- **Discovery-first:** pointless while the pipeline is blocked; new ops would stall identically.
- **Hosted rebuild with dashboard:** breaks the keyless/free philosophy, no draw gain.
- **Auto-publish gated rows:** faster inventory but risks unreviewed content on a trust brand.
