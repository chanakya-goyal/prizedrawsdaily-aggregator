# Carousel Growth Engine — Phase 1 (Foundation + Identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the carousel publisher memory (Supabase state), a single config source of truth, six themed category identities, honest/robust generation, and a caption-briefing system — the foundation for Phase 2 (Reels) and Phase 3 (learning).

**Architecture:** Keep the proven pipeline (`plan → fetchimg → build → publish → Composio`) and refactor around it: a new `config.json` + `config.mjs` replaces 4 scattered hardcoded maps; a new `state.mjs` writes per-(date,format) rows to two new Supabase tables; `render.mjs`/`styles.css` gain a parameterized particle system + per-theme fonts via CSS custom properties; `build.mjs` gains honesty guards + alt text; captions become Claude-written from a generated fact briefing.

**Tech Stack:** Bun (NOT node — see repo CLAUDE.md), Playwright Chromium (already a dep), Supabase REST (fetch), `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-02-carousel-growth-engine-design.md` (v2). This plan implements **§9 Phase 1** only.

## Global Constraints

- Runtime is **Bun**: `bun <file>`, `bun test`, `Bun.file`/`Bun.write`; never `node`/`npm`/`jest`.
- Budget £0: no new paid services, no new npm deps (Playwright already installed).
- All date math anchored `Europe/London` (`LDN` const in `format.mjs`).
- Honesty rules (spec §7): `total_prize_value` = gross ticket revenue, NEVER "prize worth"; "£X+ IN PRIZES" only past per-category `valueLineMin`; compliance line `18+ · UK ONLY · PLAY RESPONSIBLY` on every slide footer (already in render.mjs — do not remove).
- The car (default orange) and tech themes are LIVE and user-approved — refactors must keep their rendered output visually identical (token renames only, same values).
- `×` glyph missing in Anton (renders as `·`) — never introduce `×` in copy; re-check per new font.
- Working dir `~/Desktop/pdd-today` stays the default but must become env-overridable (`PDD_DIR`).
- Paths in code: repo root is `/Users/chanakyagoyal/pdd-aggregator`; all carousel files under `carousel/`.
- Commit after every task (on `main` — this repo's cron + deploys run main; feature branches have caused state divergence before).

---

### Task 1: Baseline — version the carousel pipeline in git

The entire `carousel/` directory is untracked. Before any refactor, commit the working system as-is so every later change is diffable.

**Files:**
- Modify: `.gitignore` (repo root)
- Commit: `carousel/` (all 16 files + assets)

**Interfaces:** none (baseline).

- [ ] **Step 1: Secrets sweep**

Run: `grep -rn "sb_secret\|service_role\|SUPABASE_SERVICE_ROLE_KEY=\|sk-\|AIza" carousel/ | grep -v "process.env"`
Expected: no output (the only in-source key is `sb_publishable_…` in `select.mjs:3`, which is a *publishable* anon key — public by design, moves into config.json in Task 3).

- [ ] **Step 2: Extend .gitignore**

Append to the repo-root `.gitignore` (create the lines exactly; keep existing content):

```
# carousel local/generated state
carousel/tests/tmp/
carousel/*.local.*
```

- [ ] **Step 3: Commit baseline**

```bash
git add .gitignore carousel/
git commit -m "chore(carousel): baseline — version the daily carousel pipeline (previously untracked)"
```

---

### Task 2: `util.mjs` — retry helper

Every network call (Supabase fetch/upload, image downloads) currently aborts the run on one transient 5xx. One shared helper, test-driven.

**Files:**
- Create: `carousel/util.mjs`
- Test: `carousel/tests/util.test.mjs`

**Interfaces:**
- Produces: `withRetry(fn, {tries=3, baseMs=250, label=""}) → Promise<T>` — retries `fn` on throw with exponential backoff (`baseMs * 2^attempt`), rethrows the last error with `label` prefixed. `fetchOk(url, init={}, label="") → Promise<Response>` — `fetch` that throws `Error("<label> <status>: <first 200 chars of body>")` on `!res.ok` (no retry inside — callers wrap with `withRetry`).

- [ ] **Step 1: Write the failing test**

```js
// carousel/tests/util.test.mjs
import { test, expect } from "bun:test";
import { withRetry, fetchOk } from "../util.mjs";

test("withRetry retries then succeeds", async () => {
  let n = 0;
  const out = await withRetry(async () => {
    if (++n < 3) throw new Error("transient");
    return "ok";
  }, { tries: 3, baseMs: 1 });
  expect(out).toBe("ok");
  expect(n).toBe(3);
});

test("withRetry exhausts and rethrows with label", async () => {
  let n = 0;
  await expect(withRetry(async () => { n++; throw new Error("boom"); },
    { tries: 2, baseMs: 1, label: "supabase" })).rejects.toThrow(/supabase.*boom/);
  expect(n).toBe(2);
});

test("fetchOk throws on !ok with status and body", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  try {
    await expect(fetchOk("https://x.test/", {}, "upload")).rejects.toThrow(/upload 401: bad key/);
  } finally { globalThis.fetch = orig; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chanakyagoyal/pdd-aggregator && bun test carousel/tests/util.test.mjs`
Expected: FAIL — `Cannot find module '../util.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// carousel/util.mjs — shared retry + checked-fetch helpers (used by select/state/publish).
export async function withRetry(fn, { tries = 3, baseMs = 250, label = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await Bun.sleep(baseMs * 2 ** attempt);
    }
  }
  throw new Error(`${label ? label + ": " : ""}${lastErr?.message || lastErr}`, { cause: lastErr });
}

export async function fetchOk(url, init = {}, label = "fetch") {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test carousel/tests/util.test.mjs`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add carousel/util.mjs carousel/tests/util.test.mjs
git commit -m "feat(carousel): withRetry + fetchOk helpers"
```

---

### Task 3: `config.json` + `config.mjs` — single source of truth

Replaces 4 duplicated maps: `CATEGORIES`/`VISUAL_WEIGHT` (select.mjs:5,27), `hookLabel` (format.mjs:70), `VARY` hashtags (caption.mjs:3), `THEME` (build.mjs:149). Behavior must stay identical for the live themes.

**Files:**
- Create: `carousel/config.json`, `carousel/config.mjs`
- Modify: `carousel/select.mjs`, `carousel/format.mjs`, `carousel/caption.mjs`, `carousel/build.mjs`
- Test: `carousel/tests/config.test.mjs`

**Interfaces:**
- Produces: `CFG` (parsed config object), `catCfg(slug) → {name, visualWeight, theme, seoKeyword, hashtags[], hook, particles:{type,count}, valueLineMin}` (unknown slug → safe defaults: visualWeight 0.6, theme "default", hashtags `["#ukraffle","#livedraws"]`, valueLineMin `Infinity`), `themeOf(slug) → string`, `workDir() → string` (env `PDD_DIR` > config.global.workDir with `~` expanded), `GLOBAL` (=CFG.global).
- Consumed by: every later task.

- [ ] **Step 1: Write config.json**

```json
{
  "global": {
    "igUserId": "27332554436394910",
    "fbPageId": "1106603652538117",
    "supabaseUrl": "https://kkuuwksgyypicnblwubs.supabase.co",
    "supabasePublishableKey": "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs",
    "bucket": "carousel-slides",
    "workDir": "~/Desktop/pdd-today",
    "archiveDays": 14,
    "series": { "name": "TONIGHT'S UK DRAWS", "slotLine": "every night · 7pm UK" },
    "primeWindowsUK": [[12, 13], [19, 21]],
    "fixedHashtags": ["#prizedrawsdaily", "#ukcompetition", "#winbig"],
    "bannedPhrases": ["don't miss out", "amazing prizes", "you could win", "once in a lifetime", "hurry now", "act fast", "what are you waiting for", "incredible opportunity"],
    "archetypes": ["question", "price-anchor", "deadline", "absurd-comparison"]
  },
  "categories": {
    "car-draws": {
      "name": "Car Draws", "visualWeight": 1.0, "theme": "default",
      "seoKeyword": "UK car competitions", "hashtags": ["#ukraffle", "#cargiveaway"],
      "hook": "WIN A DREAM CAR", "particles": { "type": "embers", "count": 46 },
      "valueLineMin": 20000
    },
    "cash-prizes": {
      "name": "Cash Prizes", "visualWeight": 0.4, "theme": "cash",
      "seoKeyword": "UK cash competitions", "hashtags": ["#cashgiveaway", "#ukcomps"],
      "hook": "WIN TAX-FREE CASH", "particles": { "type": "embers", "count": 30 },
      "valueLineMin": 5000
    },
    "house-draws": {
      "name": "House Draws", "visualWeight": 0.8, "theme": "house",
      "seoKeyword": "UK house competitions", "hashtags": ["#dreamhome", "#housedraw"],
      "hook": "WIN A DREAM HOME", "particles": { "type": "fireflies", "count": 34 },
      "valueLineMin": 50000
    },
    "tech-giveaways": {
      "name": "Tech Giveaways", "visualWeight": 0.92, "theme": "tech",
      "seoKeyword": "UK tech giveaways", "hashtags": ["#techgiveaway", "#ukcomps"],
      "hook": "WIN THE LATEST TECH", "particles": { "type": "embers", "count": 40 },
      "valueLineMin": 3000
    },
    "luxury": {
      "name": "Luxury", "visualWeight": 1.0, "theme": "luxury",
      "seoKeyword": "UK luxury watch competitions", "hashtags": ["#luxury", "#ukraffle"],
      "hook": "WIN LUXURY", "particles": { "type": "golddust", "count": 26 },
      "valueLineMin": 10000
    },
    "collectibles": {
      "name": "Collectibles", "visualWeight": 0.85, "theme": "collect",
      "seoKeyword": "UK Pokemon and LEGO competitions", "hashtags": ["#collectibles", "#ukraffle"],
      "hook": "WIN RARE FINDS", "particles": { "type": "holo", "count": 30 },
      "valueLineMin": 8000
    }
  }
}
```

(`valueLineMin` values chosen so the collectibles £15k-false-claim incident can't recur: the value line renders only when the summed `total_prize_value` — gross ticket revenue — clears a bar where the claim is defensible for that category. `car-draws.theme` = `"default"` on purpose: the live orange CSS is the `:root` default.)

- [ ] **Step 2: Write the failing test**

```js
// carousel/tests/config.test.mjs
import { test, expect } from "bun:test";
import { CFG, catCfg, themeOf, workDir, GLOBAL } from "../config.mjs";

test("all six categories present with full identity", () => {
  for (const slug of ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury", "collectibles"]) {
    const c = catCfg(slug);
    expect(c.name).toBeTruthy();
    expect(c.visualWeight).toBeGreaterThan(0);
    expect(c.theme).toBeTruthy();
    expect(c.hashtags.length).toBe(2);
    expect(c.hook).toMatch(/^WIN /);
    expect(["embers", "golddust", "fireflies", "holo", "none"]).toContain(c.particles.type);
    expect(c.valueLineMin).toBeGreaterThan(0);
  }
});

test("unknown slug falls back safely", () => {
  const c = catCfg("mystery-boxes");
  expect(c.visualWeight).toBe(0.6);
  expect(c.theme).toBe("default");
  expect(c.hashtags).toEqual(["#ukraffle", "#livedraws"]);
  expect(c.valueLineMin).toBe(Infinity);
});

test("live themes preserved", () => {
  expect(themeOf("car-draws")).toBe("default");
  expect(themeOf("tech-giveaways")).toBe("tech");
});

test("workDir expands ~ and honours PDD_DIR", () => {
  expect(workDir()).not.toContain("~");
  process.env.PDD_DIR = "/tmp/pdd-test";
  expect(workDir()).toBe("/tmp/pdd-test");
  delete process.env.PDD_DIR;
});

test("global ids present", () => {
  expect(GLOBAL.igUserId).toBe("27332554436394910");
  expect(GLOBAL.fbPageId).toBe("1106603652538117");
  expect(CFG.categories["luxury"]).toBeTruthy();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test carousel/tests/config.test.mjs`
Expected: FAIL — `Cannot find module '../config.mjs'`

- [ ] **Step 4: Write config.mjs**

```js
// carousel/config.mjs — loads config.json once; the single source of truth for
// category identity, theme, IDs and paths. Env PDD_DIR overrides the working dir.
import raw from "./config.json";

export const CFG = raw;
export const GLOBAL = raw.global;

const FALLBACK = {
  visualWeight: 0.6, theme: "default", hashtags: ["#ukraffle", "#livedraws"],
  particles: { type: "embers", count: 46 }, valueLineMin: Infinity,
};

export function catCfg(slug) {
  const c = CFG.categories[slug];
  if (!c) return { ...FALLBACK, name: slug || "Prize", hook: "WIN BIG", seoKeyword: "UK competitions" };
  return { ...FALLBACK, ...c };
}

export const themeOf = (slug) => catCfg(slug).theme;

export function workDir() {
  if (process.env.PDD_DIR) return process.env.PDD_DIR;
  return GLOBAL.workDir.replace(/^~/, process.env.HOME || "/Users/chanakyagoyal");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test carousel/tests/config.test.mjs`
Expected: 5 pass.

- [ ] **Step 6: Wire the four consumers (behavior-identical)**

In `carousel/select.mjs`: delete lines 2–5 (`SUPABASE_URL`, `KEY`, `CATEGORIES` consts) and line 27-30 (`VISUAL_WEIGHT` map); replace with:

```js
import { GLOBAL, catCfg } from "./config.mjs";
import { withRetry, fetchOk } from "./util.mjs";
const SUPABASE_URL = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || GLOBAL.supabasePublishableKey;
```

and in `pickBestCategory` replace `const w = VISUAL_WEIGHT[slug] ?? 0.6;` with `const w = catCfg(slug).visualWeight;`. Replace the bare fetch in `fetchEndingSoon` (`const r = await fetch(u, …); if (!r.ok) throw …; return await r.json();`) with:

```js
  const r = await withRetry(() => fetchOk(u, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } }, "supabase draws"), { label: "fetchEndingSoon" });
  return await r.json();
```

In `carousel/format.mjs`: replace the whole `hookLabel` export (lines 69–77) with:

```js
import { catCfg } from "./config.mjs";
export const hookLabel = (slug, name) => catCfg(slug).hook || `WIN ${catLabel(name)}`;
```

(put the import at the top of the file with the others).

In `carousel/caption.mjs`: replace the `FIXED` and `VARY` consts (lines 1–10) with:

```js
import { GLOBAL, catCfg } from "./config.mjs";
const FIXED = GLOBAL.fixedHashtags;
```

and replace both `[...FIXED, ...(VARY[slug] || ["#ukraffle", "#livedraws"])]` occurrences with `[...FIXED, ...catCfg(slug).hashtags]`.

In `carousel/build.mjs`: replace lines 147–150 (`const THEME = …; const theme = THEME[sel.slug] || "default";`) with:

```js
import { themeOf } from "./config.mjs";   // ← add to the imports at the top
const theme = themeOf(sel.slug);
```

In `carousel/plan.mjs` and `carousel/build.mjs` and `carousel/contact.mjs` and `carousel/fetchimg.mjs` and `carousel/publish.mjs`: replace the hardcoded `const DIR = "/Users/chanakyagoyal/Desktop/pdd-today"` with:

```js
import { workDir } from "./config.mjs";
const DIR = workDir();
```

(fetchimg.mjs sets its dir at line ~159; adjust the same way.)

- [ ] **Step 7: Verify nothing broke**

Run: `bun test carousel/tests/ && bun carousel/plan.mjs`
Expected: tests pass; plan.mjs runs and picks a category exactly as before (network + Supabase required — if no draws close this week output may legitimately be empty; the check is "no thrown error").

- [ ] **Step 8: Commit**

```bash
git add carousel/config.json carousel/config.mjs carousel/tests/config.test.mjs carousel/select.mjs carousel/format.mjs carousel/caption.mjs carousel/build.mjs carousel/plan.mjs carousel/contact.mjs carousel/fetchimg.mjs carousel/publish.mjs
git commit -m "refactor(carousel): config.json single source of truth (categories/themes/ids/paths)"
```

---

### Task 4: Fix the London date-label bug

`closesLabel` (format.mjs:40-49) computes day-diffs by parsing `en-GB` strings ("30/06/2026") with `new Date()` — JS reads MM/DD, so day>12 → Invalid Date → NaN diff → "CLOSES TONIGHT/TOMORROW" silently never fires near month-end; day≤12 → wrong month. Fix with `en-CA` (YYYY-MM-DD, parseable) and make `now` injectable for tests.

**Files:**
- Modify: `carousel/format.mjs:40-49`
- Test: `carousel/tests/format.test.mjs`

**Interfaces:**
- Produces: `closesLabel(iso, now = new Date()) → string` (signature gains optional `now`; all existing callers unchanged).

- [ ] **Step 1: Write the failing test**

```js
// carousel/tests/format.test.mjs
import { test, expect } from "bun:test";
import { closesLabel, priceLabel, cleanTitle } from "../format.mjs";

// 30 Jun 2026 was a Tuesday. en-GB "30/06/2026" is unparseable by new Date() —
// the old code returned the generic label instead of TONIGHT/TOMORROW.
test("closesLabel: tonight/tomorrow across day>12 dates", () => {
  const now = new Date("2026-06-30T10:00:00+01:00"); // London morning, Jun 30
  expect(closesLabel("2026-06-30T21:00:00+01:00", now)).toBe("CLOSES TONIGHT");
  expect(closesLabel("2026-07-01T21:00:00+01:00", now)).toBe("CLOSES TOMORROW (WED)");
});

test("closesLabel: London day boundary vs IST machine clock", () => {
  // 23:30 UTC Jul 1 = 00:30 London Jul 2 (BST) = 05:00 IST Jul 2.
  const now = new Date("2026-07-01T23:30:00Z");
  // Draw closes 21:00 London Jul 2 — same *London* day as `now` → TONIGHT.
  expect(closesLabel("2026-07-02T21:00:00+01:00", now)).toBe("CLOSES TONIGHT");
});

test("closesLabel: month boundary rollover", () => {
  const now = new Date("2026-07-31T12:00:00+01:00");
  expect(closesLabel("2026-08-01T20:00:00+01:00", now)).toBe("CLOSES TOMORROW (SAT)");
});

test("format helpers unchanged", () => {
  expect(priceLabel(0.05)).toBe("5p");
  expect(priceLabel(2)).toBe("£2");
  expect(priceLabel(49.97)).toBe("£49.97");
  expect(cleanTitle("Win this BMW M340d Touring + £1,000 cash!")).toBe("BMW M340d Touring");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test carousel/tests/format.test.mjs`
Expected: FAIL on the first test (old code yields "CLOSES TUE 30 JUN" instead of "CLOSES TONIGHT").

- [ ] **Step 3: Fix closesLabel**

Replace the whole function in `carousel/format.mjs`:

```js
export function closesLabel(iso, now = new Date()) {
  const d = new Date(iso);
  // en-CA gives YYYY-MM-DD — the only toLocaleDateString format new Date() parses reliably.
  const day = (x) => x.toLocaleDateString("en-CA", { timeZone: LDN });
  const diff = Math.round((new Date(day(d)) - new Date(day(now))) / 86400000);
  const dn = d.toLocaleDateString("en-GB", { timeZone: LDN, weekday: "short" }).toUpperCase();
  const dm = d.toLocaleDateString("en-GB", { timeZone: LDN, day: "numeric", month: "short" }).toUpperCase();
  if (diff <= 0) return "CLOSES TONIGHT";
  if (diff === 1) return `CLOSES TOMORROW (${dn})`;
  return `CLOSES ${dn} ${dm}`;
}
```

(`toDrawSlide` keeps calling `closesLabel(d.draw_date)` — default `now` applies.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test carousel/tests/format.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add carousel/format.mjs carousel/tests/format.test.mjs
git commit -m "fix(carousel): closesLabel parsed en-GB dates as MM/DD — London labels broke for day>12"
```

---

### Task 5: Supabase state — `carousel_posts` / `carousel_metrics` + `state.mjs`

The system's memory. Write-ahead rows per (date, format); readable by the cloud watchdog via anon key (RLS: anon SELECT only; writes use the service-role key which bypasses RLS).

**Files:**
- Create: `carousel/state-schema.sql`, `carousel/state.mjs`, `carousel/state-setup.mjs`, `carousel/state-mark.mjs`
- Test: `carousel/tests/state.test.mjs`

**Interfaces:**
- Produces (all async, all throw on HTTP error, service-role key required for writes):
  - `upsertPost(row)` — row: `{date:"YYYY-MM-DD", format:"carousel"|"reel"|"story"|"fb_photo"|"fb_video", status, category?, draw_slugs?:string[], hook_archetype?, seo_keyword?, caption?, ig_container_id?, ig_media_id?, fb_post_id?, asset_urls?:string[]}`; upserts on `(date,format)`.
  - `markStatus(date, format, status, patch = {})` — PATCH status (+ any extra columns); sets `posted_at` automatically when `status === "published"`.
  - `getPost(date, format) → row | null`
  - `recentPosts(days) → rows[]` (date >= today−days, newest first)
  - `recentDrawSlugs(days = 7) → string[]` (flattened, deduped)
  - `lastCategory() → string | null` (category of the most recent published/pending row)
  - `insertMetrics(rows)` — rows: `[{day:"YYYY-MM-DD", media_id (use "account" for account-level), metric, value}]`; upserts on `(day,media_id,metric)`.
  - `todayLondon() → "YYYY-MM-DD"` (exported for reuse).
- Internals: `_setFetch(fn)` exported for tests to inject a mock fetch.

- [ ] **Step 1: Write the schema**

```sql
-- carousel/state-schema.sql — one-time setup, run in Supabase dashboard → SQL editor.
create table if not exists carousel_posts (
  date date not null,
  format text not null,
  status text not null default 'pending',
  category text,
  draw_slugs jsonb not null default '[]',
  hook_archetype text,
  seo_keyword text,
  caption text,
  ig_container_id text,
  ig_media_id text,
  fb_post_id text,
  asset_urls jsonb not null default '[]',
  posted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (date, format)
);

create table if not exists carousel_metrics (
  day date not null,
  media_id text not null default 'account',
  metric text not null,
  value numeric,
  captured_at timestamptz not null default now(),
  primary key (day, media_id, metric)
);

alter table carousel_posts enable row level security;
alter table carousel_metrics enable row level security;
-- anon may READ (cloud watchdog / reports); only service_role writes (bypasses RLS).
create policy "anon read carousel_posts" on carousel_posts for select using (true);
create policy "anon read carousel_metrics" on carousel_metrics for select using (true);
```

- [ ] **Step 2: Write the failing test** (mock fetch — no live DB in unit tests)

```js
// carousel/tests/state.test.mjs
import { test, expect, beforeEach } from "bun:test";
import { upsertPost, markStatus, recentDrawSlugs, insertMetrics, todayLondon, _setFetch } from "../state.mjs";

let calls;
beforeEach(() => {
  calls = [];
  _setFetch(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    return new Response(JSON.stringify([{ date: "2026-07-01", format: "carousel", draw_slugs: ["a", "b"], category: "luxury", status: "published" }]), { status: 200, headers: { "content-type": "application/json" } });
  });
});

test("upsertPost POSTs with on_conflict resolution", async () => {
  await upsertPost({ date: "2026-07-02", format: "carousel", status: "assets_uploaded", category: "luxury", draw_slugs: ["x"] });
  const c = calls[0];
  expect(c.method).toBe("POST");
  expect(c.url).toContain("/rest/v1/carousel_posts");
  expect(c.url).toContain("on_conflict=date%2Cformat");
  expect(c.headers.Prefer).toContain("resolution=merge-duplicates");
  expect(c.body.status).toBe("assets_uploaded");
});

test("markStatus PATCHes by date+format and stamps posted_at on publish", async () => {
  await markStatus("2026-07-02", "carousel", "published", { ig_media_id: "123" });
  const c = calls[0];
  expect(c.method).toBe("PATCH");
  expect(c.url).toContain("date=eq.2026-07-02");
  expect(c.url).toContain("format=eq.carousel");
  expect(c.body.ig_media_id).toBe("123");
  expect(c.body.posted_at).toBeTruthy();
});

test("recentDrawSlugs flattens + dedupes", async () => {
  const slugs = await recentDrawSlugs(7);
  expect(slugs).toEqual(["a", "b"]);
});

test("insertMetrics upserts on day,media_id,metric", async () => {
  await insertMetrics([{ day: "2026-07-01", media_id: "account", metric: "reach", value: 5 }]);
  expect(calls[0].url).toContain("carousel_metrics");
  expect(calls[0].url).toContain("on_conflict=day%2Cmedia_id%2Cmetric");
});

test("todayLondon shape", () => {
  expect(todayLondon()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test carousel/tests/state.test.mjs`
Expected: FAIL — `Cannot find module '../state.mjs'`

- [ ] **Step 4: Write state.mjs**

```js
// carousel/state.mjs — durable post/metric state in Supabase (spec §4.2).
// Writes need SUPABASE_SERVICE_ROLE_KEY; reads fall back to the publishable key.
import { GLOBAL } from "./config.mjs";
import { withRetry, fetchOk } from "./util.mjs";

const URL_ = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || GLOBAL.supabasePublishableKey;

let _fetch = fetch;
export const _setFetch = (f) => { _fetch = f; };

const hdrs = (extra = {}) => ({ apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...extra });

async function rest(path, init = {}, label = "state") {
  return withRetry(async () => {
    const r = await _fetch(`${URL_}/rest/v1/${path}`, init);
    if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }, { label });
}

export const todayLondon = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

export async function upsertPost(row) {
  return rest(`carousel_posts?on_conflict=${encodeURIComponent("date,format")}`, {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  }, "upsertPost");
}

export async function markStatus(date, format, status, patch = {}) {
  const body = { status, updated_at: new Date().toISOString(), ...patch };
  if (status === "published" && !body.posted_at) body.posted_at = new Date().toISOString();
  return rest(`carousel_posts?date=eq.${date}&format=eq.${format}`, {
    method: "PATCH", headers: hdrs({ Prefer: "return=minimal" }), body: JSON.stringify(body),
  }, "markStatus");
}

export async function getPost(date, format) {
  const rows = await rest(`carousel_posts?date=eq.${date}&format=eq.${format}&limit=1`, { headers: hdrs() }, "getPost");
  return rows?.[0] || null;
}

export async function recentPosts(days) {
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  return (await rest(`carousel_posts?date=gte.${since}&order=date.desc`, { headers: hdrs() }, "recentPosts")) || [];
}

export async function recentDrawSlugs(days = 7) {
  const rows = await recentPosts(days);
  return [...new Set(rows.flatMap((r) => r.draw_slugs || []))];
}

export async function lastCategory() {
  const rows = await recentPosts(3);
  return rows.find((r) => r.category)?.category || null;
}

export async function insertMetrics(rows) {
  if (!rows?.length) return null;
  return rest(`carousel_metrics?on_conflict=${encodeURIComponent("day,media_id,metric")}`, {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  }, "insertMetrics");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test carousel/tests/state.test.mjs`
Expected: 5 pass.

- [ ] **Step 6: Write state-setup.mjs (detects tables; guides the one-time SQL paste)**

```js
// carousel/state-setup.mjs — checks the state tables exist; prints setup SQL if not.
// Run: bun carousel/state-setup.mjs
import { GLOBAL } from "./config.mjs";

const URL_ = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || GLOBAL.supabasePublishableKey;

async function tableExists(name) {
  const r = await fetch(`${URL_}/rest/v1/${name}?limit=1`, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  return r.ok;
}

const posts = await tableExists("carousel_posts");
const metrics = await tableExists("carousel_metrics");
if (posts && metrics) { console.log("✓ carousel_posts + carousel_metrics exist. State layer ready."); process.exit(0); }
console.log("✗ Missing state tables. ONE-TIME setup (~30s):");
console.log("  1. Open https://supabase.com/dashboard/project/kkuuwksgyypicnblwubs/sql/new");
console.log("  2. Paste and run the SQL below (also in carousel/state-schema.sql):\n");
console.log(await Bun.file(new URL("./state-schema.sql", import.meta.url)).text());
process.exit(1);
```

- [ ] **Step 7: Write state-mark.mjs (CLI the operator uses after Composio posting)**

```js
// carousel/state-mark.mjs — mark today's row: bun carousel/state-mark.mjs <format> <status> [--ig ID] [--fb ID] [--container ID]
import { markStatus, todayLondon } from "./state.mjs";

const [format, status] = Bun.argv.slice(2);
if (!format || !status) { console.error("usage: bun carousel/state-mark.mjs <format> <status> [--ig ID] [--fb ID] [--container ID]"); process.exit(1); }
const patch = {};
const flag = (name, col) => { const i = Bun.argv.indexOf(name); if (i > -1 && Bun.argv[i + 1]) patch[col] = Bun.argv[i + 1]; };
flag("--ig", "ig_media_id"); flag("--fb", "fb_post_id"); flag("--container", "ig_container_id");
await markStatus(todayLondon(), format, status, patch);
console.log(`✓ ${todayLondon()} ${format} → ${status}`, patch);
```

- [ ] **Step 8: Run the one-time table creation** *(needs the user OR dashboard access — if `bun carousel/state-setup.mjs` reports missing tables, relay the printed instructions to the user and wait for confirmation, then re-run until it prints ✓)*

Run: `bun carousel/state-setup.mjs`
Expected (eventually): `✓ carousel_posts + carousel_metrics exist.`

- [ ] **Step 9: Live smoke test (writes + reads one row)**

Write `carousel/tests/tmp/smoke.mjs` (dir is gitignored):

```js
import { upsertPost, getPost } from "../../state.mjs";
await upsertPost({ date: "2000-01-01", format: "carousel", status: "pending", category: "smoke-test" });
const row = await getPost("2000-01-01", "carousel");
if (row?.category !== "smoke-test") throw new Error("smoke failed: " + JSON.stringify(row));
console.log("✓ smoke row written + read:", row.date, row.format, row.category);
```

Run (from repo root so Bun auto-loads `.env`):
`mkdir -p carousel/tests/tmp && bun carousel/tests/tmp/smoke.mjs && curl -s -X DELETE "https://kkuuwksgyypicnblwubs.supabase.co/rest/v1/carousel_posts?date=eq.2000-01-01" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"`
Expected: `✓ smoke row written + read: 2000-01-01 carousel smoke-test`, then the cleanup DELETE returns silently.

- [ ] **Step 10: Commit**

```bash
git add carousel/state-schema.sql carousel/state.mjs carousel/state-setup.mjs carousel/state-mark.mjs carousel/tests/state.test.mjs
git commit -m "feat(carousel): Supabase state layer — carousel_posts/carousel_metrics + write-ahead helpers"
```

---

### Task 6: History-aware, non-destructive `plan.mjs`

Kill the `rm -rf`; archive instead (14-day retention); never repeat a draw featured in the last 7 days; avoid yesterday's category unless it's the only qualifier.

**Files:**
- Modify: `carousel/plan.mjs`, `carousel/select.mjs`
- Test: `carousel/tests/selection.test.mjs`

**Interfaces:**
- `pickBestCategory(draws, n = 5, onlySlug = null, opts = {})` gains `opts.excludeSlugs?: Set<string>` (draws dropped before scoring) and `opts.avoidCategory?: string` (that category's score ×0.5 — soft penalty, still wins if it's the only one with enough draws). Existing callers without `opts` behave identically.
- `plan.mjs` writes `selection.json` with two NEW fields: `seoKeyword` (from `catCfg`) and `archetype` (rotating: `GLOBAL.archetypes[dayOfYear % archetypes.length]`).

- [ ] **Step 1: Write the failing test**

```js
// carousel/tests/selection.test.mjs
import { test, expect } from "bun:test";
import { pickBestCategory } from "../select.mjs";

const draw = (slug, cat, value = 1000) => ({ slug, total_prize_value: value, categories: { slug: cat, name: cat } });
const POOL = [
  draw("car1", "car-draws"), draw("car2", "car-draws"), draw("car3", "car-draws"), draw("car4", "car-draws"),
  draw("lux1", "luxury", 5000), draw("lux2", "luxury", 5000), draw("lux3", "luxury", 5000),
];

test("excludeSlugs removes recently-featured draws before scoring", () => {
  const pick = pickBestCategory(POOL, 3, null, { excludeSlugs: new Set(["lux1", "lux2", "lux3"]) });
  expect(pick.slug).toBe("car-draws"); // luxury left with 0 draws → car wins
});

test("avoidCategory soft-penalises yesterday's category", () => {
  // luxury outscores cars on weight+value normally; the ×0.5 penalty flips it.
  const pick = pickBestCategory(POOL, 3, null, { avoidCategory: "luxury" });
  expect(pick.slug).toBe("car-draws");
});

test("avoidCategory still wins when it is the only qualifier", () => {
  const only = [draw("lux1", "luxury"), draw("lux2", "luxury"), draw("lux3", "luxury")];
  const pick = pickBestCategory(only, 3, null, { avoidCategory: "luxury" });
  expect(pick.slug).toBe("luxury");
});

test("no opts → unchanged behavior", () => {
  const pick = pickBestCategory(POOL, 3);
  expect(pick.slug).toBe("luxury"); // higher weight×value
  expect(pick.draws.length).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test carousel/tests/selection.test.mjs`
Expected: FAIL (opts ignored → both "exclude"/"avoid" tests pick luxury).

- [ ] **Step 3: Extend pickBestCategory in select.mjs**

Replace the function with:

```js
export function pickBestCategory(draws, n = 5, onlySlug = null, opts = {}) {
  const { excludeSlugs = new Set(), avoidCategory = null } = opts;
  const by = {};
  for (const d of draws) {
    if (excludeSlugs.has(d.slug)) continue;
    const s = d.categories?.slug || "other";
    if (onlySlug && s !== onlySlug) continue;
    (by[s] ||= []).push(d);
  }
  let best = null;
  for (const [slug, list] of Object.entries(by)) {
    const w = catCfg(slug).visualWeight;
    const value = list.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
    const enough = list.length >= Math.min(3, n) ? 1 : 0;
    let score = enough * 1e12 + w * Math.min(list.length, n) * 1e9 + value;
    if (slug === avoidCategory) score *= 0.5; // soft penalty: rotate categories, don't ban
    if (!best || score > best.score) best = { slug, score, list };
  }
  if (!best) return null;
  return {
    slug: best.slug, name: best.list[0].categories?.name || best.slug, count: best.list.length,
    draws: best.list.slice(0, n),
    pool: best.list,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test carousel/tests/selection.test.mjs`
Expected: 4 pass. (Note: the `enough*1e12` term dominates, so ×0.5 only reorders *within* qualified categories — exactly the "unless only qualifier" semantics.)

- [ ] **Step 5: Rewrite plan.mjs archive + history wiring**

In `carousel/plan.mjs`, replace lines 19–20 (`await rm(DIR, …); await mkdir(DIR, …);`) with:

```js
import { readdir, rename } from "node:fs/promises";         // ← extend the fs import at top
import { recentDrawSlugs, lastCategory, todayLondon } from "./state.mjs";
import { GLOBAL, catCfg } from "./config.mjs";

// Archive the previous run instead of destroying it (spec §4.2); prune >archiveDays.
const ARCHIVE = `${DIR}/archive`;
await mkdir(ARCHIVE, { recursive: true });
try {
  const prev = (await readdir(DIR)).filter((f) => f !== "archive");
  if (prev.length) {
    const stamp = `${ARCHIVE}/${todayLondon()}-${Date.now() % 86400000}`;
    await mkdir(stamp, { recursive: true });
    for (const f of prev) await rename(`${DIR}/${f}`, `${stamp}/${f}`);
  }
  const cutoff = Date.now() - (GLOBAL.archiveDays || 14) * 86400000;
  for (const dir of await readdir(ARCHIVE)) {
    const iso = dir.slice(0, 10);
    if (new Date(iso + "T00:00:00Z").getTime() < cutoff) await rm(`${ARCHIVE}/${dir}`, { recursive: true, force: true });
  }
} catch (e) { console.error("archive step:", e.message); }

// History-aware selection (state may be unreachable → degrade gracefully, loudly).
let excludeSlugs = new Set(), avoid = null;
try { excludeSlugs = new Set(await recentDrawSlugs(7)); avoid = await lastCategory(); }
catch (e) { console.error("⚠ history unavailable (selection not history-aware):", e.message); }
```

and change the pick call to `const pick = pickBestCategory(draws, N, onlySlug, { excludeSlugs, avoidCategory: avoid });`.
Then extend the `selection.json` write to include the new fields:

```js
const dayOfYear = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + "-01-01")) / 86400000);
const archetype = GLOBAL.archetypes[dayOfYear % GLOBAL.archetypes.length];
await writeFile(`${DIR}/selection.json`, JSON.stringify({
  slug: pick.slug, name: pick.name, date: new Date().toISOString(),
  seoKeyword: catCfg(pick.slug).seoKeyword, archetype,
  draws: pick.draws, backups,
}, null, 2));
```

- [ ] **Step 6: Verify end-to-end**

Run: `PDD_DIR=/tmp/pdd-plantest bun carousel/plan.mjs && cat /tmp/pdd-plantest/selection.json | head -8 && bun carousel/plan.mjs >/dev/null && ls /tmp/pdd-plantest/archive/`
Expected: selection.json contains `seoKeyword` + `archetype`; second run creates one archive dir holding the first run's files; no `rm -rf` of history. Then `rm -rf /tmp/pdd-plantest`.

- [ ] **Step 7: Commit**

```bash
git add carousel/plan.mjs carousel/select.mjs carousel/tests/selection.test.mjs
git commit -m "feat(carousel): archive instead of rm -rf; history-aware draw/category selection"
```

---

### Task 7: Theme system v2 — six identities, one skeleton (USER CHECKPOINT)

One brand skeleton, per-theme craft details (spec §5). Adds 4 theme CSS blocks + parameterized particles + per-theme display fonts + hard render gate, then a preview sheet for user approval. Car/tech rendered output must stay visually identical.

**Files:**
- Modify: `carousel/fonts.mjs`, `carousel/styles.css`, `carousel/render.mjs`, `carousel/build.mjs`
- Create: `carousel/preview-sheet.mjs`, font files under `carousel/assets/fonts/`
- Test: `carousel/tests/render.test.mjs` + visual approval gate

**Interfaces:**
- `render.mjs`: `renderSlides(slides, theme, particles = {type:"embers", count:46})` (new third arg; existing 2-arg calls default correctly). `buildHtml(slide, theme, particles)` same. **Render gate:** `renderSlides` now THROWS `Error("render not ready …")` instead of screenshotting a broken page.
- `build.mjs` passes `catCfg(sel.slug).particles`.
- CSS custom properties added to `:root` and overridable per theme: `--font-display` (default `'Anton'`), `--font-kicker` (default `'Oswald'`). Every hardcoded `font-family: 'Anton'` in styles.css becomes `font-family: var(--font-display), 'Anton', sans-serif` (and render.mjs:129 inline style likewise).
- Particle CSS classes: `.p-embers`, `.p-golddust`, `.p-fireflies`, `.p-holo` (span-based, like `.ember` today).

- [ ] **Step 1: Download the new fonts (fontsource CDN, one-time)**

```bash
cd /Users/chanakyagoyal/pdd-aggregator/carousel/assets/fonts
curl -fsSLo playfair-display-latin-700-italic.woff2  https://cdn.jsdelivr.net/fontsource/fonts/playfair-display@latest/latin-700-italic.woff2
curl -fsSLo playfair-display-latin-800-normal.woff2  https://cdn.jsdelivr.net/fontsource/fonts/playfair-display@latest/latin-800-normal.woff2
curl -fsSLo space-grotesk-latin-700-normal.woff2     https://cdn.jsdelivr.net/fontsource/fonts/space-grotesk@latest/latin-700-normal.woff2
curl -fsSLo jetbrains-mono-latin-700-normal.woff2    https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.woff2
curl -fsSLo fraunces-latin-900-normal.woff2          https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-900-normal.woff2
curl -fsSLo bungee-latin-400-normal.woff2            https://cdn.jsdelivr.net/fontsource/fonts/bungee@latest/latin-400-normal.woff2
ls -la *.woff2   # every file must be >5KB (a tiny file = CDN 404 page — refetch)
```

- [ ] **Step 2: Register faces in fonts.mjs**

Extend the `FACES` array (tuples gain an optional 4th element `style`, default `"normal"`) and the loop:

```js
const FACES = [
  ["Anton", 400, "anton-latin-400-normal.woff2"],
  ["Oswald", 500, "oswald-latin-500-normal.woff2"],
  ["Oswald", 600, "oswald-latin-600-normal.woff2"],
  ["Oswald", 700, "oswald-latin-700-normal.woff2"],
  ["Bricolage Grotesque", 400, "bricolage-grotesque-latin-400-normal.woff2"],
  ["Bricolage Grotesque", 700, "bricolage-grotesque-latin-700-normal.woff2"],
  ["Bricolage Grotesque", 800, "bricolage-grotesque-latin-800-normal.woff2"],
  ["Inter", 400, "inter-latin-400-normal.woff2"],
  ["Inter", 500, "inter-latin-500-normal.woff2"],
  ["Inter", 600, "inter-latin-600-normal.woff2"],
  ["Inter", 700, "inter-latin-700-normal.woff2"],
  // theme display faces (spec §5)
  ["Playfair Display", 700, "playfair-display-latin-700-italic.woff2", "italic"],
  ["Playfair Display", 800, "playfair-display-latin-800-normal.woff2"],
  ["Space Grotesk", 700, "space-grotesk-latin-700-normal.woff2"],
  ["JetBrains Mono", 700, "jetbrains-mono-latin-700-normal.woff2"],
  ["Fraunces", 900, "fraunces-latin-900-normal.woff2"],
  ["Bungee", 400, "bungee-latin-400-normal.woff2"],
];
```

and in the loop change the destructure + font-style:

```js
  for (const [family, weight, file, style = "normal"] of FACES) {
    …
      out.push(`@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
```

- [ ] **Step 3: styles.css — font vars + particle classes + 4 theme blocks**

(a) Add to the END of the `:root` block:

```css
  --font-display: 'Anton';                 /* per-theme display face */
  --font-kicker: 'Oswald';                 /* per-theme kicker face */
```

(b) Replace every `font-family: 'Anton'` occurrence in styles.css with `font-family: var(--font-display), 'Anton', sans-serif` (grep first: `grep -n "'Anton'" carousel/styles.css`). Do NOT touch `'Oswald'`/`'Inter'`/`'Bricolage'` occurrences.

(c) Add particle classes right after the existing `.ember` rules (find them: `grep -n "\.ember" carousel/styles.css`):

```css
/* ---- parameterized particles (spec §5): one skeleton, per-theme fields ---- */
.p-embers { border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, var(--spark-core), var(--spark-mid) 60%, transparent 75%);
  box-shadow: 0 0 14px 4px rgba(var(--spark-glow-rgb), .55); position: absolute; }
.p-golddust { border-radius: 50%;
  background: radial-gradient(circle at 40% 40%, #fff8e1, var(--gold-2) 65%, transparent 80%);
  box-shadow: 0 0 10px 2px rgba(var(--gold-rgb), .38); position: absolute; }
.p-fireflies { border-radius: 50%;
  background: radial-gradient(circle at 40% 40%, #fffbe8, #ffd98a 60%, transparent 78%);
  box-shadow: 0 0 16px 5px rgba(255, 196, 110, .34); position: absolute; }
.p-holo { border-radius: 2px; transform: rotate(45deg);
  background: linear-gradient(135deg, #9ff, #f9f 45%, #ff9 80%);
  box-shadow: 0 0 12px 3px rgba(200, 150, 255, .4); position: absolute; }
```

(d) Append the four new theme blocks at the end of the token section (immediately after the `[data-theme="tech"]` block). **LUXURY — old money:**

```css
/* LUXURY — old money: near-black + champagne gold, hairline borders, film grain, serif kickers */
[data-theme="luxury"] {
  --accent: #D8A93C;        --accent-rgb: 216,169,60;
  --accent-lt: #F1CE7E;     --accent-lt-rgb: 241,206,126;
  --accent-deep-rgb: 168,120,26;
  --glow: #C89A38;          --glow-rgb: 200,154,56;
  --ray-rgb: 236,206,140;
  --spark-core: #FFF3D0;    --spark-mid: #E9C068;   --spark-glow-rgb: 226,186,96;
  --hot: #F1CE7E;
  --stroke: #171105;
  --ink-end: #f4e8c8;
  --grad-1: #FFF3D0; --grad-2: #EFCB72; --grad-3: #C1913A;
  --bg-1: #17130c; --bg-2: #0d0b07; --bg-3: #060503; --bg-solid: #070604;
  --card-rgb: 18,15,9;
  --scrim-rgb: 7,6,4;
  --pill-1: #F1CE7E; --pill-2: #D8A93C; --pill-3: #B8842A;
  --pill-edge-rgb: 250,236,190;
  --pill-ink-rgb: 70,48,6;
  --font-kicker: 'Playfair Display';
}
[data-theme="luxury"] .card { border-width: 1px; }                     /* hairline gold frame */
[data-theme="luxury"] .intro-kicker, [data-theme="luxury"] .feat-kicker { font-style: italic; letter-spacing: 2px; }
[data-theme="luxury"] .slide::after {                                   /* 4% film grain */
  content: ""; position: absolute; inset: 0; z-index: 9; pointer-events: none; opacity: .04;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

**CASH — jackpot night:**

```css
/* CASH — jackpot night: deep casino green + gold marquee glow (no banknote rain — spec §5) */
[data-theme="cash"] {
  --accent: #22C55E;        --accent-rgb: 34,197,94;
  --accent-lt: #7CE7A6;     --accent-lt-rgb: 124,231,166;
  --accent-deep-rgb: 14,140,60;
  --glow: #2ECC71;          --glow-rgb: 46,204,113;
  --ray-rgb: 150,235,180;
  --spark-core: #FFF3C8;    --spark-mid: #FFD24A;   --spark-glow-rgb: 255,210,74;
  --hot: #FFD24A;
  --stroke: #04170b;
  --ink-end: #d8f7e4;
  --grad-1: #E9FFE9; --grad-2: #5FE08A; --grad-3: #12A34E;
  --bg-1: #0b2416; --bg-2: #071510; --bg-3: #030a06; --bg-solid: #04100a;
  --card-rgb: 8,22,14;
  --scrim-rgb: 4,10,7;
  --pill-1: #FFE07A; --pill-2: #FFC93D; --pill-3: #E8A21C;
  --pill-edge-rgb: 255,238,190;
  --pill-ink-rgb: 80,54,0;
}
```

**HOUSE — dream home at dusk:**

```css
/* HOUSE — dream home at dusk: twilight navy/teal + glowing amber windows */
[data-theme="house"] {
  --accent: #FFB255;        --accent-rgb: 255,178,85;
  --accent-lt: #FFD394;     --accent-lt-rgb: 255,211,148;
  --accent-deep-rgb: 232,140,40;
  --glow: #FFAA4A;          --glow-rgb: 255,170,74;
  --ray-rgb: 255,205,140;
  --spark-core: #FFF6DE;    --spark-mid: #FFCB7E;   --spark-glow-rgb: 255,196,110;
  --hot: #FFD394;
  --stroke: #0a1220;
  --ink-end: #ffe9c9;
  --grad-1: #FFF0D6; --grad-2: #FFC169; --grad-3: #F09A2E;
  --bg-1: #14243c; --bg-2: #0b1526; --bg-3: #050a14; --bg-solid: #060b15;
  --card-rgb: 12,20,34;
  --scrim-rgb: 5,9,16;
  --pill-1: #FFCB7E; --pill-2: #FFAA4A; --pill-3: #F08A1E;
  --pill-edge-rgb: 255,228,180;
  --pill-ink-rgb: 92,50,0;
  --font-display: 'Fraunces';
}
```

**COLLECT — holo grail:**

```css
/* COLLECT — holo grail: deep purple/magenta + animated-feel holo sheen on the card */
[data-theme="collect"] {
  --accent: #C05CFF;        --accent-rgb: 192,92,255;
  --accent-lt: #E2A9FF;     --accent-lt-rgb: 226,169,255;
  --accent-deep-rgb: 140,40,220;
  --glow: #B44DFF;          --glow-rgb: 180,77,255;
  --ray-rgb: 220,170,255;
  --spark-core: #F6E8FF;    --spark-mid: #D08CFF;   --spark-glow-rgb: 200,150,255;
  --hot: #FF7AD9;
  --stroke: #150425;
  --ink-end: #f0dcff;
  --grad-1: #F6E8FF; --grad-2: #D08CFF; --grad-3: #9A2DE8;
  --bg-1: #241238; --bg-2: #140a22; --bg-3: #080312; --bg-solid: #0a0514;
  --card-rgb: 24,12,38;
  --scrim-rgb: 9,4,16;
  --pill-1: #E2A9FF; --pill-2: #C05CFF; --pill-3: #9A2DE8;
  --pill-edge-rgb: 240,214,255;
  --pill-ink-rgb: 70,10,120;
  --font-display: 'Bungee';
}
[data-theme="collect"] .card::after {                                   /* holo sheen sweep */
  content: ""; position: absolute; inset: 0; z-index: 5; pointer-events: none; opacity: .16;
  background: conic-gradient(from 210deg at 60% 20%, transparent 0deg, #9ff 40deg, #f9f 80deg, #ff9 120deg, transparent 160deg);
  mix-blend-mode: screen; border-radius: inherit;
}
```

(e) Tech craft upgrade (spec §5: chromatic aberration + scanlines; Tron floor removed). Replace the `[data-theme="tech"] .techgrid { … }` and `[data-theme="tech"] .techfloor { … }` rules (styles.css:102-…) with:

```css
[data-theme="tech"] .techgrid { display: block; position: absolute; inset: 0; z-index: 3; pointer-events: none; opacity: .12;
  background: repeating-linear-gradient(180deg, rgba(140,215,255,.5) 0 1px, transparent 1px 5px); }  /* scanlines */
[data-theme="tech"] .hl { text-shadow: 2px 0 rgba(255,40,80,.32), -2px 0 rgba(0,229,255,.32); }        /* chromatic split */
[data-theme="tech"] .closes, [data-theme="tech"] .feat-closes, [data-theme="tech"] .intro-sub {
  font-family: 'JetBrains Mono', monospace; letter-spacing: 0; }                                          /* spec-sheet data line */
```

(the `.techfloor` rule is deleted; the div is removed from render.mjs in Step 4).

- [ ] **Step 4: render.mjs — particles param + hard gate + remove techfloor**

(a) Replace `embersHtml`/`bgFx` (render.mjs:30-44) with:

```js
// parameterized particle field (config per category: embers | golddust | fireflies | holo | none)
function particlesHtml(profile = { type: "embers", count: 46 }) {
  const { type = "embers", count = 46 } = profile || {};
  if (type === "none" || count <= 0) return "";
  let s = "";
  for (let i = 0; i < count; i++) {
    const size = (3 + Math.random() * 9).toFixed(1);
    const left = (Math.random() * 100).toFixed(1);
    const top = (Math.random() * 100).toFixed(1);
    const op = (0.22 + Math.random() * 0.55).toFixed(2);
    s += `<span class="p-${type}" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;opacity:${op}"></span>`;
  }
  return `<div class="embers">${s}</div>`;
}
const bgFx = (rays = false, profile) =>
  `<div class="bloom"></div>${rays ? `<div class="rays"></div>` : ""}${particlesHtml(profile)}`;
```

Then thread a `particles` argument through: `drawHtml(d, particles)`, `introHtml(d, particles)`, `ctaHtml(particles)` — each `bgFx(…)` call becomes `bgFx(false, particles)` / `bgFx(true, particles)` / for intro/cta density bumps use `bgFx(true, { ...particles, count: Math.round((particles?.count ?? 46) * 1.25) })`. `buildHtml(slide, theme, particles)` passes it down; `renderSlides(slides, theme, particles)` passes to `buildHtml`.
Also migrate the old CSS class: the existing `.ember` spans are gone — confirm `grep -n '"ember"' carousel/render.mjs` returns nothing after the edit.

(b) In `introHtml` delete the line `<div class="techfloor"></div>` (keep `<div class="techgrid"></div>` — it's now scanlines, displayed only under `[data-theme="tech"]`).

(c) Hard render gate — in `renderSlides` replace:

```js
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(() => {});
```

with:

```js
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(async () => {
      await browser.close();
      throw new Error(`render not ready (fonts/images failed) on slide type=${s.type} title=${s.title || ""} — refusing to ship a degraded slide`);
    });
```

(d) render.mjs:129 inline `font-family:'Anton'` in `thumbsHtml` → `font-family:var(--font-display),'Anton'`.

(e) In `build.mjs`, pass particles: `const pngs = await renderSlides(slides, theme, catCfg(sel.slug).particles);` (add `catCfg` to the config.mjs import added in Task 3).

- [ ] **Step 5: Write the render smoke test**

```js
// carousel/tests/render.test.mjs
import { test, expect } from "bun:test";
import { buildHtml } from "../render.mjs";

const draw = { type: "draw", n: 1, title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT", slug: "x" };

test("buildHtml embeds theme + particle classes", () => {
  const html = buildHtml(draw, "luxury", { type: "golddust", count: 5 });
  expect(html).toContain('data-theme="luxury"');
  expect(html).toContain("p-golddust");
  expect(html).not.toContain("techfloor");
});

test("particles none renders no field", () => {
  const html = buildHtml(draw, "luxury", { type: "none", count: 0 });
  expect(html).not.toContain("p-none");
});

test("compliance footer always present", () => {
  for (const s of [draw, { type: "cta" }, { type: "intro", hook: "WIN LUXURY", count: 5, endLine: "X", thumbs: [] }]) {
    expect(buildHtml(s, "default", { type: "embers", count: 3 })).toContain("18+ · UK ONLY · PLAY RESPONSIBLY");
  }
});
```

Run: `bun test carousel/tests/render.test.mjs` — expected 3 pass.

- [ ] **Step 6: Write preview-sheet.mjs**

```js
// carousel/preview-sheet.mjs — one real slide per theme → single approval sheet.
// Run: bun carousel/preview-sheet.mjs   → ~/Desktop/pdd-theme-preview.png
import { chromium } from "playwright";
import { renderSlides } from "./render.mjs";
import { catCfg, themeOf, CFG } from "./config.mjs";

const SAMPLES = {
  "car-draws":      { type: "draw", n: 1, title: "BMW M340d Touring", price: "99p", cashAlt: "£30,000 TAX-FREE CASH", closes: "CLOSES TONIGHT", odds: "1 IN 4,999" },
  "tech-giveaways": { type: "draw", n: 2, title: "iPhone 17 Pro Max", price: "£1.49", cashAlt: "£950 TAX-FREE CASH", closes: "CLOSES TOMORROW (WED)", odds: "1 IN 2,500" },
  "luxury":         { type: "draw", n: 3, title: "Rolex GMT Batman", price: "£4.97", cashAlt: "£16,000 TAX-FREE CASH", closes: "CLOSES FRI 10 JUL", odds: "1 IN 799" },
  "cash-prizes":    { type: "draw", n: 4, title: "£10,000 Tax-Free Cash", price: "50p", closes: "CLOSES TONIGHT", odds: "1 IN 9,999" },
  "house-draws":    { type: "draw", n: 5, title: "4-Bed Cheshire Home", price: "£2", cashAlt: "£500,000 TAX-FREE CASH", closes: "CLOSES SUN 12 JUL" },
  "collectibles":   { type: "draw", n: 6, title: "Pokemon 151 UPC", price: "3p", closes: "CLOSES TOMORROW (WED)", odds: "1 IN 1,200" },
};

const shots = [];
for (const [slug, slide] of Object.entries(SAMPLES)) {
  const [png] = await renderSlides([slide], themeOf(slug), catCfg(slug).particles);
  shots.push({ slug, b64: Buffer.from(png).toString("base64") });
  console.log(`✓ rendered ${slug} (${themeOf(slug)})`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 3300, height: 1450 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:10px;padding:10px">
  ${shots.map((s) => `<div style="text-align:center;color:#fff;font:700 20px sans-serif">
    <img src="data:image/png;base64,${s.b64}" style="width:520px;display:block;margin-bottom:6px">${s.slug}</div>`).join("")}
</body>`);
const out = `${process.env.HOME}/Desktop/pdd-theme-preview.png`;
await Bun.write(out, await page.screenshot({ type: "png", fullPage: true }));
await browser.close();
console.log(`\nPreview sheet → ${out}`);
```

- [ ] **Step 7: Generate the sheet and CHECKPOINT — user approval**

Run: `bun carousel/preview-sheet.mjs`
Expected: `~/Desktop/pdd-theme-preview.png` with all six themed slides; car (orange) and tech (blue) must look unchanged from live posts.
**GATE (spec §5): show the sheet to the user; iterate token/craft tweaks until approved. Do not proceed to Task 8 without explicit approval.** Also verify: no `·`-for-`×` glyph corruption in any theme's sample title, and each theme's price pill is legible when the image is viewed at ~20% zoom (grid test).

- [ ] **Step 8: Commit**

```bash
git add carousel/assets/fonts/*.woff2 carousel/fonts.mjs carousel/styles.css carousel/render.mjs carousel/build.mjs carousel/preview-sheet.mjs carousel/tests/render.test.mjs
git commit -m "feat(carousel): 6-theme design system — per-theme fonts/particles/craft details, hard render gate"
```

---

### Task 8: Honesty guard + alt text in `build.mjs`

**Files:**
- Modify: `carousel/build.mjs`
- Create: `carousel/honesty.mjs`
- Test: `carousel/tests/honesty.test.mjs`

**Interfaces:**
- Produces: `valueLine(totalPrizeValue, slug) → string` (`""` unless `totalPrizeValue >= catCfg(slug).valueLineMin`; formatted `£{floor to 1000, en-GB}+`), `altTexts(sel, drawSlides) → string[]` (aligned to final slide order: intro, draws…, cta).
- `build.mjs` writes `out/alt.json` (the array) and uses `valueLine()` for the intro `value`.

- [ ] **Step 1: Write the failing test**

```js
// carousel/tests/honesty.test.mjs
import { test, expect } from "bun:test";
import { valueLine, altTexts } from "../honesty.mjs";

test("value line suppressed below the per-category bar (collectibles £15k incident guard)", () => {
  expect(valueLine(1000, "collectibles")).toBe("");          // real prizes ~£1k → NO claim
  expect(valueLine(9000, "collectibles")).toBe("£9,000+");   // above collectibles bar (8000)
  expect(valueLine(15000, "car-draws")).toBe("");             // below car bar (20000)
  expect(valueLine(131000, "luxury")).toBe("£131,000+");
  expect(valueLine(50, "unknown-cat")).toBe("");              // unknown → Infinity bar → never
});

test("altTexts covers every slide with searchable, honest copy", () => {
  const sel = { name: "Luxury", slug: "luxury", seoKeyword: "UK luxury watch competitions", draws: [{}, {}] };
  const slides = [
    { title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT" },
    { title: "Omega Seamaster", price: "£2", closes: "CLOSES FRI 10 JUL" },
  ];
  const alts = altTexts(sel, slides);
  expect(alts.length).toBe(4);                                  // intro + 2 draws + cta
  expect(alts[0]).toContain("UK luxury watch competitions");
  expect(alts[1]).toContain("Rolex Daytona");
  expect(alts[1]).toContain("£4.97");
  expect(alts[1]).toContain("18+");
  expect(alts[3]).toContain("prizedrawsdaily");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test carousel/tests/honesty.test.mjs`
Expected: FAIL — `Cannot find module '../honesty.mjs'`

- [ ] **Step 3: Write honesty.mjs**

```js
// carousel/honesty.mjs — truth guards (spec §7.1) + IG-SEO alt text (spec §4.6).
// total_prize_value is GROSS TICKET REVENUE (entries × price), NOT prize worth —
// the "£X+ IN PRIZES" line only renders past a per-category defensibility bar.
import { catCfg } from "./config.mjs";

export function valueLine(totalPrizeValue, slug) {
  const total = Number(totalPrizeValue) || 0;
  if (total < catCfg(slug).valueLineMin || total < 1000) return "";
  return `£${(Math.floor(total / 1000) * 1000).toLocaleString("en-GB")}+`;
}

export function altTexts(sel, drawSlides) {
  const kw = sel.seoKeyword || catCfg(sel.slug).seoKeyword;
  const intro = `${drawSlides.length} ${kw} closing this week — prize draw round-up from Prize Draws Daily (18+, UK only).`;
  const draws = drawSlides.map((s) =>
    `${s.title} prize draw — tickets ${s.price || "available"}, ${String(s.closes || "").toLowerCase()} (18+, UK only).`);
  const cta = `See every live UK prize draw at prizedrawsdaily.co.uk — @prizedrawsdaily (18+, UK only).`;
  return [intro, ...draws, cta];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test carousel/tests/honesty.test.mjs`
Expected: 2 pass.

- [ ] **Step 5: Wire into build.mjs**

Replace the `totalValue`/`value` block (build.mjs:127-130) with:

```js
import { valueLine, altTexts } from "./honesty.mjs";   // ← top of file
const totalValue = sel.draws.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
const value = valueLine(totalValue, sel.slug);
```

and after the slide PNG write-loop (build.mjs:156) add:

```js
await Bun.write(`${outDir}/alt.json`, JSON.stringify(altTexts(sel, drawSlides), null, 2));
```

- [ ] **Step 6: Verify + commit**

Run: `bun test carousel/tests/`
Expected: all green.

```bash
git add carousel/honesty.mjs carousel/build.mjs carousel/tests/honesty.test.mjs
git commit -m "feat(carousel): honesty guard for the value line + per-slide IG-SEO alt text"
```

---

### Task 9: Caption briefing system

Claude writes captions daily from a generated fact briefing (spec §4.6) — no more verbatim template strings. `caption.mjs` keeps a keyword-led fallback for dry runs.

**Files:**
- Create: `carousel/brief.mjs`
- Modify: `carousel/caption.mjs`, `carousel/build.mjs`
- Test: `carousel/tests/brief.test.mjs`

**Interfaces:**
- Produces: `buildBriefing({ sel, drawSlides, recentOpeners = [] }) → string` (markdown briefing: facts table, archetype instruction, series line, SEO keyword rule, banned list incl. `recentOpeners`, hashtag pool, compliance line). `hashtagsFor(slug) → string` (3 fixed + 2 category, space-joined).
- `caption.mjs`: `buildCaption` head becomes keyword-led (`"${seoKeyword} closing this week 👇"` when `seoKeyword` passed as new 4th arg — signature `buildCaption(catName, slug, items, seoKeyword)`; older 3-arg calls keep old head). `buildFbCaption` unchanged.
- `build.mjs` writes `out/BRIEFING.md` and passes `sel.seoKeyword` into `buildCaption` for the fallback `CAPTION.txt`.

- [ ] **Step 1: Write the failing test**

```js
// carousel/tests/brief.test.mjs
import { test, expect } from "bun:test";
import { buildBriefing } from "../brief.mjs";

const sel = { name: "Luxury", slug: "luxury", seoKeyword: "UK luxury watch competitions", archetype: "price-anchor" };
const slides = [{ title: "Rolex Daytona", price: "£4.97", closes: "CLOSES TONIGHT", odds: "1 IN 799", cashAlt: "£16,000 TAX-FREE CASH" }];

test("briefing carries facts, archetype, keyword rule, series and bans", () => {
  const b = buildBriefing({ sel, drawSlides: slides, recentOpeners: ["UK luxury draws closing"] });
  expect(b).toContain("Rolex Daytona");
  expect(b).toContain("£4.97");
  expect(b).toContain("1 IN 799");
  expect(b).toContain("price-anchor");
  expect(b).toContain("UK luxury watch competitions");
  expect(b).toContain("TONIGHT'S UK DRAWS");
  expect(b).toContain("don't miss out");            // banned list included…
  expect(b).toContain("UK luxury draws closing");   // …plus recent openers
  expect(b).toContain("18+");
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: write brief.mjs**

```js
// carousel/brief.mjs — generates the caption BRIEFING Claude writes from (spec §4.6).
// The briefing is instructions + verified facts; Claude authors the final caption.
import { GLOBAL, catCfg } from "./config.mjs";

export const hashtagsFor = (slug) => [...GLOBAL.fixedHashtags, ...catCfg(slug).hashtags].join(" ");

export function buildBriefing({ sel, drawSlides, recentOpeners = [] }) {
  const kw = sel.seoKeyword || catCfg(sel.slug).seoKeyword;
  const rows = drawSlides.map((s, i) =>
    `| ${i + 1} | ${s.title} | ${s.price || "?"} | ${s.closes || "?"} | ${s.odds || "—"} | ${s.cashAlt || "—"} |`).join("\n");
  const banned = [...GLOBAL.bannedPhrases, ...recentOpeners].map((p) => `- "${p}"`).join("\n");
  return `# Caption briefing — ${sel.name} (${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" })})

## Verified facts (ONLY these may be claimed)
| # | Prize | Ticket | Closes | Odds | Cash alt |
|---|-------|--------|--------|------|----------|
${rows}

## Instructions
- Hook archetype today: **${sel.archetype || "price-anchor"}** (question / price-anchor / deadline / absurd-comparison).
- FIRST sentence must contain the keyword naturally: **"${kw}"** (IG SEO), THEN the hook.
- Include ≥1 concrete, verifiable, specific detail (e.g. "a Daytona for less than a meal deal").
- Series line near the end: **we post TONIGHT'S UK DRAWS every night — follow so you don't miss yours** (follow-first, site second).
- One send-CTA, fresh wording each day (never verbatim-repeat "send this to your comp buddy").
- Comper vernacular welcome (GTD, odds, exact close times) — but ONLY when the facts table proves it.
- End with: link in bio · 18+ · UK only · Play responsibly
- Then hashtags exactly: ${hashtagsFor(sel.slug)}

## Banned phrases (templated tells + last-14-day openers)
${banned}

Write the IG caption (≤2,200 chars) AND a fuller FB caption (with the clickable link https://prizedrawsdaily.co.uk in the body). Save over out/CAPTION.txt (IG) before publish; FB caption goes into publish.json fbCaption.`;
}
```

- [ ] **Step 4: Run test to verify it passes** (`bun test carousel/tests/brief.test.mjs`)

- [ ] **Step 5: Wire build.mjs + keyword fallback caption**

In `caption.mjs` change the signature and head:

```js
export function buildCaption(catName, slug, items = [], seoKeyword = null) {
  const head = seoKeyword
    ? `${seoKeyword} closing this week 👇`
    : `UK ${nounOf(catName)} draws closing this week 👇`;
```

In `build.mjs`, replace the caption block (lines 158-160) with:

```js
import { buildBriefing } from "./brief.mjs";           // ← top of file
import { recentPosts } from "./state.mjs";              // ← top of file
let recentOpeners = [];
try { recentOpeners = (await recentPosts(14)).map((r) => (r.caption || "").split("\n")[0]).filter(Boolean); } catch {}
const caption = buildCaption(sel.name, sel.slug, drawSlides.map((s) => ({ title: s.title, price: s.price })), sel.seoKeyword);
await Bun.write(`${outDir}/CAPTION.txt`, caption);
await Bun.write(`${outDir}/BRIEFING.md`, buildBriefing({ sel, drawSlides, recentOpeners }));
console.log("\n--- FALLBACK CAPTION (Claude: rewrite from BRIEFING.md) ---\n" + caption);
```

- [ ] **Step 6: Verify + commit**

Run: `bun test carousel/tests/`
Expected: all green.

```bash
git add carousel/brief.mjs carousel/caption.mjs carousel/build.mjs carousel/tests/brief.test.mjs
git commit -m "feat(carousel): caption briefing system — Claude authors captions from verified facts"
```

---

### Task 10: `publish.mjs` write-ahead + watchdog + DAILY.md v2

**Files:**
- Modify: `carousel/publish.mjs`, `carousel/DAILY.md`
- Create: `carousel/freshness.mjs`

**Interfaces:**
- `publish.mjs` additionally: reads `out/alt.json` → `altTexts` array into `publish.json`; reads `selection.json`'s `seoKeyword`/`archetype`; wraps `ensureBucket`/`upload` in `withRetry`; takes `IG_USER_ID`/bucket/url from config; **before exiting, calls `upsertPost({date, format:"carousel", status:"assets_uploaded", category, draw_slugs, hook_archetype, seo_keyword, caption, asset_urls: urls})`** — the write-ahead row. After Claude posts via Composio it runs `bun carousel/state-mark.mjs carousel published --ig <media_id>` (and `fb_photo published --fb <post_id>`).
- `freshness.mjs`: prints `OK <date>` (exit 0) if a published row exists within 36h, else `STALE <hours>h — streak at risk` (exit 1). Uses the publishable key (anon SELECT policy) so it runs anywhere.

- [ ] **Step 1: Edit publish.mjs**

Top of file — replace the consts (lines 14-19) with:

```js
import { GLOBAL, workDir } from "./config.mjs";
import { withRetry } from "./util.mjs";
import { upsertPost, todayLondon } from "./state.mjs";
const DIR = workDir();
const OUT = `${DIR}/out`;
const SUPABASE_URL = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = GLOBAL.bucket;
const IG_USER_ID = GLOBAL.igUserId;
```

Wrap the two network helpers: `await withRetry(() => ensureBucket(), { label: "ensureBucket" });` and in the upload loop `const url = await withRetry(() => upload(path, jpeg), { label: "upload" });` (keep function bodies as-is).

Replace the final `publish` object + write (lines 94-96) with:

```js
const altTexts = await Bun.file(`${OUT}/alt.json`).json().catch(() => []);
const publish = { date: today, category: sel.slug, seoKeyword: sel.seoKeyword || null, archetype: sel.archetype || null, igUserId: IG_USER_ID, caption, fbCaption, heroUrl, urls, altTexts };
await Bun.write(`${OUT}/publish.json`, JSON.stringify(publish, null, 2));
await upsertPost({
  date: todayLondon(), format: "carousel", status: "assets_uploaded",
  category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
  hook_archetype: sel.archetype || null, seo_keyword: sel.seoKeyword || null,
  caption, asset_urls: urls,
});
console.log("✓ write-ahead row: carousel assets_uploaded (idempotent re-runs will not double-post)");
```

Also add an **idempotency preflight** right after `sel` is loaded (after line 29):

```js
import { getPost } from "./state.mjs";  // (merge into the state.mjs import above)
const existing = await getPost(todayLondon(), "carousel").catch(() => null);
if (existing?.status === "published") {
  console.error(`✗ Today's carousel is already PUBLISHED (ig_media_id=${existing.ig_media_id}). Refusing to re-publish. Use state-mark.mjs if this is wrong.`);
  process.exit(2);
}
```

- [ ] **Step 2: Write freshness.mjs**

```js
// carousel/freshness.mjs — dead-man's-switch check (spec §4.10). Anon-readable.
// Run anywhere: bun carousel/freshness.mjs   (exit 0 = fresh, 1 = stale)
import { GLOBAL } from "./config.mjs";
const KEY = GLOBAL.supabasePublishableKey;
const r = await fetch(`${GLOBAL.supabaseUrl}/rest/v1/carousel_posts?status=eq.published&order=posted_at.desc&limit=1`,
  { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
const [last] = r.ok ? await r.json() : [];
if (!last?.posted_at) { console.log("STALE — no published posts recorded yet"); process.exit(1); }
const hours = (Date.now() - new Date(last.posted_at).getTime()) / 3600000;
if (hours > 36) { console.log(`STALE ${hours.toFixed(0)}h since last post (${last.date}) — streak at risk, say "publish today"`); process.exit(1); }
console.log(`OK last post ${last.date} (${hours.toFixed(1)}h ago)`);
```

Run: `bun carousel/freshness.mjs` — expected `STALE — no published posts recorded yet` (exit 1) until the first state-tracked publish.

- [ ] **Step 3: Set up the watchdog (operator step, uses the `schedule` skill)**

Create a scheduled cloud routine (daily ~15:45 IST) whose prompt is: *"GET `https://kkuuwksgyypicnblwubs.supabase.co/rest/v1/carousel_posts?status=eq.published&order=posted_at.desc&limit=1` with header `apikey: sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs` (public anon read). If the newest `posted_at` is older than 36 hours (or no rows), notify the user: '📸 PDD streak at risk — no post in >36h. Open Claude Code and say **publish today**.' Otherwise do nothing."* (No repo/secrets needed — the anon key is public by design and RLS allows SELECT only.)

- [ ] **Step 3b: Surface fetchimg failures (spec §4.9 — no more silent zero-photo draws)**

In `carousel/fetchimg.mjs`, add a module-level `const problems = [];` and in each per-draw `catch` block (the per-draw try/catch around the scrape, and the zero-candidates path) push `problems.push({ slug: d.slug, reason: e?.message || "no candidates" })`. After the main loop, before the final console output, add:

```js
await Bun.write(`${FETCHED}/report.json`, JSON.stringify({ date: new Date().toISOString(), problems }, null, 2));
if (problems.length) console.log(`⚠ ${problems.length} draw(s) had photo problems (see .fetched/report.json):`, problems.map((p) => p.slug).join(", "));
```

(`FETCHED` = the `.fetched` output dir variable already defined in the file; match its actual name when editing.) Verify: `PDD_DIR=/tmp/pdd-fi bun carousel/plan.mjs && PDD_DIR=/tmp/pdd-fi bun carousel/fetchimg.mjs && cat /tmp/pdd-fi/.fetched/report.json` → JSON with a `problems` array (possibly empty), then `rm -rf /tmp/pdd-fi`.

- [ ] **Step 4: Rewrite DAILY.md** — update these sections to match the new flow: photos priority unchanged; step 4 adds "build writes `BRIEFING.md` — Claude writes the final IG caption over `CAPTION.txt` + FB caption from it"; step 5 adds "publish.mjs records the write-ahead row and refuses double-publish; after Composio posting run `bun carousel/state-mark.mjs carousel published --ig <media_id>` and `bun carousel/state-mark.mjs fb_photo published --fb <post_id>`"; add a "State & watchdog" section documenting `carousel_posts`/`carousel_metrics`, `freshness.mjs`, the 14-day archive, and `PDD_DIR`; add a "One-time IG SEO" note reminding the user to change the IG display name in-app to **"Prize Draws Daily | UK Competitions"** (spec §4.6 — strongest IG-search signal; only the user can do this from the app).

- [ ] **Step 5: Full-suite verify + dry run**

Run: `bun test carousel/tests/ && PDD_DIR=/tmp/pdd-dryrun bun carousel/plan.mjs && PDD_DIR=/tmp/pdd-dryrun bun carousel/build.mjs && ls /tmp/pdd-dryrun/out/`
Expected: tests green; `out/` contains `01-intro.png … NN-cta.png`, `CAPTION.txt`, `BRIEFING.md`, `alt.json`. (fetchimg skipped → draws render as typographic cards; that's the expected dry-run look. Clean up: `rm -rf /tmp/pdd-dryrun`.)

- [ ] **Step 6: Commit + push**

```bash
git add carousel/publish.mjs carousel/freshness.mjs carousel/DAILY.md
git commit -m "feat(carousel): write-ahead publish state + idempotency + dead-man's-switch freshness check"
git push origin main
```

---

## Phase 2/3 pointer

Phase 2 (reel.mjs WAAPI seek-and-capture, story.mjs, insights.mjs, Reel-first publish machine) and Phase 3 (learn/report, engagement hit-lists, collab pitches, scheduled-run trial) get their own plan documents once Phase 1's preview sheet is approved and the state layer is live — their interfaces build directly on `config.mjs`/`state.mjs`/`renderSlides(slides, theme, particles)` as defined here.
