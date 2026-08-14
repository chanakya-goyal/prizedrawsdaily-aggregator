// Discovery core — shared, injectable primitives for finding and probing candidate
// operators. Extracted from probe-candidates.mjs so sources/orchestrator/approval and the
// one-shot CLI all use the same deterministic survival rule: a candidate only counts if its
// WooCommerce/Shopify API returns live, purchasable products right now. No LLM.
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 12000;

// Normalize a slug / domain / URL / display name down to a comparable token.
export const norm = (s) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
  .replace(/\.(co\.uk|org\.uk|me\.uk|com|co|uk|scot|online|net|io|shop|store|gg|win)$/g, "").replace(/[^a-z0-9]/g, "");

// Likely live domains for a bare slug (used when a source yields names, not URLs).
export function domainsFor(slug) {
  const flat = slug.replace(/-/g, "");
  const variants = new Set([
    `${flat}.co.uk`, `${flat}.com`, `${slug}.co.uk`, `${slug}.com`,
    `${flat}.uk`, `${flat}.competitions.co.uk`,
  ]);
  return [...variants];
}

export async function fetchJson(url, { fetchImpl = fetch, timeout = TIMEOUT } = {}) {
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { ok: false, status: r.status };
    const t = await r.text();
    try { return { ok: true, json: JSON.parse(t) }; } catch { return { ok: false, status: "non-json" }; }
  } catch (e) { return { ok: false, status: (e.name === "TimeoutError" ? "timeout" : "err") }; }
}

// Deterministic platform probe for one base URL. Survives only with live purchasable products.
export async function probeDomain(base, { fetchImpl = fetch } = {}) {
  const woo = await fetchJson(`${base}/wp-json/wc/store/v1/products?per_page=20&orderby=date`, { fetchImpl });
  if (woo.ok && Array.isArray(woo.json)) {
    const live = woo.json.filter((p) => p.is_in_stock !== false && p.is_purchasable !== false);
    if (live.length) return { method: "woo", live: live.length, total: woo.json.length, sample: (live[0]?.name || "").slice(0, 50) };
  }
  const sh = await fetchJson(`${base}/products.json?limit=20`, { fetchImpl });
  if (sh.ok && Array.isArray(sh.json?.products) && sh.json.products.length) {
    const ps = sh.json.products;
    return { method: "shopify", live: ps.length, total: ps.length, sample: (ps[0]?.title || "").slice(0, 50) };
  }
  return null;
}

// Everything we must never re-surface: configured operators (slug/base/name), the
// documented skip list, and explicit rejections from the approval flow.
export async function knownOperatorSet() {
  const have = new Set();
  const dir = new URL("..", import.meta.url);
  const ops = await Bun.file(new URL("operators.json", dir)).json();
  for (const o of ops) { have.add(norm(o.slug)); have.add(norm(o.base)); have.add(norm(o.name)); }
  const csv = await Bun.file(new URL("skipped-operators.csv", dir)).text().catch(() => "");
  for (const line of csv.split("\n").slice(1)) {
    const cols = line.split(",");
    if (cols[1]) have.add(norm(cols[1]));
    if (cols[0]) have.add(norm(cols[0]));
  }
  const rejected = await Bun.file(new URL("discovery/rejected.json", dir)).json().catch(() => []);
  for (const r of rejected) have.add(norm(r.domain));
  have.delete("");
  return have;
}
