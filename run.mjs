// PrizeDrawsDaily aggregator — KEYLESS orchestrator (no LLM).
//   DRY_RUN=true (default) prints; DRY_RUN=false inserts (needs SUPABASE_SERVICE_ROLE_KEY).
// Operators come from operators.json. Two feeders share this code via METHODS:
//   METHODS=render            → the GitHub Action's browser feeder
//   METHODS=woo,shopify       → the cowork routine's JSON-API scrape
// Both deterministically fill fields (lib/parse.mjs), gate them (gate.mjs), attach a
// template description (lib/describe.mjs) and insert as 'draft'. The cowork/Claude routine
// then rewrites descriptions, validates, and publishes.
import { chromium } from "playwright";
import { renderOperator, wooOperator, shopifyOperator, dedupe, makeContext } from "./extractor.mjs";
import { gate } from "./gate.mjs";
import { templateDescription } from "./lib/describe.mjs";
import { fieldFlags, buildHealthReport, writeStepSummary } from "./lib/manager.mjs";
import { rehostImage } from "./lib/rehost.mjs";

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
const existing = await sbGetAll("draws?select=id,entry_url,slug,status");
const byUrl = new Map(existing.filter((d) => d.entry_url).map((d) => [d.entry_url, d]));
const takenSlugs = new Set(existing.map((d) => d.slug));
console.log(`loaded ${cats.length} cats, ${dbOps.length} operators, ${existing.length} existing draws\n`);

const needsBrowser = operators.some((o) => o.method === "render");
const browser = needsBrowser ? await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] }) : null;
const ctx = browser ? await makeContext(browser) : null;

const toInsert = [];
const toUpdate = [];
const counts = [];
let pages = 0, skipped = 0;

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
  for (const item of [...toInsert, ...toUpdate]) {
    const drawSlug = item.row.slug || item.slug;
    if (!item.row.image_url || !drawSlug) continue;
    try {
      const res = await raced(rehostImage(item.row.image_url, item.opSlug, drawSlug, sbCreds), 90_000, "re-host");
      if (res.changed) { item.row.image_url = res.url; rehosted++; }
      else if (res.via === "miss") { missed++; console.log(`  ⚠️ image unreachable, kept origin: ${drawSlug.slice(0, 44)}`); }
    } catch (e) { missed++; console.log(`  ! re-host failed ${drawSlug.slice(0, 40)}: ${(e.message || "").slice(0, 60)}`); }
  }
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
    if (op.method === "woo") draws = await withBudget(wooOperator(op, PER_OP_API), OP_BUDGET_MS);
    else if (op.method === "shopify") draws = await withBudget(shopifyOperator(op, PER_OP_API), OP_BUDGET_MS);
    else draws = await withBudget(renderOperator(ctx, op, PER_OP), OP_BUDGET_MS);
  } catch (e) { console.log(`  FAILED: ${(e.message || "").slice(0, 80)}`); continue; }
  pages += draws.length;
  c.scraped = draws.length;
  draws = dedupe(draws);
  for (const raw of draws) {
    const { pass, stage, reasons, draw: d } = gate(raw, now);
    if (!pass) { skipped++; console.log(`  ⏭  ${(raw.title || "?").slice(0, 40)} — ${stage}: ${reasons.join(", ")}`); continue; }
    const tpv = Math.min(round2((d.ticket_price || 0) * (d.total_entries || 0)), 1_000_000_000);
    const ex = byUrl.get(d.entry_url);
    if (ex) {
      // Existing draw: refresh data on a DRAFT row (self-heals earlier wrong fields like
      // the ticket price); never touch a published/ended row.
      if (ex.status !== "draft") { skipped++; continue; }
      byUrl.delete(d.entry_url);
      toUpdate.push({ id: ex.id, opSlug: op.slug, slug: ex.slug, row: {
        category_id: catMap[d.category] || null, title: d.title, grand_prize: d.grand_prize,
        image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
        total_prize_value: tpv, draw_date: d.draw_date,
      } });
      c.inserted++; c.heldDraft++;
      console.log(`  ♻️ ${d.title.slice(0, 44)} | £${d.ticket_price}×${d.total_entries} (refreshed draft)`);
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

console.log(`\n\n==== ${totalNew} new, ${totalRefreshed} refreshed (${pages} pages read, ${skipped} skipped) ====`);
if (DRY_RUN) {
  console.log("(dry run — nothing written)");
} else {
  console.log(`🖼  re-hosted ${rehosted} image(s) to Storage${missed ? `, ${missed} kept origin (unreachable)` : ""}`);
  console.log(`✅ inserted ${inserted} (${liveInserted} live, ${inserted - liveInserted} draft) · refreshed ${updated} drafts${insertSkipped ? ` · ⏭ ${insertSkipped} skipped (duplicate/conflict)` : ""}`);
}

await writeStepSummary(buildHealthReport({ counts, expected: expectedSlugs }));
