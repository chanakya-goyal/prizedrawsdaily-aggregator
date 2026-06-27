// Pluggable fetch/render layer for the PrizeDrawsDaily aggregator — KEYLESS by default.
// Lets each operator pick HOW its pages are acquired (op.fetcher) without touching any parser.
//
//   plain        — DEFAULT: fetch() with the shared UA. Byte-identical to the old inline
//                  fetch in extractor.mjs, so every operator with no `fetcher` field is
//                  completely unaffected (the live cowork routine sees zero change).
//   flaresolverr — POST to a self-hosted FlareSolverr proxy to clear a Cloudflare challenge
//                  and return the solved HTML + cookies. Coded now; wired to the Action in
//                  the deferred Cloudflare round.
//   api          — keyed managed scraper (ZenRows/Scrapfly/…). Coded but DORMANT: with no
//                  SCRAPER_API_* env set it falls back to plain, so a stray fetcher:"api"
//                  can never hard-fail a run.
//   stealth      — render-only hook (patchright / stealth browser); handled in renderVia.
//
// All strategies return the SAME shape so callers stay strategy-agnostic:
//   fetchHtml → { status, ok, text }            (text = raw response body: HTML or JSON string)
//   renderVia → { text, html, ogImage, links }  (same shape renderPage already returns)
import { UA, load, textOf, abs } from "./parse.mjs";

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const SCRAPER_API_URL = process.env.SCRAPER_API_URL || ""; // e.g. https://api.zenrows.com/v1/
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";

// ---- static / API path -----------------------------------------------------
// Returns { status, ok, text }. Callers JSON.parse(text) for the woo/shopify APIs (same as
// the old `await r.json()`), or use text directly as HTML for product pages.
export async function fetchHtml(url, op = {}) {
  switch (op.fetcher) {
    case "flaresolverr": return fetchFlareSolverr(url, op);
    case "api":          return fetchApi(url, op);
    default:             return fetchPlain(url, op); // "plain" | undefined | unknown
  }
}

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
async function fetchPlain(url, op) {
  // Hard per-request timeout: without it a single slow/hanging endpoint stalls the whole run
  // (the per-product page fetches are the hot path at high PER_OP_API). 20s default, env-tunable.
  const init = { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  // Per-operator TLS relaxation for a misconfigured cert (Bun honours fetch tls options).
  // Scoped to the one operator — never NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide.
  if (op.insecureTLS) init.tls = { rejectUnauthorized: false };
  const r = await fetch(url, init);
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

// FlareSolverr clears a "Just a moment" managed challenge and hands back the real HTML plus
// the cf_clearance cookie. Failure is soft: { ok:false } so looksBlocked()/the caller skips.
async function fetchFlareSolverr(url, op) {
  try {
    const r = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: op.fetcherOpts?.maxTimeout || 60000 }),
    });
    const data = await r.json().catch(() => null);
    const sol = data?.solution;
    if (!sol || typeof sol.response !== "string") return { status: 502, ok: false, text: "", cookies: [] };
    const status = sol.status || 200;
    return { status, ok: status < 400, text: sol.response, cookies: sol.cookies || [] };
  } catch (e) {
    return { status: 0, ok: false, text: "", cookies: [], error: e.message };
  }
}

// Managed scraping API (opt-in, paid). Dormant until SCRAPER_API_URL + SCRAPER_API_KEY are
// set; until then it transparently degrades to plain so it never breaks an unconfigured run.
async function fetchApi(url, op) {
  if (!SCRAPER_API_URL || !SCRAPER_API_KEY) return fetchPlain(url, op);
  const opts = op.fetcherOpts || {};
  const qs = new URLSearchParams({ url, apikey: SCRAPER_API_KEY });
  if (opts.render) qs.set("js_render", "true");
  if (opts.premium) qs.set("premium_proxy", "true");
  const r = await fetch(`${SCRAPER_API_URL}?${qs.toString()}`, { headers: { "User-Agent": UA } });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

// ---- render path -----------------------------------------------------------
// Strategy wrapper around extractor.renderPage (passed in as renderFn to avoid a circular
// import). plain/stealth → delegate to the real browser render (insecureTLS is handled at the
// Playwright context via makeContext). flaresolverr → fetch the cleared HTML over HTTP and
// shape it exactly like renderPage's return, so renderOperator's parsing is unchanged.
export async function renderVia(renderFn, ctx, url, op = {}, opts = {}) {
  if (op.fetcher === "flaresolverr" || op.fetcher === "api") {
    const { ok, text } = await fetchHtml(url, op);
    if (!ok || !text) return { text: "", html: "", ogImage: null, links: [] };
    return htmlToRenderShape(text, op.base || url);
  }
  return renderFn(ctx, url, opts.waitMs, { hard: !!opts.hard });
}

// Turn raw HTML into renderPage's { text, html, ogImage, links } shape (no browser).
function htmlToRenderShape(html, base) {
  const $ = load(html);
  const ogImage = $('meta[property="og:image"]').attr("content") || null;
  const links = [];
  $("a[href]").each((_, el) => { const h = abs($(el).attr("href"), base); if (h) links.push(h); });
  return { text: textOf(html), html, ogImage, links };
}
