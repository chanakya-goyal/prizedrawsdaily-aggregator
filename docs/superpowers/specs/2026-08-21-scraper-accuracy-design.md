# Scraper Accuracy Program — Design

**Date:** 2026-08-21 · **Status:** approved (pending user sign-off of this doc) · **Repos:** `pdd-aggregator` (primary) + `draw-discovery-hub` (site PR)

## 1. Problem & evidence

Category pages on prizedrawsdaily.co.uk show wrong prizes. Measured on the live DB (2026-08-21, 555 active draws):

- **228 draws sit in Cash Prizes; ~100 don't belong there.** 101 of the 228 matched *no* keyword and landed in cash via the `inferCategory` fallback (Cobra irons, Ogio carry bags, Sealey tool chests, trampolines, Diggerland trips, gold bars). 5 more contradict their stored category outright.
- **"Instant win" counts as cash evidence** in `CAT_RULES`, so product instant-wins ("Apple Vs Samsung – Tech Instant Win", "IRONS QUICK DRAW INSTANT WIN") "positively" classify as cash. It is a mechanic, not a prize.
- **Keywords misfire in reverse:** "Fruit Ninja" → tech (Ninja appliance brand), "HOME SWEET INSTANT WINS" → house-draws.
- **Nothing re-checks live rows.** `fieldFlags` only flags a category when evidence *contradicts* it; silence passes, so fallback guesses go live and stay live.
- **0 of 94 operators** use the existing per-operator `category` pin, even single-vertical ones (Golf Star ≈ 100% golf gear, 33+ draws wrongly in cash).

Root cause in one line: **the system guesses when it has no evidence, and never re-examines its guesses.** Wrong categories and wrong prize facts directly damage the directory's trust + SEO (category pages are indexed landing surfaces).

## 2. Goals & non-goals

**Goals**

1. No draw is ever published with a guessed category. Judged once, remembered forever.
2. Every prize with no natural home gets one: two new categories.
3. Backfill the live set so category pages tell the truth today.
4. Recurring audits keep categories AND prize facts (price, entries, date, grand prize) correct, with measured coverage.
5. Every mistake found becomes a permanent regression test (self-improving loop, CI-enforced).
6. Broken operators self-diagnose and propose their own fixes (leashed self-healing).
7. Scale to 1,000–2,000 draws and future UK operators with near-zero marginal AI cost and a one-command onboarding flow.

**Non-goals**

- Rewriting the scraper. The existing two-half keyless architecture (GitHub Action = browser sites, cowork = Woo/Shopify + AI) is kept.
- Operator curation *execution* (pruning dead operators, onboarding Raffle House / Elite Competitions / Click Competitions, the 9 queued approvals). This project ships the data (operator scoreboard); curation is the immediate follow-up sprint.
- An "Instant Wins" cross-cutting browse page; `prize_value`/affiliate work; moving image storage off Supabase (fine at ~0.35 GB post-compression).
- Weekly-only *scraping*. Draws end in days; the free deterministic scrape stays daily. Weekly refers to the deep AI audit only.

## 3. Taxonomy (site + DB)

Eight categories. Existing six keep their slugs; two new:

| Slug | Name | Contents |
|---|---|---|
| `sports-outdoors` (NEW) | Sports & Outdoors | Golf gear (clubs, irons, wedges, putters, bags, trolleys, GPS), fishing (tackle, carp, rods), pedal bikes, e-bikes/e-scooters (moved from tech), gym/fitness, camping, sports kit |
| `home-garden` (NEW) | Home & Garden | Tools + tool chests (Sealey, DeWalt, Makita…), garden furniture/rattan, trampolines, mowers, pressure washers, pizza ovens, BBQs, sheds, hot tubs/Lay-Z-Spa/jacuzzi (moved from luxury) |

**Category moves of existing vocab:** golf* and fishing leave Luxury → sports-outdoors. Hot tubs leave Luxury → home-garden. E-bikes/e-scooters leave Tech → sports-outdoors. Pedal bikes leave car-draws → sports-outdoors (motorbikes/motorcycles stay car-draws). **Luxury is re-curated to genuine richness:** watches, jewellery, designer, fragrance, champagne/whisky, holidays/cruises/spa breaks, gold bars/bullion. Days-out and hotel stays stay in Luxury.

**Site PR (draw-discovery-hub, own branch → PR):**

- Migration: insert the 2 `categories` rows; add `draws.category_source text` (`'rule' | 'claude' | 'manual'`, nullable). Applied to prod per repo convention.
- Nav entries in `SiteHeader.tsx` + `__root.tsx` — labels **"Sports"** and **"Home & Garden"** (not "Home", which would collide with "Houses").
- Two cover images matching the existing dark premium covers (`category-covers.ts`).
- Per-category intro copy + operator-section headings in `category.$slug.tsx`; refresh the Luxury intro after the golf exodus; `related-links.ts` entries. Sitemap picks the new pages up automatically.

`category_source` semantics: `rule` = machine-classified (re-checkable), `claude` = judged (never re-litigated by the nightly audit), `manual` = human (never touched). Existing rows get stamped by the backfill.

## 4. Classifier (`lib/parse.mjs`)

Precedence unchanged: **operator pin → specific operator taxonomy (`OP_CAT_MAP`) → title/prize inference (`CAT_RULES`) → null.** The change is the last hop: **the cash-prizes fallback is deleted.** `inferCategory` returns null when nothing matches.

- **Cash rules:** remove `instant win` (mechanic). Keep `jackpot` (a money word). Add missing genuinely-cash vocab: `site credit`, `account credit`, `bank transfer` (fixes "£500 SITE CREDIT" falling through).
- **New rule sets** for sports-outdoors and home-garden built from the observed long tail (golf brands: Cobra, PXG, Ping, Ogio, TaylorMade, Callaway, Titleist, Mizuno, Srixon, Scotty Cameron, Shot Scope, Powakaddy, Motocaddy…; tool brands: Sealey, DeWalt, Makita, Milwaukee, Snap-on, Ryobi…). Rule order: collectibles → house → car → **sports-outdoors → home-garden** → tech → luxury → cash.
- **False-positive guards** for every observed trap: `ninja`/`shark` require appliance context (air fryer/blender/vacuum…) so "Fruit Ninja" can't read as tech; house-draws requires property context (worth-£, dream home, mortgage-free…) so "HOME SWEET" can't; the VW-Golf and Van-Gogh guards stay; bare `driver` is never a golf keyword (car-title trap) — golf drivers are caught via brand + "golf" context.
- `OP_CAT_MAP` updated for 8 slugs (operator labels like "Golf", "Tools" map to the new homes).
- `CATEGORIES` list gains the two slugs (manager validation + catMap alignment).
- **Operator pins:** audit all 94 operators; pin single-vertical ones in `operators.json` (`"category": "sports-outdoors"` for golf-star-competitions day one). Pins are only for operators whose entire inventory is one shelf.

## 5. Publish policy + cowork classification (PROMPT.md v4)

- `fieldFlags` gains: **null category → flag "no category evidence" → held as draft.** Contradiction flag stays. No new states — the existing draft/flag machinery carries it.
- The cowork manager gets a **classification step**: fetch drafts flagged for category, Claude picks **one of the 8 slugs** from title + grand prize, consulting the banner image (existing vision path) when text is generic. Writes `category_id` + `category_source='claude'`. Output validated against the slug list — anything else writes nothing and the draw stays draft, listed in the tripwire report.
- Two-observation publishing is unchanged; classification happens within the wait, so added latency ≈ 0.
- Live-row corrections (`CORRECT_LIVE` path) may move a category only when `category_source='rule'`; `claude`/`manual` rows are immune to rule-driven flapping.

## 6. Backfill (one-off, run locally by Claude in-session)

New `backfill-categories.mjs`:

1. Fetch all draws. Recompute rule verdict with the new classifier + operator pins.
2. **Active draws:** confident rule verdict that differs → update + `category_source='rule'`. Null/ambiguous → export worklist → classified in-session (title + prize + image, adversarial double-check per §12) → applied with `category_source='claude'`.
3. **Ended draws:** rule + pin fixes only (covers the Golf Star bulk); null-evidence ended rows keep their category. Archived pages aren't worth judgment tokens.
4. Every change logged old→new to a JSON file (revertible). `status` is never touched.
5. Rows already correct get `category_source='rule'` stamped for audit eligibility.

Expected outcome: Cash ~228 → ~120–130 genuine; Sports & Outdoors launches with ~50–60; Home & Garden with ~15–25.

## 7. Recurring audits (inside the existing daily cowork routine)

**Daily-cheap:** classify new unknowns (a handful/day, batched into one prompt); publish; describe. AI cost scales with novelty, not catalogue size.

**Weekly-deep (Sundays, same routine, date-gated):**

- **Category drift:** recompute rule evidence for live `category_source='rule'` rows; disagreements → Claude verdict (vision tiebreak) → fix + report.
- **Prize-detail patrol:** re-fetch a rotating slice of live rows from operators — Woo/Shopify JSON where available — and compare ticket_price, total_entries, draw_date, grand_prize in plain code; **only discrepancies reach Claude.** Slice sized for full live-set coverage every ~2 weeks (~half the catalogue per weekly run: ~280 rows today, ~1,000 at 2k scale — cheap, since fetching and diffing are deterministic). Corrections go through the existing `correctionDecision`/`CORRECT_LIVE` machinery; coverage % printed in tripwire.
- **Operator scoreboard:** per-operator live draws, 30-day scrape yield, rating, flagging PRUNE candidates (no live draws 60+ days — final prune decisions also require ~zero GSC impressions, checked in the curation sprint since cowork has no GSC creds) and ADD reminders (discovery queue). 
- **Tripwire report** gains: category distribution snapshot, moves made, drafts stuck awaiting classification, coverage %, scoreboard.

## 8. Self-improving loop (agent CI)

- New `.github/workflows/ci.yml`: `bun install && bun test` on every PR and push to main (16 existing test files currently run only by hand).
- `test/fixtures/regressions.json`: an append-only list of `{title, grand_prize, expected_category}` cases auto-loaded by `parse.test.mjs`. When an audit catches a wrong category, the cowork agent appends the case. Every mistake becomes permanent CI armor.

## 9. Self-healing operators (leashed)

- Trigger: an operator yields zero draws for **2 consecutive runs** (health report already detects this).
- Diagnose step in cowork: re-fetch, compare against the stored fixture snapshot, identify the drift class (markup change / Cloudflare / moved URL / plugin swap).
- **Config-level fixes** (URL, selector pattern in `operators.json`): applied automatically **only if** a live re-probe then passes the full gate; otherwise reported.
- **Code-level fixes:** a ready-to-review PR including the failing fixture. Nothing self-merges.

## 10. Operator onboarding at scale

Formalise `discovery/` + `probe.mjs` into one command: URL in → platform detection (Woo/Shopify/render) → generated `operators.json` entry → probe → fixture snapshot → gate dry-run → categorisation dry-run → verdict report. Human approves; entry commits. Scale maths: deterministic scraping is ~free per extra draw (1,760 draws = 42 min; 2,000+ stays well under the Action budget), and AI cost is per *new* draw only.

## 11. Opus budget architecture

Two tiers so subscription limits never pinch: daily-cheap (minutes: new unknowns + publish) and weekly-deep (the patrol, §7). All Claude calls batched (many draws per prompt). Decisions cached via `category_source` — nothing is ever judged twice. The GitHub Action stays keyless.

## 12. Adversarial verification ("agents managing agents", used where it prevents errors)

- **Runtime:** a live-row category write requires two independent agreements — rule evidence + Claude, or (when rules are silent) two Claude passes where the second sees the banner image. Still disagreeing → human queue in tripwire.
- **Build time:** the backfill worklist and the 94-operator pin audit run as parallel agent workflows — proposer agents classify, independent skeptic agents attempt to refute each decision before it's applied.
- Explicitly rejected: "tool poisoning" (a security attack, not a technique) and unsupervised self-modifying parsers. The self-extension in this system is fixtures, pins, and proposed-with-tests patches.

## 13. Testing

Every observed failure becomes a fixture in `test/parse.test.mjs` (+ `regressions.json`): Apple-vs-Samsung instant win ≠ cash · Cobra irons → sports-outdoors · Ogio bag → sports-outdoors (via pin) · Fruit Ninja ≠ tech · HOME SWEET ≠ house-draws · "£500 SITE CREDIT" → cash · hot tub → home-garden · trampoline → home-garden · gold bar → luxury · VW Golf → car-draws · motorbike → car-draws · e-bike → sports-outdoors. Policy tests: null evidence → null (never cash) · operator pin wins over keywords · Claude-slug validation rejects non-slugs · `category_source='claude'` rows immune to rule corrections. Existing 16 test files must stay green; CI enforces all of it from PR #1 of this program.

## 14. Rollout order & success criteria

1. **Site PR** (migration: 2 category rows + `category_source`; nav, covers, copy) → apply migration, deploy. *DB rows must exist before the aggregator can reference the slugs.*
2. **Aggregator PR 1:** CI workflow (tests green baseline).
3. **Aggregator PR 2:** classifier + policy + pins + backfill script + fixtures.
4. **Backfill run** (logged, revertible) → verify cash page + both new category pages on prod.
5. **PROMPT.md v4** — classification step + weekly patrol + scoreboard. *User action: paste v4 into the cowork routine task.*
6. **Watch one full weekly cycle.**

**Success =** zero rule-vs-stored contradictions on the live set; 50-row random sample manually verified 100% correct; no draw published with null `category_source`; CI green with all §13 fixtures; tripwire showing coverage % and scoreboard; the two screenshotted pages showing only what they claim.

**Risks:** cowork outage → unknowns accumulate as drafts (safe; tripwire counts them). New category pages launch thin-ish (50+/15+ draws — acceptable). Claude misclassification → adversarial pair + audit trail + human queue. Category moves change page counts Google has seen → correct content is the better trade; no URL changes involved.

## 15. Follow-up (next sprint, out of scope here)

Operator curation execution: prune rule = no live draws 60+ days AND ~zero GSC impressions 90 days → redirect to category (never bare 404); demand-first onboarding of missing searched-for UK operators (Raffle House, Elite Competitions, Click Competitions, + 9 queued approvals) ranked by brand + "is X legit" search volume via `pdd-seo-tools/serp.mjs`.
