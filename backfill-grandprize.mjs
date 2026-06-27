// One-time backfill: fix EXISTING draws whose `grand_prize` is a generic slogan title
// (the historic bug where every path copied `title` into grand_prize). Re-derives the real
// prize from the operator's WooCommerce/Shopify product description — the SAME source the live
// scraper now uses (lib/parse.mjs extractGrandPrize) — so backfill and go-forward agree.
//
//   DRY_RUN=true (default) → report proposed old→new only, NO writes
//   DRY_RUN=false          → PATCH draws.grand_prize  (needs SUPABASE_SERVICE_ROLE_KEY)
//   STATUS=active,draft    → comma-list of draw statuses to scan (default: active,draft)
//   ONLY=daydream-draws    → restrict to one operator slug (handy for a first verify run)
//
// Safety contract (identical to the go-forward fix): a draw is ONLY touched when its current
// grand_prize is a generic slogan AND a concrete, non-slogan replacement is found. Draws whose
// grand_prize already names the prize are skipped without even a network call.
import { load, parseJsonLd, findProductLd, extractGrandPrize, isGenericTitle, UA } from "./lib/parse.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const DRY_RUN = process.env.DRY_RUN !== "false";
const STATUS = (process.env.STATUS || "active,draft").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const READ = SERVICE_KEY || ANON;

if (!DRY_RUN && !SERVICE_KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const norm = (u) => (u || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
const operators = await Bun.file("operators.json").json();
const opBySlug = Object.fromEntries(operators.map((o) => [o.slug, o]));

// Per-operator product index (entry_url / slug → prize description), fetched once and cached.
const apiCache = new Map();
async function loadOpProducts(op) {
  const byUrl = new Map(), bySlug = new Map();
  try {
    if (op.method === "woo") {
      const r = await fetch(`${op.base}/wp-json/wc/store/v1/products?per_page=100&orderby=date`, { headers: { "User-Agent": UA } });
      const arr = await r.json();
      for (const p of (Array.isArray(arr) ? arr : [])) {
        const pt = p.short_description || p.description || "";
        if (p.permalink) byUrl.set(norm(p.permalink), pt);
        if (p.slug) bySlug.set(String(p.slug).toLowerCase(), pt);
      }
    } else if (op.method === "shopify") {
      const r = await fetch(`${op.base}/products.json?limit=250`, { headers: { "User-Agent": UA } });
      const j = await r.json();
      for (const p of (j?.products || [])) { if (p.handle) bySlug.set(String(p.handle).toLowerCase(), p.body_html || ""); }
    }
  } catch (e) { console.error(`  ! ${op.slug} product API: ${(e.message || "").slice(0, 50)}`); }
  return { byUrl, bySlug };
}
async function prizeTextFor(d, op) {
  if (!op || !["woo", "shopify"].includes(op.method)) return null;
  if (!apiCache.has(op.slug)) apiCache.set(op.slug, await loadOpProducts(op));
  const { byUrl, bySlug } = apiCache.get(op.slug);
  const key = norm(d.entry_url);
  return byUrl.get(key) || bySlug.get(key.split("/").pop() || "") || null;
}

const listUrl = `${SUPABASE_URL}/rest/v1/draws?status=in.(${STATUS.join(",")})&select=id,slug,title,grand_prize,entry_url,operators(slug,name)`;
const all = await (await fetch(listUrl, { headers: { apikey: READ, Authorization: `Bearer ${READ}` } })).json();
const draws = ONLY ? all.filter((d) => ONLY.has(d.operators?.slug)) : all;

// Only the broken subset: grand_prize is a generic slogan that names no prize.
const candidates = draws.filter((d) => isGenericTitle(d.grand_prize || d.title, d.operators?.name));
console.log(`${DRY_RUN ? "DRY RUN" : "LIVE"} | status=${STATUS.join("+")} | ${draws.length} draws, ${candidates.length} with a generic grand_prize\n`);

let fixed = 0, nosrc = 0, failed = 0;
for (const d of candidates) {
  const op = opBySlug[d.operators?.slug];
  const opName = d.operators?.name;
  let prizeText = null, $ = null, ld = null;
  try { prizeText = await prizeTextFor(d, op); } catch { /* fall through to page fetch */ }
  if (!prizeText && d.entry_url) {
    try { $ = load(await (await fetch(d.entry_url, { headers: { "User-Agent": UA } })).text()); ld = findProductLd(parseJsonLd($)); }
    catch (e) { failed++; console.log(`  ! fetch failed [${d.operators?.slug}] ${d.title.slice(0, 40)} — ${(e.message || "").slice(0, 40)}`); continue; }
  }
  const gp = extractGrandPrize({ $, title: d.title, ld, prizeText, opName });
  if (gp.source === "title" || !gp.value || gp.value === d.grand_prize) {
    nosrc++; console.log(`  ·  no better source  [${d.operators?.slug}] "${(d.grand_prize || "").slice(0, 44)}"`); continue;
  }
  fixed++;
  console.log(`  ${DRY_RUN ? "would set" : "✅ set"} [${gp.source}] (${d.operators?.slug})\n      old: ${d.grand_prize}\n      new: ${gp.value}`);
  if (!DRY_RUN) {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/draws?id=eq.${d.id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grand_prize: gp.value }),
    });
    if (!pr.ok) { fixed--; failed++; console.log(`  ! PATCH ${pr.status} for ${d.slug}: ${(await pr.text()).slice(0, 80)}`); }
  }
}
console.log(`\n==== ${DRY_RUN ? "would fix" : "fixed"} ${fixed} · ${nosrc} no-better-source · ${failed} fetch/patch-failed ====`);
