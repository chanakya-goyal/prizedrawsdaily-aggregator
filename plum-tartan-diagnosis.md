# Tripwire diagnosis: plum-competitions & tartan-competitions-ltd

2026-08-22. Tripwire fired: "has N live draw(s) but has added nothing in 5d — parser may have broken" for both operators. Both sites verified alive/serving inventory. This diagnosis determines whether OUR pipeline actually broke.

---

## plum-competitions

### Config as-found (operators.json)
```json
{
  "name": "Plum Competitions",
  "slug": "plum-competitions",
  "base": "https://plumcompetitions.co.uk",
  "method": "woo"
}
```
No `patterns`, `selectors`, `maxLive`, or `fetcher` overrides.

### Redirect check (the task flagged this explicitly)
`https://plumcompetitions.co.uk` apex **does** 301→`https://www.plumcompetitions.co.uk` for HTML pages (confirmed via `curl -L`, 1 redirect). But the Woo Store API endpoint our scraper actually hits — `wooPageUrl()` builds `${op.base}/wp-json/wc/store/v1/products?...` — returns **HTTP 200 directly from the apex domain, zero redirects** (`x-wp-total: 883`, confirmed via `curl -I`). WordPress redirects the front-end but not `/wp-json/`. Per-product permalinks returned by the API are already `www.`-prefixed, so the per-product HTML fetch never redirects either. **Verdict: the redirect is a non-issue for this pipeline.**

### Probe output (`AUTO_PUBLISH=false ONLY=plum-competitions DRY_RUN=true bun run.mjs`)
```
loaded 8 cats, 99 operators, 3214 existing draws

── Plum Competitions (woo) ──
  🔄 #31 £100 Supermarket Gift Card — live row corrected: draw_date
  🔄 £5000 plums big catch #8 — live row corrected: draw_date
  🔄 gift card grab instant win #17 — live row corrected: draw_date
  ⏭  Ninja Winners choice or cash alternative — business: only 300 entries — non-standard draw
  ⏭  Ninja stay sharp knife set or £100 #10 — business: only 200 entries — non-standard draw
  ⏭  Tigerlily or £200 cash #4 — business: only 200 entries — non-standard draw
  ⏭  Cash wheel #11 — business: only 200 entries — non-standard draw
  ⏭  £50 Just Eat Voucher #12 — required: missing total_entries
  ⏭  £50 Worth of Scratch cards #60 — business: only 200 entries — non-standard draw
  ... (34 more ⏭ lines, all "business: only N entries — non-standard draw" except one more
       "required: missing total_entries" for £25 Site Credit #11)

==== 0 new, 3 refreshed, 3 live rows corrected (44 pages read, 41 skipped) ====
```
Full log: was captured to scratchpad during this session (not retained in repo).

### Root cause
The parser is **working**: it fetched 44 live products from the Woo Store API (apex `base`, no redirect problem), correctly re-verified 3 of Plum's 11 existing active rows (even correcting a stale `draw_date` on each — proof of live, functioning field extraction), and correctly parsed price/entries/date on the other 41 newly-seen products.

Of those 41, **39 were rejected by `businessGate`** for `total_entries < 500` (the site's "non-standard draw" floor for non-collectibles — see `gate.mjs`). Cross-checked against Supabase: every skipped title (`Ninja...`, `Winners Choice #5x`, `Green Larch lodge...`, `#48/49/51 butchers box...`, `£50 Worth of Scratch cards #5x`) is a genuinely new, never-before-seen product (none match Plum's 11 existing `entry_url`s) — so Plum **is** posting new competitions continuously (sequential numbering runs past #60), but essentially all of them are "instant win" format with 100–300 total entries, i.e. below the site's 500-entry "standard draw" bar. This is the business rule working exactly as designed, not a parser fault.

The remaining 2 (`£50 Just Eat Voucher #12`, `£25 Site Credit #11`) failed `requiredGate` on `missing total_entries`. Checked both directly: the Woo API's `stock_availability.text` is an **empty string** for these two products, and their rendered product pages contain no "sold/remaining/tickets/stock" text anywhere (confirmed via curl + grep) — the operator's own page genuinely does not expose a ticket-cap for these two specific listings. There is nothing for any regex to extract; this is missing source data, not a parsing bug. (Also moot: given the pattern of every other low-value product on this site, these two would almost certainly also fail the 500-entry business gate even if a count were parsed.)

### Verdict: **NOT-BROKEN — no new qualifying inventory**
The "added nothing in 5d" is real but correct: Plum's recent output is dominated by sub-500-entry instant-win products that the business gate is designed to exclude. Confirmed by directly cross-referencing Supabase (`created_at` on all 11 active rows ranges 2026-07-02 → 2026-08-09, consistent with "newest: 2026-08-09" in the tripwire scoreboard) against a fresh, successful scrape.

### Config change applied: **none** — no config or code change would alter this outcome; the gate is functioning as intended.

---

## tartan-competitions-ltd

### Config as-found (operators.json, before)
```json
{
  "name": "Tartan Competitions Ltd",
  "slug": "tartan-competitions-ltd",
  "base": "https://tartancompetitions.scot",
  "method": "woo"
}
```

### Redirect check
`https://tartancompetitions.scot` — both the homepage and the `/wp-json/wc/store/v1/products` endpoint return **HTTP 200 with zero redirects** (confirmed via `curl -I` and `curl -L`, `num_redirects: 0` either way). No redirect issue at all here.

### Probe output — BEFORE (`AUTO_PUBLISH=false ONLY=tartan-competitions-ltd DRY_RUN=true bun run.mjs`)
```
── Tartan Competitions Ltd (woo) ──
  ⏭  £1500 in the Bank! — required: missing total_entries

==== 0 new, 0 refreshed (8 pages read, 8 skipped) ====
```
(8 scraped = Tartan's Woo API currently offers 8 purchasable products in the lookback window; 7 matched existing active rows with nothing to correct — silent per run.mjs's logging rules — and 1 failed the required-fields gate.)

### Root cause (traced to source, reproduced in isolation)
Queried Supabase directly: Tartan has 8 `active` rows, newest `created_at` 2026-08-15 (matches tripwire). The one gate-failure, **`£1500 in the Bank!`** (product id 79578, permalink `/product/1500-in-the-bank/`), is **not** one of the 8 existing rows — confirmed via the operator's own Woo API (`tags: ["Recently Added"]`, image uploaded to `/wp-content/uploads/2026/08/`) that this is a genuinely brand-new competition. So Tartan **is** posting new inventory; the pipeline is dropping it.

Fetched the real product page and ran it through the actual `fieldsFromHtml`/`extractEntries` functions from `lib/parse.mjs` directly (not just the CLI) to pinpoint the exact failure:

- The product's own progress bar reads **`SOLD: 2/1200`** (2 tickets sold of a 1200 cap — it had just launched).
- `extractEntries`'s Tier-2 "progress bar" regex is `/\b([\d,]{2,})\s*\/\s*([\d,]{2,})\b/gi` (lib/parse.mjs:214) — note `{2,}` on **both** capture groups, i.e. it requires the SOLD (numerator) count to be **at least 2 digits**.
- `"2/1200"` has a 1-digit numerator, so the whole match fails — not just the numerator, the *entire* pattern — and `total_entries` resolves to `null`.
- Verified directly: `extractEntries("SOLD: 2/1200")` → `null`, `extractEntries("SOLD: 9/1200")` → `null`, `extractEntries("SOLD: 10/1200")` → `1200`. Also verified the *working* comparison case — `Low Odds £2000 in the Bank!` (an existing active row, `SOLD: 46/800`) — resolves correctly to `800` today for exactly this reason: 46 is 2 digits.

**This is a real, reproducible parser gap, and it is structural, not a one-off**: any brand-new competition on this operator is, almost by definition, first scraped while its sold-count is still single-digit (0–9) — precisely the moment it needs to be picked up as "new." That is a strong candidate root cause for "added nothing in 5d" recurring on this operator specifically.

### Fix
**Applied — config-only, in `operators.json`.** Added to the `tartan-competitions-ltd` entry:
```json
"selectors": { "entries": ".progress-sold" },
"patterns": { "entries": "\\d[\\d,]*\\s*/\\s*([\\d,]{2,})" }
```
- `selectors.entries` scopes extraction to the product's own `.progress-sold` element (verified: the page contains 7 `.progress-sold` elements — this product's own bar plus 6 from a "recently added" sidebar grid of other live comps — and cheerio's `.first()` reliably returns the product's *own* bar on both tested pages, since the current product's content always renders before the sidebar grid in document order).
- `patterns.entries` is the pre-existing per-operator override mechanism (`op.patterns.entries`, already used by "Podium Prize" elsewhere in this file) — it runs before any built-in tier and has no digit-count floor on the sold side, so `"2/1200"` now resolves to `1200`.
- Verified safety before applying: tested the same regex against the unscoped whole-page text of two different products (the new one and an existing working one) and confirmed the product's own `SOLD:` line is always first in document order, ahead of the sidebar grid — i.e. even without the selector this wouldn't have grabbed a neighbour's number, and with the selector it's fully isolated regardless.

### Probe output — AFTER
```
── Tartan Competitions Ltd (woo) ──
  ✅ £1500 in the Bank! | null | £2.5×1200  ⚠️→draft: no category evidence

==== 1 new, 0 refreshed (8 pages read, 7 skipped) ====
```
`£1500 in the Bank!` now parses `ticket_price: 2.50` and `total_entries: 1200` (both confirmed correct against the operator's own API: `price: "250"` minor-unit GBP, and page text "The maximum tickets for this competition is 1200"), passes `requiredGate` and `businessGate` (1200 ≥ 500), and is inserted as a **new** draw (held `draft` pending category classification — an unrelated, working part of the no-guess-publishing policy; category inference from the title alone is genuinely ambiguous here). Still `0 refreshed` and the other `7 skipped` unchanged from the BEFORE run — proof the fix is scoped to exactly the previously-broken row and does not perturb the 7 already-correct ones.

### Verdict: **BROKEN — fixed** (config-only workaround applied and proven; see below for the real underlying fix)

### Underlying code bug (not touched, per instructions — described precisely instead)
File: `lib/parse.mjs`, function `extractEntries`, Tier 2 (~lines 205–217):
```js
takeDenom(/\b([\d,]{2,})\s*\/\s*([\d,]{2,})\b/gi);
takeDenom(/\b([\d,]{2,})\s+(?:sold\s+)?(?:of|out of)\s+([\d,]{2,})\b/gi);
```
Both regexes require `{2,}` (2+ digits) on the **numerator** (sold-count) side, not just the denominator/cap side that actually matters. The fix is to relax the numerator-side quantifier to `{1,}` (or `\d+`) on both patterns, e.g.:
```js
takeDenom(/\b([\d,]{1,})\s*\/\s*([\d,]{2,})\b/gi);
takeDenom(/\b([\d,]{1,})\s+(?:sold\s+)?(?:of|out of)\s+([\d,]{2,})\b/gi);
```
This is a shared-code change (affects every operator using this fallback tier), so it needs a normal PR + review, not a one-operator config patch — the operators.json change above is a scoped stand-in for this one operator only. Worth a follow-up: other operators relying on this same Tier-2 fallback (i.e. no cleaner labelled cap available) likely have the same blind spot on their own freshly-launched comps.

---

## Summary

| operator | verdict | root cause | operators.json changed? |
|---|---|---|---|
| plum-competitions | NOT-BROKEN — no new qualifying inventory | New products are real but are all sub-500-entry "instant win" format; `businessGate`'s 500-entry floor correctly excludes them (by design). 2 unrelated products have no ticket-cap data anywhere on the source page/API — missing data, not a parse bug. | No |
| tartan-competitions-ltd | BROKEN — fixed (config-only) | `extractEntries` Tier-2 progress-bar regex requires a 2+ digit SOLD count; a brand-new comp scraped at 0–9 tickets sold (e.g. "SOLD: 2/1200") parsed `total_entries: null` and was dropped by `requiredGate` at exactly the moment it should have been added. | Yes — added `selectors.entries` + `patterns.entries` override; before/after probe proves the draw now parses, gates, and inserts as new. |
