// Shared scraping engine for the PrizeDrawsDaily aggregator — KEYLESS (no LLM).
// Fetches each operator's pages (WooCommerce Store API, Shopify products.json, or a
// headless render) and maps them to draw fields deterministically via lib/parse.mjs.
import { chromium } from "playwright";
import { fieldsFromHtml, compileOpRegex, CATEGORIES, UA, WINDOW_DAYS, normalizeUkDate } from "./lib/parse.mjs";
import { fetchHtml, renderVia } from "./lib/fetcher.mjs";

export { CATEGORIES, UA, WINDOW_DAYS, normalizeUkDate };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function wooOperator(op, perOp = 6) {
  const r = await fetchHtml(`${op.base}/wp-json/wc/store/v1/products?per_page=${perOp + 2}&orderby=date`, op);
  if (!r.ok) { console.log(`  woo API ${r.status} for ${op.base}`); return []; }
  let body = null; try { body = JSON.parse(r.text); } catch { /* non-JSON → no products */ }
  const products = (Array.isArray(body) ? body : []).slice(0, perOp);
  if (!products.length) { console.log(`  woo API returned no products`); return []; }
  const draws = [];
  for (const p of products) {
    try {
      const minor = p.prices?.currency_minor_unit ?? 2;
      const price = p.prices?.price != null ? Number((Number(p.prices.price) / 10 ** minor).toFixed(2)) : null;
      const img = p.images?.[0]?.src || null;
      const apiDesc = `${p.name || ""}\n${p.short_description || ""}\n${p.description || ""}`;
      let html = "";
      try { html = (await fetchHtml(p.permalink, op)).text; } catch { /* API desc still usable */ }
      draws.push(fieldsFromHtml({ html, url: p.permalink, op, knownTitle: p.name, knownImage: img, knownPrice: price, descriptionText: apiDesc }));
    } catch (e) { console.log(`  ! ${(p.permalink || p.name || "?").slice(-42)} parse failed: ${(e.message || "").slice(0, 50)}`); }
  }
  return draws.filter(Boolean);
}

export async function shopifyOperator(op, perOp = 6) {
  const r = await fetchHtml(`${op.base}/products.json?limit=${perOp + 4}`, op);
  if (!r.ok) { console.log(`  shopify API ${r.status} for ${op.base}`); return []; }
  let body = null; try { body = JSON.parse(r.text); } catch { /* non-JSON → no products */ }
  const products = (Array.isArray(body?.products) ? body.products : []).slice(0, perOp);
  if (!products.length) { console.log(`  shopify API returned no products`); return []; }
  const draws = [];
  for (const p of products) {
    try {
      const url = `${op.base}/products/${p.handle}`;
      const price = p.variants?.[0]?.price ? Number(p.variants[0].price) : null;
      const img = p.images?.[0]?.src || null;
      const apiDesc = `${p.title || ""}\n${p.body_html || ""}`;
      let html = "";
      try { html = (await fetchHtml(url, op)).text; } catch { /* body_html still usable */ }
      draws.push(fieldsFromHtml({ html, url, op, knownTitle: p.title, knownImage: img, knownPrice: price, descriptionText: apiDesc }));
    } catch (e) { console.log(`  ! ${(p.handle || p.title || "?")} parse failed: ${(e.message || "").slice(0, 50)}`); }
  }
  return draws.filter(Boolean);
}

export function dedupe(draws) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 45);
  const score = (x) => (x.total_entries > 0 ? 2 : 0) + (x.draw_date ? 1 : 0) + (x.ticket_price > 0 ? 1 : 0);
  const best = new Map();
  for (const d of draws) {
    const k = norm(d.title);
    if (!k) continue;
    if (!best.has(k) || score(d) > score(best.get(k))) best.set(k, d);
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
