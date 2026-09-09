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
import { textOf } from "./parse.mjs";

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

// ⚠️ NEVER run FINISHED_RE against raw HTML — use this.
//
// Measured 2026-08-26: wc-lottery ships its i18n string bundle inside a <script> on EVERY
// page it renders, live or not, and that bundle contains the literal "This competition has
// finished". ended-sweep tested `FINISHED_RE.test(html)` on the unparsed body, so every
// draw on a wc-lottery operator matched and was expired within ~38 minutes of ingest —
// 42 draws were sitting at status='ended' with a draw_date still in the FUTURE when this
// was found. The marker has to come from text a reader can actually see.
//
// textOf() (lib/parse.mjs) already strips <script>/<style> and tags; <template> and
// <noscript> go first because textOf keeps their INNER text, which is exactly where a
// framework parks its "competition has finished" string for later use.
export function saysFinished(html) {
  const visible = textOf(
    String(html || "")
      .replace(/<template[\s\S]*?<\/template>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " "),
  );
  return FINISHED_RE.test(visible);
}

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

// Path of a product permalink, host-insensitive. operators.json holds the APEX base while
// stored entry_urls carry `www.` (lucky-day-competitions is exactly this shape), so comparing
// whole urls would reject correct products. What identifies a product is its path.
const permalinkPath = (url) => {
  const s = permalinkKey(url);
  if (!s) return "";
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/);
  return m ? m[1] : (s.startsWith("/") ? s : "");
};

// ⚠️ THE PRODUCT COMING BACK IS NOT NECESSARILY THE PRODUCT YOU ASKED FOR.
//
// `?slug=<x>` looks like a lookup by identity, so ended-sweep took `arr[0]` on trust. It is
// really a filter on a cacheable collection endpoint, and a CDN that leaves the query string
// out of its cache key will serve ONE body for every slug. Measured on lucky-day-competitions
// 2026-09-09 (`x-cache: Hit from cloudfront`), the same endpoint answered every slug we asked
// — including a slug that does not exist — with:
//     age=16     → [ samsung-galaxy-s26… ]    one real product, the wrong one
//     age=15995  → [ ]                        empty
// so ~10 unrelated draws were each bound to whichever product was cached at that moment. That
// product then supplied their ticket_price (the audit proposed one identical price across all
// of them — how this was found), their draw date, and their PURCHASABILITY: a single cached
// sold-out product would have expired the operator's entire live catalogue in one sweep.
//
// The operator has no way to tell us this is happening and the payload looks perfectly valid,
// so the only defence is to check identity ourselves. Returning null on a mismatch is cheap:
// callers already fall back to the LISTING feed, which matches on permalink and is correct by
// construction. Position in an array proves nothing.
export function pickProductForUrl(products, url) {
  if (!Array.isArray(products) || !products.length) return null;
  const wantSlug = productSlug(url).toLowerCase();
  const wantPath = permalinkPath(url);
  if (!wantSlug && !wantPath) return null;
  if (wantSlug) {
    for (const p of products) {
      const slug = typeof p?.slug === "string" ? p.slug.trim().toLowerCase() : "";
      if (slug && slug === wantSlug) return p;
    }
  }
  if (wantPath) {
    for (const p of products) {
      const path = permalinkPath(p?.permalink);
      if (path && path === wantPath) return p;
    }
  }
  return null;
}
