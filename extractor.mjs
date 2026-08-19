// Shared scraping engine for the PrizeDrawsDaily aggregator — KEYLESS (no LLM).
// Fetches each operator's pages (WooCommerce Store API, Shopify products.json, or a
// headless render) and maps them to draw fields deterministically via lib/parse.mjs.
import { chromium } from "playwright";
import { fieldsFromHtml, compileOpRegex, CATEGORIES, UA, WINDOW_DAYS, normalizeUkDate } from "./lib/parse.mjs";
import { fetchHtml, renderVia } from "./lib/fetcher.mjs";

export { CATEGORIES, UA, WINDOW_DAYS, normalizeUkDate };
import { detectZap, parseZapRefresh, mergeZap, fetchZapRefresh } from "./lib/zap.mjs";
import { isPurchasable, hasAvailableVariant, permalinkKey } from "./lib/liveness.mjs";
import { raffleEngineOperator } from "./lib/adapters/raffle-engine.mjs";
import { hydraOperator } from "./lib/adapters/hydra.mjs";
import { inertiaOperator } from "./lib/adapters/inertia.mjs";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded-concurrency map — runs the per-product page fetches in parallel (with a ceiling so
// we never hammer one operator). At PER_OP_API=60 this turns ~60 sequential fetches per operator
// into ~60/limit waves, the difference between a 90s/op crawl and a ~12s/op one.
const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 8);
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// ---- block detection (Cloudflare / JS challenge / empty SPA) ----
const BLOCK_RE = /just a moment|attention required|cf-browser-verification|enable javascript and cookies|verifying you are human|checking your browser|access denied|request blocked/i;
// Blocked = a known challenge phrase OR a near-empty body. The length floor is deliberately
// low (80) so a terse-but-valid product page isn't mistaken for a block.
export function looksBlocked(text) { return !text || text.replace(/\s+/g, " ").trim().length < 80 || BLOCK_RE.test(text); }

// ---- headless render. Returns { text, html (post-JS DOM), ogImage, links }. ----
// `hard` = the try-harder pass: wait for network idle + longer settle (passes many soft
// JS challenges). We never solve CAPTCHAs — a still-blocked page is skipped by the caller.
export async function renderPage(ctx, url, waitMs = 2800, { hard = false } = {}) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: hard ? "networkidle" : "domcontentloaded", timeout: hard ? 45000 : 35000 });
    await page.waitForTimeout(hard ? Math.max(waitMs, 6000) : waitMs);
    const data = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      let img = og?.content || null;
      if (!img) {
        const big = [...document.querySelectorAll("img")].sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
        img = big?.src || null;
      }
      return {
        text: document.body.innerText,
        html: document.documentElement.outerHTML,
        ogImage: img,
        links: [...document.querySelectorAll("a[href]")].map((a) => a.href),
      };
    });
    data.text = data.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
    return data;
  } finally {
    await page.close();
  }
}

export function pickDrawLinks(links, base, drawMatch, exclude, cap) {
  const origin = new URL(base).origin;
  const seen = new Set();
  const out = [];
  for (const href of links) {
    if (!href.startsWith(origin)) continue;
    const clean = href.split("?")[0].split("#")[0];
    if (!drawMatch.test(clean)) continue;
    if ((exclude || []).some((rx) => rx.test(clean))) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

// Generic draw-link discovery for operators without a hand-tuned config.
export const DRAW_RE = /\/(product|competition|competitions|draw|draws|raffle|raffles|win|prize|prizes|comp|comps|giveaway|giveaways|ticket|tickets)\/[a-z0-9][a-z0-9-]{3,}\/?$/i;
export const BAD_LINK = /\/(category|categories|collections|product-category|draw-results|winners?|results|past|account|cart|checkout|basket|blog|faq|about|contact|terms|privacy|how-it-works|pages?|my-account|wishlist|login|register)(\/|$)/i;
export const CATEGORY_TAIL = /\/(cars?|cash|tech|house|houses|luxury|electronics|jewellery|watch(es)?|instant-wins?|all|live|holidays?|gadgets?|home|bundles?)\/?$/i;

export async function renderOperator(ctx, op, perOp = 6) {
  const drawMatch = compileOpRegex(op.drawMatch) || DRAW_RE;
  const exclude = (op.exclude || []).map((e) => compileOpRegex(e)).filter(Boolean);

  const excludeRx = exclude.length ? exclude : [BAD_LINK, CATEGORY_TAIL];
  const linksFrom = (l) => pickDrawLinks(l, op.base, drawMatch, excludeRx, perOp);

  const url0 = op.listing || op.base;
  let listing = await renderVia(renderPage, ctx, url0, op, { waitMs: op.wait || 4000 });
  // Retry patiently (network-idle) if blocked OR if links haven't lazy-loaded yet — many
  // listings render their competition links into a carousel after first paint.
  if (looksBlocked(listing.text) || linksFrom(listing.links).length === 0) {
    listing = await renderVia(renderPage, ctx, url0, op, { waitMs: Math.max(op.wait || 0, 6000), hard: true });
  }
  if (looksBlocked(listing.text)) { console.log("  ⛔ blocked after retry — skipping operator"); return []; }

  const drawUrls = linksFrom(listing.links);
  console.log(`  found ${drawUrls.length} draw pages`);
  if (drawUrls.length === 0) {
    // Diagnostic: when nothing matches, surface the same-origin links that WERE present so an
    // operator's real draw-URL pattern can be tuned — essential for Cloudflare/flaresolverr
    // sites we can't inspect locally (the cleared HTML only exists inside the Action).
    const origin = new URL(op.base).origin;
    const sample = [...new Set(listing.links.filter((h) => h.startsWith(origin)).map((h) => h.split("?")[0].split("#")[0]))]
      .filter((h) => !/\.(css|js|png|jpe?g|svg|webp|ico|woff2?|gif|mp4)$/i.test(h)).slice(0, 14);
    console.log(`  ⓘ 0 matched — same-origin links seen: ${sample.length ? "\n    " + sample.join("\n    ") : "(none — JS-rendered grid)"}`);
  }
  const draws = [];
  for (const url of drawUrls) {
    try {
      let d = await renderVia(renderPage, ctx, url, op, { waitMs: op.wait ? 5000 : 2500 });
      if (looksBlocked(d.text)) d = await renderVia(renderPage, ctx, url, op, { waitMs: 5000, hard: true });
      if (looksBlocked(d.text)) { console.log(`  ⛔ ${url.slice(-42)} blocked — skip`); continue; }
      draws.push(fieldsFromHtml({ html: d.html, url, op, knownImage: d.ogImage }));
    } catch (e) {
      console.log(`  ! ${url.slice(-42)} failed: ${(e.message || "").slice(0, 60)}`);
    }
  }
  return draws.filter(Boolean);
}

// ---- Woo pagination -------------------------------------------------------
// The Store API caps per_page at 100, so depth needs ?page=N. But paging to the END is not
// an option: these catalogues are ARCHIVES, not inventories — capital-competitions returns
// 18,616 products and gaming-giveaways 9,894, nearly all of them finished comps. Since each
// kept product also costs one HTML fetch, "paginate everything" is tens of thousands of
// requests for a few dozen live draws.
//
// `after=` (a documented Store API filter) bounds it server-side instead: at after=90d,
// gaming-giveaways drops from 9,894 products to ~195. Combined with a live-row target, every
// operator finishes in 1-4 pages.
export const WOO_PER_PAGE = 100; // API maximum

export function wooPageUrl(op, { page, after }) {
  const qs = `per_page=${WOO_PER_PAGE}&orderby=date&order=desc&page=${page}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
  return op.apiStyle === "rest_route"
    ? `${op.base}/?rest_route=/wc/store/v1/products&${qs}`
    : `${op.base}/wp-json/wc/store/v1/products?${qs}`;
}

// Stop when the operator has no more pages, or we already hold what we came for. Pure so the
// loop's exit conditions are testable without the network.
export function shouldStopPaging({ returned, liveSoFar, target, page, maxPages, emptyStreak }) {
  if (returned < WOO_PER_PAGE) return "last page";
  if (liveSoFar >= target) return "target reached";
  if (page >= maxPages) return "page cap";
  // Products are newest-first, so once two whole pages contain nothing purchasable we are
  // deep in the archive and everything below is older still.
  if (emptyStreak >= 2) return "two pages with no live products";
  return null;
}

export async function wooOperator(op, perOp = 6, { knownUrls = new Set() } = {}) {
  // Some hosts 500/404 the pretty /wp-json/ route but still serve the Store API via the
  // ?rest_route= query form (flex-competitions, thewatchdraws, redhotraffles).
  const target = Number(op.maxLive || perOp);
  const maxPages = Number(op.maxPages || process.env.WOO_MAX_PAGES || 5);
  const lookbackDays = Number(op.lookbackDays || process.env.WOO_LOOKBACK_DAYS || 90);
  const after = new Date(Date.now() - lookbackDays * 864e5).toISOString().replace(/\.\d+Z$/, "");

  const collected = [];
  let emptyStreak = 0, pagesRead = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await fetchHtml(wooPageUrl(op, { page, after }), op);
    // Page 1 failing is an operator problem worth reporting; a later page failing just ends
    // the walk with what we already have.
    if (!r.ok) { if (page === 1) { console.log(`  woo API ${r.status} for ${op.base}`); return []; } break; }
    let arr = null; try { arr = JSON.parse(r.text); } catch { /* non-JSON → stop */ }
    if (!Array.isArray(arr) || arr.length === 0) break;
    pagesRead = page;
    const live = arr.filter(isPurchasable);
    emptyStreak = live.length === 0 ? emptyStreak + 1 : 0;
    collected.push(...live);
    const stop = shouldStopPaging({ returned: arr.length, liveSoFar: collected.length, target, page, maxPages, emptyStreak });
    if (stop) { if (page > 1) console.log(`  paged ${pagesRead}×${WOO_PER_PAGE} (${stop})`); break; }
  }
  // `collected` is already purchasable-only (filtered per page above, type-safely — the API
  // returns the NUMBER 0 as well as `false`; see lib/liveness.mjs).
  //
  // `maxLive` caps what we INGEST, never what we RE-CHECK. Slicing the whole list stranded
  // every row that fell outside the window: gaming-giveaways runs 81 live comps against a cap
  // of 40, and 33 of its published rows were left carrying a prize pool that no longer matched
  // price x entries, with nothing able to reach them. A row we already have on the site must be
  // re-read every run so it can be corrected or expired — the cap exists to stop one operator
  // flooding the listings, not to blind us to what we've already published.
  const known = collected.filter((p) => knownUrls.has(permalinkKey(p.permalink)));
  const fresh = collected.filter((p) => !knownUrls.has(permalinkKey(p.permalink)));
  const products = [...known, ...fresh.slice(0, Math.max(0, target - known.length))];
  if (!products.length) { console.log(`  woo API returned no purchasable products`); return []; }
  if (collected.length > products.length) {
    console.log(`  ${products.length} of ${collected.length} live (maxLive ${target}; ${known.length} already published, always re-checked)`);
  }
  let sawZap = false;
  const pairs = await pMap(products, FETCH_CONCURRENCY, async (p) => {
    try {
      const minor = p.prices?.currency_minor_unit ?? 2;
      const price = p.prices?.price != null ? Number((Number(p.prices.price) / 10 ** minor).toFixed(2)) : null;
      const img = p.images?.[0]?.src || null;
      const apiDesc = `${p.name || ""}\n${p.short_description || ""}\n${p.description || ""}`;
      const prizeText = p.short_description || p.description || null; // cleanest grand_prize source
      // The operator's own product categories (e.g. ["Auto Draw","Warhammer"]) and stock count
      // ("97 in stock" = tickets remaining ≈ the cap on a freshly-listed comp) are the reliable
      // per-product signals the JS-rendered page hides. Pass them straight to the parser.
      const apiCategories = Array.isArray(p.categories) ? p.categories.map((c) => c.name).filter(Boolean) : [];
      const sm = String(p.stock_availability?.text || "").match(/([\d,]+)\s*in\s*stock/i);
      const apiStock = sm ? Number(sm[1].replace(/,/g, "")) : null;
      let html = "";
      try { html = (await fetchHtml(p.permalink, op)).text; } catch { /* API desc still usable */ }
      if (!sawZap && detectZap(html)) sawZap = true;
      return { id: p.id, draw: fieldsFromHtml({ html, url: p.permalink, op, knownTitle: p.name, knownImage: img, knownPrice: price, descriptionText: apiDesc, prizeText, apiCategories, apiStock }) };
    } catch (e) { console.log(`  ! ${(p.permalink || p.name || "?").slice(-42)} parse failed: ${(e.message || "").slice(0, 50)}`); return null; }
  });
  const kept = pairs.filter((x) => x && x.draw);
  // Zap/craic-competitions family: cap + close date exist only behind a public admin-ajax
  // call (the pages paint them client-side) — one batched request fills every gap.
  if (sawZap && kept.some((x) => x.draw.total_entries == null || !x.draw.draw_date)) {
    const rows = parseZapRefresh(await fetchZapRefresh(op.base, kept.map((x) => x.id)), new Date());
    let filled = 0;
    for (const x of kept) { const before = x.draw.draw_date; mergeZap(x.draw, rows[x.id]); if (x.draw.draw_date !== before || x.draw.total_entries != null) filled++; }
    if (filled) console.log(`  ⚡ zap ajax filled cap/date for ${filled} draw(s)`);
  }
  return kept.map((x) => x.draw);
}

export async function shopifyOperator(op, perOp = 6, { knownUrls = new Set() } = {}) {
  const r = await fetchHtml(`${op.base}/products.json?limit=${perOp + 4}`, op);
  if (!r.ok) { console.log(`  shopify API ${r.status} for ${op.base}`); return []; }
  let body = null; try { body = JSON.parse(r.text); } catch { /* non-JSON → no products */ }
  // Shopify has no is_purchasable equivalent — an available variant is the signal, and until
  // now nothing filtered on it at all, so sold-out/finished comps were ingested as live and
  // every one of them also burned a product-page fetch. (The LIST feed carries `available`;
  // the single-product /products/<handle>.json endpoint omits it — read it here, not there.)
  const all = Array.isArray(body?.products) ? body.products : [];
  const live = all.filter(hasAvailableVariant);
  // Same rule as woo: the cap bounds new ingestion, never the re-check of a published row.
  const urlOf = (p) => permalinkKey(`${op.base.replace(/\/+$/, "")}/products/${p.handle}`);
  const knownP = live.filter((p) => knownUrls.has(urlOf(p)));
  const freshP = live.filter((p) => !knownUrls.has(urlOf(p)));
  const products = [...knownP, ...freshP.slice(0, Math.max(0, perOp - knownP.length))];
  if (!products.length) { console.log(`  shopify API returned no available products (of ${all.length})`); return []; }
  if (all.length !== products.length) console.log(`  shopify: ${products.length} of ${live.length} available (${all.length} listed)`);
  const draws = await pMap(products, FETCH_CONCURRENCY, async (p) => {
    try {
      const url = `${op.base}/products/${p.handle}`;
      const price = p.variants?.[0]?.price ? Number(p.variants[0].price) : null;
      const img = p.images?.[0]?.src || null;
      const apiDesc = `${p.title || ""}\n${p.body_html || ""}`;
      const prizeText = p.body_html || null; // cleanest grand_prize source
      // Shopify product_type + tags are the operator's taxonomy (no reliable inventory count here).
      const apiCategories = [p.product_type, ...(Array.isArray(p.tags) ? p.tags : [])].filter(Boolean);
      let html = "";
      try { html = (await fetchHtml(url, op)).text; } catch { /* body_html still usable */ }
      return fieldsFromHtml({ html, url, op, knownTitle: p.title, knownImage: img, knownPrice: price, descriptionText: apiDesc, prizeText, apiCategories });
    } catch (e) { console.log(`  ! ${(p.handle || p.title || "?")} parse failed: ${(e.message || "").slice(0, 50)}`); return null; }
  });
  return draws.filter(Boolean);
}

// JSON-API operators. `apiStyle` picks the platform parser; each returns the same shape
// fieldsFromHtml does, so the gate, dedupe, flush and re-host stages see no difference.
// These beat the browser path on every axis: complete catalogues instead of a link cap,
// exact operator-published numbers instead of regex inference, and no Chromium.
const API_ADAPTERS = {
  "raffle-engine": raffleEngineOperator, // 7Days Performance, UKCC
  hydra: hydraOperator,                  // Dream Car Giveaways
  inertia: inertiaOperator,              // Dream Big Competitions (compengine.io)
};

export async function apiOperator(op, perOp = 300) {
  const fn = API_ADAPTERS[op.apiStyle];
  if (!fn) { console.log(`  unknown apiStyle '${op.apiStyle}' — skipping`); return []; }
  return fn(op, perOp);
}

// Collapse the SAME competition appearing twice in one scrape (a listing that links a draw
// from both a carousel and a grid).
//
// ⚠️ This used to key on the first 45 alphanumeric characters of the TITLE, which silently
// destroyed real inventory: operators run many concurrent competitions with identical names.
// At the-car-competition — a CAR operator — 100 live products collapsed to 34, losing 66,
// including five separate live "Win £250 Site Credit" comps at /250sc-5 … /250sc-9.
// Lengthening the prefix fixes none of them, because the titles are genuinely identical.
//
// entry_url is the actual identity of a draw — it is already what run.mjs dedupes against
// across runs — so key on that, normalised for trailing-slash/query/case churn. Distinct
// URLs are distinct competitions, full stop.
export function dedupe(draws, { onDrop } = {}) {
  const score = (x) => (x.total_entries > 0 ? 2 : 0) + (x.draw_date ? 1 : 0) + (x.ticket_price > 0 ? 1 : 0);
  const best = new Map();
  for (const d of draws) {
    // Fall back to the title only when there is no URL to key on — a row with neither is
    // unusable anyway and the gate will drop it.
    const k = d.entry_url ? permalinkKey(d.entry_url) : (d.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!k) continue;
    const prev = best.get(k);
    if (!prev) { best.set(k, d); continue; }
    if (onDrop) onDrop(d, prev);
    if (score(d) > score(prev)) best.set(k, d);
  }
  return [...best.values()];
}

export async function makeContext(browser, { insecureTLS = false } = {}) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    ignoreHTTPSErrors: insecureTLS, // false (Playwright default) unless an insecureTLS op opts in
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
  });
  return ctx;
}

export { chromium };
