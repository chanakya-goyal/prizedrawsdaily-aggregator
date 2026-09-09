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
// `retry` lets the caller choose a budget: a LISTING fetch failing loses the whole operator,
// so it earns 3 attempts; a per-product fetch loses one draw and runs at FETCH_CONCURRENCY 8,
// so it gets 2 and does not multiply the run's wall-clock.
export async function fetchHtml(url, op = {}, retry = {}) {
  // An unknown value here is a config typo (or `stealth`, which is documented in this file's
  // header but has no implementation). Falling through to plain is the right RUNTIME choice —
  // failing the run would turn one bad operator into a 105-operator outage — but it must not
  // be silent, and test/operators-config.test.mjs fails CI on it.
  if (op.fetcher && !KNOWN_FETCHERS.has(op.fetcher)) {
    warnUnknownFetcher(op);
  }
  switch (op.fetcher) {
    case "flaresolverr": return fetchFlareSolverr(url, op);
    case "api":          return fetchApi(url, op);
    default:             return fetchPlain(url, op, retry); // "plain" | undefined | unknown
  }
}

export const KNOWN_FETCHERS = new Set(["plain", "flaresolverr", "api"]);
const warnedFetchers = new Set();
function warnUnknownFetcher(op) {
  if (warnedFetchers.has(op.slug)) return; // once per operator per run, not once per request
  warnedFetchers.add(op.slug);
  console.log(`  ⚠️ ${op.slug || op.base}: unknown fetcher "${op.fetcher}" — falling back to plain`);
}

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
// Downstream parsing (cheerio + the regex library) runs SYNCHRONOUSLY over the fetched
// text — a multi-MB pathological page can freeze the event loop for hours, defeating every
// timeout, signal, and Promise.race in the process (Red Hot Raffles served 8MB pages and
// stalled three Action runs on 2026-08-14). No legitimate product page needs more.
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES || 3_000_000);

// ---- retry ----------------------------------------------------------------
// A transient refusal used to be permanent for a day: extractor.mjs bails the whole operator
// when listing page 1 fails, so one 403 from a jittery WAF cost that operator its entire
// day's inventory. On 4 Sept 2026 a single unlucky runner IP took out 18 operators that way,
// while the other four runs that week lost only 2-3 — the failures are transient, and nothing
// was retrying them.
//
// Both helpers below are pure and exported so the policy is testable without touching the
// network — the same reason shouldStopPaging is pure in extractor.mjs. The CI gate must stay
// offline: a failing `bun run test:scraper` skips the day's scrape entirely.

// 403 is in here deliberately. It is also lib/manager.mjs's "genuinely blocked" signal, which
// is exactly why it must be retried a FEW times and not many: a real block stays blocked and
// costs us three requests, while a soft WAF flag clears on the second. Hammering it would risk
// turning a temporary flag into a durable one.
// 520-527 is Cloudflare's own range for "the edge reached us but the ORIGIN misbehaved"
// (520 unknown error, 521 origin down, 522 connect timeout, 523 origin unreachable, 524 origin
// timeout, 525/526 TLS handshake, 527 railgun). Every one of them describes a transient upstream
// condition, not an answer about the resource — which makes them the textbook retry case, and
// they were missing. Measured 9 Sep 2026: a single trade-tool-giveaways run took 14 × HTTP 520
// under load and lost 14 draws outright, with no retry even attempted.
const RETRYABLE_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);
export function isRetryableStatus(status) {
  // 451 is never retryable: it is a legal geo-block (nitrous-competitions serves it to every
  // non-UK IP). It will not succeed on attempt two, so retrying only burns the run's budget.
  // 400/401/404/410/422 are stable client-side answers — the resource is absent or the request
  // is wrong, and neither heals by asking again.
  return RETRYABLE_STATUSES.has(status);
}

// Deliberately short. run.mjs's operator loop is SERIAL, so every retry delay is additive
// across ~105 operators; a classic 1-2-4-8s ladder on top of a 20s FETCH_TIMEOUT_MS could eat
// most of RUN_DEADLINE_MIN=130 during a broad network wobble.
export function backoffMs(attempt, { baseMs = 500, maxMs = 4000 } = {}) {
  return Math.min(maxMs, baseMs * Math.pow(3, Math.max(0, attempt - 1)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns a real Response, so every call site is a one-word swap from fetch().
// `attempts` is the TOTAL number of tries, not the number of retries.
//
// `init` may be an object OR a factory. Pass a FACTORY whenever init carries an AbortSignal:
// an AbortSignal.timeout that has fired stays aborted forever, so reusing one init object means
// attempt 2 aborts instantly and the retry is silently worthless — which is exactly the case
// (a timeout) we most want to retry. The factory rebuilds the signal per attempt.
export async function fetchWithRetry(url, init = {}, { attempts = 3, baseMs = 500, maxMs = 4000, onRetry = null } = {}) {
  const buildInit = typeof init === "function" ? init : () => init;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetch(url, buildInit());
      if (r.ok || !isRetryableStatus(r.status) || attempt === attempts) return r;
      // Discarding a response without reading it leaves the socket open, which keeps the
      // process alive past its last statement. Release it before sleeping.
      await r.body?.cancel().catch(() => {});
      onRetry?.({ url, attempt, status: r.status });
      await sleep(backoffMs(attempt, { baseMs, maxMs }));
    } catch (e) {
      // Network-level failure: DNS, connection reset, or our own AbortSignal.timeout firing.
      lastErr = e;
      if (attempt === attempts) throw e;
      onRetry?.({ url, attempt, error: e.message });
      await sleep(backoffMs(attempt, { baseMs, maxMs }));
    }
  }
  throw lastErr; // unreachable: the loop returns or throws above
}
async function fetchPlain(url, op, retry = {}) {
  // Hard per-request timeout: without it a single slow/hanging endpoint stalls the whole run
  // (the per-product page fetches are the hot path at high PER_OP_API). 20s default, env-tunable.
  // A FACTORY, not an object: the timeout signal must be rebuilt for each attempt (see
  // fetchWithRetry) or a timed-out first attempt makes every retry abort instantly.
  const init = () => {
    const i = { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    // Per-operator TLS relaxation for a misconfigured cert (Bun honours fetch tls options).
    // Scoped to the one operator — never NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide.
    if (op.insecureTLS) i.tls = { rejectUnauthorized: false };
    return i;
  };
  const r = await fetchWithRetry(url, init, {
    attempts: retry.attempts ?? 3,
    onRetry: ({ attempt, status, error }) =>
      console.log(`  ↻ retry ${attempt} for ${url.slice(-52)} — ${status ? `HTTP ${status}` : error}`),
  });
  let text = await r.text();
  if (text.length > MAX_HTML_BYTES) { console.log(`  ⚠️ ${url.slice(-40)}: ${(text.length / 1e6).toFixed(1)}MB page truncated to ${MAX_HTML_BYTES / 1e6}MB`); text = text.slice(0, MAX_HTML_BYTES); }
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
    return { status, ok: status < 400, text: unwrapBrowserJson(sol.response), cookies: sol.cookies || [] };
  } catch (e) {
    return { status: 0, ok: false, text: "", cookies: [], error: e.message };
  }
}

// FlareSolverr hands back what the BROWSER rendered, not the raw body. Point it at a JSON
// endpoint (which is exactly what a Cloudflare-blocked woo operator needs) and Chrome's JSON
// viewer wraps the payload in `<html>…<pre>{…}</pre>…</html>`. wooOperator then does
// JSON.parse(text) inside a `catch {}` that swallows the error, so the operator silently
// yields zero draws and looks merely "quiet" — the exact failure mode this whole exercise is
// about. Unwrap the <pre> so the strategies really do return interchangeable bodies.
export function unwrapBrowserJson(text) {
  const s = (text || "").trim();
  if (!s.startsWith("<")) return text; // already raw JSON or real HTML we shouldn't touch
  const m = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) return text;
  const inner = m[1].replace(/<[^>]+>/g, "").trim(); // the viewer adds spans for syntax colour
  if (!/^[[{]/.test(inner)) return text;
  const decoded = inner.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  try { JSON.parse(decoded); return decoded; } catch { return text; } // only swap if it really is JSON
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
