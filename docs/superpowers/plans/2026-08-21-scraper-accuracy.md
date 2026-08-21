# Scraper Accuracy Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No draw ever publishes with a wrong or guessed category or prize facts: 8-category taxonomy, evidence-or-draft classification with Claude judging unknowns, live-set backfill, weekly patrol, and CI that turns every caught mistake into a permanent test.

**Architecture:** Deterministic scraper stays authoritative for facts; `lib/parse.mjs` classifies by operator pin → operator taxonomy → keyword evidence → **null** (cash fallback deleted). Null-category draws are held as drafts; the daily cowork Claude routine stamps one of the 8 slugs (`category_source='claude'`) and the existing two-observation gate publishes. A Sunday patrol (drift scan + prize-detail diff + operator scoreboard) feeds fixes and regression fixtures back into CI.

**Tech Stack:** Bun (aggregator: use `bun`, `bun test`, never node/npm — see repo CLAUDE.md), Supabase REST (PostgREST), GitHub Actions, TanStack Start + Vite (site repo `~/prizedrawsdaily`), vite-imagetools asset imports.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-21-scraper-accuracy-design.md`. Slugs exactly: `sports-outdoors` ("Sports & Outdoors"), `home-garden` ("Home & Garden"). Full slug set (8): `car-draws, cash-prizes, house-draws, tech-giveaways, luxury, collectibles, sports-outdoors, home-garden`.
- `category_source` values exactly: `'rule' | 'claude' | 'manual'` (nullable).
- **Order is load-bearing:** Site migration (Task 1) must be applied to prod before any aggregator code referencing the new slugs merges to main (the Action runs `main` daily at 07:00 UTC).
- Aggregator env for DB access: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `~/pdd-aggregator/.env`. Every REST call needs both `apikey:` and `Authorization: Bearer` headers.
- Site repo works via branch → PR (never commit to its main). Aggregator work also lands via PR. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Draw `status` is NEVER changed by anything in this plan. Only `category_id` / `category_source` (and test/report files) are written.
- The GitHub Action stays keyless — no AI calls in `run.mjs` or workflows.
- UK English in all user-facing site copy.

---

### Task 1: Site migration — 2 category rows + `category_source` column (repo `~/prizedrawsdaily`)

**Files:**
- Create: `~/prizedrawsdaily/supabase/migrations/20260821200000_sports_home_categories.sql`
- Branch: create `feat/sports-home-categories` off latest `main` (`git -C ~/prizedrawsdaily fetch origin && git checkout -b feat/sports-home-categories origin/main`)

**Interfaces:**
- Produces: DB rows `categories(slug='sports-outdoors')`, `categories(slug='home-garden')`; column `draws.category_source text` with CHECK. Tasks 5–13 depend on these existing in prod.

- [ ] **Step 1: Inspect the categories table shape** so the INSERT matches reality (description column may or may not exist):

```bash
export $(grep -E "^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)" ~/pdd-aggregator/.env | xargs)
curl -s "$SUPABASE_URL/rest/v1/categories?select=*&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Note which columns exist (expect at least `id, slug, name`; there may be `description`, `created_at`).

- [ ] **Step 2: Write the migration.** If `description` exists, include the description values shown; otherwise drop that column from the INSERT:

```sql
-- Adds the two new prize categories and the category provenance column.
-- sports-outdoors / home-garden: prizes that previously had no correct home
-- (golf gear, fishing, bikes / tools, garden furniture, trampolines, hot tubs)
-- and were falling into cash-prizes via the classifier fallback.
insert into public.categories (slug, name, description)
values
  ('sports-outdoors', 'Sports & Outdoors', 'Golf, fishing, bikes and outdoor-gear competitions from verified UK operators.'),
  ('home-garden', 'Home & Garden', 'Tool, furniture, garden and home-upgrade prize draws from verified UK operators.')
on conflict (slug) do nothing;

-- Who decided a draw's category: 'rule' (keyword/pin classifier, re-checkable),
-- 'claude' (judged once, never re-litigated), 'manual' (human, never touched).
alter table public.draws
  add column if not exists category_source text
  check (category_source in ('rule', 'claude', 'manual'));
```

- [ ] **Step 3: Apply to prod.** Read `~/prizedrawsdaily/CLAUDE.md` for the repo's documented migration method (it references `supabase link` / `db push`). Use it. If the CLI path is unusable, fall back to executing the SQL via `psql` with the pooler URL used by `~/pdd-migration` scripts (see `~/pdd-migration/set-new.sh` for the URL shape; credentials in that toolkit's env).

- [ ] **Step 4: Verify both changes live:**

```bash
curl -s "$SUPABASE_URL/rest/v1/categories?select=slug,name&order=slug" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect 8 rows including sports-outdoors + home-garden
curl -s "$SUPABASE_URL/rest/v1/draws?select=id,category_source&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect no 42703 error
```

- [ ] **Step 5: Commit** (branch only — the PR ships with Tasks 2–4):

```bash
git -C ~/prizedrawsdaily add supabase/migrations/20260821200000_sports_home_categories.sql
git -C ~/prizedrawsdaily commit -m "feat(db): sports-outdoors + home-garden categories, draws.category_source provenance column

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Site cover images for the two new categories

**Files:**
- Create: `~/prizedrawsdaily/src/assets/cover-sports-outdoors.jpg`, `~/prizedrawsdaily/src/assets/cover-home-garden.jpg`
- Modify: `~/prizedrawsdaily/src/lib/category-covers.ts`

**Interfaces:**
- Consumes: existing `PictureCover` import pattern in `category-covers.ts`.
- Produces: `getCategoryCover("sports-outdoors")` / `getCategoryCover("home-garden")` return real covers (not the generic fallback).

- [ ] **Step 1: Look at one existing cover** (`src/assets/cover-luxury.jpg`) with the Read tool to match style: dark, premium, cinematic single-subject hero, landscape ≥1920px wide.

- [ ] **Step 2: Generate two matching covers** with the Higgsfield image tool (`generate_image`, pick the recommended photoreal model via `models_explore` if unsure), then download the results to the exact asset paths. Prompts:

- sports-outdoors: "Cinematic dark premium hero photograph: a set of gleaming golf irons and a driver resting against a leather golf bag on dew-lit turf at dusk, dramatic rim lighting, deep shadows, dark moody background with warm golden accent light, no people, no text, landscape 16:9"
- home-garden: "Cinematic dark premium hero photograph: a modern garden terrace at dusk — glowing fire pit, rattan furniture silhouette, warm string lights against deep twilight shadows, dramatic moody lighting, no people, no text, landscape 16:9"

Convert/resize to JPEG ≥1920px wide if needed (`sips -s format jpeg -Z 1920 <in> --out <path>` works on macOS). Verify each file is a real JPEG >100KB: `file <path> && ls -la <path>`.

- [ ] **Step 3: Wire them into `category-covers.ts`** — add two imports and two MAP entries exactly matching the existing pattern:

```ts
import coverSports from "@/assets/cover-sports-outdoors.jpg?w=640;1024;1440;1920&format=webp&as=picture";
import coverHomeGarden from "@/assets/cover-home-garden.jpg?w=640;1024;1440;1920&format=webp&as=picture";
```

and inside `MAP`:

```ts
  "sports-outdoors": coverSports,
  "home-garden": coverHomeGarden,
```

- [ ] **Step 4: Verify the site builds:** `cd ~/prizedrawsdaily && npm run build` (this repo is npm/vite — do NOT use bun here). Expected: build completes, no unresolved-import errors.

- [ ] **Step 5: Commit:**

```bash
git -C ~/prizedrawsdaily add src/assets/cover-sports-outdoors.jpg src/assets/cover-home-garden.jpg src/lib/category-covers.ts
git -C ~/prizedrawsdaily commit -m "feat(site): cover images for Sports & Outdoors and Home & Garden

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Site nav, SEO copy, and internal links for the new categories

**Files:**
- Modify: `~/prizedrawsdaily/src/components/site/SiteHeader.tsx` (CATEGORIES array, ~line 18)
- Modify: `~/prizedrawsdaily/src/routes/__root.tsx` (NOT_FOUND_CATEGORIES array, ~line 34)
- Modify: `~/prizedrawsdaily/src/routes/category.$slug.tsx` (CATEGORY_SEO map ~line 20, and the operator-section-heading map — find it with `grep -n "Cash draw operators we review" src/routes/category.\$slug.tsx`)
- Check-and-touch-if-needed: `~/prizedrawsdaily/src/lib/related-links.ts`

**Interfaces:**
- Consumes: category slugs from Task 1.
- Produces: nav labels "Sports" and "Home & Garden"; CATEGORY_SEO entries for both slugs.

- [ ] **Step 1: Add to BOTH nav arrays** (`SiteHeader.tsx` CATEGORIES and `__root.tsx` NOT_FOUND_CATEGORIES) — append after collectibles, same shape:

```ts
  { slug: "sports-outdoors", label: "Sports" },
  { slug: "home-garden", label: "Home & Garden" },
```

("Home" alone would collide with "Houses" — use the full label.)

- [ ] **Step 2: Add CATEGORY_SEO entries** in `category.$slug.tsx`:

```ts
  "sports-outdoors": {
    h1: "Win Sports & Outdoor Prizes in the UK",
    title: "Golf & Sports Competitions UK: Clubs, Bikes & Gear | PrizeDrawsDaily",
    description:
      "Win golf clubs, bikes and outdoor gear in the UK — live sports competitions and prize draws from verified operators, with odds, ticket prices and countdowns. Updated daily.",
  },
  "home-garden": {
    h1: "Win Home & Garden Prizes in the UK",
    title: "Home & Garden Competitions UK: Tools, Hot Tubs & More | PrizeDrawsDaily",
    description:
      "Win tools, garden furniture, hot tubs and home upgrades in the UK — live prize draws from verified operators, with odds and countdowns. Updated daily.",
  },
```

- [ ] **Step 3: Add operator-section headings** in the same file's heading map (found via the grep above), matching its existing string style:

```ts
    "sports-outdoors": "Golf and sports draw operators we review",
    "home-garden": "Home and garden draw operators we review",
```

- [ ] **Step 4: Luxury copy sanity.** `grep -rn "golf\|fishing\|hot tub" ~/prizedrawsdaily/src/routes/category.\$slug.tsx ~/prizedrawsdaily/src/lib/related-links.ts` — if Luxury copy mentions golf/fishing/hot tubs, reword those phrases to watches/holidays/jewellery. If nothing matches, no change. In `related-links.ts`, only add links if a genuinely matching guide list exists (e.g. a golf guide) — otherwise leave it; do not force links.

- [ ] **Step 5: Build + typecheck:** `cd ~/prizedrawsdaily && npm run build`. Expected: clean.

- [ ] **Step 6: Commit:**

```bash
git -C ~/prizedrawsdaily add -A src/
git -C ~/prizedrawsdaily commit -m "feat(site): Sports & Outdoors + Home & Garden — nav, SEO copy, operator headings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Site PR → merge → prod verification

- [ ] **Step 1: Push + open PR:**

```bash
git -C ~/prizedrawsdaily push -u origin feat/sports-home-categories
cd ~/prizedrawsdaily && gh pr create --title "Sports & Outdoors + Home & Garden categories" --body "$(cat <<'EOF'
Adds the two categories that give golf gear, tools, trampolines etc. a real home (they currently pollute Cash Prizes — see docs in pdd-aggregator spec 2026-08-21). Migration (already applied to prod): 2 categories rows + draws.category_source provenance column. Site: nav, covers, SEO copy, operator headings.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Merge** (`gh pr merge --squash --delete-branch`) and wait for the Vercel deploy to go green (`gh run list` / check the deployment status on the PR).

- [ ] **Step 3: Verify prod:** `curl -s -o /dev/null -w "%{http_code}" https://prizedrawsdaily.co.uk/category/sports-outdoors` → 200; same for `/category/home-garden` → 200. Pages will be near-empty until the backfill (Task 12) — that's expected; confirm the hero renders the right H1 by fetching the page and grepping for "Win Sports".

---

### Task 5: Aggregator CI workflow (tests on every PR/push)

**Files:**
- Create: `~/pdd-aggregator/.github/workflows/ci.yml`
- Branch: `git -C ~/pdd-aggregator checkout -b feat/scraper-accuracy origin/main` (single branch for Tasks 5–11; one PR at the end keeps the Action on main untouched until everything is green together)

**Interfaces:**
- Produces: CI job named `test` that later tasks' pushes will exercise.

- [ ] **Step 1: Confirm the suite is green locally first:** `cd ~/pdd-aggregator && bun test 2>&1 | tail -5`. Expected: all pass. If anything fails on main, STOP and report — do not build on a red base.

- [ ] **Step 2: Write `.github/workflows/ci.yml`:**

```yaml
name: CI

# Every push and PR runs the full bun test suite. The self-improving loop
# depends on this: audit-caught mistakes append fixtures to
# test/fixtures/regressions.json, and this job is what makes them permanent.
on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
```

- [ ] **Step 3: Commit:**

```bash
git -C ~/pdd-aggregator add .github/workflows/ci.yml
git -C ~/pdd-aggregator commit -m "ci: run bun test on every push and PR (agent-CI backbone for regression fixtures)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Classifier overhaul in `lib/parse.mjs` (TDD)

**Files:**
- Modify: `~/pdd-aggregator/lib/parse.mjs` (lines ~9 CATEGORIES, ~313–360 CAT_RULES/categoryEvidence/inferCategory/OP_CAT_MAP, ~625 resolveCategory)
- Create: `~/pdd-aggregator/test/fixtures/regressions.json`
- Modify: `~/pdd-aggregator/test/parse.test.mjs` (append new describe blocks)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CATEGORIES` (8 slugs); `inferCategory(input) → slug | null` (NO cash fallback); `categoryEvidence` unchanged signature; `mapOperatorCategory(names) → slug | null`; `resolveCategory({op, title, grand_prize, url, apiCategories}) → slug | null`. Tasks 8–11 rely on the null contract.

- [ ] **Step 1: Write the failing tests** — append to `test/parse.test.mjs`:

```js
describe("category — mechanics are not evidence, fallback is dead", () => {
  const cases = [
    // instant win is a MECHANIC — product instant-wins must not read as cash
    ["Apple Vs Samsung - Tech Instant Win - 60,000 Instant Prizes", null],
    ["Dart Mystery Box Instant Win", null],
    // genuine cash vocabulary that used to fall through
    ["£500 SITE CREDIT!#26", "cash-prizes"],
    ["GGUK £250 Store Credit + Instant Wins #89", "cash-prizes"],
    ["Win £2,000 Tax Free Cash", "cash-prizes"],
    ["£1,000 Bank Transfer Friday", "cash-prizes"],
    // sports-outdoors long tail (from the live wrong-category audit)
    ["SATURDAY SALE AUTO-DRAW: WIN A SET OF COBRA RAD-S IRONS! #3", "sports-outdoors"],
    ["WIN A CUSTOM FIT SET OF PXG IRONS #2", "sports-outdoors"],
    ["AUTO-DRAW: WIN A J LINDEBERG FLARE STAND BAG! #13", "sports-outdoors"],
    ["AUTO DRAW: WIN A SHOT SCOPE H50 HANDHELD GPS DEVICE! #1", "sports-outdoors"],
    ["Win a Trout Fishing Weekend with all Tackle", "sports-outdoors"],
    ["Specialized Rockhopper Mountain Bike", "sports-outdoors"],
    ["Win an E-Bike worth £2,000", "sports-outdoors"],
    // home-garden long tail
    ["Win This Sealey Topchest 5 Drawer & 230pc Tool Kit for just 1p!", "home-garden"],
    ["Trampoline & Enclosure", "home-garden"],
    ["Lay-Z-Spa Miami Hot Tub", "home-garden"],
    ["Ooni Koda 16 Pizza Oven Bundle", "home-garden"],
    ["Rattan Garden Corner Sofa Set", "home-garden"],
    // luxury keeps richness, gains bullion
    ["Win A 5g Gold Bar for Just 3p!", "luxury"],
    ["Rolex Datejust 41", "luxury"],
    ["5* Maldives Holiday for Two", "luxury"],
    // trap guards
    ["Fruit Ninja", null],                       // Ninja the game ≠ Ninja appliances
    ["Ninja Woodfire Electric BBQ", "tech-giveaways"], // appliance context present
    ["HOME SWEET INSTANT WINS – £250 MAIN PRIZE", null], // no property context
    ["Win a 4-Bed House in Cheshire worth £450,000", "house-draws"],
    ["VW Golf GTI Clubsport", "car-draws"],      // car tested before sports
    ["Yamaha MT-07 Motorbike", "car-draws"],
    ["Van Gogh Print Set", null],
    // silence is null, not cash
    ["Mando's Jungle Leaderboard", null],
    ["🫧 Bubble Blast", null],
  ];
  for (const [title, expected] of cases) {
    test(`"${title}" → ${expected}`, () => expect(inferCategory({ title })).toBe(expected));
  }
});

describe("operator taxonomy map — 8 slugs", () => {
  test("Golf label → sports-outdoors", () => expect(mapOperatorCategory(["Golf"])).toBe("sports-outdoors"));
  test("Tools label → home-garden", () => expect(mapOperatorCategory(["Power Tools"])).toBe("home-garden"));
  test("generic label → null", () => expect(mapOperatorCategory(["Auto Draw", "Competitions"])).toBe(null));
});

describe("regression fixtures (auto-appended by audits)", () => {
  const regs = JSON.parse(require("fs").readFileSync(new URL("./fixtures/regressions.json", import.meta.url), "utf8"));
  test("fixture file is a non-empty array", () => expect(Array.isArray(regs) && regs.length > 0).toBe(true));
  for (const r of regs) {
    test(`[reg] "${r.title}" → ${r.expected_category}`, () =>
      expect(inferCategory({ title: r.title, grand_prize: r.grand_prize })).toBe(r.expected_category));
  }
});
```

(Adjust the `require("fs")` to `import { readFileSync } from "fs"` at the top of the file if the test file is pure ESM — it is `.mjs`, so use the import form.)

- [ ] **Step 2: Seed `test/fixtures/regressions.json`** with the observed live mistakes (this is the file audits append to later):

```json
[
  { "title": "AUTO-DRAW: WIN AN OGIO FUNDAY CARRY BAG #5", "grand_prize": null, "expected_category": "sports-outdoors", "found": "2026-08-21 live audit: was cash-prizes via fallback" },
  { "title": "SHOES QUICK DRAW INSTANT WIN COMPETITION! 350 INSTANT WINS OF A PAIR OF GOLF SHOES TO BE WON!", "grand_prize": null, "expected_category": "sports-outdoors", "found": "2026-08-21: 'instant win' read as cash" },
  { "title": "WIN A WINNER’S CHOICE CUSTOM FIT SET OF WEDGES #93", "grand_prize": null, "expected_category": "sports-outdoors", "found": "2026-08-21 live audit" },
  { "title": "SATURDAY SALE AUTO-DRAW: WIN A COBRA RAD-S DRIVER! #5", "grand_prize": null, "expected_category": "sports-outdoors", "found": "2026-08-21 live audit" },
  { "title": "£100 site credit for 1p #77", "grand_prize": null, "expected_category": "cash-prizes", "found": "2026-08-21: fell through to fallback" },
  { "title": "£75 SITE CREDIT!", "grand_prize": null, "expected_category": "cash-prizes", "found": "2026-08-21 live audit" },
  { "title": "HOME SWEET INSTANT WINS – £250 MAIN PRIZE", "grand_prize": null, "expected_category": null, "found": "2026-08-21: 'home' false-positived house-draws" },
  { "title": "Fruit Ninja", "grand_prize": null, "expected_category": null, "found": "2026-08-21: 'ninja' false-positived tech" },
  { "title": "🥷 Rendalls Ninja Instant Win – Over £4,000 in Cash Prizes!", "grand_prize": null, "expected_category": "cash-prizes", "found": "2026-08-21: cash prizes named; ninja must not force tech" },
  { "title": "Big BBQ Feast Package from Tunstall Meat company! serves 10!", "grand_prize": null, "expected_category": null, "found": "2026-08-21: food package — Claude territory, must not be cash" }
]
```

- [ ] **Step 3: Run to verify they fail:** `bun test test/parse.test.mjs 2>&1 | tail -15`. Expected: the new blocks fail (fallback still returns "cash-prizes", sports-outdoors unknown), pre-existing tests still pass.

- [ ] **Step 4: Implement in `lib/parse.mjs`.** Precise edits:

4a. Line ~9: `export const CATEGORIES = ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury", "collectibles", "sports-outdoors", "home-garden"];`

4b. Replace the whole `CAT_RULES` array with (order: collectibles → house → car → sports → home-garden → tech → luxury → cash; car BEFORE sports so "VW Golf"/"Golf GTI" stay cars, then bare `golf` is safely sports):

```js
const CAT_RULES = [
  // Collectibles FIRST so "LEGO Technic Ferrari" / "Pokémon Charizard" don't fall into car/luxury.
  ["collectibles", /\b(lego|warhammer|age of sigmar|sigmar|slaanesh|nighthaunt|stormcast|astra militarum|space marines?|necrons?|tyranids?|aeldari|horus heresy|kill team|games workshop|citadel|gundam|airfix|model kit|pok[eé]mon|pikachu|charizard|tcg|trading cards?|lorcana|magic the gathering|\bmtg\b|yu-?gi-?oh|funko|graded|psa ?10|gem ?mint|holo|slab|miniature|collectible|memorabilia|signed (?:shirt|jersey|boots?|glove))\b/i],
  // House needs PROPERTY context — bare "home"/"house" false-positived marketing titles
  // ("HOME SWEET INSTANT WINS"). A real house draw names the asset or its worth.
  ["house-draws", /\b(house draws?|(?:win|won) (?:a|this|your(?: own)?|our) (?:house|home|flat|apartment|bungalow|cottage)|dream home|mortgage[- ]?free|property (?:draw|raffle|competition)|(?:house|home|flat|apartment|villa|bungalow|cottage) (?:worth|valued)|holiday home)\b/i],
  // Cars BEFORE sports so VW Golf / Golf GTI / Golf R resolve as cars; bare "golf" (below) is then gear.
  // "bike" bare is gone — motorbikes stay here, pedal bikes are sports-outdoors.
  ["car-draws", /\b(cars?|bmw|audi|mercedes|merc|amg|porsche|ford|focus|fiesta|vw|volkswagen|(?:vw|volkswagen)\s+golf|golf\s+(?:gti|gtd|gte|r\b)|polo|scirocco|gti|gtr|m2|m3|m4|m5|rs\d|a45|c63|motorbike|motorcycle|moped|van\b|campervan|vehicle|supercar|hypercar|tesla|lamborghini|lambo|ferrari|range\s?rover|land\s?rover|defender|peugeot|vauxhall|corsa|astra|insignia|nissan|skyline|toyota|supra|yaris|honda|civic|jaguar|mini cooper|seat|skoda|renault|fiat|kia|hyundai|mazda|subaru|impreza|bentley|aston\s?martin|mclaren|maserati|jeep|suzuki|yamaha|kawasaki|ducati|volvo|bugatti|rolls\s?royce)\b/i],
  // Sports & Outdoors: the golf/fishing/bike/fitness long tail that used to hit the cash fallback.
  ["sports-outdoors", /\b(golf|taylormade|callaway|titleist|mizuno|srixon|powakaddy|motocaddy|odyssey|scotty cameron|shot ?scope|pxg|ogio|j ?lindeberg|footjoy|garmin approach|(?:set of |custom fit )?(?:irons|wedges?)|putters?|fairway woods?|stand bag|cart bag|rangefinder|fishing|tackle|carp|angling|rod and reel|e-?bike|e-?scooter|electric scooter|(?:mountain|road|gravel|hybrid) bike|bicycle|cycling|peloton|treadmill|dumbbells?|kettlebells?|home gym|paddle ?board|kayak|wetsuit|tent|camping)\b/i],
  // Home & Garden: tools, furniture, garden. Hot tubs move here from luxury.
  ["home-garden", /\b(dewalt|makita|milwaukee|sealey|snap-?on|ryobi|einhell|k[aä]rcher|erbauer|halfords advanced|tool ?(?:kit|chest|box|set)|toolbox|topchest|impact (?:driver|wrench)|angle grinder|welder|socket set|cordless drill|workbench|rattan|garden furniture|egg chair|patio|gazebo|pergola|trampoline|lawn ?mower|strimmer|hedge trimmer|leaf blower|pressure washer|jet wash|pizza oven|ooni|gozney|bbq|barbecue|kamado|smoker\b|log burner|chimenea|fire pit|hot ?tub|lay-?z-?spa|jacuzzi|shed\b|greenhouse|log cabin|summerhouse|(?:corner |garden )?sofa|dining (?:set|table)|mattress|air ?con)\b/i],
  // Tech BEFORE luxury so "Apple Watch"/"Garmin watch" read tech, not luxury's bare "watch".
  // Ninja/Shark need appliance context — "Fruit Ninja" is a game, not an air fryer.
  // e-bikes/e-scooters moved to sports-outdoors.
  ["tech-giveaways", /\b(iphone|ipad|macbook|imac|apple ?watch|apple|laptop|notebook|ps5|ps4|playstation|xbox|nintendo|switch\b|console|oled|qled|gpu|rtx|graphics card|gaming pc|airpods|samsung galaxy|galaxy s\d|samsung|google pixel|smartphone|tablet|drone|gadget|dyson|vacuum|hoover|air ?fryer|ninja (?:air ?fryer|foodi|blender|kitchen|dual ?zone|double stack|woodfire|creami|slushi|speedi)|shark (?:vacuum|hoover|flexstyle|steam|cordless|stratos)|kitchenaid|nespresso|coffee machine|fridge|freezer|washing machine|dishwasher|microwave|soundbar|speaker|headphones|earbuds|monitor|smartwatch|garmin|fitbit|gopro|projector|robot vacuum|alexa|echo dot|smart home|smart tv|\btv\b)\b/i],
  // Luxury = genuine richness: watches, jewellery, designer, drinks, travel, bullion.
  ["luxury", /\b(rolex|omega|tudor|breitling|tag ?heuer|cartier|watch|jewellery|jewelry|diamond|designer|holiday|getaway|cruise|spa (?:day|break|weekend)|champagne|prosecco|whisky|whiskey|cognac|perfume|aftershave|fragrance|sunglasses|ray-?ban|handbag|chanel|louis vuitton|gucci|prada|dior|burberry|hermes|mulberry|gold bars?|bullion|krugerrand|sovereign coin)\b/i],
  // Cash: prizes that ARE money. "instant win"/"jackpot spins" are mechanics, not prizes —
  // "instant win" is deliberately absent. Site/store credit and bank transfer are money.
  ["cash-prizes", /\b(cash|money|jackpot|tax[- ]?free|(?:site|store|account) ?credit|bank transfer|gift ?card|voucher|e-?gift|pay ?day|paypal)\b/i],
];
```

4c. `inferCategory` loses the fallback:

```js
// null = "no evidence" — the caller decides what that means (hold as draft; Claude judges).
// The old `?? "cash-prizes"` fallback is what filled the Cash page with golf bags.
export function inferCategory(input = {}) {
  return categoryEvidence(input);
}
```

4d. Replace `OP_CAT_MAP` (operator-label map) so golf/tools/outdoors map to the new homes:

```js
const OP_CAT_MAP = [
  ["collectibles", /\b(warhammer|age of sigmar|sigmar|astra militarum|space marines?|necrons?|tyranids?|horus heresy|kill team|games workshop|citadel|lego|pok[eé]mon|trading cards?|lorcana|magic the gathering|\bmtg\b|yu-?gi-?oh|one piece|funko|tcg|collectibles?|model kits?|airbrush(?:es)?|miniatures?|memorabilia)\b/i],
  ["sports-outdoors", /\b(golf|fishing|angling|bikes?|cycling|e-?bikes?|fitness|gym|sports?|outdoors?|camping)\b/i],
  ["home-garden", /\b(tools?|diy|garden(?:ing)?|home (?:&|and) garden|furniture|hot ?tubs?|bbqs?|barbecues?)\b/i],
  ["tech-giveaways", /\b(tech|electronics?|gaming|consoles?|computers?|laptops?|phones?|mobiles?|gadgets?|appliances?|smart home)\b/i],
  ["car-draws", /\b(cars?|vehicles?|motorbikes?|motorcycles?|automotive)\b/i],
  ["house-draws", /\b(house draws?|houses?|propert(?:y|ies)|real estate)\b/i],
  ["luxury", /\b(luxury|watch(?:es)?|jewell?ery|holidays?|travel|spa days?|designer|bullion)\b/i],
  ["cash-prizes", /\b(cash|money|instant ?wins?|site credit|vouchers?|gift ?cards?|jackpot)\b/i],
];
```

(NOTE: `instant wins` stays in the OPERATOR map's cash row on purpose — as an operator *shelf label* it genuinely means cash-style instant draws, and `resolveCategory` already refuses to let a cash-bucket operator label override title evidence. `homes?` was removed from the house row — a "Home" shelf on a garden operator is not a property raffle.)

4e. `resolveCategory` — same precedence, null-safe end:

```js
export function resolveCategory({ op = {}, title, grand_prize, url, apiCategories }) {
  const opCat = mapOperatorCategory(apiCategories);
  const inferred = inferCategory({ title, grand_prize, url });
  return op.category
    || (opCat && opCat !== "cash-prizes" ? opCat : null)
    || inferred
    || opCat            // a cash-bucket operator label, with no title evidence against it
    || null;            // no evidence anywhere → caller holds as draft
}
```

- [ ] **Step 5: Run the full suite:** `bun test 2>&1 | tail -8`. Expected: ALL green — new blocks pass AND every pre-existing test passes. Pre-existing tests that asserted the cash fallback (`inferCategory → "cash-prizes"` for unmatched input) must be UPDATED to expect `null` — check `grep -n "cash-prizes" test/parse.test.mjs test/fixtures.test.mjs test/adapters.test.mjs` and fix ONLY assertions that encoded the old fallback; any other failure means the implementation is wrong, not the test.

- [ ] **Step 6: Commit:**

```bash
git -C ~/pdd-aggregator add lib/parse.mjs test/parse.test.mjs test/fixtures/regressions.json
git -C ~/pdd-aggregator commit -m "feat(classifier): 8 categories, cash fallback deleted, mechanic words demoted, trap guards + regression fixture net

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Operator category pins in `operators.json`

**Files:**
- Modify: `~/pdd-aggregator/operators.json`
- Test: `~/pdd-aggregator/test/parse.test.mjs` (one describe block)

**Interfaces:**
- Consumes: `resolveCategory` (Task 6) — `op.category` wins over everything.
- Produces: `category` field on single-vertical operators.

- [ ] **Step 1: Build the evidence table.** For each of the 94 operators, compute the live distribution of what their ACTIVE draws would classify as under the NEW rules:

```bash
cd ~/pdd-aggregator && export $(grep -E "^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)" .env | xargs)
bun -e '
import { inferCategory } from "./lib/parse.mjs";
const h = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
const rows = await (await fetch(`${process.env.SUPABASE_URL}/rest/v1/draws?select=title,grand_prize,operators(slug)&status=eq.active&limit=3000`, { headers: h })).json();
const per = {};
for (const r of rows) {
  const s = r.operators?.slug; if (!s) continue;
  (per[s] ??= {}); const c = inferCategory({ title: r.title, grand_prize: r.grand_prize }) ?? "NULL";
  per[s][c] = (per[s][c] || 0) + 1;
}
for (const [s, d] of Object.entries(per).sort()) console.log(s, JSON.stringify(d));
'
```

- [ ] **Step 2: Pin ONLY true single-verticals.** Criteria: ≥90% of that operator's classifiable draws land in one category AND the operator's name/site confirms the vertical (a golf shop, a Warhammer shop). Known day-one pin: `golf-star-competitions` → `"category": "sports-outdoors"`. Expected candidates from names (verify with the table before pinning): Waffle Competitions (collectibles — retired LEGO sets), Gaming Giveaways (tech), Cosmetic Competitions (NOT pinnable if mixed — check). When in doubt, DON'T pin — the Claude layer handles mixed operators. Add the key to each pinned operator's JSON object: `"category": "<slug>"`.

- [ ] **Step 3: Test — pins are valid slugs** (append to `test/parse.test.mjs`):

```js
describe("operators.json category pins", () => {
  const ops = JSON.parse(readFileSync(new URL("../operators.json", import.meta.url), "utf8"));
  const list = Array.isArray(ops) ? ops : ops.operators;
  for (const o of list.filter((o) => o.category)) {
    test(`${o.slug} pin '${o.category}' is a real slug`, () => expect(CATEGORIES.includes(o.category)).toBe(true));
  }
  test("golf-star-competitions is pinned sports-outdoors", () => {
    expect(list.find((o) => o.slug === "golf-star-competitions")?.category).toBe("sports-outdoors");
  });
});
```

(Import `CATEGORIES` in the test file's existing import from `../lib/parse.mjs`.)

- [ ] **Step 4: Run:** `bun test test/parse.test.mjs 2>&1 | tail -5` → green. **Step 5: Commit** (`feat(operators): category pins for single-vertical operators`, same trailer).

---

### Task 8: Publish policy — null category holds; stamped categories survive refresh

**Files:**
- Modify: `~/pdd-aggregator/lib/manager.mjs` (`fieldFlags`)
- Modify: `~/pdd-aggregator/lib/verify.mjs` (read first; thread stored-category awareness)
- Modify: `~/pdd-aggregator/run.mjs` (insert / draft-refresh / relist / live-correct paths)
- Test: `~/pdd-aggregator/test/manager.test.mjs`, `~/pdd-aggregator/test/verify.test.mjs`

**Interfaces:**
- Consumes: `inferCategory` null contract (Task 6).
- Produces: flag string exactly `"no category evidence"`; run.mjs writes `category_source` on rows it categorises; a Claude-stamped draft (category set in DB, fresh scrape resolves null) still publishes.

- [ ] **Step 1: Failing tests.** In `test/manager.test.mjs`:

```js
describe("fieldFlags — category policy", () => {
  const base = { ticket_price: 1, total_entries: 1000, image_url: "https://x.com/i.jpg", entry_url: "https://x.com/d", description: "A perfectly reasonable description here.", title: "Some Mystery Prize Draw" };
  test("null category → 'no category evidence' flag (draft-holding)", () => {
    expect(fieldFlags({ ...base, category: null })).toContain("no category evidence");
  });
  test("stored category neutralises the null flag", () => {
    expect(fieldFlags({ ...base, category: null }, { hasStoredCategory: true })).not.toContain("no category evidence");
  });
  test("valid category → no category flags", () => {
    const flags = fieldFlags({ ...base, category: "sports-outdoors", title: "Win a set of Cobra irons" });
    expect(flags.filter((f) => /category/.test(f))).toEqual([]);
  });
});
```

In `test/verify.test.mjs` add (mirror the file's existing helper style for building `ex`/`d` pairs — read the file first):

```js
test("draft with DB category but null fresh category still publishes (Claude-stamped draft)", () => {
  // build an ex/d pair that passes every other check; d.category = null; ex.category_id = "some-uuid"
  const v = verifyAgainstStored({ ...storedFixture, category_id: "11111111-1111-1111-1111-111111111111" }, { ...freshFixture, category: null }, { now, imageOk: true });
  expect(v.publish).toBe(true);
});
```

- [ ] **Step 2: Run — confirm both fail** (`bun test test/manager.test.mjs test/verify.test.mjs 2>&1 | tail -6`).

- [ ] **Step 3: Implement.**

3a. `lib/manager.mjs` — `fieldFlags(draw, opts = {})`:

```js
export function fieldFlags(draw, { hasStoredCategory = false } = {}) {
  ...existing checks...
  // No evidence is a publishing blocker (Claude will judge it), but a category already
  // stamped on the stored row (claude/manual/backfill) satisfies the requirement — a fresh
  // scrape being unable to RE-derive it is expected and must not re-hold the draw forever.
  if (!draw.category && !hasStoredCategory) flags.push("no category evidence");
  ...
}
```

3b. `lib/verify.mjs` — READ THE FILE FIRST. Where `verifyAgainstStored(ex, d, opts)` computes `fieldFlags(d)`, change to `fieldFlags(d, { hasStoredCategory: !!ex.category_id })`. If `review()` in manager.mjs also calls fieldFlags, leave its call sites as-is (no stored row in that context).

3c. `run.mjs` — four spots (find them by the comments quoted in this plan's spec §1; they are in the `for (const raw of draws)` loop):

- **Insert path** (`toInsert.push`): add `category_source: catMap[d.category] ? "rule" : null,` next to `category_id`.
- **Draft-refresh path** (the `toUpdate.push` after `verifyAgainstStored`): replace `category_id: catMap[d.category] || null,` with:

```js
        // Never blank a stamped category with a fresh null read — a Claude/manual decision
        // must survive every subsequent scrape (undefined keys vanish in JSON.stringify).
        category_id: catMap[d.category] || undefined,
        category_source: catMap[d.category] ? "rule" : undefined,
```

  …but ONLY overwrite `category_source` when the stored source isn't `claude`/`manual`. The `ex` rows come from the big draws fetch near the top of run.mjs — confirm it selects `category_id` and `category_source` (add both to the `select=` if absent). Guard:

```js
        category_source: catMap[d.category] && !["claude", "manual"].includes(ex.category_source) ? "rule" : undefined,
```

  and likewise only send `category_id` when it would not fight a claude/manual stamp:

```js
        category_id: catMap[d.category] && !["claude", "manual"].includes(ex.category_source) ? catMap[d.category] : undefined,
```

- **Relist path** (`status: "draft"` revive block): same two-line treatment as draft-refresh.
- **Live-correction path**: it already guards with `if (catMap[d.category]) row.category_id = ...` — extend the guard to `if (catMap[d.category] && !["claude", "manual"].includes(ex.category_source))` and set `row.category_source = "rule"` inside it.
- **Publish candidacy**: where `const candidate = AUTO_PUBLISH && verdict.publish;` — verdict now already accounts for stored category via 3b; no extra condition needed. Verify by reading the line.

- [ ] **Step 4: Full suite green:** `bun test 2>&1 | tail -5`. Fix any pre-existing fixture that constructed draws relying on the cash fallback (same rule as Task 6 Step 5: only assertions encoding old policy may change).

- [ ] **Step 5: Dry-run one operator end-to-end as a smoke test** (no writes): `cd ~/pdd-aggregator && DRY_RUN=true AUTO_PUBLISH=false ONLY=golf-star-competitions METHODS=woo bun run.mjs 2>&1 | tail -25`. Expected: draws print with `| sports-outdoors |` (pin working) and no crash.

- [ ] **Step 6: Commit** (`feat(policy): no-guess publishing — null category holds as draft, stamped categories survive refresh`, trailer).

---

### Task 9: `backfill-categories.mjs`

**Files:**
- Create: `~/pdd-aggregator/backfill-categories.mjs`
- Test: `~/pdd-aggregator/test/backfill-categories.test.mjs` (decision function only)

**Interfaces:**
- Consumes: `resolveCategory`/`inferCategory` (Task 6), operators.json pins (Task 7).
- Produces: CLI with `MODE=rules|export|apply`; exports `decideRuleFix(draw, opsBySlug, catBySlug)` for tests; log file `backfill-log-<ISO>.json`; worklist `backfill-unknowns.json`; decisions input `backfill-decisions.json`.

- [ ] **Step 1: Failing test** (`test/backfill-categories.test.mjs`):

```js
import { test, expect, describe } from "bun:test";
import { decideRuleFix } from "../backfill-categories.mjs";

const cats = { "cash-prizes": "c1", "sports-outdoors": "c2", "luxury": "c3" };
const ops = { "golf-star-competitions": { slug: "golf-star-competitions", category: "sports-outdoors" }, "plain-op": { slug: "plain-op" } };
const mk = (o) => ({ id: "d1", title: "x", grand_prize: null, entry_url: "https://x/y", status: "active", category_slug: "cash-prizes", category_source: null, op_slug: "plain-op", ...o });

describe("decideRuleFix", () => {
  test("pin overrides everything → fix", () => {
    const d = mk({ op_slug: "golf-star-competitions", title: "AUTO DRAW #9" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "fix", category: "sports-outdoors", source: "rule" });
  });
  test("rule disagrees with stored → fix", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "fix", category: "luxury", source: "rule" });
  });
  test("rule agrees with stored → stamp source only", () => {
    const d = mk({ title: "Win £2,000 Tax Free Cash" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "stamp", category: "cash-prizes", source: "rule" });
  });
  test("no evidence + active → export for Claude", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "export" });
  });
  test("no evidence + ended → leave alone", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard", status: "ended" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
  test("claude/manual source is never touched", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!", category_source: "claude" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
});
```

- [ ] **Step 2: Run — fails** (module doesn't exist). **Step 3: Implement** `backfill-categories.mjs`:

```js
// One-off (re-runnable, idempotent) category backfill. Three modes:
//   MODE=rules  [DRY_RUN=true|false]  — apply rule/pin verdicts + stamp category_source
//   MODE=export                        — write backfill-unknowns.json (active rows Claude must judge)
//   MODE=apply DECISIONS=<file> [DRY_RUN] — apply {id → category} judgments as category_source='claude'
// Never touches status. Every write is logged old→new to backfill-log-<ts>.json.
import { readFileSync, writeFileSync } from "fs";
import { resolveCategory } from "./lib/parse.mjs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const DRY = process.env.DRY_RUN !== "false";

export function decideRuleFix(d, opsBySlug, catBySlug) {
  if (["claude", "manual"].includes(d.category_source)) return { action: "skip" };
  const op = opsBySlug[d.op_slug] || {};
  const verdict = resolveCategory({ op, title: d.title, grand_prize: d.grand_prize, url: d.entry_url, apiCategories: [] });
  if (verdict && catBySlug[verdict]) {
    return verdict === d.category_slug
      ? { action: "stamp", category: verdict, source: "rule" }
      : { action: "fix", category: verdict, source: "rule" };
  }
  return d.status === "active" ? { action: "export" } : { action: "skip" };
}

async function fetchAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function patch(id, body) {
  if (DRY) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/draws?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(body) });
  if (!r.ok) console.error(`  ✗ ${id}: HTTP ${r.status} ${await r.text()}`);
  return r.ok;
}

if (import.meta.main) {
  const MODE = process.env.MODE || "rules";
  const opsRaw = JSON.parse(readFileSync(new URL("./operators.json", import.meta.url), "utf8"));
  const opsBySlug = Object.fromEntries((Array.isArray(opsRaw) ? opsRaw : opsRaw.operators).map((o) => [o.slug, o]));
  const cats = await fetchAll("categories?select=id,slug");
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const draws = (await fetchAll("draws?select=id,title,grand_prize,entry_url,status,category_source,categories(slug),operators(slug)&status=in.(active,draft,ended)&order=id"))
    .map((d) => ({ ...d, category_slug: d.categories?.slug ?? null, op_slug: d.operators?.slug ?? null }));
  console.log(`${draws.length} draws · mode=${MODE} · DRY_RUN=${DRY}`);
  const log = [];

  if (MODE === "rules") {
    let fixed = 0, stamped = 0, exported = 0, skipped = 0;
    for (const d of draws) {
      const v = decideRuleFix(d, opsBySlug, catBySlug);
      if (v.action === "fix") {
        log.push({ id: d.id, title: d.title, from: d.category_slug, to: v.category, source: v.source });
        if (await patch(d.id, { category_id: catBySlug[v.category], category_source: v.source })) fixed++;
      } else if (v.action === "stamp") {
        if (await patch(d.id, { category_source: v.source })) stamped++;
      } else if (v.action === "export") exported++;
      else skipped++;
    }
    console.log(`fixed=${fixed} stamped=${stamped} needs-claude=${exported} skipped=${skipped}`);
  }

  if (MODE === "export") {
    const un = draws.filter((d) => decideRuleFix(d, opsBySlug, catBySlug).action === "export")
      .map((d) => ({ id: d.id, title: d.title, grand_prize: d.grand_prize, current: d.category_slug, op: d.op_slug, entry_url: d.entry_url }));
    writeFileSync("backfill-unknowns.json", JSON.stringify(un, null, 2));
    console.log(`wrote backfill-unknowns.json (${un.length} rows)`);
  }

  if (MODE === "apply") {
    const dec = JSON.parse(readFileSync(process.env.DECISIONS || "backfill-decisions.json", "utf8"));
    let applied = 0, invalid = 0;
    for (const { id, category } of dec) {
      if (!catBySlug[category]) { console.error(`  ✗ ${id}: '${category}' is not a slug — refused`); invalid++; continue; }
      const d = draws.find((x) => x.id === id);
      log.push({ id, title: d?.title, from: d?.category_slug, to: category, source: "claude" });
      if (await patch(id, { category_id: catBySlug[category], category_source: "claude" })) applied++;
    }
    console.log(`applied=${applied} invalid=${invalid}`);
  }

  if (log.length && !DRY) {
    const f = `backfill-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(f, JSON.stringify(log, null, 2));
    console.log(`log → ${f}`);
  }
}
```

- [ ] **Step 4: Tests green:** `bun test test/backfill-categories.test.mjs`. **Step 5: Rules-mode dry run sanity:** `bun backfill-categories.mjs 2>&1 | tail -3` (DRY default) — expect fixed/stamped counts in the hundreds, no errors. **Step 6: Commit** (`feat(backfill): three-mode category backfill with provenance stamping and revert log`, trailer).

---

### Task 10: `patrol.mjs` (drift scan + detail worklist) + operator scoreboard in `manager/tripwire.mjs`

**Files:**
- Create: `~/pdd-aggregator/patrol.mjs`
- Modify: `~/pdd-aggregator/manager/tripwire.mjs` (append scoreboard section to its report)
- Test: `~/pdd-aggregator/test/patrol.test.mjs`

**Interfaces:**
- Consumes: `inferCategory`, `resolveCategory` (Task 6); REST env.
- Produces: `bun patrol.mjs` writes `patrol-worklist.json`: `{ week, drift: [{id,title,stored,evidence,op}], detail_sample: [{id,title,entry_url,op,ticket_price,total_entries,draw_date,grand_prize}], counts }`. Exports `weekParity(date)` and `inSample(id, parity)` for tests. Scoreboard appears in `tripwire.md` under `## Operator scoreboard`.

- [ ] **Step 1: Failing tests** (`test/patrol.test.mjs`):

```js
import { test, expect, describe } from "bun:test";
import { weekParity, inSample } from "../patrol.mjs";

describe("patrol rotation — stateless half-catalogue per week", () => {
  test("parity flips week to week", () => {
    expect(weekParity(new Date("2026-08-23"))).not.toBe(weekParity(new Date("2026-08-30")));
  });
  test("a given id is sampled exactly once per fortnight", () => {
    const id = "3247f98b-762c-4a46-b144-9b2a928f5f53";
    expect(inSample(id, 0) !== inSample(id, 1)).toBe(true);
  });
  test("roughly half of ids fall in each parity", () => {
    const n = 1000, ids = Array.from({ length: n }, (_, i) => `id-${i}-${i * 7919}`);
    const a = ids.filter((x) => inSample(x, 0)).length;
    expect(a).toBeGreaterThan(n * 0.35); expect(a).toBeLessThan(n * 0.65);
  });
});
```

- [ ] **Step 2: Implement `patrol.mjs`:**

```js
// Weekly patrol worklist generator (deterministic, keyless — Claude does the judging).
//   bun patrol.mjs   → patrol-worklist.json
// drift: active rows with category_source='rule' whose stored category the CURRENT rules
//        no longer support (evidence differs). claude/manual rows are never re-litigated.
// detail_sample: the half of the live catalogue whose turn it is this week (stateless
//        rotation: id-hash parity vs ISO-week parity), for price/entries/date/prize re-proof.
import { writeFileSync } from "fs";
import { inferCategory } from "./lib/parse.mjs";

export function weekParity(d = new Date()) {
  const oneJan = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - oneJan) / 604800000) % 2);
}
export function inSample(id, parity) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 2) === parity;
}

if (import.meta.main) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/draws?select=id,title,grand_prize,entry_url,ticket_price,total_entries,draw_date,category_source,categories(slug),operators(slug)&status=eq.active`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const drift = rows.filter((d) => d.category_source === "rule").flatMap((d) => {
    const ev = inferCategory({ title: d.title, grand_prize: d.grand_prize });
    const stored = d.categories?.slug ?? null;
    return ev && ev !== stored ? [{ id: d.id, title: d.title, stored, evidence: ev, op: d.operators?.slug }] : [];
  });
  const parity = weekParity();
  const detail_sample = rows.filter((d) => inSample(d.id, parity)).map((d) => ({
    id: d.id, title: d.title, entry_url: d.entry_url, op: d.operators?.slug,
    ticket_price: d.ticket_price, total_entries: d.total_entries, draw_date: d.draw_date, grand_prize: d.grand_prize,
  }));
  const out = { week: parity, generated: new Date().toISOString(), counts: { active: rows.length, drift: drift.length, detail_sample: detail_sample.length }, drift, detail_sample };
  writeFileSync("patrol-worklist.json", JSON.stringify(out, null, 2));
  console.log(`patrol-worklist.json → active=${rows.length} drift=${drift.length} sample=${detail_sample.length} (week parity ${parity})`);
}
```

- [ ] **Step 3: Scoreboard in `manager/tripwire.mjs`.** READ the file first; append a section writer that adds to `tripwire.md`, using data it can already reach (or one extra fetch of `draws?select=status,created_at,operators(slug,name)` + `operators?select=slug,name,rating`):

```
## Operator scoreboard
| operator | live | added 30d | newest | rating | flag |
```

Flag logic: `PRUNE?` when live = 0 AND newest created_at older than 60 days (final call needs the GSC check in the curation sprint — say so in a footnote line); `ADD-QUEUE` footnote listing `discovery/queue.json` pending count. Keep sorting: flagged rows first.

- [ ] **Step 4: Tests + full suite green**, then run `bun patrol.mjs` once for real (it only READS the DB and writes a local file) — sanity-check counts against Task 9's numbers. **Step 5: Commit** (`feat(patrol): weekly drift+detail worklist generator and operator scoreboard`, trailer).

---

### Task 11: `manager/PROMPT.md` v4 + `.gitignore` hygiene + PR

**Files:**
- Modify: `~/pdd-aggregator/manager/PROMPT.md`
- Modify: `~/pdd-aggregator/.gitignore` (add `patrol-worklist.json`, `backfill-unknowns.json`, `backfill-decisions.json`, `backfill-log-*.json`)
- Modify: `~/pdd-aggregator/COWORK.txt` (one line in the agents summary noting the classify step + Sunday patrol)

**Interfaces:**
- Consumes: Tasks 6–10 CLIs and flag strings (exact names: `"no category evidence"`, `bun patrol.mjs`, `bun manager/draw-update.mjs <id> '<json>'`, `test/fixtures/regressions.json`).
- Produces: the v4 prompt text the user pastes into the cowork routine.

- [ ] **Step 1: Edit PROMPT.md.** Keep v3's structure, hard rules, and steps 0–5 intact except these surgical changes:

1a. Header: retitle v4; update R5 to name all EIGHT slugs and add the new traps line:

```
- R5 category: exactly one of car-draws, cash-prizes, house-draws, tech-giveaways, luxury,
  collectibles, sports-outdoors, home-garden. Traps: a £300k cash pot is cash-prizes NOT
  house-draws; golf gear/fishing/bikes = sports-outdoors (a VW Golf is still a car);
  tools/garden/hot tubs = home-garden; Warhammer/Pokémon/LEGO/graded cards/Funko =
  collectibles; "instant win" is a MECHANIC, never category evidence; "Van Gogh" is not a van.
```

1b. New step 2b (after the spot-check), verbatim:

```
2b. **Classify the category-blocked drafts.** These are rows the scraper refused to guess:
   `…/rest/v1/draws?status=eq.draft&category_id=is.null&order=created_at.desc&limit=60&select=id,title,grand_prize,entry_url,image_url,operator:operators(slug)`
   For each (batch them in ONE judgment pass): pick EXACTLY one of the eight R5 slugs from
   title + grand_prize; if the text is generic ("Summer Cash Splash", "Mystery Box"), fetch the
   image_url and judge from the banner. Write it with provenance:
   `bun manager/draw-update.mjs <id> '{"category_id":"<uuid-from-the-categories-lookup>","category_source":"claude"}'`
   (`categories` lookup: `…/rest/v1/categories?select=id,slug`.) If genuinely undecidable, leave
   it and count it in the report — never force one. NEVER touch rows whose category_source is
   already claude or manual. Cap: 40 rows/run; oldest first beyond that.
```

1c. New Sunday block (before step 5), verbatim:

```
## SUNDAYS ONLY — the deep patrol (skip entirely Mon–Sat)
S1. `bun patrol.mjs` → patrol-worklist.json (drift + this week's detail half; stateless rotation).
S2. **Drift:** for each `drift` entry, decide rule-evidence vs stored like a fresh
    classification (image tiebreak allowed). Fix real mistakes via draw-update
    (`{"category_id":"…","category_source":"claude"}`); a WRONG RULE (evidence itself is bad —
    e.g. a keyword misfiring) gets reported as a parser bug AND appended to
    `test/fixtures/regressions.json` on a branch: entry shape
    {"title":"…","grand_prize":null,"expected_category":"…","found":"YYYY-MM-DD patrol: <why>"} —
    commit + push branch `patrol/regressions-<date>` and open a PR (`gh pr create`); CI proves it.
S3. **Detail re-proof:** for each `detail_sample` row use the step-2 curl recipes (woo store API
    first) to re-prove ticket_price, total_entries, draw DAY and grand_prize against R1–R4.
    Wrong field + clean page read → patch that one field via draw-update. Unreadable page or
    ≥2 wrong fields → `{"status":"draft"}` back to the gate. Same KILL RULE as step 2.
S4. **Scoreboard:** run `bun manager/tripwire.mjs`; copy its "Operator scoreboard" table into the
    report; name the top PRUNE? candidate and the ADD-QUEUE count (final prune decisions belong
    to the curation sprint — never delete anything from here).
S5. **Silent-operator diagnosis (self-healing, leashed).** For each operator tripwire lists as
    silent/stalled for ≥2 consecutive runs: re-probe it —
    `AUTO_PUBLISH=false ONLY=<slug> DRY_RUN=true bun run.mjs` — and read the failure. Classify:
    MOVED-URL / MARKUP-DRIFT / CLOUDFLARE / PLUGIN-SWAP / DEAD-SITE. A pure CONFIG fix (base
    url changed, a selector pattern in operators.json) you may apply on a branch ONLY if a
    re-probe with the edited config then yields gate-passing draws — commit the config change +
    push branch `heal/<slug>-<date>` + `gh pr create` with the before/after probe output in the
    body. Anything needing CODE changes: open the PR with the diagnosis and failing evidence
    only — never edit parser code from this routine. Report one line per diagnosed operator.
```

1d. Step-5 report template gains three lines:

```
   **Classified:** N drafts categorised (M undecidable, left draft)
   **Patrol (Sun):** drift fixed N · rules flagged N (PR: <link|none>) · details checked N, fixed N, redrafted N
   **Scoreboard (Sun):** top prune candidate <op|none> · discovery queue N
```

1e. THE THREE THINGS YOU MUST NOT DO — append to rule 3: "The one field you MAY write without page evidence is `category_id` (+`category_source:'claude'`) on rows where it is NULL — that judgment is this routine's job (step 2b)."

- [ ] **Step 2: .gitignore + COWORK.txt one-liners.** **Step 3:** `bun test` green. **Step 4: Commit** (`feat(cowork): PROMPT v4 — classify blocked drafts, Sunday patrol, regression-fixture loop`, trailer).

- [ ] **Step 5: Push branch, open the aggregator PR, watch CI pass, merge:**

```bash
git -C ~/pdd-aggregator push -u origin feat/scraper-accuracy
cd ~/pdd-aggregator && gh pr create --title "Scraper accuracy program: 8 categories, no-guess publishing, patrol, agent CI" --body "Implements docs/superpowers/specs/2026-08-21-scraper-accuracy-design.md — see spec for the measured live damage this fixes. Site-side migration is already live (categories rows + category_source).

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 
gh pr checks --watch && gh pr merge --squash --delete-branch
```

(If CI fails: fix on the branch, never merge red.)

---

### Task 12: The backfill run (prod data — the moment the site becomes truthful)

**Interfaces:**
- Consumes: merged main (Tasks 5–11), live categories rows (Task 1).
- Produces: every active draw correctly shelved + stamped; log file kept.

- [ ] **Step 1: Rules pass, dry then real:**

```bash
cd ~/pdd-aggregator && git checkout main && git pull && export $(grep -E "^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)" .env | xargs)
MODE=rules bun backfill-categories.mjs            # dry — read the counts
MODE=rules DRY_RUN=false bun backfill-categories.mjs
```

- [ ] **Step 2: Export unknowns:** `MODE=export bun backfill-categories.mjs` → expect roughly 80–120 active rows in `backfill-unknowns.json`.

- [ ] **Step 3: Classify the unknowns — adversarial two-pass (orchestrator does this, not a script).** Split the worklist into batches of ~20. For each batch dispatch a PROPOSER subagent: prompt = the 8 slugs + R5 trap lines from PROMPT.md v4 + the batch JSON (title, grand_prize, operator, entry_url) + "return STRICT JSON `[{id, category, confidence: high|low, reason}]`; when the title is opaque, fetch the entry_url and judge the page; `null` category is allowed for undecidable". Then dispatch a separate SKEPTIC subagent per batch with the proposer's answers + the same rules + "your job is to REFUTE: return the ids where the category is defensibly WRONG, with the correct slug". Accept: proposals the skeptic left standing; skeptic-corrected rows where the correction is obviously right (spot-check 5 yourself against the live pages); anything still contested or `null` → leave unclassified (stays draft-eligible for the daily routine... note: these are ACTIVE rows, so leave their category as-is and list them in the run report). Write accepted decisions to `backfill-decisions.json` as `[{"id":"…","category":"…"}]`.

- [ ] **Step 4: Apply:** `MODE=apply DRY_RUN=false bun backfill-categories.mjs` — zero `invalid` expected. Keep the `backfill-log-*.json` files (they're gitignored; copy the final one into the task report).

- [ ] **Step 5: Verify prod truthfulness:**

```bash
# distribution after
curl -s "$SUPABASE_URL/rest/v1/draws?select=categories(slug)&status=eq.active&limit=3000" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | python3 -c "import json,sys,collections; print(collections.Counter((r.get('categories') or {}).get('slug') for r in json.load(sys.stdin)))"
```

Expected shape: cash-prizes ≈ 120–140, sports-outdoors ≈ 45–65, home-garden ≈ 15–30, no NULL actives (or a handful listed as contested). Then fetch `https://prizedrawsdaily.co.uk/category/cash-prizes` and confirm no golf/tool titles in the first pages; fetch both new category URLs and confirm they render draws.

---

### Task 13: Discovery onboarding command (`discovery/onboard.mjs`)

**Files:**
- Create: `~/pdd-aggregator/discovery/onboard.mjs`
- Test: `~/pdd-aggregator/test/onboard.test.mjs`
- Branch: new branch `feat/onboard-command` off main → PR (post-merge of the big one).

**Interfaces:**
- Consumes: `resolveCategory` (category dry-run), run.mjs `ONLY=<slug> DRY_RUN=true` flow.
- Produces: `bun discovery/onboard.mjs <url>` → prints a report + writes `discovery/onboard-<slug>.json` (proposed operators.json entry + verdict). Exports `detectPlatform(baseUrl)` and `draftEntry({url, platform, name})`.

- [ ] **Step 1: Failing tests:**

```js
import { test, expect, describe } from "bun:test";
import { draftEntry } from "../discovery/onboard.mjs";

describe("draftEntry", () => {
  test("woo entry shape", () => {
    const e = draftEntry({ url: "https://example-comps.co.uk", platform: "woo", name: "Example Comps" });
    expect(e).toEqual({ name: "Example Comps", slug: "example-comps", url: "https://example-comps.co.uk", methods: ["woo"] });
  });
  test("render entry gets the render method", () => {
    expect(draftEntry({ url: "https://x.co.uk", platform: "render", name: "X" }).methods).toEqual(["render"]);
  });
});
```

(FIRST read two real entries in `operators.json` and mirror their exact field names — if entries use e.g. `"method"` not `"methods"`, or carry `"pages"`, match reality and update the test to the real shape. The shape above is the fallback if entries are truly `{name, slug, url, methods}`.)

- [ ] **Step 2: Implement** — `detectPlatform` probes in order: `GET <base>/wp-json/wc/store/v1/products?per_page=1` (JSON array → `woo`), `GET <base>/products.json?limit=1` (JSON with products → `shopify`), else `render`. `main`: detect → draft entry → print it → append entry to a TEMP copy of operators.json → spawn `Bun.spawnSync(["bun", "run.mjs"], { env: { ...process.env, ONLY: slug, DRY_RUN: "true", AUTO_PUBLISH: "false", OPERATORS_FILE: tmpPath } })` — read run.mjs first: if it has no `OPERATORS_FILE` env override, add one (default `./operators.json`, one line) — then summarise: draws found, gate pass/fail reasons, category distribution (count of null = "will need Claude"), and a verdict line `READY | NEEDS-CONFIG | BLOCKED(<why>)`. Write the report JSON.

- [ ] **Step 3: Tests green; live-fire against one EXISTING operator's URL as a smoke test** (safe: DRY_RUN). **Step 4: PR + CI + merge** (`feat(discovery): one-command operator onboarding with dry-run verdict`, trailer).

---

### Task 14: Final verification sweep + handoff

- [ ] **Step 1: Whole-suite + CI:** `cd ~/pdd-aggregator && bun test 2>&1 | tail -3` on main; `gh run list --workflow=ci.yml --limit 1` shows green.
- [ ] **Step 2: The two screenshot pages:** fetch `/category/cash-prizes` (page 1–2) — zero non-cash titles; `/category/sports-outdoors` shows the Golf Star inventory; `curl -s https://prizedrawsdaily.co.uk/sitemap.xml | grep -c "sports-outdoors\|home-garden"` ≥ 2.
- [ ] **Step 3: One live Action cycle sanity (next morning or via `workflow_dispatch`):** trigger `aggregate.yml`, read its summary — expect no crash, `no category evidence` holds on new unknowns (grep the log), zero rows published with null category:
  `…/rest/v1/draws?status=eq.active&category_id=is.null&select=id` → `[]`.
- [ ] **Step 4: Tripwire:** `bun manager/tripwire.mjs` locally — scoreboard section renders.
- [ ] **Step 5: Handoff report to the user**, containing: what shipped (PR links), the before/after category distribution, the backfill log location, and THE ONE USER ACTION: paste the new `manager/PROMPT.md` (below the `---`) into the cowork routine task, keeping schedule/env unchanged. Update the memory file `scraper-accuracy-program.md` to "shipped" state with the follow-up (curation sprint) pointer.

---

## Self-review notes (already applied)

- Task 8 is the risk center: the stored-category threading (`hasStoredCategory`) is what lets Claude-stamped drafts publish. Its verify.test case is the load-bearing test of the whole program.
- Task 6 Step 5 / Task 8 Step 4 explicitly bound which pre-existing tests may be edited (only ones encoding the dead fallback) — everything else failing = implementation bug.
- Type consistency: flag string `"no category evidence"` (Tasks 8, 11, 14); modes `rules|export|apply` (Tasks 9, 12); file names `patrol-worklist.json`, `backfill-unknowns.json`, `backfill-decisions.json`, `backfill-log-*.json` (Tasks 9–12); slugs everywhere match the Global Constraints list; `decideRuleFix` consumed only by its own test; `weekParity`/`inSample` consumed only by their test.
- Spec coverage: §3→T1–4 · §4→T6–7 · §5→T8+T11 · §6→T9+T12 · §7→T10+T11 · §8→T5+T6(fixtures)+T11(S2) · §9→T11(S4 diagnose lives in scoreboard+kill-rules; config-fix leash is PROMPT S2/S3 behavior) · §10→T13 · §11→T11 cadence gating · §12→T12 Step 3 + T11 2b guardrails · §13→T6/T7/T8/T9/T10 tests · §14→T1-order+T14.
- §9's "config-level fixes applied only if re-probe passes gate": realised as the PROMPT's existing diagnosis flow + `onboard.mjs`-style dry-run recipe named in S2/S3 kill rules; no unsupervised code edits anywhere — matches the leash requirement.
