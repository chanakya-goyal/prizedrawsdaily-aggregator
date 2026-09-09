// PrizeDrawsDaily aggregator — KEYLESS orchestrator (no LLM).
//   DRY_RUN=true (default) prints; DRY_RUN=false inserts (needs SUPABASE_SERVICE_ROLE_KEY).
// Operators come from operators.json; METHODS selects which of them run (the daily Action
// sweeps them all: api,render,woo,shopify).
// Fields are filled deterministically (lib/parse.mjs), gated (gate.mjs), given a template
// description (lib/describe.mjs) and inserted as 'draft'. A draft goes live only when a LATER
// run re-reads the same URL and agrees with it (lib/verify.mjs) — publishing is this script's
// job now, not the cowork routine's, which QAs the result and rewrites descriptions.
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./lib/browser.mjs";
import { renderOperator, wooOperator, shopifyOperator, apiOperator, dedupe, makeContext, renderLivenessMode, pageBlocks } from "./extractor.mjs";
import { gate } from "./gate.mjs";
import { templateDescription } from "./lib/describe.mjs";
import { fieldFlags, buildHealthReport, writeStepSummary, checkImage, probeSilentReasons } from "./lib/manager.mjs";
import { rehostImage } from "./lib/rehost.mjs";
import { summarise, byPublishUrgency } from "./lib/verify.mjs";
import { permalinkKey } from "./lib/liveness.mjs";
import { routeDraw } from "./lib/route.mjs";
import { shardConfig, shardOf, shardedPublishCap, rotateRoster, rosterOffset } from "./lib/shard.mjs";
import { fetchWithRetry } from "./lib/fetcher.mjs";
import { CATEGORIES } from "./lib/parse.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const DRY_RUN = process.env.DRY_RUN !== "false";
const PUBLISH_STATUS = process.env.PUBLISH_STATUS || "draft"; // cowork owns publish; keep draft by default
const PER_OP = Number(process.env.PER_OP || 5);             // render: per-op cap (browser cost — keep modest)
// woo/shopify hit a single cheap JSON endpoint, so there's no per-product cost to capturing the
// whole live catalogue. With orderby=date a low cap only ever sees the newest few products and
// silently drops every older-but-still-live competition (the 213-vs-600+ capture gap). The gate
// still rejects anything missing price/entries/date, so a high cap can only ADD valid draws.
const PER_OP_API = Number(process.env.PER_OP_API || 60);
const BATCHES = Number(process.env.BATCHES || 1);            // no LLM quota → full coverage daily
const MAX_PAGES = Number(process.env.MAX_DRAWS || 2000);    // backstop on pages read per run (raised with PER_OP_API)
// Auto-publish a draft the moment a second independent scrape agrees with it (lib/verify.mjs).
// New rows are never published on first sighting — PUBLISH_STATUS still governs those.
// OPT-IN, not opt-out: only AUTO_PUBLISH="true" turns it on, and the daily Action is the one
// place that sets it. A default of ON would mean every other caller — a local shell holding
// the service key, the cowork routine's own scrape, a one-off `ONLY=x bun run.mjs` — silently
// publishes to the live site as a side effect of a debugging run, and doubles as the "second
// independent observation" for rows the Action inserted hours earlier. The verdicts are still
// computed and reported when it is off; they just aren't acted on.
const AUTO_PUBLISH = process.env.AUTO_PUBLISH === "true";
// Ceiling on how many rows one run may publish. A scoring mistake is then bounded to this
// many rows for at most a day, rather than the whole backlog at once.
const AUTO_PUBLISH_MAX = Number(process.env.AUTO_PUBLISH_MAX || 200);
// Correcting a LIVE row is a different risk to publishing a draft: it is a single-observation
// write onto something the public is already seeing, with no agreement test available. Quality
// is guarded per-row by correctionDecision, but quantity needs its own ceiling — a parser
// regression that passes fieldFlags could otherwise rewrite the whole live catalogue in one
// run. CORRECT_LIVE=false stops corrections entirely without touching publishing.
const CORRECT_LIVE = process.env.CORRECT_LIVE !== "false";
const CORRECT_MAX = Number(process.env.CORRECT_MAX || 100);
// Minimum wall-clock between a draft's FIRST sighting and its publication. 0 = off, which is
// correct for a single daily run (the gap is ~24h by construction). The higher-cadence JSON
// sweep sets it, or several runs a day would collapse the two-observation rule into one.
const MIN_OBSERVATION_GAP_MS = Number(process.env.MIN_OBSERVATION_GAP_MS || 0);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const METHODS = process.env.METHODS ? new Set(process.env.METHODS.split(",").map((s) => s.trim())) : null;
const READ_KEY = SERVICE_KEY || ANON_KEY;
// No hardcoded key fallback. The `sb_publishable_h-iA9…` literal that used to sit on ANON_KEY
// has returned 401 since the project moved, so it was not a working fallback — it was a false
// affordance that made a keyless invocation look supported and then failed three layers down
// with an opaque 401 from whichever request happened to run first.
if (!READ_KEY) {
  console.error("No Supabase key available. Bun auto-loads .env — check SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_PUBLISHABLE_KEY) is set there.");
  process.exit(1);
}

const now = new Date();
const slugify = (s) => (s || "draw").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draw";
// Match the website's convention: "<title>-<operatorSlug>", regex-safe, <=120 chars.
const makeSlug = (title, opSlug) => `${slugify(title).slice(0, Math.max(8, 119 - opSlug.length))}-${opSlug}`.slice(0, 120);

// Every Supabase call carries a hard timeout: one silently-dead TCP connection with no
// RST is an infinite await in Bun's fetch, and it stalled two full Action runs for 2h+
// on 2026-08-14 (the flush after Red Hot Raffles both times).
const SB_TIMEOUT = { signal: () => AbortSignal.timeout(30000) };
async function sbGet(path) {
  // Reads are idempotent, and the preload pages through ~4,700 draws — a single transient
  // Supabase timeout used to kill the WHOLE run before a single operator was scraped, losing
  // the day's inventory. (Supabase REST here 522s/times out intermittently.) Retry the read;
  // the init is a factory so each attempt gets a fresh 30s signal.
  const r = await fetchWithRetry(
    `${SUPABASE_URL}/rest/v1/${path}`,
    () => ({ headers: { apikey: READ_KEY, Authorization: `Bearer ${READ_KEY}` }, signal: SB_TIMEOUT.signal() }),
    { attempts: 3, onRetry: ({ attempt, status, error }) => console.log(`  ↻ Supabase read retry ${attempt} (${status ? `HTTP ${status}` : error})`) },
  );
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
// PostgREST silently caps any select at 1000 rows — page through or the dedupe maps go blind
// past 1000 draws (slug collisions → 409 → the whole insert stage dies).
async function sbGetAll(path, pageSize = 1000) {
  const sep = path.includes("?") ? "&" : "?";
  const rows = [];
  // Paging with limit/offset over an UNORDERED query is unsound: Postgres guarantees no row
  // order without ORDER BY, so two pages can overlap or skip rows if the plan changes between
  // requests — and a skipped draw looks brand new, so it gets inserted a second time. Ordering
  // on the primary key makes the window stable. (Any caller that sets its own order wins.)
  const order = path.includes("order=") ? "" : "&order=id.asc";
  for (let offset = 0; ; offset += pageSize) {
    const page = await sbGet(`${path}${sep}limit=${pageSize}&offset=${offset}${order}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
async function sbInsert(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/draws`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(rows),
    signal: SB_TIMEOUT.signal(),
  });
  if (!r.ok) throw new Error(`INSERT → ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpdate(id, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/draws?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(row),
    signal: SB_TIMEOUT.signal(),
  });
  if (!r.ok) throw new Error(`UPDATE ${id} → ${r.status} ${await r.text()}`);
}

// ---- pick operators for this run ----
// OPERATORS_FILE lets a caller (discovery/onboard.mjs's dry-run spawn) point this at a throwaway
// temp copy — e.g. to test-drive a candidate entry — without ever touching the real config.
let operators = await Bun.file(process.env.OPERATORS_FILE || "operators.json").json();
operators = operators.filter((o) => o.enabled !== false && !o.aiAssist); // exclude disabled + aiAssist (cowork handles those)
if (METHODS) operators = operators.filter((o) => METHODS.has(o.method));
if (ONLY) operators = operators.filter((o) => ONLY.has(o.slug));
const expectedSlugs = operators.map((o) => o.slug);
const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
const batch = dayOfYear % BATCHES;
if (!ONLY && BATCHES > 1) operators = operators.filter((_, i) => i % BATCHES === batch);
// PARALLEL sharding, which is the opposite trade to BATCHES above: BATCHES scrapes 1/N of the
// roster each DAY and cycles, buying runtime by giving up freshness; a shard is 1/N of the
// roster scraped TODAY, alongside the other shards, buying runtime with concurrency. Needed
// past ~200 operators: measured 0.35 min/op, the JSON sweep projects to ~63 min at 300
// operators against a 60 min job cap. Defaults to 1 shard, i.e. today's behaviour exactly.
const SHARD = shardConfig(process.env);
if (!ONLY && SHARD.count > 1) operators = shardOf(operators, SHARD.index, SHARD.count);
// Rotate the run order. Every scarce resource in this run — the publish cap, RUN_DEADLINE_MIN,
// MAX_PAGES — is spent in roster order, and operators.json order never changes, so the back of
// the list was permanently excluded rather than occasionally unlucky. Applied AFTER sharding so
// shard membership stays stable and only the order inside a shard moves.
if (!ONLY) operators = rotateRoster(operators, rosterOffset(now));
// AUTO_PUBLISH_MAX is a per-PROCESS counter. Without dividing it, N shards running at once
// would each publish up to the full cap and the day's real ceiling would be N times what was
// budgeted — the same mistake the workflow split had to avoid, one level down.
const PUBLISH_CAP = shardedPublishCap(AUTO_PUBLISH_MAX, SHARD.count);

console.log(`${DRY_RUN ? "DRY RUN" : "LIVE"} — ${now.toISOString()} | keyless | methods ${METHODS ? [...METHODS].join("+") : "all"} | batch ${batch + 1}/${BATCHES}${SHARD.count > 1 ? ` | shard ${SHARD.index + 1}/${SHARD.count}` : ""} | ${operators.length} operators | PER_OP ${PER_OP} | status '${PUBLISH_STATUS}'\n`);
if (!DRY_RUN && !SERVICE_KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const cats = await sbGet("categories?select=id,slug");
const catMap = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
// Every slug the classifier can assign MUST have a categories row here, because the two
// halves of the publish gate look at different things: `fieldFlags` decides "is this draw
// categorised?" from the SLUG, while the insert writes `catMap[slug]` — the DB id. A slug
// with no row therefore passes unflagged AND writes category_id NULL, and the row publishes
// live with no category at all, invisible to every category page, with nothing left to
// re-check it. Assert the two lists agree before a single operator is scraped, so a missing
// migration is a loud day-one failure instead of a silent backlog of NULL-category publishes.
const missingCats = CATEGORIES.filter((slug) => !catMap[slug]);
if (missingCats.length) {
  console.error(`\n✖ categories table is missing ${missingCats.length} slug(s) the classifier can assign:`);
  for (const slug of missingCats) console.error(`    · ${slug}`);
  console.error("  Apply supabase/migrations/20260821200000_sports_home_categories.sql in the site repo");
  console.error("  (it adds the missing categories rows AND draws.category_source), then re-run.\n");
  process.exit(1);
}
const dbOps = await sbGet("operators?select=id,slug");
const opMap = Object.fromEntries(dbOps.map((o) => [o.slug, o.id]));
// The field values come back too, not just identity: publish verification compares this
// stored observation against today's fresh scrape (see lib/verify.mjs). `category_id` +
// `category_source` come back for a second reason — they are the record of a judgment the
// rules cannot reproduce, so every write path below has to read them before it overwrites.
const existing = await sbGetAll("draws?select=id,entry_url,slug,status,title,ticket_price,total_entries,total_prize_value,draw_date,image_url,prize_description,category_id,category_source,created_at");
const byUrl = new Map(existing.filter((d) => d.entry_url).map((d) => [d.entry_url, d]));
const takenSlugs = new Set(existing.map((d) => d.slug));
// Canonical keys of every draw we already hold, so a capped operator still re-reads them.
const knownUrls = new Set(existing.filter((d) => d.entry_url).map((d) => permalinkKey(d.entry_url)));
console.log(`loaded ${cats.length} cats, ${dbOps.length} operators, ${existing.length} existing draws\n`);

const needsBrowser = operators.some((o) => o.method === "render");
const browser = needsBrowser ? await chromium.launch(chromiumLaunchOptions({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })) : null;
const ctx = browser ? await makeContext(browser) : null;

const toInsert = [];
const toUpdate = [];
const counts = [];
const verdicts = [];
// Publish candidates for the WHOLE run, settled once at the end. They used to be settled inside
// each flush(), which meant urgency only applied within an arbitrary 25-row batch while the cap
// counter was run-wide: an early flush could spend the budget on a draw closing in three weeks
// before a later operator's draw closing tomorrow had even been scraped. Sorting once, over
// everything, is the only way the cap is genuinely a budget for the run. (Raised in review on
// PR #40.) Rows sit in the DB as draft until settled, so nothing is half-published if the run
// dies; the next run simply re-verifies them.
const publishQueue = [];
let pages = 0, skipped = 0, autoPublished = 0, relisted = 0, correctedLive = 0;
// Render-path comps whose page visibly says the competition has finished. In `report` mode
// these are counted and kept; in `enforce` they are counted and dropped. Either way the
// number is printed — an unreported inventory change is the failure mode this fleet exists
// to prevent, and a drop is a removal of inventory.
const renderFinished = [];

// Incremental flush: re-host + write pending rows every few operators so a job-timeout
// kill loses only the tail, never the sweep (the 2026-08-14 90-min cancel lost a full
// 90-minute scrape because inserts only happened at the very end).
const sbCreds = { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY };
let totalNew = 0, totalRefreshed = 0, rehosted = 0, missed = 0, inserted = 0, insertSkipped = 0, updated = 0, liveInserted = 0;
// Race-based bound: unlike a fetch AbortSignal (which Bun has historically not honoured in
// every stage of a request), Promise.race ALWAYS resolves the await — the stalled work is
// leaked, not waited on. Used around flush IO because a hung await inside flush is
// unreachable by both the per-op budget and the loop-top deadline check.
const raced = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${Math.round(ms / 1000)}s`)), ms))]);
async function flush() {
  totalNew += toInsert.length; totalRefreshed += toUpdate.length;
  if (DRY_RUN || (!toInsert.length && !toUpdate.length)) { toInsert.length = 0; toUpdate.length = 0; return; }
  console.log(`  💾 flushing ${toInsert.length} new + ${toUpdate.length} refreshed…`); // stage marker — if a run stalls, the log shows whether it died in rehost/insert/update
  // Re-host every image onto our own Storage BEFORE writing, so the site never hotlinks a
  // third-party host (which breaks under Cloudflare bot protection — the root cause of
  // operator images silently breaking). A fetch miss keeps the original URL, never blocks.
  // Re-hosting was SEQUENTIAL with a 90s cap per image, so one flush of 55 images could
  // occupy 82 minutes — most of the Action's 130-minute deadline — and a live run was
  // observed making no DB writes at all for 20 minutes while it ground through Dream Car
  // images that weserv cannot proxy. These fetches are independent and IO-bound, so run them
  // concurrently and give each a much tighter budget: a slow image is not worth waiting for
  // when the fallback (keep the origin URL) is already graceful and costs nothing.
  const REHOST_CONCURRENCY = Number(process.env.REHOST_CONCURRENCY || 6);
  const REHOST_TIMEOUT_MS = Number(process.env.REHOST_TIMEOUT_MS || 30_000);
  const queue = [...toInsert, ...toUpdate].filter((it) => it.row.image_url && (it.row.slug || it.slug));
  let qi = 0;
  await Promise.all(Array.from({ length: Math.min(REHOST_CONCURRENCY, queue.length) }, async () => {
    while (qi < queue.length) {
      const item = queue[qi++];
      const drawSlug = item.row.slug || item.slug;
      try {
        const res = await raced(rehostImage(item.row.image_url, item.opSlug, drawSlug, sbCreds), REHOST_TIMEOUT_MS, "re-host");
        if (res.changed) { item.row.image_url = res.url; rehosted++; }
        else if (res.via === "miss") { missed++; console.log(`  ⚠️ image unreachable, kept origin: ${drawSlug.slice(0, 44)}`); }
      } catch (e) { missed++; console.log(`  ! re-host failed ${drawSlug.slice(0, 40)}: ${(e.message || "").slice(0, 60)}`); }
    }
  }));
  liveInserted += toInsert.filter((x) => x.row.status === "active").length;
  let flushed = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const batch = toInsert.slice(i, i + 50).map((x) => x.row);
    try {
      flushed += (await raced(sbInsert(batch), 60_000, "insert")).length;
    } catch (e) {
      // A single bad row (e.g. a duplicate slug/entry_url race with another run) must not
      // sink the whole batch — retry row by row and skip only the offender.
      for (const row of batch) {
        try { flushed += (await raced(sbInsert([row]), 60_000, "insert")).length; }
        catch (e2) { insertSkipped++; console.log(`  ⏭ insert skipped ${row.slug}: ${(e2.message || "").slice(0, 70)}`); }
      }
    }
  }
  inserted += flushed;
  // Publish gate, final step. The image is checked HERE rather than at verdict time because
  // re-hosting above has just rewritten image_url to our own storage — checking the operator's
  // original URL would test the wrong thing. Anything that isn't a clean 2xx stays draft and
  // gets another chance tomorrow; we never publish a card we can't prove renders.
  // Queued, not settled here — see publishQueue. The image is checked at settle time rather
  // than now, so only the rows that actually win the budget cost a request.
  for (const u of toUpdate) if (u.candidate) publishQueue.push(u);
  let refreshed = 0;
  for (const u of toUpdate) { try { await raced(sbUpdate(u.id, u.row), 60_000, "update"); refreshed++; } catch (e) { console.log(`  ! update failed: ${(e.message || "").slice(0, 70)}`); } }
  updated += refreshed;
  console.log(`  💾 flush: +${flushed} inserted, +${refreshed} refreshed (${inserted}/${updated} total)`);
  toInsert.length = 0; toUpdate.length = 0;
}
// No single operator may monopolise the run (Red Hot Raffles ate 125 of 150 minutes on
// 2026-08-14): each op gets a hard wall-clock budget, and the whole run stops CLEANLY at
// a deadline safely under the job timeout — flushed, summarised, exit 0 — instead of
// being killed mid-work.
const OP_BUDGET_MS = Number(process.env.OP_BUDGET_MS || 8 * 60_000);
const DEADLINE_MIN = Number(process.env.RUN_DEADLINE_MIN || 0); // 0 = no deadline
const deadlineAt = DEADLINE_MIN ? now.getTime() + DEADLINE_MIN * 60_000 : Infinity;
const withBudget = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`op budget ${Math.round(ms / 1000)}s exceeded — skipping operator`)), ms))]);

// Spend the run's publish budget on the draws closest to closing. Skipping those kills them —
// 277 drafts died unpublished with a median 3.5-day window — while a draw three weeks out gets
// another chance tomorrow. The rows are already written (as draft); this only flips status, so
// a failure here costs nothing but a day.
async function settlePublish() {
  if (DRY_RUN || !AUTO_PUBLISH || !publishQueue.length) return;
  publishQueue.sort(byPublishUrgency);
  let capped = 0;
  for (const u of publishQueue) {
    if (autoPublished >= PUBLISH_CAP) { capped++; continue; }
    let ok = false, why = "image check timed out";
    try { const img = await raced(checkImage(u.row.image_url), 15_000, "image check"); ok = img.ok === true; why = `image ${img.reason}`; }
    catch { /* keep the timeout reason */ }
    if (!ok) { console.log(`  ⏸ held back at publish: ${u.slug.slice(0, 44)} — ${why}`); continue; }
    try { await raced(sbUpdate(u.id, { status: "active" }), 60_000, "publish"); u.row.status = "active"; autoPublished++; }
    catch (e) { console.log(`  ! publish failed ${u.slug.slice(0, 40)}: ${(e.message || "").slice(0, 60)}`); }
  }
  // One line, not one per row: at 110/run against ~190 candidates this would otherwise bury the
  // report. The soonest-closing draw that still missed out is the number worth seeing.
  if (capped) {
    const first = publishQueue[autoPublished]?.row?.draw_date;
    console.log(`  ⏸ ${capped} candidate(s) held by the run publish cap (${PUBLISH_CAP})` + (first ? ` — soonest missed closes ${String(first).slice(0, 10)}` : ""));
  }
}

for (const op of operators) {
  if (pages >= MAX_PAGES) { console.log(`\n⏹ hit MAX_PAGES cap (${MAX_PAGES}) — remaining operators run next time`); break; }
  if (Date.now() > deadlineAt) { console.log(`\n⏹ RUN_DEADLINE_MIN (${DEADLINE_MIN}m) reached — flushing and stopping early; remaining operators run next time`); break; }
  if (!opMap[op.slug]) { console.log(`· ${op.name}: not in DB, skip`); continue; }
  console.log(`\n── ${op.name} (${op.method}) ──`);
  const c = { slug: op.slug, scraped: 0, inserted: 0, published: 0, heldDraft: 0 };
  counts.push(c);
  let draws = [];
  try {
    if (op.method === "api") draws = await withBudget(apiOperator(op, PER_OP_API), OP_BUDGET_MS);
    // knownUrls: rows we already hold must be re-read every run even when the operator is
    // capped, or a published draw outside the cap can never be corrected or expired.
    else if (op.method === "woo") draws = await withBudget(wooOperator(op, PER_OP_API, { knownUrls }), OP_BUDGET_MS);
    else if (op.method === "shopify") draws = await withBudget(shopifyOperator(op, PER_OP_API, { knownUrls }), OP_BUDGET_MS);
    // `onFinished` mirrors dedupe's onDrop below: a removal of inventory that nobody counts
    // is the same silence that let dedupe destroy two thirds of a car operator's catalogue.
    else draws = await withBudget(renderOperator(ctx, op, PER_OP, { onFinished: (hit) => renderFinished.push(hit) }), OP_BUDGET_MS);
  } catch (e) { console.log(`  FAILED: ${(e.message || "").slice(0, 80)}`); c.pageBlocks = pageBlocks.get(op.slug) || null; continue; }
  // Product pages the WAF refused. Carried onto the per-operator count so the health report
  // can say "the cap was unreadable from this IP" instead of leaving 420 draws/day looking
  // like a parser that cannot find a number (see readProductPage in extractor.mjs).
  c.pageBlocks = pageBlocks.get(op.slug) || null;
  pages += draws.length;
  c.scraped = draws.length;
  // Report collapses. This was silent for months while it was destroying two thirds of a car
  // operator's inventory — a drop counter is what would have surfaced it.
  let dropped = 0;
  draws = dedupe(draws, { onDrop: () => { dropped++; } });
  if (dropped) console.log(`  ⧉ ${dropped} duplicate URL(s) collapsed`);
  for (const raw of draws) {
    const { pass, stage, reasons, draw: d } = gate(raw, now);
    if (!pass) { skipped++; console.log(`  ⏭  ${(raw.title || "?").slice(0, 40)} — ${stage}: ${reasons.join(", ")}`); continue; }
    const ex = byUrl.get(d.entry_url);
    // The five-way decision (insert / relist / correct / draft / skip) lives in lib/route.mjs so
    // it can be unit-tested; everything below is side effects only — pushes, counters, logging.
    const plan = routeDraw(ex, d, {
      now, catMap,
      autoPublish: AUTO_PUBLISH,
      correctLive: CORRECT_LIVE,
      correctRemaining: CORRECT_MAX - correctedLive,
      minObservationGapMs: MIN_OBSERVATION_GAP_MS,
    });
    const tpv = plan.tpv;

    if (plan.kind === "skip") {
      skipped++;
      // Silent when there's simply nothing to correct; loud when a flagged read was REFUSED,
      // because that is the parser breaking on a row the public can see.
      if (plan.reason === "no-correction" && plan.decision.flags.length && plan.decision.fields.length) {
        console.log(`  🚫 ${d.title.slice(0, 40)} — live row left alone: ${plan.decision.reason.slice(0, 90)}`);
      }
      if (plan.reason === "correction-cap") {
        console.log(`  ⏸ correction cap ${CORRECT_MAX} reached — ${d.title.slice(0, 40)} left for the next run`);
      }
      continue;
    }

    if (plan.kind === "relist") {
      byUrl.delete(d.entry_url);
      toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate: false, row: plan.row });
      relisted++; c.inserted++; c.heldDraft++;
      console.log(`  ↩️ ${d.title.slice(0, 44)} — relisted for ${String(d.draw_date).slice(0, 10)}, back as draft`);
      continue;
    }

    if (plan.kind === "correct") {
      byUrl.delete(d.entry_url);
      toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate: false, row: plan.row });
      correctedLive++;
      console.log(`  🔄 ${d.title.slice(0, 40)} — live row corrected: ${plan.decision.fields.join(", ")}`);
      continue;
    }

    if (plan.kind === "draft") {
      byUrl.delete(d.entry_url);
      verdicts.push(plan.verdict);
      toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate: plan.candidate, row: plan.row });
      c.inserted++;
      if (plan.candidate) { c.published++; console.log(`  ✅ ${d.title.slice(0, 44)} | £${d.ticket_price}×${d.total_entries} (verified — publishing)`); }
      else { c.heldDraft++; console.log(`  ♻️ ${d.title.slice(0, 44)} | £${d.ticket_price}×${d.total_entries} (held: ${plan.verdict.reasons.slice(0, 2).join("; ").slice(0, 80) || "auto-publish off"})`); }
      continue;
    }

    if (!d.description) d.description = templateDescription(d);
    const slug = (() => { let s = makeSlug(d.title, op.slug), i = 2; const b = s; while (takenSlugs.has(s)) s = `${b}-${i++}`.slice(0, 120); takenSlugs.add(s); return s; })();
    const flags = fieldFlags(d);
    const status = flags.length ? "draft" : PUBLISH_STATUS;
    if (status === "active") c.published++; else c.heldDraft++;
    c.inserted++;
    toInsert.push({
      opSlug: op.slug,
      row: {
        // `category_source` records HOW this row was categorised. 'rule' is re-checkable by the
        // nightly audit; null means the rules found no evidence and the row is waiting on a
        // judgment (it is held as a draft by the "no category evidence" flag above).
        slug, operator_id: opMap[op.slug], category_id: catMap[d.category] || null,
        category_source: catMap[d.category] ? "rule" : null,
        title: d.title, grand_prize: d.grand_prize, prize_description: d.description,
        image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
        total_prize_value: tpv, prize_value: null,
        draw_date: d.draw_date, entry_url: d.entry_url, affiliate_url: null,
        status, featured: false,
      },
      flags,
    });
    console.log(`  ✅ ${d.title.slice(0, 44)} | ${d.category} | £${d.ticket_price}×${d.total_entries}${flags.length ? "  ⚠️→draft: " + flags.join("; ") : ""}`);
  }
  if (!DRY_RUN && toInsert.length + toUpdate.length >= 25) await flush();
}
if (browser) await browser.close();
await flush();
await settlePublish();

if (renderFinished.length) {
  const mode = renderLivenessMode();
  const byOp = renderFinished.reduce((a, h) => { a[h.operator] = (a[h.operator] || 0) + 1; return a; }, {});
  console.log(`\n🏁 render liveness (${mode}): ${renderFinished.length} page(s) say finished — ` +
    Object.entries(byOp).map(([s, n]) => `${s}:${n}`).join(" "));
  await Bun.write("render-finished.json", JSON.stringify({ mode, total: renderFinished.length, byOperator: byOp, hits: renderFinished }, null, 2));
}
console.log(`\n\n==== ${totalNew} new, ${totalRefreshed} refreshed${relisted ? `, ${relisted} relisted` : ""}${correctedLive ? `, ${correctedLive} live rows corrected` : ""} (${pages} pages read, ${skipped} skipped) ====`);
if (DRY_RUN) {
  console.log("(dry run — nothing written)");
} else {
  console.log(`🖼  re-hosted ${rehosted} image(s) to Storage${missed ? `, ${missed} kept origin (unreachable)` : ""}`);
  console.log(`✅ inserted ${inserted} (${liveInserted} live, ${inserted - liveInserted} draft) · refreshed ${updated} drafts${insertSkipped ? ` · ⏭ ${insertSkipped} skipped (duplicate/conflict)` : ""}`);
}
// Publish verification report — always printed, in dry runs too, because the hold reasons are
// the parser's to-do list: "total_entries → likely a stock counter" names a specific bug.
if (verdicts.length) {
  const s = summarise(verdicts);
  // In a dry run flush() returns before the image check, so report the verdict-level count
  // as "would publish" rather than claiming rows went live.
  console.log(DRY_RUN
    ? `\n🔎 publish verification: ${s.published} would publish, ${s.held} held (of ${verdicts.length} re-observed drafts)`
    : `\n🔎 publish verification: ${autoPublished} published, ${verdicts.length - autoPublished} held (${AUTO_PUBLISH ? `cap ${PUBLISH_CAP}` : "AUTO_PUBLISH=false"})`);
  for (const [reason, n] of Object.entries(s.heldReasons)) console.log(`     ${String(n).padStart(4)} × ${reason}`);
}

// Before reporting, work out WHY each silent operator was silent. One cheap request per silent
// operator (typically ~20), nothing next to the scrape itself, and it turns an undifferentiated
// warning list into actionable ones: blocked (infrastructure), parser found nothing (our bug),
// unreachable (probably gone).
{
  const silent = counts.filter((c) => (c.scraped || 0) === 0);
  const reasons = await probeSilentReasons(
    silent.map((c) => ({ slug: c.slug, base: operators.find((o) => o.slug === c.slug)?.base })),
  );
  for (const c of silent) c.silentReason = reasons.get(c.slug);
}
await writeStepSummary(buildHealthReport({
  counts,
  expected: expectedSlugs,
  // `existing` is the start-of-run snapshot, so this is the queue this run inherited.
  funnel: {
    draftsWaiting: existing.filter((d) => d.status === "draft").length,
    publishCap: AUTO_PUBLISH ? PUBLISH_CAP : null,
    // `autoPublished`, not the per-operator tally: the tally counts rows that BECAME publish
    // candidates, while flush() is where AUTO_PUBLISH_MAX and the image proof actually decide.
    // Reporting the intention would overstate the number the cap decision rests on. In a dry
    // run nothing publishes, so report the candidate count and let the reader see it is a dry run.
    publishedThisRun: DRY_RUN ? counts.reduce((a, c) => a + (c.published || 0), 0) : autoPublished,
  },
}));
