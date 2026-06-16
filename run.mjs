// PrizeDrawsDaily aggregator — production orchestrator.
//   DRY_RUN=true  (default) → prints exactly what WOULD be inserted, writes nothing.
//   DRY_RUN=false           → inserts new draws into Supabase (needs SUPABASE_SERVICE_ROLE_KEY).
// Flow: load id maps + existing draws → aggregate each operator → hard filter (evaluate) →
//       supervisor sanity flags → skip ones already on the site → insert (status=PUBLISH_STATUS).
import { chromium } from "playwright";
import { OPERATORS, renderOperator, wooOperator, dedupe, evaluate, makeContext, CATEGORIES, WINDOW_DAYS } from "./extractor.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const DRY_RUN = process.env.DRY_RUN !== "false"; // default = dry
const PUBLISH_STATUS = process.env.PUBLISH_STATUS || "draft"; // drafts by default (matches admin UI: active/ended/draft)
const PER_OP = Number(process.env.PER_OP || 6);
const READ_KEY = SERVICE_KEY || ANON_KEY; // service key sees pending rows too

const now = new Date();
const round2 = (n) => Math.round(n * 100) / 100;
const slugify = (s) => (s || "draw").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "draw";

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

// Supervisor: sanity bounds that flag suspicious values for human review (typos, bad data).
function supervisor(d) {
  const flags = [];
  const pool = d.ticket_price * d.total_entries;
  if (d.ticket_price > 50) flags.push(`ticket £${d.ticket_price} >£50?`);
  if (d.total_entries > 5_000_000) flags.push(`${d.total_entries} entries >5M?`);
  if (d.total_entries < 200) flags.push(`only ${d.total_entries} entries — likely a mis-read`);
  if (pool > 50_000_000) flags.push(`pool £${Math.round(pool)} >£50M?`);
  if (["car-draws", "house-draws"].includes(d.category) && pool < 5000) flags.push(`${d.category} pool only £${Math.round(pool)} — likely wrong entries`);
  if (!/^https?:\/\/.+/.test(d.image_url || "")) flags.push("missing/bad image");
  if (!CATEGORIES.includes(d.category)) flags.push(`bad category ${d.category}`);
  if (!d.description || d.description.length < 20) flags.push("thin description");
  return flags;
}

console.log(`${DRY_RUN ? "DRY RUN" : "LIVE PUBLISH"} — ${now.toISOString()} | window ${WINDOW_DAYS}d | status='${PUBLISH_STATUS}' | ${PER_OP}/op\n`);
if (!DRY_RUN && !SERVICE_KEY) {
  console.error("ERROR: DRY_RUN=false requires SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// --- load id maps + what's already on the site ---
const cats = await sbGet("categories?select=id,slug");
const catMap = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
const ops = await sbGet("operators?select=id,slug");
const opMap = Object.fromEntries(ops.map((o) => [o.slug, o.id]));
const existing = await sbGet("draws?select=entry_url,slug");
const seenUrls = new Set(existing.map((d) => d.entry_url).filter(Boolean));
const takenSlugs = new Set(existing.map((d) => d.slug));
console.log(`loaded: ${cats.length} categories, ${ops.length} operators, ${existing.length} existing draws\n`);

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await makeContext(browser);

const toInsert = [];
let skipped = 0;
for (const op of OPERATORS) {
  console.log(`\n========== ${op.name} (${op.method}) ==========`);
  if (!opMap[op.slug]) {
    console.log(`  ! operator slug "${op.slug}" not found in DB — skipping operator`);
    continue;
  }
  let draws = [];
  try {
    draws = op.method === "woo" ? await wooOperator(op, PER_OP) : await renderOperator(ctx, op, PER_OP);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
    continue;
  }
  draws = dedupe(draws);
  for (const d of draws) {
    const { pass, reasons } = evaluate(d, now);
    if (!pass) { skipped++; console.log(`  ⛔ ${d.title.slice(0, 50)} — ${reasons.join(", ")}`); continue; }
    if (seenUrls.has(d.entry_url)) { skipped++; console.log(`  ↩︎ ${d.title.slice(0, 50)} — already on site`); continue; }
    seenUrls.add(d.entry_url);
    const slug = (() => { let s = slugify(d.title), i = 2; while (takenSlugs.has(s)) s = `${slugify(d.title)}-${i++}`; takenSlugs.add(s); return s; })();
    const flags = supervisor(d);
    const row = {
      slug,
      operator_id: opMap[op.slug],
      category_id: catMap[d.category] || null,
      title: d.title,
      grand_prize: d.grand_prize,
      prize_description: d.description,
      image_url: d.image_url,
      ticket_price: d.ticket_price,
      total_entries: d.total_entries,
      total_prize_value: round2(d.ticket_price * d.total_entries),
      prize_value: null,
      draw_date: d.draw_date,
      entry_url: d.entry_url,
      affiliate_url: null,
      // suspicious draws are always held as 'draft' for review, even when PUBLISH_STATUS='active'
      status: flags.length ? "draft" : PUBLISH_STATUS,
      featured: false,
    };
    toInsert.push({ row, flags });
    console.log(`  ✅ ${d.title.slice(0, 50)} | ${d.category} | £${d.ticket_price}×${d.total_entries} = £${row.total_prize_value}${flags.length ? "  ⚠️ " + flags.join("; ") : ""}`);
  }
}
await browser.close();

console.log(`\n\n==== ${toInsert.length} new draws to add, ${skipped} skipped ====`);
const flagged = toInsert.filter((x) => x.flags.length);
if (flagged.length) console.log(`⚠️  ${flagged.length} flagged for closer review: ${flagged.map((x) => x.row.title.slice(0, 30)).join(" | ")}`);

if (DRY_RUN) {
  console.log(`\n(DRY RUN — nothing written. Sample row:)`);
  if (toInsert[0]) console.log(JSON.stringify(toInsert[0].row, null, 2));
} else if (toInsert.length) {
  const inserted = await sbInsert(toInsert.map((x) => x.row));
  console.log(`\n✅ INSERTED ${inserted.length} draws with status='${PUBLISH_STATUS}'.`);
} else {
  console.log(`\nNothing new to insert.`);
}
