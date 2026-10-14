# Free prize draws — design

Date: 2026-10-14 · Owner decisions taken in brainstorming the same day · Repos: `pdd-aggregator` (scraper) and `draw-discovery-hub` (site)

## Goal
List UK prize draws that are **truly free to enter** alongside paid ones, and give them a
dedicated landing page, `/free-prize-draws-uk`. This grows the live library, adds indexable
draw pages, and gives search and AI answers a checked list of free draws to cite.

Today the quality gate rejects every £0 draw outright (`businessGate`: "no/zero ticket price").
The last JSON sweep threw away 27 such draws, and Raffolux alone runs 17 a week once its
adapter lands.

## Decisions (owner, 2026-10-14)
1. **Truly free only.** No purchase, spend, subscription, membership or loyalty condition.
   Spend-to-qualify, subscriber-only, free instant wins and free spins are excluded.
2. **Same checks as paid draws, apart from the price:** ticket cap ≥500 (collectibles 50),
   fixed draw date within 35 days, photo, entry link. Every free draw therefore shows real
   odds (1 in cap).
3. **Shown everywhere with a Free badge** (/draws, categories, operator pages, ending-today),
   **plus** the dedicated page.
4. **Detection:** an automatic text check at scrape time, plus a double-check by the daily QA
   routine on the operator's page. No manual approval.
5. **Site-credit prizes count as free to enter** (owner, 2026-10-15), but every place that shows
   one must say the credit can only be spent with that operator (see 2.2).
6. **"Account required" and "answer a question" still count as free** (owner, 2026-10-15).
7. **A £0 draw the QA routine finds conditional is hidden permanently** (`rejected`), with no
   manual undo (owner, 2026-10-15).
8. **Split the header entry** into "Free Draws" and "Instant Wins" (owner, 2026-10-15).

## Part 1 — scraper (`pdd-aggregator`)

### 1.1 `lib/free.mjs` (new)
`freeCheck(draw) → { free: boolean, reason: string }`. It is pure and has no I/O.
- Applies only when `ticket_price === 0`.
- Reads `title`, `grand_prize` and `description`, plus `free_text` when the adapter supplies
  the operator's own product description (the Woo Store API `short_description` +
  `description`, Inertia/Raffolux description fields).
- **Rejects** on any condition phrase. It fails closed: in doubt, not free.
  - Spend or purchase: `spend £`, `spent`, `must have (spent|purchased|bought|entered a paid)`,
    `with any (order|purchase)`, `purchase required`, `when you buy`.
  - Membership: `subscriber`, `subscription`, `members? only`, `vip`, `loyalty`, `club members`,
    `active players only`, `points`.
  - Not a draw: `instant win`, `spin`, `spins`, `scratch`, `wheel`.
- **Allows** skill or entry wording that free UK prize draws normally use: `must answer`,
  `answer the question`, `one entry per person`, `account required`, `postal entry`.
- Returns the matched phrase as `reason` ("free but conditional: spend £").

Test fixtures are the real titles from the 2026-10-13 sweep and the agents' sightings.
- Pass: "FREE ENTRY – £1000 CASH FOR FREE!", "ABARTH 500 T-JET – FREE ENTRY! – MUST ANSWER…",
  "FREE TO ENTER – Milwaukee 7 Piece…", "Win £5 Cash - FREE" (Raffolux), "Free Draw - £30 Site Credit" (Ruby).
- Fail: "FREE ENTRY - WIN £100 | SPEND £1-£5+ AND…", "£200 Site Credit For Free! (Must Have Spent…)",
  "Jackpot Cash Subscriber Exclusive Instant…", "FREE INSTANT WIN COMP!", "Tuesday - 5 Daily Free Spins",
  "🆓 £200 Active Players Only!".

### 1.2 `gate.mjs` `businessGate`
- `ticket_price > 0` → unchanged.
- `ticket_price === 0` → passes the price rule only if `freeCheck(draw).free`. Otherwise the
  reason is `free but conditional: …`.
- Every other rule is unchanged and still applies to free draws.
- `ticket_price` missing (null) still fails in `requiredGate`. Free means a parsed £0, never
  an unread price.

### 1.3 Adapters supply `free_text`
- Woo: product `short_description` + `description`, as text, capped at 2,000 chars.
- Inertia, Raffolux and DrawHouse: their description field when present.
- Render: the product-summary text `fieldsFromHtml` already isolates.

`free_text` is used only by the free check and is never stored.

### 1.4 Publishing (unchanged)
Free draws insert as `draft` and publish only when a second scrape ≥18h later agrees. This
is the existing `lib/verify.mjs` path.

### 1.5 QA routine double-check (`manager/PROMPT.md`)
- **New rule:** for each £0 row (draft or active) not checked before, open the entry page once.
  If the page states a spend, purchase, subscription or membership condition, set
  `{"status":"rejected"}`.
- **Why `rejected` stays put:**
  - `lib/existing.mjs` loads every status in its identity read, so run.mjs never re-inserts that URL.
  - Relisting only revives `ended` rows.
  - Correction and the ended-sweep only touch `active`/`draft`.
  - The site's read policy exposes only `active` and `ended`, so `rejected` rows are hidden.
  - `draws.status` is plain `TEXT`, so no migration is needed.
- **Report:** the routine lists every rejection with the quoted condition in its step-5 report.

### 1.6 Verification
- Unit tests for `freeCheck` (the fixtures above) and for the gate's price branch.
- A/B dry run across all enabled operators, old vs new.
  - The only differences allowed are £0 rows moving from rejected to passing or conditional.
  - Every paid row must be byte-identical.

## Part 2 — site (`draw-discovery-hub`)

### 2.1 `/free-prize-draws-uk` (new route)
Modelled on `src/routes/instant-win-competitions-uk.tsx`.
- **Hero:** "Free prize draws in the UK", and the live count: "N free draws open today".
- **Grid:** live free draws (`status=active`, `ticket_price=0`), soonest first. Each card shows
  the odds "1 in {cap}" and the close time.
- **"How free entry works":** truly free draws vs the free postal route on paid draws (a
  short, accurate explainer, linking to the relevant guide).
- **FAQ:** mirrored verbatim into FAQPage JSON-LD. Two answers quote live inventory, like the
  instant-win page. Questions:
  - "Are free prize draws legit?"
  - "What is the easiest free draw to win?" (asked only when there is a live cap)
  - "Do free draws have worse odds?"
  - "Why do sites give away free draws?"
- **Schema:** CollectionPage + ItemList + BreadcrumbList.
- **Empty state:** "No free draws are open right now". Link to `/draws` sorted by lowest
  ticket price, and to the free postal route explainer. The page stays indexable.

### 2.2 Free badge
- `DrawCard` shows a "Free" badge when `Number(ticket_price) === 0`. It replaces the price line.
  The draw page, HomeSpotlight and ClosedDrawRow already handle £0.
- **Site-credit note:** when a free draw's prize is site credit (title or grand_prize matches
  `site credit`, `account credit` or `wallet credit`), the card, the draw page and the
  /free-prize-draws-uk grid show "Site credit: can only be spent at {operator name}". The
  helper `isSiteCredit(draw)` is shared, so the wording is identical everywhere.
- Check every list that renders `DrawCard`: /draws, category, operator, ending-today and new-competitions.

### 2.3 Links and discovery
- Header nav: today's entry is "Free & Instant Wins" → `/instant-win-competitions-uk`. Split it
  into two entries: "Free Draws" → `/free-prize-draws-uk` and "Instant Wins" →
  `/instant-win-competitions-uk`.
- Footer link, a homepage "Free draws today (N)" link (hidden when N = 0), sitemap entry,
  `edge-cache.ts` path list, and an IndexNow ping on deploy.

### 2.4 Verification
- SSR check with `curl` to a file + `grep -a`: the title, FAQPage and ItemList JSON-LD, and the badge.
- Validate the schema.
- Check in Safari (WebKit) at phone width.

## Order of delivery
1. Aggregator PR (Part 1). Free draws start arriving as drafts and publish about 18h later.
2. Site PR (Part 2), after the first free draws are live, so the page launches populated.

## Out of scope
- Conditional "free" draws (decision 1).
- Draws with missing details, such as no cap or no date. They are a separate brainstorm.
- Free instant wins and spins.
