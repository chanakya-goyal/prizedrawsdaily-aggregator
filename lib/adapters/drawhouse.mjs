// DrawHouse — the white-label prize-draw platform (drawhouse.io) behind Raffle Town,
// ToffeesDraws, KopiteDraws and The Baby Show Prizes. The storefronts are Next.js on Vercel and
// trip a bot checkpoint ("Vercel Security Checkpoint", 403) after a few dozen requests, but they
// all read ONE keyless JSON API, and `affiliateId` picks the brand:
//   GET https://api.prod.raffletown.co.uk/v3/pub/gs/charityraffles/lobbygames?affiliateId=N&state=INPROGRESS
// → { errorCode: 0, data: { lobbyGames: [...] } }. The full URL lives in the operator's `listApi`.
//
// ⚠️ Shared pools: one game is sold through several brands. Game 69 is a single 1,100-ticket
// pool with ONE winner, shown as a supermarket voucher on Raffle Town and a club shirt on each
// fan site. Each brand gets its own `edition` (name, slug, image) and its own prize edition in
// the DRAW pool, so `maxTickets` is the NETWORK total. When the pool carries more than one
// brand's prize edition, the description says so (owner decision 2026-10-11) — otherwise the
// cap would read as odds for this brand alone.
//
// ⚠️ INSTANT_ONLY games (no DRAW prize pool) have no main draw and are skipped by owner
// decision (2026-10-11). The Baby Show runs only these, so it yields 0 until it runs a draw.
//
// `scheduledDrawTime` is a TRUE UTC instant ("…T21:00:00.000Z"); entries close 15 minutes
// earlier. It must NOT go through normalizeUkDate, which strips the offset and re-stamps the
// wall-clock as UK time (an hour early in BST). `entriesCount` is always "0" — it is not a
// sold counter; never read it.
import { UA, resolveCategory } from "../parse.mjs";
import { fetchWithRetry } from "../fetcher.mjs";
import { templateDescription } from "../describe.mjs";

export function affiliateIdOf(op) {
  try { return Number(new URL(op.listApi).searchParams.get("affiliateId")) || null; } catch { return null; }
}

// The brand's own edition of a game. The feed is already filtered per affiliate, but match on
// the id anyway: picking another brand's edition would publish the wrong prize and URL.
export function brandEdition(game, affiliateId) {
  const eds = Array.isArray(game?.editions) ? game.editions : [];
  return eds.find((e) => e?.affiliateId === affiliateId && e?.state === "ACTIVE") || null;
}

export function drawPool(game) {
  const pools = Array.isArray(game?.prizePools) ? game.prizePools : [];
  return pools.find((p) => p?.prizeType === "DRAW" && p?.isActive !== false) || null;
}

const isOpen = (game) => (Array.isArray(game?.roundsSummary) ? game.roundsSummary : []).some((r) => r?.state === "OPEN");
const gbpCount = (n) => n.toLocaleString("en-GB");

export function poolSentence(cap, pool) {
  const winners = Number(pool?.totalAvailable) || 1;
  return `Tickets are pooled across the DrawHouse network of brands, so the ${gbpCount(cap)}-ticket cap is the total for this draw, with ${winners === 1 ? "one winner" : `${gbpCount(winners)} winners`}.`;
}

export function mapGame(game, op, affiliateId) {
  const f = game?.fieldsSummary || {};
  if (f.requiresCode === "true") return null;
  if (!isOpen(game)) return null;
  const pool = drawPool(game);
  if (!pool) return null; // instant-win only: no main draw
  const ed = brandEdition(game, affiliateId);
  if (!ed?.slug) return null;
  const title = String(ed.name || "").trim();
  if (!title) return null;
  const poolEds = (Array.isArray(pool.editions) ? pool.editions : []).filter((e) => e?.isActive !== false);
  const mine = poolEds.find((e) => e?.editionId === ed.id);
  // pool.prizeName is an internal label ("£100 physical prize") unless the pool has no
  // per-brand editions — so it is only a fallback when it isn't that generic stock text.
  const poolName = /physical prize/i.test(pool.prizeName || "") ? "" : String(pool.prizeName || "").trim();
  const prize = String(mine?.prizeName || "").trim() || poolName;
  const grand_prize = prize || title;
  const price = Number(f.ticketPrice);
  const cap = Number(f.maxTickets);
  const ticket_price = Number.isFinite(price) ? Math.round(price * 100) / 100 : null;
  const total_entries = Number.isFinite(cap) && cap > 0 ? cap : null;
  const draw_date = f.scheduledDrawTime || null;
  const entry_url = `${op.base.replace(/\/+$/, "")}/prize-draw/${encodeURIComponent(ed.slug)}`;
  const shared = poolEds.length > 1;
  const base = templateDescription({ grand_prize, title, ticket_price, draw_date, slug: entry_url });
  return {
    title,
    grand_prize,
    grand_prize_source: mine?.prizeName ? "api:prizePools[DRAW].editions[brand].prizeName" : poolName ? "api:prizePools[DRAW].prizeName" : "title",
    category: resolveCategory({ op, title, grand_prize, url: entry_url, apiCategories: [] }),
    ticket_price,
    total_entries,
    draw_date,
    image_url: ed.images?.["lobby-card"]?.base || mine?.imageUrl || f.imageUrl || null,
    entry_url,
    description: shared && total_entries ? `${base} ${poolSentence(total_entries, pool)}` : null,
  };
}

export async function drawhouseOperator(op, perOp = 300) {
  const affiliateId = affiliateIdOf(op);
  if (!affiliateId) { console.log(`  drawhouse: no affiliateId in listApi for ${op.slug}`); return []; }
  const r = await fetchWithRetry(op.listApi, () => ({ headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }));
  if (!r.ok) { console.log(`  drawhouse lobby ${r.status} for ${op.listApi}`); return []; }
  let body;
  try { body = await r.json(); } catch { console.log("  drawhouse: unparseable lobby JSON"); return []; }
  const games = Array.isArray(body?.data?.lobbyGames) ? body.data.lobbyGames : [];
  const draws = games.map((g) => mapGame(g, op, affiliateId)).filter(Boolean);
  const instant = games.filter((g) => !drawPool(g)).length;
  console.log(`  ${draws.length} draws from the lobby feed (${games.length} games; ${instant} instant-win only, skipped)`);
  return draws.slice(0, perOp);
}
