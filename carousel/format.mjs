// Shared formatting helpers for carousel slides (UK locale, Europe/London).
import { catCfg } from "./config.mjs";
export const LDN = "Europe/London";

export const priceLabel = (p) => {
  const n = Number(p);
  if (!isFinite(n) || n <= 0) return null;
  return n < 1 ? `${Math.round(n * 100)}p` : (n % 1 === 0 ? `£${n}` : `£${n.toFixed(2)}`);
};

// Turn a messy operator title into a clean PRODUCT name for the slide.
// Strips "Win this/a/the", price/cash/extras tails, and parentheticals — but NEVER
// breaks a mid-word hyphen (e.g. "T-ROC", "X-Tribute" stay intact).
export const cleanTitle = (t = "") => {
  const s = String(t).trim()
    // an operator's promo shout before the prize: "ULTRA-LOW ODDS! Win this X", "SUPER LOW ODDS – Win a X".
    // Only when "Win" follows, so a product name that merely contains "!" is left alone. The shout is
    // the operator's claim (often an odds claim) and must not reach a PDD bubble as if it were ours.
    .replace(/^[^!–—]{2,40}?\s*(?:!+|[–—-])\s*(?=win\b)/i, "")
    .replace(/^win\s+(this|a|an|the)\s+/i, "")  // "Win this/a/the X" → "X"
    .replace(/^win\s+/i, "")                       // bare "Win X" → "X"
    .replace(/\s*[-–|]\s+.*$/, "")                 // " - subtitle" (spaced separators only)
    .replace(/\s*\+\s.*$/, "")                      // " + extras" (e.g. "550 BHP + £2,000…")
    .replace(/\s*&\s*£.*$/i, "")                    // " & £cash…"
    .replace(/\s*\(.*$/, "")                        // " (parenthetical…"
    .replace(/\s+or\s+£[\d,]+.*$/i, "")            // " or £X tax-free…"
    .replace(/\s+for\s+just\s+.*$/i, "")            // " for just 2p!" promo tail
    .replace(/\bcompetition\b/i, "")
    .replace(/[!\s]+$/, "")                         // trailing "!" / spaces
    .replace(/\s+/g, " ")
    .trim();
  return s || String(t).trim();
};

// Cash attached to a NON-cash prize, split by what the operator actually offers:
//   alternative — "X or £30,000 cash", "X | £2,000 CASH ALT": cash INSTEAD of the prize
//   bonus       — "X + £2,000 cash", "X & £2,000 or £45,000": cash ON TOP of the prize
// Ambiguous wording returns null rather than a guess: a draw whose main prize IS cash, cash that
// replaces a sub-item ("+ your choice of tools or £3,500"), and instant-win pools, end prizes and
// jackpots that are not paid to the main winner. taxFree only when the operator says it of that amount.
const MONEY_RE = /£\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
const NOT_THE_WINNERS = /^(?:tax[-\s]?free\s+)?(?:cash\s+)?(?:instant|instants|end\s+prize|main\s+prize|top\s+prize|prize\s+fund|jackpot|credit|site\s+credit|worth|tickets?|entries|bundle|find\s*&)/i;
const toAmount = (n, k) => Math.round(Number(n.replaceAll(",", "")) * (k ? 1000 : 1));

function parseCash(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  const none = { alternative: null, bonus: null };
  // The main prize is cash ("Win £1,000 Tax Free Cash", "💰£2,000 Cash", "Treasure Hunters – £5,000 Cash"):
  // nothing to attach. Leading emoji/punctuation and "Win (this/a)" are skipped first.
  const lead = s.replace(/^[^\p{L}\p{N}£]+/u, "").replace(/^win\s+(?:this\s+|a\s+|an\s+)?/i, "");
  if (/^£/.test(lead) || /^[^£]{0,40}?\s[–—-]\s£/.test(lead)) return none;
  let alternative = null, bonus = null;
  for (const m of s.matchAll(MONEY_RE)) {
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].trimEnd().length);
    // the words that belong to THIS amount stop at the next connector
    const own = after.split(/(?:^|\s)(?:or|\+|&|and)\s|(?:^|\s)[-–—|]\s/i)[0];
    if (/\bx\s*$/i.test(before) || NOT_THE_WINNERS.test(own.trim())) continue;
    const amount = toAmount(m[1], m[2]);
    const taxFree = /tax[-\s]?free/i.test(own);
    const isCashWord = /^(?:tax[-\s]?free\s*)?(?:cash\b|$|[!.]|tax[-\s]?free)/i.test(own.trim());
    const connector = (before.match(/(?:^|\s)(or|\+|&|and|plus|\|)\s*$/i) || [])[1]?.toLowerCase();
    if (!alternative && /^(?:tax[-\s]?free\s+)?cash\s+alt(?:ernative)?\b/i.test(own.trim())) {
      alternative = { amount, taxFree };
    } else if (!alternative && connector === "or" && isCashWord) {
      // "+ your choice of tools or £3,500": the cash replaces what follows the last "+", not the prize
      const lastPlus = before.lastIndexOf("+");
      const alternated = lastPlus >= 0 ? before.slice(lastPlus + 1) : "";
      if (/choice/i.test(before) || /\p{L}{3,}/u.test(alternated.replace(/£\s?[\d,]+k?|\bor\b|\bcash\b/gi, ""))) continue;
      alternative = { amount, taxFree };
    } else if (!bonus && ["+", "&", "and", "plus"].includes(connector)
               && (isCashWord || /^\s*or\s+£/i.test(after))) {
      bonus = { amount, taxFree };
    }
  }
  return { alternative, bonus };
}

// Operator text in priority order (grand_prize, then title); each field is filled by the first
// source that states it. Our own prize_description is NOT a source — it is a paraphrase.
export function cashExtras(...texts) {
  const out = { alternative: null, bonus: null };
  for (const t of texts) {
    if (!t) continue;
    const r = parseCash(t);
    out.alternative ??= r.alternative;
    out.bonus ??= r.bonus;
  }
  return out;
}

// Legacy string consumers (honesty.mjs ceiling, odds-copy absurd-comparison, the briefing):
// the ALTERNATIVE only — a bonus is not an honest ceiling on what the prize is worth.
export function cashAlt(...texts) {
  const a = cashExtras(...texts).alternative;
  return a ? `£${a.amount.toLocaleString("en-GB")} ${a.taxFree ? "TAX-FREE CASH" : "CASH"}` : null;
}

// Bubble-sized money: £30k, £22.5k, £1.25m, £400.
export function shortMoney(n) {
  const trim = (x) => String(Number(x.toFixed(2)));
  if (n >= 1e6) return `£${trim(n / 1e6)}m`;
  if (n >= 1000) return `£${trim(n / 1000)}k`;
  return `£${n}`;
}

export function closesLabel(iso, now = new Date()) {
  const d = new Date(iso);
  // en-CA gives YYYY-MM-DD — the only toLocaleDateString format new Date() parses reliably.
  const day = (x) => x.toLocaleDateString("en-CA", { timeZone: LDN });
  const diff = Math.round((new Date(day(d)) - new Date(day(now))) / 86400000);
  const dn = d.toLocaleDateString("en-GB", { timeZone: LDN, weekday: "short" }).toUpperCase();
  const dm = d.toLocaleDateString("en-GB", { timeZone: LDN, day: "numeric", month: "short" }).toUpperCase();
  if (diff <= 0) return "CLOSES TONIGHT";
  if (diff === 1) return `CLOSES TOMORROW (${dn})`;
  return `CLOSES ${dn} ${dm}`;
}

// oddsLabel() is retired (§10.6a 1.0): an odds string is composed only in odds-copy.mjs, and
// this one had a single consumer — the slide model below, whose `odds` field only ever reached the
// caption briefing. build.mjs now builds that field with oddsCopy.conditional().

export function toDrawSlide(d, n) {
  return {
    type: "draw", n,
    price: priceLabel(d.ticket_price),
    title: cleanTitle(d.title),
    cashAlt: cashAlt(d.grand_prize, d.title),
    closes: closesLabel(d.draw_date),
    image: d.image_url,
    slug: d.slug,
  };
}

export const catLabel = (name = "PRIZE") =>
  name.toUpperCase().replace(" DRAWS", "").replace(" PRIZES", "").replace(" GIVEAWAYS", "").trim();

// Big punchy intro hook per category (matches the reference "WIN A ROLEX" energy).
export const hookLabel = (slug, name) => catCfg(slug).hook || `WIN ${catLabel(name)}`;
