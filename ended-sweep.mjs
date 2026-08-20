// Ended-comp sweep: a draft draw whose WooCommerce/Shopify product is no longer PURCHASABLE is a
// FINISHED competition that was scraped in error (or has since closed) — it must not sit in the
// "live" draft queue. Purchasability is the operator's own authoritative "ended" flag
// (is_in_stock stays true after a draw closes, so we key on is_purchasable — via
// lib/liveness.mjs, because the API returns it as `false` OR the number 0). For shopify we use
// the absence of an available variant; for render-only operators we fall back to a "finished" text
// probe on the page. Conservative: only an explicit not-purchasable / finished signal marks ended.
//
//   DRY_RUN=true (default) → report only.  DRY_RUN=false → set status='ended' on the finished ones.
import { UA } from "./lib/parse.mjs";
import { isPurchasable, productSlug, isPercentLiteralSlug, permalinkKey, FINISHED_RE } from "./lib/liveness.mjs";
const URL = "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
// Which statuses to scan. Default 'draft' (queue cleanup); the daily cron passes 'active,draft'
// so a LIVE draw whose competition has since finished is auto-expired off the public site.
const STATUS = (process.env.STATUS || "draft").split(",").map((s) => s.trim()).filter(Boolean);
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
// FINISHED_RE now lives in lib/liveness.mjs so scraper, sweep and verifier share one definition.

const ops = await Bun.file("operators.json").json();
const opBy = Object.fromEntries(ops.map((o) => [o.slug, o]));
const draws = await (await fetch(`${URL}/rest/v1/draws?status=in.(${STATUS.join(",")})&select=id,title,entry_url,draw_date,operators(slug,name)`, { headers: H })).json();
console.log(`${DRY ? "DRY RUN" : "LIVE"} — checking ${draws.length} ${STATUS.join("+")} draws for ended comps\n`);

const slugFromUrl = productSlug;

// Shopify: the single-product /products/<handle>.json endpoint OMITS variant `available`, so it
// always read as "no variant available" (false ended). The LIST endpoint /products.json DOES
// carry `available` — load it once per operator and map handle → available.
// Woo: same idea, for the products ?slug= can't resolve. One paged pass per operator,
// cached, keyed on permalink. Bounded at 5 pages — this is a fallback, not a full crawl.
const wooCache = new Map();
async function wooFeed(op) {
  if (wooCache.has(op.slug)) return wooCache.get(op.slug);
  const map = new Map();
  try {
    for (let page = 1; page <= 5; page++) {
      const url = op.apiStyle === "rest_route"
        ? `${op.base}/?rest_route=/wc/store/v1/products&per_page=100&page=${page}`
        : `${op.base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
      const arr = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
      if (!Array.isArray(arr) || !arr.length) break;
      for (const p of arr) map.set(permalinkKey(p.permalink), p);
      if (arr.length < 100) break;
    }
  } catch { /* partial or empty map → those draws stay unverified, never wrongly expired */ }
  wooCache.set(op.slug, map);
  return map;
}

const shopCache = new Map();
async function shopAvail(op) {
  if (shopCache.has(op.slug)) return shopCache.get(op.slug);
  const map = new Map();
  try {
    const j = await fetch(`${op.base}/products.json?limit=250`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    for (const p of (j?.products || [])) map.set(String(p.handle).toLowerCase(), (p.variants || []).some((v) => v.available));
  } catch { /* empty map → all unknown */ }
  shopCache.set(op.slug, map);
  return map;
}

async function isEnded(d) {
  const op = opBy[d.operators?.slug];
  if (!op) return { ended: null, why: "operator not in config" };
  const slug = slugFromUrl(d.entry_url);
  try {
    if (op.method === "woo") {
      let p = null;
      // ?slug= is one cheap request, but it cannot resolve percent-literal slugs at all —
      // skip straight to the feed for those rather than spend a request proving it.
      if (!isPercentLiteralSlug(slug)) {
        const r = await fetch(`${op.base}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
        const arr = await r.json();
        p = Array.isArray(arr) ? arr[0] : null;
      }
      // Fall back to the listing feed, matched on permalink. Without this, any product
      // ?slug= can't find stays "unverifiable" forever and is therefore never expired —
      // which covered 56 of easy-living-competitions' newest 100 products.
      if (!p) p = (await wooFeed(op)).get(permalinkKey(d.entry_url)) || null;
      if (!p) return { ended: null, why: "product not found in API or feed" };
      if (!isPurchasable(p)) return { ended: true, why: `not purchasable (stock: ${p.stock_availability?.text || "?"})` };
      return { ended: false, why: "purchasable" };
    }
    if (op.method === "shopify") {
      const map = await shopAvail(op);
      if (!map.size) return { ended: null, why: "feed unavailable" };
      if (!map.has(slug.toLowerCase())) return { ended: null, why: "not in product feed (unverified)" }; // conservative: never expire on absence
      const avail = map.get(slug.toLowerCase());
      return { ended: !avail, why: avail ? "available" : "sold out / no available variant" };
    }
    // render / other: text probe
    const html = await (await fetch(d.entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
    return { ended: FINISHED_RE.test(html), why: FINISHED_RE.test(html) ? "page says finished" : "no finished marker" };
  } catch (e) { return { ended: null, why: `error ${(e.message || "").slice(0, 30)}` }; }
}

// bounded concurrency
let i = 0; const out = [];
async function w() { while (i < draws.length) { const d = draws[i++]; out.push({ d, ...(await isEnded(d)) }); } }
await Promise.all(Array.from({ length: 8 }, w));

const ended = out.filter((x) => x.ended === true);
const unknown = out.filter((x) => x.ended === null);
console.log(`ENDED (finished comps in the draft queue): ${ended.length}`);
for (const x of ended) console.log(`  ⛔ [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 44)} — ${x.why}`);
if (unknown.length) { console.log(`\nUNKNOWN (couldn't verify — left as-is): ${unknown.length}`); for (const x of unknown.slice(0, 12)) console.log(`  ? [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 40)} — ${x.why}`); }

if (!DRY && ended.length) {
  let n = 0;
  for (const x of ended) {
    const pr = await fetch(`${URL}/rest/v1/draws?id=eq.${x.d.id}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status: "ended" }) });
    if (pr.ok) n++; else console.log(`  ! PATCH ${pr.status} for ${x.d.id}`);
  }
  console.log(`\n✅ marked ${n} finished comps as status='ended' (removed from the live draft queue)`);
} else if (DRY) {
  console.log(`\n(dry run — re-run with DRY_RUN=false to mark these ${ended.length} as ended)`);
}
