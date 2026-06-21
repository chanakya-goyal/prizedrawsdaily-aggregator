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

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const DRY_RUN = process.env.DRY_RUN !== "false";
const PUBLISH_STATUS = process.env.PUBLISH_STATUS || "draft"; // cowork owns publish; keep draft by default
const PER_OP = Number(process.env.PER_OP || 5);
const BATCHES = Number(process.env.BATCHES || 1);            // no LLM quota → full coverage daily
const MAX_PAGES = Number(process.env.MAX_DRAWS || 500);      // backstop on pages read per run
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const METHODS = process.env.METHODS ? new Set(process.env.METHODS.split(",").map((s) => s.trim())) : null;
const READ_KEY = SERVICE_KEY || ANON_KEY;

const now = new Date();
const round2 = (n) => Math.round(n * 100) / 100;
const slugify = (s) => (s || "draw").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draw";
// Match the website's convention: "<title>-<operatorSlug>", regex-safe, <=120 chars.
const makeSlug = (title, opSlug) => `${slugify(title).slice(0, Math.max(8, 119 - opSlug.length))}-${opSlug}`.slice(0, 120);

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: READ_KEY, Authorization: `Bearer ${READ_KEY}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/draws`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`INSERT → ${r.status} ${await r.text()}`);
  return r.json();
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
const existing = await sbGet("draws?select=entry_url,slug");
const seenUrls = new Set(existing.map((d) => d.entry_url).filter(Boolean));
const takenSlugs = new Set(existing.map((d) => d.slug));
console.log(`loaded ${cats.length} cats, ${dbOps.length} operators, ${existing.length} existing draws\n`);

const needsBrowser = operators.some((o) => o.method === "render");
const browser = needsBrowser ? await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] }) : null;
const ctx = browser ? await makeContext(browser) : null;

const toInsert = [];
const counts = [];
let pages = 0, skipped = 0;
for (const op of operators) {
  if (pages >= MAX_PAGES) { console.log(`\n⏹ hit MAX_PAGES cap (${MAX_PAGES}) — remaining operators run next time`); break; }
  if (!opMap[op.slug]) { console.log(`· ${op.name}: not in DB, skip`); continue; }
  console.log(`\n── ${op.name} (${op.method}) ──`);
  const c = { slug: op.slug, scraped: 0, inserted: 0, published: 0, heldDraft: 0 };
  counts.push(c);
  let draws = [];
  try {
    if (op.method === "woo") draws = await wooOperator(op, PER_OP);
    else if (op.method === "shopify") draws = await shopifyOperator(op, PER_OP);
    else draws = await renderOperator(ctx, op, PER_OP);
  } catch (e) { console.log(`  FAILED: ${(e.message || "").slice(0, 80)}`); continue; }
  pages += draws.length;
  c.scraped = draws.length;
  draws = dedupe(draws);
  for (const raw of draws) {
    const { pass, stage, reasons, draw: d } = gate(raw, now);
    if (!pass) { skipped++; console.log(`  ⏭  ${(raw.title || "?").slice(0, 40)} — ${stage}: ${reasons.join(", ")}`); continue; }
    if (seenUrls.has(d.entry_url)) { skipped++; continue; }
    seenUrls.add(d.entry_url);
    if (!d.description) d.description = templateDescription(d);
    const slug = (() => { let s = makeSlug(d.title, op.slug), i = 2; const b = s; while (takenSlugs.has(s)) s = `${b}-${i++}`.slice(0, 120); takenSlugs.add(s); return s; })();
    const flags = fieldFlags(d);
    const status = flags.length ? "draft" : PUBLISH_STATUS;
    if (status === "active") c.published++; else c.heldDraft++;
    c.inserted++;
    toInsert.push({
      row: {
        slug, operator_id: opMap[op.slug], category_id: catMap[d.category] || null,
        title: d.title, grand_prize: d.grand_prize, prize_description: d.description,
        image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries,
        total_prize_value: Math.min(round2((d.ticket_price || 0) * (d.total_entries || 0)), 1_000_000_000), prize_value: null,
        draw_date: d.draw_date, entry_url: d.entry_url, affiliate_url: null,
        status, featured: false,
      },
      flags,
    });
    console.log(`  ✅ ${d.title.slice(0, 44)} | ${d.category} | £${d.ticket_price}×${d.total_entries}${flags.length ? "  ⚠️→draft: " + flags.join("; ") : ""}`);
  }
}
if (browser) await browser.close();

console.log(`\n\n==== ${toInsert.length} new draws (${pages} pages read, ${skipped} skipped) ====`);
if (DRY_RUN) {
  console.log("(dry run — nothing written)");
} else if (toInsert.length) {
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const res = await sbInsert(toInsert.slice(i, i + 50).map((x) => x.row));
    inserted += res.length;
  }
  const live = toInsert.filter((x) => x.row.status === "active").length;
  console.log(`✅ inserted ${inserted} (${live} live, ${inserted - live} held as draft)`);
} else {
  console.log("nothing new to insert");
}

await writeStepSummary(buildHealthReport({ counts, expected: expectedSlugs }));
