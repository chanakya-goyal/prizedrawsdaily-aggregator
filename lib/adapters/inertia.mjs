// Laravel + Inertia.js (compengine.io whitelabel) — Dream Big Competitions.
//
// These sites ship no REST API and no sitemap, but Inertia serialises the ENTIRE page state
// into a `data-page` attribute on `#app`, so one plain HTML fetch yields fully structured
// JSON — every field we need, including the description, with no per-product page fetch.
//
// ⚠️ Do NOT use the `X-Inertia: true` header shortcut to get bare JSON. It 409s unless the
// request also carries `X-Inertia-Version`, whose hash changes on every deploy — a scraper
// built on it breaks silently the next time the operator ships. Parsing `data-page` works
// regardless of version.
//
// ⚠️ Shape trap: on the LISTING page `categories` / `galleries` are plain arrays, but on a
// DETAIL page the same keys are wrapped as `{ data: [...] }`. `arrayOf` handles both.
//
// Also note `?category=N` is applied client-side — every request returns the full set, so one
// fetch is the complete catalogue and there is nothing to paginate.
import { UA, normalizeUkDate, resolveCategory } from "../parse.mjs";

// Minimal, targeted HTML-entity decode for the attribute value. The attribute is written with
// `&quot;` for every JSON quote, so this must run before JSON.parse.
const unescapeAttr = (s) => s
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseDataPage(html) {
  const m = (html || "").match(/data-page="([^"]*)"/s);
  if (!m) return null;
  try { return JSON.parse(unescapeAttr(m[1])); } catch { return null; }
}

export const arrayOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

export function mapCompetition(r, op) {
  const title = (r?.name || "").trim();
  const slug = r?.slug;
  if (!title || !slug) return null;
  // ⚠️ `sale_price` is "0.00" when there is NO sale — it is not null. A `??` here would take
  // that zero as the real price and wipe out the ticket price on most of the catalogue (6 of
  // 9 live comps when this was written), and the gate would then drop them all for "no/zero
  // ticket price". Only treat sale_price as authoritative when it is actually positive.
  const sale = Number(r?.sale_price);
  const price = sale > 0 ? sale : Number(r?.price);
  const cats = arrayOf(r?.categories).map((c) => c?.name).filter(Boolean);
  return {
    title,
    grand_prize: title,
    grand_prize_source: "api:name",
    category: resolveCategory({ op, title, grand_prize: title, url: slug, apiCategories: cats }),
    ticket_price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    total_entries: Number.isFinite(Number(r?.total_tickets)) ? Number(r.total_tickets) : null,
    // `end` is "YYYY-MM-DD HH:MM:SS" with NO timezone — it is Europe/London wall-clock, which
    // is exactly what normalizeUkDate expects to stamp with the right BST/GMT offset.
    draw_date: r?.end ? normalizeUkDate(String(r.end).replace(" ", "T")) : null,
    // image_path is relative to the site origin.
    image_url: r?.image_path ? new URL(r.image_path, op.base).href : null,
    entry_url: `${op.base.replace(/\/+$/, "")}/competitions/${slug}`,
    description: null,
  };
}

export async function inertiaOperator(op, perOp = 300) {
  const url = op.listing || `${op.base.replace(/\/+$/, "")}/competitions`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) { console.log(`  inertia listing ${r.status} for ${url}`); return []; }
  const page = parseDataPage(await r.text());
  if (!page) { console.log("  inertia: no parseable data-page attribute"); return []; }
  // Featured competitions are duplicates of entries already in the main list — merge by id so
  // one comp can't be ingested twice under two slugs.
  const seen = new Set();
  const rows = [...arrayOf(page?.props?.competitions), ...arrayOf(page?.props?.featuredCompetitions)]
    .filter((x) => { const k = x?.id ?? x?.slug; if (k == null || seen.has(k)) return false; seen.add(k); return true; });
  const live = rows.filter((x) => String(x?.status || "").toLowerCase() === "active");
  console.log(`  ${live.length} live competitions from data-page (${rows.length} listed)`);
  return live.slice(0, perOp).map((x) => mapCompetition(x, op)).filter(Boolean);
}
