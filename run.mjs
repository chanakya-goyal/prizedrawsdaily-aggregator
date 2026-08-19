// PrizeDrawsDaily aggregator — KEYLESS orchestrator (no LLM).
//   DRY_RUN=true (default) prints; DRY_RUN=false inserts (needs SUPABASE_SERVICE_ROLE_KEY).
// Operators come from operators.json. Two feeders share this code via METHODS:
//   METHODS=render            → the GitHub Action's browser feeder
//   METHODS=woo,shopify       → the cowork routine's JSON-API scrape
// Both deterministically fill fields (lib/parse.mjs), gate them (gate.mjs), attach a
// template description (lib/describe.mjs) and insert as 'draft'. The cowork/Claude routine
// then rewrites descriptions, validates, and publishes.
import { chromium } from "playwright";
import { renderOperator, wooOperator, shopifyOperator, apiOperator, dedupe, makeContext } from "./extractor.mjs";
import { gate } from "./gate.mjs";
import { templateDescription } from "./lib/describe.mjs";
import { fieldFlags, buildHealthReport, writeStepSummary, checkImage } from "./lib/manager.mjs";
import { rehostImage } from "./lib/rehost.mjs";
import { verifyAgainstStored, summarise, relistDecision, correctionDecision } from "./lib/verify.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
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
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const METHODS = process.env.METHODS ? new Set(process.env.METHODS.split(",").map((s) => s.trim())) : null;
const READ_KEY = SERVICE_KEY || ANON_KEY;

const now = new Date();
const round2 = (n) => Math.round(n * 100) / 100;
const slugify = (s) => (s || "draw").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draw";
// Match the website's convention: "<title>-<operatorSlug>", regex-safe, <=120 chars.
const makeSlug = (title, opSlug) => `${slugify(title).slice(0, Math.max(8, 119 - opSlug.length))}-${opSlug}`.slice(0, 120);

// Every Supabase call carries a hard timeout: one silently-dead TCP connection with no
// RST is an infinite await in Bun's fetch, and it stalled two full Action runs for 2h+
// on 2026-08-14 (the flush after Red Hot Raffles both times).
const SB_TIMEOUT = { signal: () => AbortSignal.timeout(30000) };
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: READ_KEY, Authorization: `Bearer ${READ_KEY}` }, signal: SB_TIMEOUT.signal() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
// PostgREST silently caps any select at 1000 rows — page through or the dedupe maps go blind
// past 1000 draws (slug collisions → 409 → the whole insert stage dies).
async function sbGetAll(path, pageSize = 1000) {
  const sep = path.includes("?") ? "&" : "?";
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await sbGet(`${path}${sep}limit=${pageSize}&offset=${offset}`);
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
let operators = await Bun.file("operators.json").json();
operators = operators.filter((o) => o.enabled !== false && !o.aiAssist); // exclude disabled + aiAssist (cowork handles those)
if (METHODS) operators = operators.filter((o) => METHODS.has(o.method));
if (ONLY) operators = operators.filter((o) => ONLY.has(o.slug));
const expectedSlugs = operators.map((o) => o.slug);
const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
const batch = dayOfYear % BATCHES;
if (!ONLY && BATCHES > 1) operators = operators.filter((_, i) => i % BATCHES === batch);

console.log(`${DRY_RUN ? "DRY RUN" : "LIVE"} — ${now.toISOString()} | keyless | methods ${METHODS ? [...METHODS].join("+") : "all"} | batch ${batch + 1}/${BATCHES} | ${operators.length} operators | PER_OP ${PER_OP} | status '${PUBLISH_STATUS}'\n`);
if (!DRY_RUN && !SERVICE_KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const cats = await sbGet("categories?select=id,slug");
const catMap = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
const dbOps = await sbGet("operators?select=id,slug");
const opMap = Object.fromEntries(dbOps.map((o) => [o.slug, o.id]));
// The field values come back too, not just identity: publish verification compares this
// stored observation against today's fresh scrape (see lib/verify.mjs).
const existing = await sbGetAll("draws?select=id,entry_url,slug,status,title,ticket_price,total_entries,draw_date,image_url,prize_description");
const byUrl = new Map(existing.filter((d) => d.entry_url).map((d) => [d.entry_url, d]));
const takenSlugs = new Set(existing.map((d) => d.slug));
console.log(`loaded ${cats.length} cats, ${dbOps.length} operators, ${existing.length} existing draws\n`);

const needsBrowser = operators.some((o) => o.method === "render");
const browser = needsBrowser ? await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] }) : null;
const ctx = browser ? await makeContext(browser) : null;

const toInsert = [];
const toUpdate = [];
const counts = [];
const verdicts = [];
let pages = 0, skipped = 0, autoPublished = 0, relisted = 0, correctedLive = 0;

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
  const candidates = toUpdate.filter((u) => u.candidate);
  if (candidates.length) {
    const checks = await Promise.all(candidates.map(async (u) => {
      if (autoPublished >= AUTO_PUBLISH_MAX) return { u, ok: false, why: "run publish cap reached" };
      try {
        const img = await raced(checkImage(u.row.image_url), 15_000, "image check");
        return { u, ok: img.ok === true, why: `image ${img.reason}` };
      } catch { return { u, ok: false, why: "image check timed out" }; }
    }));
    for (const { u, ok, why } of checks) {
      if (ok && autoPublished < AUTO_PUBLISH_MAX) { u.row.status = "active"; autoPublished++; }
      else console.log(`  ⏸ held back at publish: ${u.slug.slice(0, 44)} — ${why}`);
    }
  }
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
    else if (op.method === "woo") draws = await withBudget(wooOperator(op, PER_OP_API), OP_BUDGET_MS);
    else if (op.method === "shopify") draws = await withBudget(shopifyOperator(op, PER_OP_API), OP_BUDGET_MS);
    else draws = await withBudget(renderOperator(ctx, op, PER_OP), OP_BUDGET_MS);
  } catch (e) { console.log(`  FAILED: ${(e.message || "").slice(0, 80)}`); continue; }
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
    const tpv = Math.min(round2((d.ticket_price || 0) * (d.total_entries || 0)), 1_000_000_000);
    const ex = byUrl.get(d.entry_url);
    if (ex) {
      // Existing draw: refresh data on a DRAFT row (self-heals earlier wrong fields like
      // the ticket price); never touch a published/ended row.
      // An ended row whose competition has been RELISTED for a later draw comes back as a
      // draft; without this the URL is retired permanently, which silently loses every
      // recurring competition (and every sold-out-awaiting-draw comp ended-sweep closed).
      if (ex.status === "ended") {
        const { revive } = relistDecision(ex, d, now);
        if (!revive) { skipped++; continue; }
        byUrl.delete(d.entry_url);
        toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate: false, row: {
          category_id: catMap[d.category] || null, title: d.title, grand_prize: d.grand_prize,
          image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
          total_prize_value: tpv, draw_date: d.draw_date, status: "draft",
        } });
        relisted++; c.inserted++; c.heldDraft++;
        console.log(`  ↩️ ${d.title.slice(0, 44)} — relisted for ${String(d.draw_date).slice(0, 10)}, back as draft`);
        continue;
      }
      // A LIVE row used to be frozen the moment it was published — never re-read, never
      // corrected. That was tolerable while publishing was a human decision on a small
      // queue; it is not now that rows publish automatically, because an operator dropping
      // a ticket price or moving a draw date would leave the wrong number on the public site
      // indefinitely. Correct the FIELDS in place and leave `status` alone: a data change is
      // not a reason to yank a live draw off the site, and a comp that has actually finished
      // is ended-sweep's job. This is a single-observation write onto a PUBLISHED row, so
      // correctionDecision() holds it to the deterministic half of the publish bar: a flagged
      // read never overwrites values the site is already showing (lib/verify.mjs).
      if (ex.status === "active") {
        const c = correctionDecision(ex, d, { now });
        if (!c.correct) {
          skipped++;
          // Silent when there's simply nothing to correct; loud when a flagged read was
          // REFUSED, because that is the parser breaking on a row the public can see.
          if (c.flags.length) console.log(`  🚫 ${d.title.slice(0, 40)} — live row left alone: ${c.reason.slice(0, 90)}`);
          continue;
        }
        byUrl.delete(d.entry_url);
        toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate: false, row: {
          category_id: catMap[d.category] || null, title: d.title, grand_prize: d.grand_prize,
          image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
          total_prize_value: tpv, draw_date: d.draw_date,
        } });
        correctedLive++;
        console.log(`  🔄 ${d.title.slice(0, 40)} — live row corrected: ${c.fields.join(", ")}`);
        continue;
      }
      if (ex.status !== "draft") { skipped++; continue; }
      byUrl.delete(d.entry_url);
      // This is the SECOND independent observation of a row we already hold. If it agrees
      // with what's stored, that draft has been read twice, on different days, by separate
      // fetches — enough to publish it. The image check is async and runs in flush(), so the
      // verdict is provisional here and only rows that also pass it go live.
      const verdict = verifyAgainstStored(ex, d, { now, imageOk: true });
      const candidate = AUTO_PUBLISH && verdict.publish;
      verdicts.push(verdict);
      toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, candidate, row: {
        category_id: catMap[d.category] || null, title: d.title, grand_prize: d.grand_prize,
        image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
        total_prize_value: tpv, draw_date: d.draw_date,
      } });
      c.inserted++;
      if (candidate) { c.published++; console.log(`  ✅ ${d.title.slice(0, 44)} | £${d.ticket_price}×${d.total_entries} (verified — publishing)`); }
      else { c.heldDraft++; console.log(`  ♻️ ${d.title.slice(0, 44)} | £${d.ticket_price}×${d.total_entries} (held: ${verdict.reasons.slice(0, 2).join("; ").slice(0, 80) || "auto-publish off"})`); }
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
        slug, operator_id: opMap[op.slug], category_id: catMap[d.category] || null,
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
    : `\n🔎 publish verification: ${autoPublished} published, ${verdicts.length - autoPublished} held (${AUTO_PUBLISH ? `cap ${AUTO_PUBLISH_MAX}` : "AUTO_PUBLISH=false"})`);
  for (const [reason, n] of Object.entries(s.heldReasons)) console.log(`     ${String(n).padStart(4)} × ${reason}`);
}

await writeStepSummary(buildHealthReport({ counts, expected: expectedSlugs }));
