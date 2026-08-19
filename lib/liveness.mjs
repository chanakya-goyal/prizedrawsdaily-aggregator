// Is this competition still open? Shared by the scraper (don't ingest a finished comp),
// ended-sweep (expire one that has since finished) and the publish verifier — because when
// those three disagree, a finished draw either sits on the public site or never leaves it.
//
// ⚠️ THE BUG THIS MODULE EXISTS TO KILL: WooCommerce's Store API does NOT return a stable
// type for `is_purchasable`. Measured on gaming-giveaways 2026-08-19:
//     page 1 → {"boolean:true": 68, "number:0": 32}
//     page 4 → {"number:0": 100}
// So a finished competition can arrive as the NUMBER 0 rather than `false`, and both call
// sites got it wrong in opposite directions:
//     extractor.mjs   `p.is_purchasable !== false`  → 0 !== false is TRUE  → ingested as live
//     ended-sweep.mjs `p.is_purchasable === false`  → 0 === false is FALSE → never expired
// Shallow depth masked it (the newest 60 products are mostly genuinely live), but page 4 at
// gaming-giveaways is 100/100 finished comps that the old filter would have accepted —
// which is why this had to land before pagination, not after.

// Truthy-but-not-live values seen in the wild. Compared as strings so a future "0"/"false"/
// 0 all collapse to the same answer, and an ABSENT flag stays live (older Woo builds omit it).
const NOT_LIVE = new Set(["false", "0", "no", "off"]);

export function isPurchasable(product) {
  const v = product?.is_purchasable;
  if (v === undefined || v === null) return true; // field absent → no evidence of closure
  return !NOT_LIVE.has(String(v).trim().toLowerCase());
}

// Shopify has no purchasability flag — an available variant is the equivalent signal. Note
// the single-product /products/<handle>.json endpoint OMITS `available`, so callers must
// read it from the LIST feed (/products.json); passing a single-product payload here would
// read as "sold out" for everything.
export function hasAvailableVariant(product) {
  return (product?.variants || []).some((v) => v?.available === true);
}

// Text fallback for render/JSON operators with no structured flag.
export const FINISHED_RE = /this competition has (?:now )?finished|competition (?:has )?finished|competition is (?:now )?closed|this draw has (?:now )?(?:ended|closed)/i;

// Last path segment of an entry_url — returned RAW, because that is exactly what Woo stores
// in `product.slug`. Do NOT decode it: operators whose titles start with an emoji get a
// percent-literal slug ("%f0%9f%8e%b0-33-for-33-instant-wins", 🎰), and Woo keeps those
// escapes verbatim in the slug field, so a decoded form would match nothing.
export function productSlug(url) {
  return (url || "").replace(/[#?].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
}

// ⚠️ `?slug=` CANNOT resolve percent-literal slugs. Measured on easy-living-competitions
// 2026-08-19: `?slug=dino-doors` → 1 product, but `?slug=%f0%9f%92%b7-win-200-cash…` → 0,
// for ANY encoding of that value (raw, once-encoded, decoded). 56 of its newest 100 products
// carry such slugs. Since ended-sweep treats "product not found" as unverifiable and
// therefore never expires the draw, over half that operator's catalogue was permanently
// unexpirable. Callers must fall back to the LISTING feed and match on permalink — which is
// what `permalinkKey` is for.
export const isPercentLiteralSlug = (slug) => /%[0-9a-f]{2}/i.test(slug || "");

// Canonical key for matching a stored entry_url against a product permalink: they differ
// freely in trailing slash, query string and fragment.
export const permalinkKey = (url) => (url || "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
