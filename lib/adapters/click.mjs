// Click Competitions — bespoke Next.js storefront (Prismic CMS + their own competition
// backend). There is no public REST API, but every page embeds its full state in
// <script id="__NEXT_DATA__">, and /all-competitions carries the COMPLETE live catalogue
// (47 comps when written — the homepage shows only ~9). One plain fetch, no browser.
//
// ⚠️ Shape trap: the same competition objects appear TWICE per page — once under
// `pageProps.pageData.data.body[].ref.list[].competition` and mirrored under
// `pageProps.pageComponents[].ref.list[].competition` — and which blocks are inline vs
// ref-wrapped differs between the homepage and /all-competitions templates. Walking fixed
// paths breaks on a re-template, so we collect EVERY object carrying a `server.slug`
// anywhere in the tree and dedupe on that slug (250 objects → 47 unique when written).
//
// The `server` object is the operator's own backend record: `ticketAmount` (GBP units),
// `endDate`/`drawDate` (real UTC instants), `unified_status` ("liveOpen" = purchasable),
// and the ticket cap under `dynamicVisibility.detail.totalTickets`. `infiniteTickets`
// exists and must null the cap — the gate is what excludes uncapped comps, but it must
// not see a fake number.
import { UA, resolveCategory } from "../parse.mjs";
// These adapters bypass fetchHtml, so before this they had no retry at all — a single
// transient refusal returned [] and cost the operator its whole day (see lib/fetcher.mjs).
import { fetchWithRetry } from "../fetcher.mjs";

export function parseNextData(html) {
  const m = (html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Every object with a `server.slug` is one competition card; later duplicates of a slug are
// the mirrored render of the same card, so first sighting wins.
export function collectCompetitions(root) {
  const bySlug = new Map();
  const walk = (o) => {
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (!o || typeof o !== "object") return;
    if (o.server && typeof o.server === "object" && o.server.slug) {
      if (!bySlug.has(o.server.slug)) bySlug.set(o.server.slug, o);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return [...bySlug.values()];
}

export function mapCompetition(c, op) {
  const srv = c?.server || {};
  const title = String(c?.title || srv.name || "").trim();
  if (!title || !srv.slug) return null;
  const prize = Array.isArray(srv.prizes) ? String(srv.prizes[0]?.prize?.name || "").trim() : "";
  const grand_prize = prize || title;
  const apiCategories = [
    ...(Array.isArray(srv.prizes) ? srv.prizes.map((p) => p?.prize?.category) : []),
  ].filter(Boolean);
  const price = Number(srv.ticketAmount);
  const cap = Number(srv?.dynamicVisibility?.detail?.totalTickets);
  // `slugPrefix` is the public path with dots for slashes: ".cars.Subaru-Impreza-RB320-…"
  // → /cars/Subaru-Impreza-RB320-…  (the Prismic `slug` on the card matches it).
  const pathParts = String(srv.slugPrefix || c?.slug || "").split(".").filter(Boolean);
  if (!pathParts.length) return null;
  const entry_url = `${op.base.replace(/\/+$/, "")}/${pathParts.map(encodeURIComponent).join("/")}`;
  return {
    title,
    grand_prize,
    grand_prize_source: prize ? "api:prizes[0].prize.name" : "title",
    category: resolveCategory({ op, title, grand_prize, url: entry_url, apiCategories }),
    ticket_price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    total_entries: Number.isFinite(cap) && cap > 0 && !srv.infiniteTickets ? cap : null,
    // endDate is the entry deadline (drawDate matches it on every live comp seen). These are
    // TRUE UTC instants ("…T19:55:00.000Z") — normalizeUkDate must NOT touch them: it strips
    // the offset and re-stamps the wall-clock as UK time, which would shift every draw an
    // hour early in summer. It exists for operators that publish offset-less UK wall-clock.
    draw_date: srv.endDate || srv.drawDate || null,
    image_url: c?.card_asset?.default?.url || null,
    entry_url,
    description: null,
  };
}

export async function clickOperator(op, perOp = 300) {
  const url = op.listing || `${op.base.replace(/\/+$/, "")}/all-competitions`;
  const r = await fetchWithRetry(url, () => ({ headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) }));
  if (!r.ok) { console.log(`  click listing ${r.status} for ${url}`); return []; }
  const next = parseNextData(await r.text());
  if (!next) { console.log("  click: no parseable __NEXT_DATA__"); return []; }
  const all = collectCompetitions(next);
  const live = all.filter((c) => c?.server?.unified_status === "liveOpen" && !c?.server?.availableOnlyForTestUser);
  console.log(`  ${live.length} live competitions from __NEXT_DATA__ (${all.length} unique listed)`);
  return live.slice(0, perOp).map((c) => mapCompetition(c, op)).filter(Boolean);
}
