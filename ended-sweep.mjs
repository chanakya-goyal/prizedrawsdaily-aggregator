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
import { isPurchasable, productSlug, isPercentLiteralSlug, permalinkKey, saysFinished } from "./lib/liveness.mjs";
const URL = "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
// Which statuses to scan. Default 'draft' (queue cleanup); the daily cron passes 'active,draft'
// so a LIVE draw whose competition has since finished is auto-expired off the public site.
const STATUS = (process.env.STATUS || "draft").split(",").map((s) => s.trim()).filter(Boolean);
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
// FINISHED_RE and its matcher live in lib/liveness.mjs so scraper, sweep and verifier share one
// definition. Match through saysFinished(), never FINISHED_RE.test(html) — see the note there.

const ops = await Bun.file("operators.json").json();
const opBy = Object.fromEntries(ops.map((o) => [o.slug, o]));
const drawsRes = await fetch(`${URL}/rest/v1/draws?status=in.(${STATUS.join(",")})&select=id,title,entry_url,draw_date,operators(slug,name)`, { headers: H });
const draws = await drawsRes.json();
// PostgREST answers a failed read with an OBJECT. Unchecked, `draws.length` is undefined,
// the worker loop `while (i < draws.length)` never runs, and this exits 0 having reported
// "checking undefined draws" and expired nothing — a silent no-op on the daily cron, which
// is the failure mode this fleet exists to prevent. Fail loudly instead.
if (!Array.isArray(draws)) {
  console.error(`read failed — HTTP ${drawsRes.status}: ${draws?.message || JSON.stringify(draws).slice(0, 200)}`);
  process.exit(1);
}
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

// `draw_date` was selected by the query from the start and then used by nothing. A draw
// closing three weeks from now could be marked ended on a phrase match alone.
const NOW_MS = Date.now();
function isFutureDated(d) {
  const t = Date.parse(d?.draw_date ?? "");
  return Number.isFinite(t) && t > NOW_MS;
}
function isPastDated(d) {
  const t = Date.parse(d?.draw_date ?? "");
  return Number.isFinite(t) && t <= NOW_MS;
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
      if (!isPurchasable(p)) return { ended: true, strength: "strong", why: `not purchasable (stock: ${p.stock_availability?.text || "?"})` };
      return { ended: false, strength: "strong", why: "purchasable" };
    }
    if (op.method === "shopify") {
      const map = await shopAvail(op);
      if (!map.size) return { ended: null, why: "feed unavailable" };
      if (!map.has(slug.toLowerCase())) return { ended: null, why: "not in product feed (unverified)" }; // conservative: never expire on absence
      const avail = map.get(slug.toLowerCase());
      return { ended: !avail, strength: "strong", why: avail ? "available" : "sold out / no available variant" };
    }
    // render / other: text probe. This is the ONLY weak signal in this file — Woo's
    // is_purchasable and Shopify's variant availability are the operator's own flags, but
    // "the page contains a finished phrase" is a heuristic, and it has been wrong at scale
    // (see saysFinished in lib/liveness.mjs). So it gets a second gate the strong signals
    // do not need: a draw still dated in the future is contrary evidence, and we report it
    // as unverifiable rather than expiring a live draw on a phrase match.
    const html = await (await fetch(d.entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
    // "no finished marker in raw HTML" is NOT evidence the comp is open. These operators are
    // mostly JS-rendered, so the un-executed HTML says nothing either way — Dream Car pages
    // read "ended" to a browser while this probe sees nothing. Marking such rows "still
    // purchasable" overstated the evidence and hid genuinely-finished draws in the stale-date
    // bucket, where nothing ever acted on them.
    if (!saysFinished(html)) return { ended: false, strength: "weak", why: "no finished marker (raw HTML — unrendered)" };
    if (isFutureDated(d)) return { ended: null, strength: "weak", why: "page says finished but draw_date is still ahead" };
    return { ended: true, strength: "weak", why: "page says finished" };
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

// Still purchasable, but the close date has already passed. NOT expired here: a live
// product means the DATE is wrong, not that the competition is over, and expiring it
// would hide a draw people can still enter — correcting the date is run.mjs's job.
// Reported because 219 of these were sitting in `active` completely unannounced
// (measured 2026-08-26), inflating every live-draw count the site derives. Silence is
// the enemy; this is the cohort nobody was looking at.
const staleDate = out.filter((x) => x.ended === false && isPastDated(x.d));
// Two very different situations were being reported as one. Only the operator's OWN flag
// (Woo is_purchasable / Shopify variant availability) supports the claim "still purchasable" —
// and THAT is hidden inventory, because the site filters listings on draw_date >= now. A weak
// text probe on unrendered HTML supports nothing, and those rows may simply be finished.
const staleConfirmed = staleDate.filter((x) => x.strength === "strong");
const staleUnproven = staleDate.filter((x) => x.strength !== "strong");
if (staleConfirmed.length) {
  console.log(`\n📅 HIDDEN LIVE COMPS (operator says still purchasable, but our close date has passed — the site is filtering these out): ${staleConfirmed.length}`);
  for (const x of staleConfirmed.slice(0, 12)) console.log(`  📅 [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 40)} — our date ${String(x.d.draw_date).slice(0, 10)}`);
  if (staleConfirmed.length > 12) console.log(`  … and ${staleConfirmed.length - 12} more`);
}
if (staleUnproven.length) {
  console.log(`\n❔ PAST-DATED, UNVERIFIED (${staleUnproven.length}) — JS-rendered pages where a raw fetch proves nothing either way.`);
  console.log(`   Not expired (we never expire on absence of evidence) and not counted as live.`);
  for (const x of staleUnproven.slice(0, 8)) console.log(`  ❔ [${x.d.operators?.slug}] ${(x.d.title || "").slice(0, 40)} — our date ${String(x.d.draw_date).slice(0, 10)}`);
  if (staleUnproven.length > 8) console.log(`  … and ${staleUnproven.length - 8} more`);
}

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
