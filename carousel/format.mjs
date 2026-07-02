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

export function cashAlt(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = String(t).match(/£\s?([\d,]{3,})\s*(?:tax[-\s]?free\s*)?(?:cash|alternative)/i)
          || String(t).match(/\bor\s*£\s?([\d,]{3,})/i);
    if (m) return `£${m[1]} TAX-FREE CASH`;
  }
  return null;
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

export const oddsLabel = (n) => (n ? `1 IN ${Number(n).toLocaleString("en-GB")}` : null);

export function toDrawSlide(d, n) {
  return {
    type: "draw", n,
    price: priceLabel(d.ticket_price),
    title: cleanTitle(d.title),
    cashAlt: cashAlt(d.grand_prize, d.prize_description),
    closes: closesLabel(d.draw_date),
    odds: oddsLabel(d.total_entries),
    image: d.image_url,
    slug: d.slug,
  };
}

export const catLabel = (name = "PRIZE") =>
  name.toUpperCase().replace(" DRAWS", "").replace(" PRIZES", "").replace(" GIVEAWAYS", "").trim();

// Big punchy intro hook per category (matches the reference "WIN A ROLEX" energy).
export const hookLabel = (slug, name) => catCfg(slug).hook || `WIN ${catLabel(name)}`;
