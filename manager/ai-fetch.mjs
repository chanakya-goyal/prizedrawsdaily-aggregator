// Cowork/Claude helper for "AI-assist" (premium) operators whose draw date / ticket count
// are JS countdowns or %-bars that deterministic code can't read — but whose data IS in the
// raw HTML. This script does the plumbing (discover + fetch + known fields); the cowork
// Claude agent reads `page_text` + `iso_dates` to work out draw_date (and total_entries if a
// max is stated), then inserts via draw-insert.mjs. No browser needed.
//
// Usage: bun manager/ai-fetch.mjs            # all aiAssist operators
//        ONLY=dream-car-giveaways bun manager/ai-fetch.mjs
// Env (optional): SUPABASE_SERVICE_ROLE_KEY / SUPABASE_PUBLISHABLE_KEY to skip already-known draws.
import { load, parseJsonLd, findProductLd, pickTitleImage, extractPrice, inferCategory, textOf, compileOpRegex, decodeEntities } from "../lib/parse.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const PER_OP = Number(process.env.PER_OP || 6);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";

const DEFAULT_DRAW_RE = /\/(competitions?|product|draws?|raffles?|win|prize)\/[a-z0-9][a-z0-9-]{4,}\/?$/i;
const BAD = /\/(category|categories|instant-wins?|winners?|results|past|account|cart|checkout|basket|faq|about|contact|terms|privacy|how-it-works|watches|cash|tech|cars?)\/?$/i;

const get = async (url) => (await fetch(url, { headers: { "User-Agent": UA } })).text();

let operators = (await Bun.file("operators.json").json()).filter((o) => o.aiAssist && o.enabled !== false);
if (ONLY) operators = operators.filter((o) => ONLY.has(o.slug));

// Optionally load existing entry_urls to avoid re-emitting known draws.
let seen = new Set();
if (KEY) {
  try {
    const rows = await (await fetch(`${SB}/rest/v1/draws?select=entry_url`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
    if (Array.isArray(rows)) seen = new Set(rows.map((r) => r.entry_url).filter(Boolean));
  } catch { /* dedup is best-effort */ }
}

const out = [];
for (const op of operators) {
  const drawRe = compileOpRegex(op.drawMatch) || DEFAULT_DRAW_RE;
  let listing = "";
  try { listing = await get(op.listing || op.base); } catch (e) { console.error(`# ${op.slug} listing failed: ${e.message}`); continue; }
  const origin = new URL(op.base).origin;
  const links = [...new Set([...listing.matchAll(/href="([^"]+)"|"(\/[a-z0-9][^"\s]*)"/gi)]
    .map((m) => m[1] || m[2]).filter(Boolean)
    .map((h) => { try { return new URL(h, op.base).href.split("?")[0].split("#")[0]; } catch { return null; } })
    .filter(Boolean)
    .filter((h) => h.startsWith(origin) && drawRe.test(h) && !BAD.test(h)))];

  let n = 0;
  for (const url of links) {
    if (n >= PER_OP) break;
    if (seen.has(url)) continue;
    let html = "";
    try { html = await get(url); } catch { continue; }
    const $ = load(html);
    const ld = findProductLd(parseJsonLd($));
    const ti = pickTitleImage($, ld, op.base);
    const title = decodeEntities(ld?.name || ti.title || "");
    if (!title) continue;
    const text = textOf(html);
    const iso = [...new Set([...html.matchAll(/20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g)].map((m) => m[0]))].slice(0, 6);
    // Authoritative "Competition Details" data often sits in the page's data blob (stripped
    // from visible text). Read it straight from the raw HTML — the structured field first
    // (e.g. "numTickets":1999999), then the displayed "maximum number of N" as a fallback
    // (tolerant of the data-blob's quote/escape punctuation between label and number).
    const maxM = html.match(/"(?:numTickets|maxTickets|totalTickets|maximumEntries)"\s*:\s*(\d{3,})/i)
      || html.match(/maximum\s+(?:number\s+)?of["\\,\s]{1,18}([\d][\d,]{2,})["\\,\s]{1,12}entr/i);
    const detail_entries = maxM ? Number(maxM[1].replace(/[^\d]/g, "")) : null;
    const drawM = html.match(/draw\s+date\s+for\s+this\s+competition\s+is["\\,\s]{1,12}(\d{1,2}\/\d{1,2}\/\d{4})(?:["\\,\s]{1,12}at["\\,\s]{1,12}(\d{1,2}:\d{2}\s*[ap]\.?m\.?))?/i);
    const detail_draw = drawM ? `${drawM[1]}${drawM[2] ? " " + drawM[2].replace(/\s/g, "") : ""}` : null;
    // Surface the snippets Claude actually needs (close time / price / % sold) up front,
    // since the relevant text can sit deep in a long page.
    const grab = (re, before = 25, after = 80) => { const m = text.match(re); return m ? text.slice(Math.max(0, m.index - before), m.index + after).replace(/\s+/g, " ").trim() : null; };
    const hints = [
      grab(/closes?\b[^.]{0,45}/i), grab(/draws?\b[^.]{0,45}\d/i), grab(/\b(today|tomorrow|tonight)\b[^.]{0,30}/i),
      grab(/per ticket/i, 30), grab(/£\s?[\d.,]+/i, 5), grab(/%\s*sold[^.]{0,20}/i), grab(/tickets?\b[^.]{0,40}/i),
    ].filter(Boolean);
    out.push({
      operator_slug: op.slug,
      entry_url: url,
      title,
      grand_prize: title,
      category: op.category || inferCategory({ title, url }),
      image_url: ti.image_url,
      ticket_price: extractPrice({ ld, text }),    // a hint only — Claude should confirm from hints/page_text
      detail_entries,                              // authoritative MAX entries from Competition Details (use as total_entries)
      detail_draw,                                 // authoritative draw date+time from Competition Details (e.g. "21/06/2026 10:00pm")
      iso_dates: iso,                              // candidate absolute datetimes from the HTML
      hints,                                       // key snippets: close time, price, % sold
      page_text: text.slice(0, 4000),
    });
    n++;
  }
  console.error(`# ${op.slug}: ${n} pages`);
}

console.log(JSON.stringify({ count: out.length, draws: out }, null, 2));
