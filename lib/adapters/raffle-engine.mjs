// "Raffle engine" platform — the Angular SPA behind 7Days Performance AND UKCC.
//
// WHY THIS EXISTS: 7Days is the single biggest UK car operator on the site, and it serves an
// Angular app where every HTML path returns the same ~66KB shell. The scraper reached it by
// driving a browser and scraping `/product/…` links off the listing, which is slow, lazy-load
// flaky, and hard-capped at PER_OP links — a probe found 10 draw pages on an operator running
// 56 live competitions.
//
// The app talks to a public, keyless JSON API on the same host. Found by reading the bundle's
// route table (`main.*.js`), then confirming against live traffic:
//     GET {base}/api/v2/raffle-draws/GBP?limit=300&include_finished=false
//                                       &include_running=true&include_soldout=true
// No auth, no cookie, no Referer, no User-Agent required. Returns a BARE ARRAY.
//
// ⚠️ Two traps for anyone re-deriving this:
//   1. The bundle also exposes `getPageRaffle` → `/api/v2/page-raffle-list/{slug}`. That route
//      is DEAD — it 404s for every category slug and id, on both operators. Don't chase it.
//   2. `include_finished` defaults to TRUE. Omitting it returns 500 rows for 7Days instead of
//      56, i.e. mostly finished competitions. Always pass it explicitly.
//
// UKCC runs the identical platform and schema; only the public URL shape differs, which is
// why `drawPath` is config rather than code.
import { UA, normalizeUkDate, resolveCategory } from "../parse.mjs";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Prices come as a tiered ladder (1 / 5 / 25 tickets…). The per-ticket price is the entry
// with tickets_quantity === 1; fall back to the cheapest unit price if that tier is absent.
export function unitPrice(offers) {
  const list = Array.isArray(offers) ? offers : [];
  const single = list.find((o) => Number(o?.tickets_quantity) === 1);
  if (single != null && num(single.price) != null) return num(single.price);
  const units = list.map((o) => { const q = Number(o?.tickets_quantity), p = num(o?.price); return q > 0 && p != null ? p / q : null; }).filter((x) => x != null);
  return units.length ? Math.round(Math.min(...units) * 100) / 100 : null;
}

// Map one API record into the shape fieldsFromHtml produces, so gate/dedupe/flush see no
// difference between a JSON operator and an HTML one.
export function mapRaffle(r, op) {
  const title = (r?.title || "").trim();
  const slug = r?.slug;
  if (!title || !slug) return null;
  const grand_prize = (r?.end_prize_name || "").trim() || title;
  return {
    title,
    grand_prize,
    grand_prize_source: r?.end_prize_name ? "api:end_prize_name" : "title",
    // The operator's own category_ids are slugs like "car-sport"/"car-suv". They're useful but
    // not authoritative — a Rolex is tagged into car-* on 7Days — so they go through the same
    // precedence as every other source, where a clear title signal still wins.
    category: resolveCategory({ op, title, grand_prize, url: slug, apiCategories: Array.isArray(r?.category_ids) ? r.category_ids : [] }),
    ticket_price: unitPrice(r?.offers),
    total_entries: num(r?.max_entries),
    // end_at is the entry deadline and carries a real UK offset already; normalizeUkDate keeps
    // the stored instant consistent with every other operator.
    draw_date: r?.end_at ? normalizeUkDate(r.end_at) : null,
    image_url: r?.thumbnail?.url || r?.thumbnail?.big || null,
    entry_url: `${op.base.replace(/\/+$/, "")}${(op.drawPath || "/product/{slug}").replace("{slug}", slug)}`,
    description: null,
  };
}

export function listUrl(op) {
  const base = op.base.replace(/\/+$/, "");
  const currency = op.currency || "GBP";
  return `${base}/api/v2/raffle-draws/${currency}`
    + `?limit=${op.apiLimit || 300}&offset=0`
    + `&include_finished=false&include_running=true&include_soldout=true&sortby=date`;
}

export async function raffleEngineOperator(op, perOp = 300) {
  const r = await fetch(listUrl(op), { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) { console.log(`  raffle-engine API ${r.status} for ${op.base}`); return []; }
  let body = null;
  try { body = await r.json(); } catch { console.log("  raffle-engine API returned non-JSON"); return []; }
  const rows = Array.isArray(body) ? body : [];
  if (!rows.length) { console.log("  raffle-engine API returned no competitions"); return []; }
  // is_open is the platform's own live flag; keep it as a belt-and-braces filter alongside
  // include_finished=false rather than trusting one signal.
  const live = rows.filter((x) => x?.is_open !== false);
  console.log(`  ${live.length} live competitions from the API (${rows.length} returned)`);
  return live.slice(0, perOp).map((x) => mapRaffle(x, op)).filter(Boolean);
}
