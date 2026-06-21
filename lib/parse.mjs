// Deterministic (keyless, no-LLM) field extraction for the PrizeDrawsDaily aggregator.
// Pure module: no network, no browser — takes HTML/text strings in, returns field values
// out, so every function is trivially unit-testable against saved fixtures.
//
// Resolution order used by fieldsFromHtml(): structured data (JSON-LD / API) → operator
// `selectors` (cheerio) → operator `patterns` (regex) → built-in regex library.
import * as cheerio from "cheerio";

export const CATEGORIES = ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury", "collectibles"];
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
export const WINDOW_DAYS = 21;

// ---- date helpers (moved from extractor.mjs; preserves the UK BST/GMT stamping) ----
function ukOffset(naive) { const m = Number((naive || "").slice(5, 7)); return m >= 4 && m <= 9 ? "+01:00" : "+00:00"; }
export function normalizeUkDate(raw) {
  if (!raw) return null;
  const naive = String(raw).trim().replace(/(z|[+-]\d{2}:?\d{2})$/i, "");
  const m = naive.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) return `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00${ukOffset(naive)}`;
  const d = naive.match(/^(\d{4}-\d{2}-\d{2})$/);
  return d ? `${d[1]}T20:00:00${ukOffset(naive)}` : raw;
}

// ---- low-level / shared ----
export function load(html) { return cheerio.load(html || ""); }
export function textOf(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function abs(url, base) {
  if (!url) return null;
  try { return new URL(url, base).href; } catch { return null; }
}
export function compileOpRegex(src, flags = "i") {
  if (!src) return null;
  if (src instanceof RegExp) return src;
  try { return new RegExp(src, flags); } catch { return null; }
}
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));
const round2 = (n) => Math.round(n * 100) / 100;

// Decode HTML entities (numeric + common named) — operator API titles are HTML-encoded.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€", hellip: "…", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", trade: "™", reg: "®", copy: "©" };
export function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return _; } })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// ---- structured data (JSON-LD) ----
export function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const graph = data && data["@graph"];
    const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : graph ? [graph] : [data];
    for (const n of nodes) if (n && typeof n === "object") out.push(n);
  });
  return out;
}
export function findProductLd(ld) {
  const isProduct = (t) => (Array.isArray(t) ? t : [t]).some((x) => /product/i.test(x || ""));
  const node = ld.find((n) => isProduct(n["@type"]));
  if (!node) return null;
  const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  const image = Array.isArray(node.image) ? node.image[0] : node.image?.url || node.image;
  return {
    name: node.name || null,
    image: typeof image === "string" ? image : image?.url || null,
    price: offer?.price != null ? num(offer.price) : null,
  };
}

// ---- title + image ----
export function pickTitleImage($, ld, base) {
  let title = ld?.name || $('meta[property="og:title"]').attr("content") || $("h1").first().text().trim() || null;
  if (title) title = title.replace(/\s+/g, " ").trim();
  let image = ld?.image || $('meta[property="og:image"]').attr("content") || null;
  if (!image) {
    let best = null, bestArea = 0;
    $("img").each((_, el) => {
      const w = Number($(el).attr("width")) || 0, h = Number($(el).attr("height")) || 0;
      const area = w * h, src = $(el).attr("src") || $(el).attr("data-src");
      if (src && area > bestArea) { bestArea = area; best = src; }
    });
    image = best;
  }
  return { title, image_url: abs(image, base) };
}

// ---- price ----
export function extractPrice({ structuredPrice, ld, text }) {
  if (structuredPrice != null && isFinite(structuredPrice)) return round2(structuredPrice);
  if (ld?.price != null && isFinite(ld.price)) return round2(ld.price);
  const m = (text || "").match(/£\s?([\d]+(?:\.\d{1,2})?)/);
  return m ? round2(num(m[1])) : null;
}

// ---- total_entries (highest-risk; veto-first, tiered, conservative) ----
// "sold"/"remaining"/etc are sold-counters; a "N% sold" bar is caught by "sold". A bare
// "%" is NOT a veto (e.g. "1% prize odds" sitting next to a real "max of N tickets").
const VETO = /\b(sold|remaining|left|used|gone|claimed|to go)\b/i;
function vetoedAround(text, idx, len) {
  return VETO.test(text.slice(Math.max(0, idx - 28), idx + len + 28));
}
function plausibleEntries(n) { return Number.isFinite(n) && n >= 100 && n <= 10_000_000; }

export function extractEntries(text, opPatterns) {
  if (!text) return null;
  const t = String(text).replace(/ /g, " ");

  // 0) operator-specific override pattern
  if (opPatterns?.entries) {
    const rx = compileOpRegex(opPatterns.entries);
    const m = rx && t.match(rx);
    if (m && m[1]) { const n = num(m[1]); if (plausibleEntries(n)) return n; }
  }

  const collect = (patterns, { veto = true } = {}) => {
    const cands = [];
    for (const rx of patterns) {
      for (const m of t.matchAll(rx)) {
        const cap = m[1];
        if (cap == null) continue;
        if (veto && vetoedAround(t, m.index, m[0].length)) continue;
        const n = num(cap);
        if (plausibleEntries(n)) cands.push(n);
      }
    }
    return cands;
  };

  // Tier 1 — explicit "max / total / N available" forms (highest confidence; no veto —
  // the keyword disambiguates, and an unrelated nearby "sold" count shouldn't kill it)
  const tier1 = collect([
    /\b(?:max(?:imum)?|total)\s+(?:number\s+)?(?:of\s+)?([\d,]{2,})\s+(?:tickets?|entries?)\b/gi,
    /\bfrom\s+a\s+maximum\s+(?:number\s+)?of\s+([\d,]{2,})\s+(?:tickets?|entries?)\b/gi,
    /\b([\d,]{2,})\s+(?:tickets?|entries?)\s+(?:available|in total|in this (?:draw|competition|comp)|on offer|up for grabs|max(?:imum)?)\b/gi,
    /\b(?:tickets?|entries?)\s*(?:available|limited to|capped at|max(?:imum)?)\s*[:\-]?\s*([\d,]{2,})\b/gi,
    /\bdraw\s+(?:of|limited to)\s+([\d,]{2,})\s+(?:tickets?|entries?)\b/gi,
  ], { veto: false });
  if (tier1.length) return Math.max(...tier1);

  // Tier 1b — "only/just N tickets" is a cap ONLY when not next to a sold/left/remaining
  // counter ("only 800 entries left" is a remaining count, not the maximum).
  const tier1b = collect([/\b(?:only|just)\s+(?:of\s+)?([\d,]{2,})\s+(?:tickets?|entries?)\b/gi]);
  if (tier1b.length) return Math.max(...tier1b);

  // Tier 2 — progress bar "N / M" or "N sold of M": the denominator/total is the cap
  let barCap = null;
  const takeDenom = (rx, gi = 2) => {
    for (const m of t.matchAll(rx)) {
      const b = num(m[gi]);
      const a = m[gi - 1] != null ? num(m[gi - 1]) : 0;
      if (plausibleEntries(b) && b >= a) barCap = Math.max(barCap ?? 0, b);
    }
  };
  takeDenom(/\b([\d,]{2,})\s*\/\s*([\d,]{2,})\b/gi);
  takeDenom(/\b([\d,]{2,})\s+(?:sold\s+)?(?:of|out of)\s+([\d,]{2,})\b/gi);
  takeDenom(/\bsold\s*[:\-]?\s*[\d,]+\s*(?:of|out of)\s*([\d,]{2,})\b/gi, 1);
  if (barCap != null) return barCap;

  // Tier 3 — bare "N tickets/entries" (lowest confidence; skip £-prefixed amounts)
  const tier3 = [];
  for (const m of t.matchAll(/([£\d,]{3,})\s+(?:tickets?|entries?)\b/gi)) {
    if (m[1].includes("£")) continue;
    if (vetoedAround(t, m.index, m[0].length)) continue;
    const n = num(m[1]);
    if (plausibleEntries(n)) tier3.push(n);
  }
  return tier3.length ? Math.max(...tier3) : null;
}

// ---- draw_date (UK formats → ISO) ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function monthNum(name) { return MONTHS[(name || "").slice(0, 3).toLowerCase()] || null; }
const pad = (n) => String(n).padStart(2, "0");
const THIS_YEAR = new Date().getFullYear();
// A valid draw is within ~21 days, so the year is this year or next; reject parses that
// land on a stray number as the year (e.g. "1256", "6835" lifted from product codes).
const saneYear = (y) => { const n = Number(y); return n >= THIS_YEAR - 1 && n <= THIS_YEAR + 2; };

function parseClock(m) {
  let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return (h >= 0 && h <= 23 && min >= 0 && min <= 59) ? `${pad(h)}:${pad(min)}` : null;
}
function timeIn(win, { last = false } = {}) {
  let ms = [...win.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)];
  if (!ms.length) ms = [...win.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (!ms.length) return null;
  for (const m of (last ? ms.reverse() : ms)) { const t = parseClock(m); if (t) return t; }
  return null;
}
function findTime(text, idx) {
  // Prefer a time AFTER the date ("Draw 20th July at 9pm"); otherwise the time CLOSEST
  // before the date ("drawn live 9pm on 17th") — not an earlier unrelated cutoff ("buy by 6pm").
  return timeIn(text.slice(idx, idx + 80)) || timeIn(text.slice(Math.max(0, idx - 30), idx), { last: true });
}

export function extractDate(text, opPatterns) {
  if (!text) return null;
  const t = String(text);

  if (opPatterns?.date) {
    const rx = compileOpRegex(opPatterns.date);
    const m = rx && t.match(rx);
    if (m) { const iso = parseDateFragment(m[1] || m[0], t, m.index); if (iso) return iso; }
  }

  // 1) labelled "draw ... 1st July 2026" — prefer an explicit DRAW label; only fall back to
  //    a CLOSE/END date if no draw-labelled date exists (close dates precede the draw).
  let m = t.match(/(?:draw(?:n| date| takes? place| will take place| live)?|live\s+draw|drawn live)\D{0,24}(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) m = t.match(/\b(?:closes?|closing|ends?)\D{0,24}(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
  if (m) { const iso = ymd(m[3], monthNum(m[2]), m[1], t, m.index); if (iso) return iso; }

  // 2) any "1st July 2026"
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})\b/);
  if (m && monthNum(m[2])) { const iso = ymd(m[3], monthNum(m[2]), m[1], t, m.index); if (iso) return iso; }

  // 3) ISO already present
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m && saneYear(m[1]) && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const time = m[4] ? `${pad(m[4])}:${m[5]}` : findTime(t, m.index) || "20:00";
    return normalizeUkDate(`${m[1]}-${m[2]}-${m[3]}T${time}`);
  }

  // 4) UK numeric dd/mm/yyyy (day-first)
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let [_, d, mo, y] = m;
    if (Number(d) > 12 && Number(mo) <= 12) { /* day-first ok */ }
    else if (Number(d) <= 12 && Number(mo) > 12) { [d, mo] = [mo, d]; } // clearly month-first
    y = y.length === 2 ? `20${y}` : y;
    return ymd(y, Number(mo), d, t, m.index);
  }
  return null;
}
function ymd(y, mo, d, text, idx) {
  if (!mo || mo < 1 || mo > 12) return null;
  if (!saneYear(y)) return null;
  const dd = Number(d); if (dd < 1 || dd > 31) return null;
  const time = (text != null && idx != null && findTime(text, idx)) || "20:00";
  return normalizeUkDate(`${y}-${pad(mo)}-${pad(dd)}T${time}`);
}
function parseDateFragment(frag, text, idx) {
  const m = String(frag).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m && monthNum(m[2])) return ymd(m[3], monthNum(m[2]), m[1], text, idx);
  const iso = String(frag).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return normalizeUkDate(`${iso[1]}-${iso[2]}-${iso[3]}T20:00`);
  return null;
}

// ---- category (keyword heuristic, no LLM) ----
const CAT_RULES = [
  // Collectibles FIRST so a "LEGO Technic Ferrari" or "Pokémon Charizard" doesn't fall into car/luxury.
  ["collectibles", /\b(lego|warhammer|age of sigmar|sigmar|slaanesh|games workshop|citadel|gundam|airfix|model kit|pok[eé]mon|tcg|trading card|funko|graded|psa ?10|gem ?mint|holo|slab|miniature|collectible)\b/i],
  ["house-draws", /\b(house|home|flat|apartment|bungalow|property|villa|mortgage[- ]?free)\b/i],
  ["car-draws", /\b(cars?|bmw|audi|mercedes|merc|amg|porsche|ford|focus|fiesta|vw|volkswagen|golf|polo|scirocco|gti|gtr|m2|m3|m4|m5|rs\d|a45|c63|motorbike|motorcycle|bike|van|campervan|vehicle|supercar|hypercar|tesla|lamborghini|lambo|ferrari|range\s?rover|land\s?rover|defender|peugeot|vauxhall|corsa|astra|insignia|nissan|skyline|toyota|supra|yaris|honda|civic|jaguar|mini cooper|seat|skoda|renault|fiat|kia|hyundai|mazda|subaru|impreza|bentley|aston\s?martin|mclaren|maserati|jeep|suzuki|volvo|bugatti|rolls\s?royce)\b/i],
  ["tech-giveaways", /\b(iphone|ipad|macbook|laptop|pc|ps5|playstation|xbox|nintendo|switch|console|tv|gpu|rtx|gaming|airpods|samsung galaxy|drone|gadget)\b/i],
  ["luxury", /\b(rolex|omega|watch|jewellery|jewelry|diamond|designer|holiday|getaway|tackle|fishing|carp|handbag|chanel|louis vuitton|gucci)\b/i],
  ["cash-prizes", /\b(cash|money|jackpot|tax[- ]?free|instant win)\b/i],
];
export function inferCategory({ title, grand_prize, url } = {}) {
  const hay = `${title || ""} ${grand_prize || ""} ${url || ""}`;
  for (const [cat, rx] of CAT_RULES) if (rx.test(hay)) return cat;
  return "cash-prizes"; // generic fallback; manager re-checks
}

// ---- the shared assembler ----
// Returns the full draw field object (description = null; run.mjs/describe fills the baseline).
export function fieldsFromHtml({ html, url, op = {}, knownTitle, knownImage, knownPrice, descriptionText }) {
  const $ = load(html);
  const ld = findProductLd(parseJsonLd($));
  const ti = pickTitleImage($, ld, op.base || url);
  const title = decodeEntities(knownTitle || ti.title || "") || null;
  const image_url = abs(knownImage, op.base || url) || ti.image_url || null;

  // Combine rendered page text + any API/description HTML so entries/date regexes see everything.
  const text = `${textOf(html)}\n${textOf(descriptionText || "")}`;

  // Resolution: operator selector → built-in common-plugin selector → whole-text regex.
  // UK comp sites cluster on a few WooCommerce plugins, so a small shared selector library
  // grabs the *specific* draw-date/entries element (avoiding wrong dates on listing-heavy
  // pages) for many operators with no per-operator config.
  const sel = op.selectors || {};
  const pickText = (selectors) => {
    for (const s of selectors) { try { const t = $(s).first().text().trim(); if (t) return t; } catch { /* bad selector */ } }
    return null;
  };
  const selOrCommon = (key, common) => (sel[key] ? pickText([sel[key]]) : null) || pickText(common);

  const dateSel = selOrCommon("date", [".draw-date-time", ".draw-date", ".competition-draw-date", ".product-draw-date", "[class*='draw-date']", "[class*='draw_date']"]);
  const entriesSel = selOrCommon("entries", [".total-tickets", ".tickets-total", ".max-tickets", "[class*='total-ticket']", "[class*='max-ticket']", "[class*='tickets-available']"]);

  const ticket_price = extractPrice({
    structuredPrice: knownPrice,
    ld,
    text: (sel.price ? pickText([sel.price]) : null) || text,
  });
  // Selectors are ADDITIVE: try the targeted element first, then fall back to the full
  // page text (so an empty/wrong selector match can never lose a value the text contains).
  const total_entries = (entriesSel && extractEntries(entriesSel, op.patterns)) ?? extractEntries(text, op.patterns);
  const draw_date = (dateSel && extractDate(dateSel, op.patterns)) || extractDate(text, op.patterns);
  const grand_prize = title;
  const category = op.category || inferCategory({ title, grand_prize, url });

  return { title, grand_prize, category, ticket_price, total_entries, draw_date, image_url, entry_url: url, description: null };
}
