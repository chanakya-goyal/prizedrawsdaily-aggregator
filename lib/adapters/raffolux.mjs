// Raffolux — a bespoke Next.js storefront whose competition pages render client-side, so the
// render path found no draw links and the operator yielded 0. The storefront reads ONE keyless
// JSON feed of every live raffle:
//   GET https://raffolux.com/api/raffle/active/site/all → [ { id, slug, category, title, … } ]
// The URL lives in the operator's `listApi`.
//
// Fields: `pricePerTicket` is a number in pounds (0 on the free draws), `totalTickets` is the
// cap, and `soldTicketCount` is a live counter we don't read. `drawDate` is a TRUE UTC instant
// ("2026-10-14T21:00:00.000Z" = 10pm BST), so it must NOT go through normalizeUkDate, which
// strips the offset and re-stamps the wall clock as UK time (an hour late in BST).
// The entry page is /raffle/{category}/{id}/{slug}; all three parts are required.
import { UA, resolveCategory } from "../parse.mjs";
import { fetchWithRetry } from "../fetcher.mjs";

export const RAFFOLUX_API = "https://raffolux.com/api/raffle/active/site/all";

// Raffolux's own category slugs, spelled the way lib/parse.mjs mapOperatorCategory reads them.
// "indulgence" (gifts, days out, beauty) is deliberately unmapped: the title decides, or the
// draw is held as a draft for the QA routine like any other draw with no category evidence.
const CATEGORY_LABEL = { "instant-win": "instant win", credit: "site credit" };

export function mapRaffle(r, op) {
  const title = String(r?.title || "").trim();
  if (!title || !r?.id || !r?.slug || !r?.category) return null;
  const prize = String(r.prizeName || "").trim();
  const price = Number(r.pricePerTicket);
  const cap = Number(r.totalTickets);
  const entry_url = `${op.base.replace(/\/+$/, "")}/raffle/${encodeURIComponent(r.category)}/${encodeURIComponent(r.id)}/${encodeURIComponent(r.slug)}`;
  return {
    title,
    grand_prize: prize || title,
    grand_prize_source: prize ? "api:prizeName" : "title",
    category: resolveCategory({ op, title, grand_prize: prize || title, url: entry_url, apiCategories: [CATEGORY_LABEL[r.category] || r.category] }),
    ticket_price: r.pricePerTicket != null && Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    total_entries: Number.isFinite(cap) && cap > 0 ? cap : null,
    draw_date: r.drawDate || null,
    image_url: r.media?.main || r.media?.thumbnail || null,
    entry_url,
    description: null,
  };
}

export async function raffoluxOperator(op, perOp = 300) {
  const url = op.listApi || RAFFOLUX_API;
  const res = await fetchWithRetry(url, () => ({ headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }));
  if (!res.ok) { console.log(`  raffolux feed ${res.status} for ${url}`); return []; }
  let body;
  try { body = await res.json(); } catch { console.log("  raffolux: unparseable feed JSON"); return []; }
  const raffles = Array.isArray(body) ? body : [];
  const draws = raffles.map((r) => mapRaffle(r, op)).filter(Boolean);
  console.log(`  ${draws.length} live raffles from the feed (${raffles.length} returned)`);
  return draws.slice(0, perOp);
}
