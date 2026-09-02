// Ended-comp sweep: a draft draw whose WooCommerce/Shopify product is no longer PURCHASABLE is a
// FINISHED competition that was scraped in error (or has since closed) — it must not sit in the
// "live" draft queue. Purchasability is the operator's own authoritative "ended" flag
// (is_in_stock stays true after a draw closes, so we key on is_purchasable — via
// lib/liveness.mjs, because the API returns it as `false` OR the number 0). For shopify we use
// the absence of an available variant; for render-only operators we fall back to a "finished" text
// probe on the page. Conservative: only an explicit not-purchasable / finished signal marks ended.
//
//   DRY_RUN=true (default) → report only.  DRY_RUN=false → set status='ended' on the finished ones.
import { UA, textOf, extractDate, fieldsFromHtml } from "./lib/parse.mjs";
import { staleDateDecision } from "./lib/verify.mjs";
import { isPurchasable, productSlug, isPercentLiteralSlug, permalinkKey, saysFinished } from "./lib/liveness.mjs";
import { sbGetAll, sbCount } from "./lib/sb.mjs";
const URL = "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
// Which statuses to scan. Default 'draft' (queue cleanup); the daily cron passes 'active,draft'
// so a LIVE draw whose competition has since finished is auto-expired off the public site.
const STATUS = (process.env.STATUS || "draft").split(",").map((s) => s.trim()).filter(Boolean);
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (!READ) {
  console.error("No Supabase key available. Bun auto-loads .env — check SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_PUBLISHABLE_KEY) is set there.");
  process.exit(1);
}
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
// FINISHED_RE and its matcher live in lib/liveness.mjs so scraper, sweep and verifier share one
// definition. Match through saysFinished(), never FINISHED_RE.test(html) — see the note there.

const ops = await Bun.file("operators.json").json();
const opBy = Object.fromEntries(ops.map((o) => [o.slug, o]));
// Paged, not a single read. This was one unpaginated request and PostgREST silently caps at
// 1000: on 2026-08-30 it logged "checking 1000 active+draft draws" — the cap describing
// itself as a total — and every row past 1000 had never been swept in the table's life.
// sbGetAll throws on a non-array body, preserving the loud-failure guard this replaced (a
// silent no-op on the daily cron is the failure mode this fleet exists to prevent).
const scope = await sbCount(`draws?select=id&status=in.(${STATUS.join(",")})`, { key: READ, base: URL });
let draws;
try {
  draws = await sbGetAll(`draws?status=in.(${STATUS.join(",")})&select=id,title,entry_url,draw_date,operators(slug,name)`, { key: READ, base: URL });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
// Print read-vs-scope, never a bare count. A truncation can then never again read as a total.
console.log(`${DRY ? "DRY RUN" : "LIVE"} — checking ${draws.length} of ${scope ?? "?"} ${STATUS.join("+")} draws in scope for ended comps\n`);
if (scope != null && draws.length < scope) {
  console.error(`⚠️  read ${draws.length} rows but ${scope} are in scope — pagination is losing rows`);
}
// Consumed by manager/inventory-scorecard.mjs to score sweep coverage. Written even on a dry
// run: coverage is a property of the read, not of whether we wrote anything.
await Bun.write("sweep-scope.json", JSON.stringify({ swept: draws.length, scope, statuses: STATUS, at: new Date().toISOString() }, null, 2));

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

// Returns { ended, why } as before, plus the EVIDENCE staleDateDecision needs:
//   purchasable  true | false | null   the operator's own flag, where one exists
//   freshDate    ISO | null            re-parsed with the SAME extractDate that produced the
//                                      stored value — no second definition of "the draw date"
//   reachable    bool                  did we actually read the product/page
//   source       "woo"|"shopify"|"render"|null   grades confidence downstream
// The ended/why contract is unchanged, so the write path below is untouched.
async function isEnded(d) {
  const op = opBy[d.operators?.slug];
  if (!op) return { ended: null, why: "operator not in config", purchasable: null, freshDate: null, reachable: false, source: null };
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
      if (!p) return { ended: null, why: "product not found in API or feed", purchasable: null, freshDate: null, reachable: false, source: "woo" };
      // The product payload is already in hand — parse the date from it rather than spending
      // a second request. Same parser (extractDate + op.patterns) as the original ingest.
      const wooText = textOf([p.name, p.description, p.short_description].filter(Boolean).join(" "));
      const freshDate = extractDate(wooText, op.patterns);
      if (!isPurchasable(p)) return { ended: true, why: `not purchasable (stock: ${p.stock_availability?.text || "?"})`, purchasable: false, freshDate, reachable: true, source: "woo" };
      return { ended: false, why: "purchasable", purchasable: true, freshDate, reachable: true, source: "woo" };
    }
    if (op.method === "shopify") {
      const map = await shopAvail(op);
      if (!map.size) return { ended: null, why: "feed unavailable", purchasable: null, freshDate: null, reachable: false, source: "shopify" };
      if (!map.has(slug.toLowerCase())) return { ended: null, why: "not in product feed (unverified)", purchasable: null, freshDate: null, reachable: false, source: "shopify" }; // conservative: never expire on absence
      const avail = map.get(slug.toLowerCase());
      // The /products.json list carries availability but not the draw date, so a shopify row
      // can only ever be ENDED or HELD here — never extended. Fetching each product page to
      // find a date would be a request per row; that is apply-time work, not sweep work.
      return { ended: !avail, why: avail ? "available" : "sold out / no available variant", purchasable: avail, freshDate: null, reachable: true, source: "shopify" };
    }
    // API operators have never had a branch here, so they fell through to the render text
    // probe below — which fetches the raw HTML of a JS-rendered SPA and finds neither a
    // finished marker nor a date. Measured 2026-08-31: 151 of the 472 stale-dated rows are
    // ukcc + seven-days-perf alone, held as "no future date readable" when the truth is that
    // we never asked their API. Their adapters (lib/adapters/raffle-engine.mjs, hydra, inertia)
    // already answer both questions server-side and are the correct source; wiring them into
    // the sweep is its own change. Until then, say so explicitly rather than letting these
    // rows sit in the render bucket looking like a parser failure.
    if (op.method === "api") {
      return { ended: null, why: `api operator (${op.apiStyle || "?"}) — sweep has no adapter path`, purchasable: null, freshDate: null, reachable: false, source: "api" };
    }

    // render / other: text probe. This is the ONLY weak signal in this file — Woo's
    // is_purchasable and Shopify's variant availability are the operator's own flags, but
    // "the page contains a finished phrase" is a heuristic, and it has been wrong at scale
    // (see saysFinished in lib/liveness.mjs). So it gets a second gate the strong signals
    // do not need: a draw still dated in the future is contrary evidence, and we report it
    // as unverifiable rather than expiring a live draw on a phrase match.
    const html = await (await fetch(d.entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
    // Render operators expose no purchasability flag, so "the page does not say finished" is
    // the closest thing to one — genuinely weaker evidence, and graded `medium` downstream.
    //
    // Use the FULL fieldsFromHtml here, not extractDate alone: it tries an attribute date and
    // a configured date selector before falling back to a text scan, and it is literally the
    // function that produced the stored value. A text-only scan missed the date on 303 of 406
    // readable rows in the first cut of this — a second, weaker definition of "the draw date"
    // is exactly what this was supposed to avoid.
    const freshDate = fieldsFromHtml({ html, url: d.entry_url, op })?.draw_date ?? null;
    if (!saysFinished(html)) return { ended: false, why: "no finished marker", purchasable: true, freshDate, reachable: true, source: "render" };
    if (isFutureDated(d)) return { ended: null, why: "page says finished but draw_date is still ahead", purchasable: null, freshDate, reachable: true, source: "render" };
    return { ended: true, why: "page says finished", purchasable: false, freshDate, reachable: true, source: "render" };
  } catch (e) { return { ended: null, why: `error ${(e.message || "").slice(0, 30)}`, purchasable: null, freshDate: null, reachable: false, source: op.method || null }; }
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

// Rows whose close date has already passed. NOT expired here: this sweep only ever writes
// status='ended' on the `ended === true` cohort above, and a past date is not evidence that a
// competition is over — only the operator's own purchasability flag is.
//
// OWNERSHIP: this block used to say "correcting the date is run.mjs's job". That was wrong,
// and it is why 397 rows accumulated with nobody acting on them. run.mjs structurally cannot
// reach these rows: render rows are discovered by crawling the operator's LISTING and a
// past-date comp is no longer linked there; woo rows fall outside the `after=` window and the
// page caps. The sweep reaches rows by entry_url, so the sweep is the right owner — but it
// stays REPORT-ONLY. It emits a verdict per row; a separate, gated script does the writing.
const staleDate = out.filter((x) => isPastDated(x.d) && x.ended !== true);
if (staleDate.length) {
  const verdicts = staleDate.map((x) => ({
    id: x.d.id,
    slug: x.d.operators?.slug ?? null,
    title: x.d.title ?? null,
    entry_url: x.d.entry_url,
    stored_draw_date: x.d.draw_date,
    ...staleDateDecision(x.d, x, new Date(NOW_MS)),
  }));
  const tally = verdicts.reduce((a, v) => { a[v.action] = (a[v.action] || 0) + 1; return a; }, {});
  console.log(`\n📅 STALE DATE (close date already passed): ${staleDate.length} — ` +
    Object.entries(tally).map(([k, n]) => `${k}:${n}`).join(" "));
  for (const v of verdicts.filter((v) => v.action === "extend").slice(0, 10)) {
    console.log(`  ↗ [${v.slug}] ${(v.title || "").slice(0, 38)} — ${String(v.stored_draw_date).slice(0, 10)} → ${v.to.slice(0, 10)} (${v.confidence})`);
  }
  // An `end` verdict here would mean the two paths disagree: this cohort excludes
  // `ended === true`, which is exactly the rows the write below has already handled, so a
  // not-purchasable row should never reach staleDateDecision. If one ever does, the sweep's
  // verdict and the date-decision's verdict have diverged and that is worth shouting about.
  const contradictions = verdicts.filter((v) => v.action === "end");
  for (const v of contradictions.slice(0, 6)) {
    console.error(`  ⚠️  [${v.slug}] ${(v.title || "").slice(0, 38)} — staleDateDecision says end but the sweep did not: ${v.reason}`);
  }
  const holds = verdicts.filter((v) => v.action === "hold");
  if (holds.length) console.log(`  ⏸ ${holds.length} held (no actionable evidence) — e.g. ${holds[0].reason}`);

  // Consumed by apply-stale-dates.mjs, which refuses a report older than its MAX_AGE_MIN:
  // a stale report applied later could extend a draw that has since closed.
  await Bun.write("stale-date-report.json", JSON.stringify({
    generatedAt: new Date(NOW_MS).toISOString(), dry: DRY, total: staleDate.length, tally, verdicts,
  }, null, 2));
  console.log(`  → stale-date-report.json written (${verdicts.length} verdicts)`);
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
