# Free prize draws, Part 1 (scraper): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let truly free (£0, no-catch) prize draws through the scrape gate, with a daily QA double-check that permanently hides any that turn out to have a catch.

**Architecture:** A pure `freeCheck(draw)` in `lib/free.mjs` decides whether a £0 draw is free. `businessGate` calls it only when the price is exactly 0; every other rule is unchanged. Adapters attach a transient `free_text` (the operator's own description), which run.mjs never stores because its insert row is an explicit whitelist. The QA routine (`manager/PROMPT.md`) gets one new step that opens each unchecked £0 row once and either marks it `free_entry_route:"online-free"` (checked, genuinely free) or `status:"rejected"` (hidden for good).

**Tech Stack:** Bun, `bun:test`, plain ESM `.mjs`; Supabase PostgREST via `manager/draw-update.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-14-free-draws-design.md` (this branch). Part 2 (site) is the separate plan `docs/superpowers/plans/2026-10-15-free-draws-site.md`.

## Global Constraints

- Branch from fresh `origin/main` in `~/pdd-aggregator-free` (branch `spec/free-draws` already rebased onto main 15269c8). Never push to main; open a PR; the user merges.
- Truly free only. Spend-to-qualify, subscriber-only, members/VIP/loyalty, free instant wins and free spins are excluded.
- Every other gate rule applies to free draws unchanged: cap ≥500 (collectibles 50), fixed draw date within 35 days, photo, entry link.
- A missing price (`null`) is never "free": it still fails `requiredGate`.
- Fail closed: in doubt, not free.
- Publishing is unchanged: free draws insert as `draft` and publish only when a second scrape ≥18h later agrees (`lib/verify.mjs`).
- The QA routine never publishes. Its new status write is `rejected`, which is permanent. There is no manual undo.
- Site-credit prizes count as free to enter. The spend-only-there note is a site concern (Part 2), so the scraper does nothing special for them.
- Every paid draw's gate result must be byte-identical before and after (A/B, Task 5).
- Never write to the DB from development. Use `DRY_RUN=true AUTO_PUBLISH=false` only.

## Review Focus

1. **A £0 price that is really an unread price.** A sale-price glitch or a parse miss returns 0 for a paid draw. The draw must not be listed as free. Pinned in Task 1: £0 without any free wording ("free", "no cost") is rejected.
2. **Boilerplate catch words in a genuinely free draw's description.** A Woo description footer advertising "instant wins" on other comps will reject a real free draw. That is accepted, because it fails closed. Pinned in Task 1 with a test that documents the behaviour.
3. **Word-boundary false hits on prize names.** "Spinning reel" and "Clubhouse" must not trip `spin`/`club members`. Pinned in Task 1.
4. **HTML in descriptions.** Raffolux descriptions are HTML (`<b>…</b><br>`). Tags must not glue words together, as in `FREE</b>spend`. Pinned in Task 1.
5. **A `rejected` row reappearing.** The next scrape must not re-insert or revive it. Covered by existing code: `lib/existing.mjs` loads every status, and `lib/route.mjs` returns `skip / not-draft` for any status other than active, draft or ended. Pinned in Task 4 with a `routeDraw` test.

---

### Task 1: `lib/free.mjs`, the free check

**Files:**
- Create: `lib/free.mjs`
- Test: `test/free.test.mjs`

**Interfaces:**
- Produces: `freeCheck(draw: { ticket_price, title?, grand_prize?, description?, free_text? }) → { free: boolean, reason: string }`. The `reason` on a catch is `"free but conditional: <matched phrase, lower-case>"`, and on a £0 with no free wording it is `"£0 with no free wording"`.

- [ ] **Step 1: Write the failing test**

```js
// test/free.test.mjs
import { test, expect, describe } from "bun:test";
import { freeCheck } from "../lib/free.mjs";

const free = (title, extra = {}) => ({ ticket_price: 0, title, grand_prize: title, ...extra });

describe("freeCheck: genuinely free draws pass", () => {
  for (const t of [
    "FREE ENTRY – £1000 CASH FOR FREE!",
    "ABARTH 500 T-JET – FREE ENTRY! – MUST ANSWER THE QUESTION",
    "FREE TO ENTER – Milwaukee 7 Piece Kit",
    "Win £5 Cash - FREE",
    "Free Draw - £30 Site Credit",
  ]) test(t, () => expect(freeCheck(free(t))).toEqual({ free: true, reason: "free to enter" }));

  test("account required / one entry per person / postal entry stay free", () => {
    expect(freeCheck(free("Free £50 draw", { free_text: "Account required. One entry per person. Postal entry available." })).free).toBe(true);
  });
  test("'spinning reel' and 'Clubhouse' are not catches", () => {
    expect(freeCheck(free("FREE Shimano spinning reel from Clubhouse")).free).toBe(true);
  });
  test("'no cost' counts as free wording", () => {
    expect(freeCheck(free("Win £5 Cash", { free_text: "absolutely no cost to enter" })).free).toBe(true);
  });
});

describe("freeCheck: conditional or not-a-draw £0 items fail", () => {
  const cases = [
    ["FREE ENTRY - WIN £100 | SPEND £1-£5+ AND GET A TICKET", "spend £"],
    ["£200 Site Credit For Free! (Must Have Spent £10)", "spent"],
    ["Jackpot Cash Subscriber Exclusive Instant Free", "subscriber"],
    ["FREE INSTANT WIN COMP!", "instant win"],
    ["Tuesday - 5 Daily Free Spins", "spins"],
    ["🆓 £200 Active Players Only! Free", "active players"],
    ["Free VIP draw", "vip"],
    ["Free loyalty draw", "loyalty"],
    ["Free draw – members only", "members only"],
    ["Free scratchcard", "scratch"],
    ["Free wheel of fortune", "wheel"],
    ["Free draw with any order", "with any order"],
  ];
  for (const [t, phrase] of cases) test(t, () => {
    const r = freeCheck(free(t));
    expect(r.free).toBe(false);
    expect(r.reason).toBe(`free but conditional: ${phrase}`);
  });

  test("the catch can sit in free_text, not the title", () => {
    const r = freeCheck(free("FREE £250 Cash", { free_text: "To qualify you must have purchased a ticket this week." }));
    expect(r).toEqual({ free: false, reason: "free but conditional: must have purchased" });
  });
  test("HTML tags never glue words together", () => {
    const r = freeCheck(free("Win £5", { free_text: "<b>FREE</b><br>Spend £5 to qualify" }));
    expect(r.reason).toBe("free but conditional: spend £");
  });
  test("boilerplate 'instant wins' in a description rejects (fails closed, by design)", () => {
    expect(freeCheck(free("FREE £100", { free_text: "Check out our other instant wins!" })).free).toBe(false);
  });
});

describe("freeCheck: fail closed on price", () => {
  test("£0 with no free wording is treated as an unread price", () => {
    expect(freeCheck({ ticket_price: 0, title: "Win a BMW M4", grand_prize: "BMW M4" }))
      .toEqual({ free: false, reason: "£0 with no free wording" });
  });
  test("a paid draw is never 'free'", () => expect(freeCheck({ ticket_price: 0.99, title: "FREE BMW" }).free).toBe(false));
  test("a null price is never 'free'", () => expect(freeCheck({ ticket_price: null, title: "FREE BMW" }).free).toBe(false));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/free.test.mjs`
Expected: FAIL with `Cannot find module '../lib/free.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// lib/free.mjs
// Is a £0 draw TRULY free to enter? (owner decision 2026-10-14: truly free only.)
// Pure, no I/O. It fails closed: any catch phrase, or a £0 with no free wording at all (which is
// what an unread or glitched price looks like), means "not free", and the gate drops the draw.
// Order matters only for the reported reason; the first phrase found is the one named.
const CONDITIONS = [
  /\bspend\s*£/i,
  /\bspent\b/i,
  /\bmust have (?:spent|purchased|bought|entered a paid)/i,
  /\bwith any (?:order|purchase)\b/i,
  /\bpurchase required\b/i,
  /\bwhen you (?:buy|purchase)\b/i,
  /\bsubscri(?:ber|bers|ption)\b/i,
  /\bmembers?[\s-]+only\b/i,
  /\bvip\b/i,
  /\bloyalty\b/i,
  /\bclub members?\b/i,
  /\bactive players?\b/i,
  /\bpoints\b/i,
  /\binstant[\s-]?win/i,
  /\bspins?\b/i,
  /\bscratch/i,
  /\bwheel\b/i,
];
const FREE_WORDING = /\bfree\b|\bno cost\b|\bcosts? nothing\b/i;

const plain = (s) => String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

export function freeCheck(draw) {
  if (draw?.ticket_price !== 0) return { free: false, reason: "not a £0 draw" };
  const text = [draw.title, draw.grand_prize, draw.description, draw.free_text].filter(Boolean).map(plain).join(" \n ");
  for (const re of CONDITIONS) {
    const m = text.match(re);
    if (m) return { free: false, reason: `free but conditional: ${m[0].toLowerCase().replace(/\s+/g, " ")}` };
  }
  if (!FREE_WORDING.test(text)) return { free: false, reason: "£0 with no free wording" };
  return { free: true, reason: "free to enter" };
}
```

The test expects `"instant win"` as the reason for "FREE INSTANT WIN COMP!". The regex `/\binstant[\s-]?win/i` matches `INSTANT WIN`, which lower-cases to `instant win`. "Must Have Spent" hits `\bspent\b` first, so its reason is `spent`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/free.test.mjs`
Expected: PASS, all tests. If one reason string differs, fix the CONDITIONS order rather than the test. The test encodes which phrase a reader should see.

- [ ] **Step 5: Commit**

```bash
git add lib/free.mjs test/free.test.mjs
git commit -m "Free check: a £0 draw is free only with free wording and no spend, membership or instant-win catch

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: the gate lets free draws through

**Files:**
- Modify: `gate.mjs`: the import line and line 67 of `businessGate` (`if (!(draw.ticket_price > 0)) reasons.push("no/zero ticket price");`)
- Test: `test/gate.test.mjs` (append)

**Interfaces:**
- Consumes: `freeCheck` from Task 1.
- Produces: `businessGate` and `gate` accept a £0 draw when `freeCheck(draw).free`. Otherwise the reason is `freeCheck`'s own reason string. For a negative or missing price, the reason stays `"no/zero ticket price"`.

- [ ] **Step 1: Write the failing test** (append to `test/gate.test.mjs`; `good()`, `soon` are already defined at the top)

```js
describe("businessGate: free draws (2026-10-14)", () => {
  const freeDraw = (over = {}) => ({ ...good(), title: "FREE ENTRY – £1000 CASH", grand_prize: "£1000 cash", ticket_price: 0, ...over });

  test("a truly free draw passes the whole gate", () => expect(gate(freeDraw()).pass).toBe(true));
  test("a conditional free draw fails with the catch named", () => {
    const r = gate(freeDraw({ title: "FREE ENTRY - SPEND £5 AND WIN" }));
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("free but conditional: spend £");
  });
  test("£0 without free wording still fails (unread price)", () => {
    expect(gate(freeDraw({ title: "Win a BMW M4", grand_prize: "BMW M4" })).reasons).toContain("£0 with no free wording");
  });
  test("free draws still need a real cap", () => {
    expect(gate(freeDraw({ total_entries: 100 })).reasons).toContain("only 100 entries — non-standard draw");
  });
  test("free draws still need a date inside the window", () => {
    expect(gate(freeDraw({ draw_date: farOff })).pass).toBe(false);
  });
  test("a null price is still a missing field, not free", () => {
    expect(gate(freeDraw({ ticket_price: null })).stage).toBe("required");
  });
  test("paid draws are unchanged", () => expect(gate(good())).toEqual(gate({ ...good() })));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/gate.test.mjs`
Expected: FAIL on "a truly free draw passes the whole gate" (today: `no/zero ticket price`).

- [ ] **Step 3: Implement**

In `gate.mjs`, add the import under the existing one:

```js
import { freeCheck } from "./lib/free.mjs";
```

Replace line 67:

```js
  if (!(draw.ticket_price > 0)) reasons.push("no/zero ticket price");
```

with:

```js
  // £0 is allowed only for a TRULY free draw (owner decision 2026-10-14). lib/free.mjs fails
  // closed, and every other rule below still applies to it unchanged.
  if (draw.ticket_price === 0) { const f = freeCheck(draw); if (!f.free) reasons.push(f.reason); }
  else if (!(draw.ticket_price > 0)) reasons.push("no/zero ticket price");
```

- [ ] **Step 4: Run the whole suite**

Run: `bun run test:scraper`
Expected: PASS, everything. `test/onboard.test.mjs:125` holds a literal log line `"no/zero ticket price"` as fixture text, so it is unaffected. If any other test asserts that a £0 draw fails with `"no/zero ticket price"`, update it to the new reason, and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add gate.mjs test/gate.test.mjs
git commit -m "Gate: a £0 draw passes the price rule only when the free check says it is truly free

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: adapters hand the free check the operator's own text

The spec (§1.3) lists every adapter. This plan wires only the two paths where free draws actually occur today:
- **Woo and render**, both via `fieldsFromHtml`. These cover the 27 £0 rejects in the last sweep and Ruby's "Free Draw".
- **Raffolux**, with 17 free draws.

The other API adapters (click, hydra, raffle-engine, inertia, drawhouse) still get title and `grand_prize` checked. If one of them starts carrying free draws, add `free_text` then (YAGNI).

**Files:**
- Modify: `lib/parse.mjs`: the `return { … description: null };` line at the end of `fieldsFromHtml` (≈ line 876)
- Modify: `lib/adapters/raffolux.mjs`: the object returned by `mapRaffle`
- Test: `test/adapters.test.mjs` (append inside the raffolux `describe`), `test/parse.test.mjs` (append)

**Interfaces:**
- Produces: every draw from `fieldsFromHtml` and `mapRaffle` carries `free_text: string | null` (≤2,000 chars). `run.mjs` builds its insert row field by field (`run.mjs` ≈ line 433), so `free_text` is never written to the DB. Do not add it there.

- [ ] **Step 1: Write the failing tests**

Append to the raffolux `describe` in `test/adapters.test.mjs`:

```js
  test("free raffles carry the operator's own text for the free check, and pass the gate", async () => {
    const { gate } = await import("../gate.mjs");
    const raffles = await feed();
    const r = raffles.find((x) => x.title === "Win £5 Cash - FREE");
    const d = mapRaffolux(r, op);
    expect(d.ticket_price).toBe(0);
    expect(d.free_text).toContain("no cost to enter");
    expect(d.free_text.length).toBeLessThanOrEqual(2000);
    // The fixture date may be in the past by the time this runs; gate against a "now" just before it.
    const now = new Date(new Date(d.draw_date).getTime() - 864e5);
    expect(gate(d, now).pass).toBe(true);
  });
```

Append to `test/parse.test.mjs`:

```js
describe("fieldsFromHtml free_text (free-draw check input)", () => {
  test("carries the API description and the product summary, capped at 2,000 chars", () => {
    const html = `<html><body><div class="summary"><h1>FREE ENTRY – £1000 CASH</h1><p>${"Answer the question to enter. ".repeat(10)}</p></div></body></html>`;
    const d = fieldsFromHtml({ html, url: "https://op.test/p/1", op: { base: "https://op.test" }, knownTitle: "FREE ENTRY – £1000 CASH", descriptionText: "No purchase necessary. " + "x".repeat(3000) });
    expect(d.free_text).toContain("No purchase necessary");
    expect(d.free_text).toContain("Answer the question");
    expect(d.free_text.length).toBeLessThanOrEqual(2000);
  });
});
```

(`fieldsFromHtml` is already imported in `test/parse.test.mjs`. If not, add it to the existing `../lib/parse.mjs` import.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/adapters.test.mjs test/parse.test.mjs`
Expected: FAIL: `d.free_text` is `undefined`.

- [ ] **Step 3: Implement**

In `lib/parse.mjs`, at the end of `fieldsFromHtml`, change the return to add `free_text` (`apiText` and `summaryText` are already in scope):

```js
  // free_text feeds lib/free.mjs only (is a £0 draw truly free?). run.mjs never stores it.
  const free_text = [apiText, summaryText].filter((s) => s && s.trim()).join("\n").slice(0, 2000) || null;
  return { title, grand_prize, grand_prize_source: gp.source, category, ticket_price, total_entries, total_entries_method, figures_source_url: url, draw_date, image_url, entry_url: url, description: null, free_text };
```

In `lib/adapters/raffolux.mjs` `mapRaffle`, add after `description: null,`:

```js
    // The operator's own words, for lib/free.mjs only (never stored): free raffles say "no cost
    // to enter" here, and a catch ("must have purchased…") would be stated here too.
    free_text: [r.description, r.summary, r.competitionDetails, r.questionText].filter(Boolean).join("\n").slice(0, 2000) || null,
```

- [ ] **Step 4: Run the whole suite**

Run: `bun run test:scraper`
Expected: PASS, everything.

- [ ] **Step 5: Commit**

```bash
git add lib/parse.mjs lib/adapters/raffolux.mjs test/adapters.test.mjs test/parse.test.mjs
git commit -m "Adapters pass the operator's own description to the free check (never stored)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: the QA routine double-checks every free draw once

**Files:**
- Modify: `manager/draw-update.mjs`: add status validation after the `free_entry_route` block (≈ line 47)
- Modify: `manager/PROMPT.md`:
  - rule 1 of "THE THREE THINGS YOU MUST NOT DO" (≈ line 32);
  - a new step `1b` after step 1;
  - one line in the step-5 report template.
- Test: `test/manager.test.mjs` (append), `test/route.test.mjs` (append)

**Interfaces:**
- Consumes: the existing `routeDraw(existing, fresh, opts)` from `lib/route.mjs`.
- Produces: `draw-update.mjs` accepts `status` only in `["draft", "ended", "rejected"]` and exits 1 on anything else, including `"active"`. That enforces the "never publish" rule in code.

- [ ] **Step 1: Write the failing tests**

First check how `test/manager.test.mjs` invokes the manager scripts:

Run: `grep -n "draw-update\|spawnSync\|Bun.spawn\|\$\`" test/manager.test.mjs | head`

If it already spawns `draw-update.mjs`, copy that style. Otherwise append:

```js
import { spawnSync } from "node:child_process";
describe("draw-update status values", () => {
  const run = (json) => spawnSync("bun", ["manager/draw-update.mjs", "00000000-0000-0000-0000-000000000000", json], {
    env: { ...process.env, SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "test" }, encoding: "utf8",
  });
  test("refuses to publish", () => {
    const r = run('{"status":"active"}');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("status must be one of draft, ended, rejected");
  });
  test("refuses a typo", () => expect(run('{"status":"rejcted"}').status).toBe(1));
});
```

Append to `test/route.test.mjs` (use the existing import of `routeDraw`):

```js
test("a rejected row is never re-inserted, revived or corrected", () => {
  const existing = { id: "x", status: "rejected", draw_date: new Date(Date.now() + 864e5).toISOString() };
  const fresh = { title: "FREE ENTRY", ticket_price: 0, total_entries: 1000, draw_date: existing.draw_date };
  expect(routeDraw(existing, fresh).kind).toBe("skip");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/manager.test.mjs test/route.test.mjs`
Expected:
- the draw-update test FAILS: today, `status:"active"` gets as far as the network call, whose error text differs;
- the route test PASSES already. It pins existing behaviour, so keep it.

- [ ] **Step 3: Implement**

In `manager/draw-update.mjs`, after the `FREE_ENTRY_ROUTES` block:

```js
// The routine never publishes (PROMPT.md rule 1); draft→active belongs to the verify gate.
// 'rejected' (2026-10-14) permanently hides a £0 draw whose page states a catch: existing.mjs
// still loads it, so run.mjs never re-inserts the URL, and route.mjs skips every status but
// active/draft/ended. The site only ever shows active and ended rows.
const STATUSES = ["draft", "ended", "rejected"];
if ("status" in body && !STATUSES.includes(body.status)) {
  console.error(`status must be one of ${STATUSES.join(", ")} — got ${JSON.stringify(body.status)}`);
  process.exit(1);
}
```

In `manager/PROMPT.md` rule 1, change the sentence ``Your only status writes go the other way: `"draft"` sends a row back to the gate to re-prove itself, `"ended"` retires a finished comp.`` to:

```
Your only status writes go the other way: `"draft"` sends a row back to the gate
   to re-prove itself, `"ended"` retires a finished comp, `"rejected"` permanently hides a
   "free" draw whose page states a catch (step 1b). draw-update.mjs refuses anything else.
```

Insert after step 1:

```
1b. **Free-draw double-check (once per £0 row).** The gate lets a £0 draw through only when its
   own text shows no catch; this step reads the operator's PAGE once to confirm it.
   `…/rest/v1/draws?ticket_price=eq.0&status=in.(active,draft)&or=(free_entry_route.is.null,free_entry_route.neq.online-free)&select=id,title,entry_url,operator:operators(slug)&limit=40`
   For each row, open `entry_url` (same curl as step 2; a bot block → leave it and count it as
   unchecked). Read the entry rules and terms on that page:
   - It states ANY spend, purchase, subscription, membership, VIP/loyalty or "active players"
     condition, or the free item is an instant win / spin / scratchcard →
     `bun manager/draw-update.mjs <id> '{"status":"rejected"}'` and quote the condition.
   - Genuinely free (an account, a skill question or one entry per person is fine) →
     `bun manager/draw-update.mjs <id> '{"free_entry_route":"online-free"}'` (marks it checked).
   `rejected` is permanent and there is no undo, so reject only on a condition you can quote.
```

In the step-5 template, add after the `**Spot-check:**` line:

```
   **Free draws:** N checked · N confirmed free · N rejected · N unchecked (blocked)
   - <operator>/<title> — rejected: "<quoted condition>"
```

- [ ] **Step 4: Run the whole suite**

Run: `bun run test:scraper`
Expected: PASS, everything.

- [ ] **Step 5: Commit**

```bash
git add manager/draw-update.mjs manager/PROMPT.md test/manager.test.mjs test/route.test.mjs
git commit -m "QA routine opens each free draw once: confirmed free, or rejected for good with the catch quoted

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: A/B on live operators, then the PR

Only the gate's price rule and one transient field changed. The A/B therefore scrapes each operator ONCE and runs both gates over the same draws. That avoids run-to-run noise (Storm's countdown seconds, Lavish's leak) entirely.

**Files:**
- Create (outside the repo): `~/Desktop/PDD/40-ops/operator-reviews-2026-10/ab-free.mjs`

- [ ] **Step 1: Prepare the OLD gate**

```bash
git -C ~/pdd-aggregator-drawhouse fetch -q origin && git -C ~/pdd-aggregator-drawhouse checkout -q --detach origin/main
```

- [ ] **Step 2: Write the A/B script**

```js
// ab-free.mjs: run from ~/pdd-aggregator-free so bun loads .env. Read-only: no DB writes.
//   bun ~/Desktop/PDD/40-ops/operator-reviews-2026-10/ab-free.mjs
import { gate as gateNew } from "/Users/chanakyagoyal/pdd-aggregator-free/gate.mjs";
import { gate as gateOld } from "/Users/chanakyagoyal/pdd-aggregator-drawhouse/gate.mjs";
import { wooOperator, shopifyOperator, apiOperator } from "/Users/chanakyagoyal/pdd-aggregator-free/extractor.mjs";

const ops = (await Bun.file("/Users/chanakyagoyal/pdd-aggregator-free/operators.json").json())
  .filter((o) => o.enabled !== false && ["woo", "shopify", "api"].includes(o.method));
const now = new Date();
let paid = 0, paidDiff = 0;
const freeRows = [];
for (const op of ops) {
  let draws = [];
  try {
    draws = op.method === "woo" ? await wooOperator(op, 300)
      : op.method === "shopify" ? await shopifyOperator(op, 300) : await apiOperator(op, 300);
  } catch (e) { console.log(`  ${op.slug}: scrape failed — ${e.message}`); continue; }
  for (const d of draws || []) {
    const { free_text, ...withoutFreeText } = d;
    const a = gateOld(withoutFreeText, now), b = gateNew(d, now);
    if (d.ticket_price === 0) { freeRows.push({ op: op.slug, title: d.title, old: a.reasons.join("; ") || "pass", now: b.pass ? "PASS" : b.reasons.join("; ") }); continue; }
    paid++;
    const strip = (r) => JSON.stringify({ pass: r.pass, stage: r.stage, reasons: r.reasons });
    if (strip(a) !== strip(b)) { paidDiff++; console.log(`  ≠ PAID ${op.slug}: ${d.title.slice(0, 50)}  old=${strip(a)} new=${strip(b)}`); }
  }
}
console.log(`\npaid draws: ${paid} · gate result changed: ${paidDiff} (must be 0)`);
console.log(`£0 draws: ${freeRows.length} · now passing: ${freeRows.filter((r) => r.now === "PASS").length}`);
for (const r of freeRows) console.log(`  ${r.now === "PASS" ? "✅" : "⛔"} ${r.op}: ${r.title.slice(0, 60)} → ${r.now}`);
process.exit(paidDiff ? 1 : 0);
```

- [ ] **Step 3: Run it**

Run: `cd ~/pdd-aggregator-free && bun ~/Desktop/PDD/40-ops/operator-reviews-2026-10/ab-free.mjs | tee ~/Desktop/PDD/40-ops/operator-reviews-2026-10/ab-free.log`
Expected:
- `gate result changed: 0`, exit 0;
- Raffolux's free raffles listed. They pass only where their cap is ≥500 and the date is within 35 days.

**Any paid change is a blocker:** stop and investigate.

**Read every ✅ line by eye.** For each one, open its page and confirm it is truly free. A wrong ✅ means a phrase is missing from `CONDITIONS`. Add it with a test (Task 1 style), then re-run.

- [ ] **Step 4: Render operators, by hand**

Ruby's "Free Draw – £30 Site Credit" comes through the render path. Run:

```bash
AUTO_PUBLISH=false ONLY=ruby-competitions-ltd DRY_RUN=true bun run.mjs 2>&1 | grep -i "free"
```

Expected: the free draws show `✅` (would insert as draft), or a `⏭` naming a gate reason. Ruby may be FlareSolverr-only and blocked locally. Then write "CI-only" in the PR instead.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin spec/free-draws
gh pr create --title "Free prize draws: truly free £0 draws pass the gate; QA double-checks each once" --body "$(cat <<'EOF'
## What
- `lib/free.mjs`: `freeCheck()` — a £0 draw is free only with free wording and no spend / membership / instant-win catch (fails closed).
- `gate.mjs`: £0 passes the price rule only via `freeCheck`; every other rule unchanged; a null price still fails.
- Woo/render (`fieldsFromHtml`) and Raffolux pass the operator's own text as `free_text` (never stored).
- QA routine step 1b: opens each £0 row once → `free_entry_route:"online-free"` or `status:"rejected"` (permanent). `draw-update.mjs` now refuses any status but draft/ended/rejected.
- Spec + this plan under `docs/superpowers/`.

## A/B (one scrape, old gate vs new gate)
<paste the summary lines + the £0 table from ab-free.log>

## Publishing
Unchanged: free draws insert as draft and publish after a second scrape ≥18h later agrees.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: a PR URL. Do not merge. Report the URL, the A/B summary and the ✅ list to the user.
