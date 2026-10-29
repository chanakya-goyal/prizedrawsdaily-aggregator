// Same draw, new URL. An operator that re-lists a competition often mints a new product (a
// cloned WooCommerce product, a renamed slug, a 301 to a shorter permalink). run.mjs matched
// stored rows by exact entry_url only, so the re-list looked brand new and was inserted with a
// "-2" slug next to the row it duplicates: same operator, title, price and close date, the
// duplicate titles/descriptions the SEO guard fails on (live 2026-10-29: island-competitions
// "choose-your-paradise-...-2", pawsome-comps "...-kindle-end-prize-...-2").
//
// This module finds the stored row a fresh draw is the re-list of. It is pure.

const LIVE = ["active", "draft"];
export const normTitle = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ms = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? t : null; };
const price = (p) => (p == null ? null : Math.round(Number(p) * 100));

/** operator + normalised title + close instant + ticket price, or null if any part is missing. */
export function relistKey(operatorId, row) {
  const t = normTitle(row.title), when = ms(row.draw_date), p = price(row.ticket_price);
  if (!operatorId || !t || when == null || p == null) return null;
  return `${operatorId}|${t}|${when}|${p}`;
}

/**
 * @param rows stored draws (need id, operator_id, title, ticket_price, draw_date, entry_url, status, created_at)
 * @returns { match(operatorId, fresh, scrapedKeys), consume(row) }
 *  match returns the stored row to update, or null:
 *  - only active/draft rows, never ended or rejected (a relisted ended row has its own path)
 *  - the stored row's URL must differ from the fresh one (same URL is the normal byUrl path)
 *  - and must NOT still be in this operator's current scrape (`scrapedKeys`, permalink keys): if the
 *    operator lists both URLs they are two products that happen to share a title, so both stay.
 *  - oldest candidate wins; consume() makes a row adoptable at most once per run.
 */
export function relistIndex(rows, keyOfUrl) {
  const byKey = new Map();
  for (const r of rows) {
    if (!LIVE.includes(r.status) || !r.entry_url) continue;
    const k = relistKey(r.operator_id, r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const list of byKey.values()) list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return {
    match(operatorId, fresh, scrapedKeys) {
      const k = relistKey(operatorId, fresh);
      if (!k) return null;
      const freshKey = keyOfUrl(fresh.entry_url);
      return (byKey.get(k) || []).find((r) => {
        const rk = keyOfUrl(r.entry_url);
        return rk !== freshKey && !scrapedKeys.has(rk);
      }) || null;
    },
    consume(row) {
      const k = relistKey(row.operator_id, row);
      const list = byKey.get(k);
      if (list) byKey.set(k, list.filter((r) => r.id !== row.id));
    },
  };
}
