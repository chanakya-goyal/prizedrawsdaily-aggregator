// Shared extraction engine for the PrizeDrawsDaily aggregator.
// A headless browser renders each operator's listing + each draw's detail page, then an
// LLM maps the rendered page to our draw fields. WooCommerce Store API is a fast-path.
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

// GitHub Models (free for GitHub users, UK-accessible). Auth = a GitHub token with Models
// access — locally `GITHUB_TOKEN=$(gh auth token)`, in Actions the built-in token + `models: read`.
const github = createOpenAI({
  apiKey: process.env.GITHUB_TOKEN,
  baseURL: "https://models.github.ai/inference",
  compatibility: "compatible",
});
const MODEL = "openai/gpt-4o-mini";

export const CATEGORIES = ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury"];
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
export const WINDOW_DAYS = 21;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The model returns UK wall-clock time with no zone; we stamp the correct UK offset so the stored
// instant is right (BST +01:00 roughly Apr–Sep, GMT +00:00 otherwise).
function ukOffset(naive) { const m = Number((naive || "").slice(5, 7)); return m >= 4 && m <= 9 ? "+01:00" : "+00:00"; }
export function normalizeUkDate(raw) {
  if (!raw) return null;
  const naive = String(raw).trim().replace(/(z|[+-]\d{2}:?\d{2})$/i, "");
  const m = naive.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  return m ? `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00${ukOffset(naive)}` : raw;
}

export const DrawSchema = z.object({
  draws: z.array(
    z.object({
      title: z.string(),
      grand_prize: z.string(),
      category: z.enum(CATEGORIES),
      ticket_price: z.number().nullable(),
      total_entries: z.number().nullable(),
      draw_date: z.string().nullable(),
      image_url: z.string().nullable(),
      entry_url: z.string().nullable(),
      description: z.string().nullable().describe("short ORIGINAL 2-3 sentence UK-English blurb for this draw"),
    }),
  ),
});

export async function extract(operator, content, sourceUrl, knownImage) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
  const { object } = await generateObject({
    model: github.chat(MODEL), // .chat = /chat/completions (GitHub Models has no /responses endpoint)
    schema: DrawSchema,
    maxRetries: 6,
    prompt: `You are extracting the CURRENT live prize draw(s) from ONE page of the UK competitions operator "${operator}".
Today is ${today} (${weekday}), timezone Europe/London. Resolve relative dates ("today", "tomorrow", "Sunday", countdown timers) against this.

Return one entry per distinct active draw on the page (usually 1 on a detail page).
NEVER invent values — if a field isn't on the page, use null.
- ticket_price: price for ONE ticket/entry in GBP (number). Free entry => 0.
- total_entries: the MAXIMUM tickets available (NOT sold / NOT remaining). null if only a "% sold" bar is shown with no absolute maximum.
- draw_date: the LIVE DRAW date & time in UK LOCAL time, formatted EXACTLY as "YYYY-MM-DDTHH:MM" (24-hour, NO timezone, NO "Z"). ALWAYS use the explicit calendar date PRINTED on the page (e.g. "17-06-2026 @ 9:00PM" → "2026-06-17T21:00"; "draw will take place on 23/06/2026 ... 9pm" → "2026-06-23T21:00"). Do NOT use the words "today"/"tomorrow", and do NOT convert time zones — just copy the wall-clock time shown. If the page shows BOTH an entry-closing time and a separate draw time (e.g. "entries close 8:45pm, live draw 9pm"), ALWAYS use the DRAW time (9pm).
- image_url: ${knownImage ? `use "${knownImage}"` : "absolute URL of the prize image, else null"}.
- entry_url: "${sourceUrl}".
- description: write a SHORT, ORIGINAL 2-3 sentence blurb in UK English for THIS draw — mention the prize, the entry price, and when it closes. Do NOT copy the operator's wording verbatim; write fresh, engaging copy.
- category MUST be exactly one of: ${CATEGORIES.join(", ")}. Decide by the SINGLE headline/grand prize (ignore secondary cash add-ons). Mapping:
   car-draws = the grand prize is a car, motorbike, van, campervan or any road vehicle.
   cash-prizes = the grand prize is money: pure cash, an instant-win cash pot, or a "mystery cash" draw.
   house-draws = houses, flats, property.
   tech-giveaways = phones, games consoles, computers, TVs, gadgets.
   luxury = watches, jewellery, designer items, holidays, fishing/tackle bundles, collectibles/trading cards (e.g. Pokémon).

PAGE CONTENT:
${content.slice(0, 7000)}`,
  });
  for (const dr of object.draws) dr.draw_date = normalizeUkDate(dr.draw_date);
  return object.draws;
}

export async function renderPage(ctx, url, waitMs = 2800) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(waitMs);
    const data = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      let img = og?.content || null;
      if (!img) {
        const big = [...document.querySelectorAll("img")].sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
        img = big?.src || null;
      }
      return {
        text: document.body.innerText,
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
  const listing = await renderPage(ctx, op.listing || op.base, op.wait || 4000);
  const drawUrls = pickDrawLinks(listing.links, op.base, op.drawMatch || DRAW_RE, op.exclude || [BAD_LINK, CATEGORY_TAIL], perOp);
  console.log(`  found ${drawUrls.length} draw pages`);
  const draws = [];
  for (const url of drawUrls) {
    try {
      const d = await renderPage(ctx, url, op.wait ? 5000 : 2500);
      const got = await extract(op.name, d.text, url, d.ogImage);
      for (const g of got) {
        g.entry_url = g.entry_url || url;
        g.image_url = g.image_url || d.ogImage;
        draws.push(g);
      }
    } catch (e) {
      console.log(`  ! ${url.slice(-42)} failed: ${e.message.slice(0, 60)}`);
    }
    await sleep(6000); // stay under Groq free-tier 8000 TPM
  }
  return draws;
}

export async function wooOperator(op, perOp = 6) {
  const r = await fetch(`${op.base}/wp-json/wc/store/v1/products?per_page=${perOp + 2}&orderby=date`, { headers: { "User-Agent": UA } });
  const products = (await r.json()).slice(0, perOp);
  const draws = [];
  for (const p of products) {
    const pr = await fetch(p.permalink, { headers: { "User-Agent": UA } });
    const html = (await pr.text())
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const minor = p.prices?.currency_minor_unit ?? 2;
    const price = p.prices?.price != null ? Number((Number(p.prices.price) / 10 ** minor).toFixed(2)) : null;
    const img = p.images?.[0]?.src || null;
    const got = await extract(op.name, `Known: ticket_price=£${price}; entry_url=${p.permalink}\n\n${html}`, p.permalink, img);
    for (const g of got) {
      g.entry_url = g.entry_url || p.permalink;
      g.image_url = g.image_url || img;
      if (price != null && g.ticket_price == null) g.ticket_price = price;
      draws.push(g);
    }
    await sleep(6000); // pace LLM calls (GitHub Models ~15 req/min)
  }
  return draws;
}

export async function shopifyOperator(op, perOp = 6) {
  const r = await fetch(`${op.base}/products.json?limit=${perOp + 4}`, { headers: { "User-Agent": UA } });
  const products = ((await r.json()).products || []).slice(0, perOp);
  const draws = [];
  for (const p of products) {
    const url = `${op.base}/products/${p.handle}`;
    const pr = await fetch(url, { headers: { "User-Agent": UA } });
    const html = (await pr.text())
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const price = p.variants?.[0]?.price ? Number(p.variants[0].price) : null;
    const img = p.images?.[0]?.src || null;
    const got = await extract(op.name, `Known: ticket_price=£${price}; entry_url=${url}\n\n${html}`, url, img);
    for (const g of got) {
      g.entry_url = g.entry_url || url;
      g.image_url = g.image_url || img;
      if (price != null && g.ticket_price == null) g.ticket_price = price;
      draws.push(g);
    }
    await sleep(6000); // pace LLM calls (GitHub Models ~15 req/min)
  }
  return draws;
}

export function dedupe(draws) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 45);
  const score = (x) => (x.total_entries > 0 ? 2 : 0) + (x.draw_date ? 1 : 0) + (x.ticket_price > 0 ? 1 : 0);
  const best = new Map();
  for (const d of draws) {
    const k = norm(d.title);
    if (!best.has(k) || score(d) > score(best.get(k))) best.set(k, d);
  }
  return [...best.values()];
}

export function evaluate(d, now = new Date()) {
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 864e5);
  const reasons = [];
  if (!(d.ticket_price > 0)) reasons.push("no/zero ticket price");
  if (!(d.total_entries > 0)) reasons.push("no total entries");
  // Instant-wins, prize-drops and subscription "clubs" don't publish a real ticket cap — the
  // model tends to invent a tiny number, which sneaks them past the no-entries check. Require a
  // credible entry count, EXCEPT collectible/card draws which legitimately have small print runs.
  const collectible = /pok[eé]mon|\bpsa\b|\bcard\b|holo|gem ?mint|ace ?10|\btcg\b|graded|\bslab\b|funko/i.test(`${d.title} ${d.grand_prize}`);
  const minEntries = collectible ? 50 : 500;
  if (d.total_entries > 0 && d.total_entries < minEntries)
    reasons.push(`only ${d.total_entries} entries — instant-win/non-standard draw, not a raffle`);
  let inWindow = false;
  if (!d.draw_date) reasons.push("no draw date");
  else {
    const dt = new Date(d.draw_date);
    if (isNaN(dt)) reasons.push("bad date");
    else if (dt < now) reasons.push("already closed");
    else if (dt > windowEnd) reasons.push(`ends >${WINDOW_DAYS}d away`);
    else inWindow = true;
  }
  return { pass: d.ticket_price > 0 && d.total_entries >= minEntries && inWindow, reasons };
}

export async function makeContext(browser) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
  });
  return ctx;
}

// Operator config. `slug` MUST match the operators table slug (for operator_id mapping).
export const OPERATORS = [
  { name: "7Days Performance", slug: "seven-days-perf", base: "https://7daysperformance.co.uk", method: "render", listing: "https://7daysperformance.co.uk/", drawMatch: /\/product\// },
  { name: "UKCC", slug: "ukcc", base: "https://ukcc.co.uk", method: "render", listing: "https://ukcc.co.uk/", drawMatch: /\/competition\// },
  { name: "Dream Car Giveaways", slug: "dream-car-giveaways", base: "https://dreamcargiveaways.co.uk", method: "render", listing: "https://dreamcargiveaways.co.uk/", drawMatch: /\/competitions\//, exclude: [/\/competitions\/(cars|cash|tech|instant-wins|instant-cash)\/?$/] },
  { name: "Rev Comps", slug: "rev-comps", base: "https://www.revcomps.com", method: "woo" },
  // Bounty (Cloudflare bot challenge) + Jammy (Wordfence IP block) are hard-blocked — add manually.
];
