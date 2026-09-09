// "Give me the product this stored row is about" — one implementation, because there were two
// and only one of them was right.
//
// ended-sweep asked `?slug=` and fell back to the listing feed on a miss; qa-fix asked `?slug=`
// and gave up. After the CloudFront fix (see pickProductForUrl) that difference stopped being
// cosmetic: on an operator whose CDN ignores the query string, ended-sweep still resolves the
// row through the feed while qa-fix silently skipped it, leaving exactly the rows most likely to
// be wrong unaudited. Both callers now come through here.
import { permalinkKey, productSlug, isPercentLiteralSlug, pickProductForUrl } from "./liveness.mjs";
import { UA } from "./parse.mjs";

const feedCache = new Map();

// One paged pass per operator, cached, keyed on permalink. Bounded at 5 pages — this is a
// fallback, not a full crawl. A partial or empty map means those rows stay unverified, which is
// the safe direction: never wrongly expired, never wrongly corrected.
export async function wooFeed(op, { fetchImpl = fetch, ua = UA, timeoutMs = 20000 } = {}) {
  if (feedCache.has(op.slug)) return feedCache.get(op.slug);
  const map = new Map();
  try {
    for (let page = 1; page <= 5; page++) {
      const url = op.apiStyle === "rest_route"
        ? `${op.base}/?rest_route=/wc/store/v1/products&per_page=100&page=${page}`
        : `${op.base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
      const arr = await fetchImpl(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json());
      if (!Array.isArray(arr) || !arr.length) break;
      for (const p of arr) map.set(permalinkKey(p.permalink), p);
      if (arr.length < 100) break;
    }
  } catch { /* partial map — see above */ }
  feedCache.set(op.slug, map);
  return map;
}

export function resetWooFeedCache() { feedCache.clear(); }

// `onMismatch(op.slug)` fires when `?slug=` answered with a product that is not ours — an
// operator-side fault we can only detect, never fix, so the caller is given the chance to count
// and print it rather than let it stay invisible.
export async function wooProductForUrl(op, entryUrl, { fetchImpl = fetch, ua = UA, timeoutMs = 20000, onMismatch } = {}) {
  const slug = productSlug(entryUrl);
  let product = null;
  // ?slug= cannot resolve percent-literal slugs at all — skip straight to the feed for those
  // rather than spend a request proving it.
  if (!isPercentLiteralSlug(slug)) {
    try {
      const r = await fetchImpl(`${op.base}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(timeoutMs) });
      const arr = await r.json();
      product = pickProductForUrl(arr, entryUrl);
      if (!product && Array.isArray(arr) && arr.length) onMismatch?.(op.slug);
    } catch { /* fall through to the feed */ }
  }
  if (!product) product = (await wooFeed(op, { fetchImpl, ua, timeoutMs })).get(permalinkKey(entryUrl)) || null;
  return product;
}
