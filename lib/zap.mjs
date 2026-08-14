// "Zap Competitions" (craic-competitions WP plugin) support. This family renders NO
// countdown or ticket cap server-side — jquery.countdown + luxon paint them client-side
// from an admin-ajax call, so the static product page and Store API both lack draw_date
// and total_entries (the #1 gate-skip reason across the never-scraped woo operators:
// 294 missing-date + 82 missing-cap on 2026-08-14). The same ajax endpoint is public and
// batchable: action=zap_competition_ajax_refresh&ids[]=<product_id> returns
//   { "<id>": { tickets_max, tickets_sold, tickets_remaining, tickets_days_remaining, … } }
// tickets_max is the authoritative CAP (never a sold/remaining count — safe under the
// sold-veto rule) and days_remaining gives a day-precision close date.
import { UA } from "./parse.mjs";

export function detectZap(html) {
  return /zapc\s*=\s*\{|product-type-zap_competition|craic-competitions/.test(html || "");
}

export function parseZapRefresh(json, now) {
  const rows = {};
  if (!json || typeof json !== "object") return rows;
  for (const [id, r] of Object.entries(json)) {
    if (!r || typeof r !== "object") continue;
    const out = {};
    const max = Number(r.tickets_max);
    if (Number.isFinite(max) && max > 0) out.total_entries = max;
    const days = Number(r.tickets_days_remaining);
    if (Number.isFinite(days) && days >= 0) out.draw_date = new Date(now.getTime() + days * 864e5).toISOString();
    rows[id] = out;
  }
  return rows;
}

// Fill gaps only — a value the page parser DID extract always wins over the ajax estimate.
export function mergeZap(draw, zapRow) {
  if (!draw || !zapRow) return draw;
  if (draw.total_entries == null && zapRow.total_entries != null) draw.total_entries = zapRow.total_entries;
  if (!draw.draw_date && zapRow.draw_date) draw.draw_date = zapRow.draw_date;
  return draw;
}

export async function fetchZapRefresh(base, ids, { fetchImpl = fetch } = {}) {
  try {
    const body = new URLSearchParams();
    body.set("action", "zap_competition_ajax_refresh");
    for (const id of ids) body.append("ids[]", String(id));
    const r = await fetchImpl(`${base}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
