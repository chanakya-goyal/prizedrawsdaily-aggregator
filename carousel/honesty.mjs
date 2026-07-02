// carousel/honesty.mjs — truth guards (spec §7.1) + IG-SEO alt text (spec §4.6).
// total_prize_value is GROSS TICKET REVENUE (entries × price), NOT prize worth —
// the "£X+ IN PRIZES" line only renders past a per-category defensibility bar.
import { catCfg } from "./config.mjs";
import { cashAlt } from "./format.mjs";

// Parse "£40,000 TAX-FREE CASH" → 40000. cashAlt() already normalises the string.
const cashAltValue = (d) => {
  const s = cashAlt(d.grand_prize, d.prize_description);
  const m = s && s.match(/£([\d,]+)/);
  return m ? Number(m[1].replaceAll(",", "")) : null;
};

// Per-draw claimable value: ticket revenue, capped at the operator's own cash
// alternative when one is stated (the operator's number is the honest ceiling).
// Guard alt > 0: a "£0"/"£000" cash-alt string parses to 0, and a zero cap would
// zero out an otherwise-legitimate revenue figure — that's a parse artifact, not
// an honest ceiling, so fall back to revenue instead.
export function capValue(d) {
  const revenue = Number(d.total_prize_value) || 0;
  const alt = cashAltValue(d);
  return (alt != null && alt > 0) ? Math.min(revenue, alt) : revenue;
}

export function valueLine(draws, slug) {
  const total = (Array.isArray(draws) ? draws : []).reduce((a, d) => a + capValue(d), 0);
  if (total < catCfg(slug).valueLineMin || total < 1000) return "";
  return `£${(Math.floor(total / 1000) * 1000).toLocaleString("en-GB")}+`;
}

export function altTexts(sel, drawSlides) {
  const kw = sel.seoKeyword || catCfg(sel.slug).seoKeyword;
  const intro = `${drawSlides.length} ${kw} closing this week — prize draw round-up from Prize Draws Daily (18+, UK only).`;
  const draws = drawSlides.map((s) =>
    `${s.title} prize draw — tickets ${s.price || "available"}, ${String(s.closes || "").toLowerCase()} (18+, UK only).`);
  const cta = `See every live UK prize draw at prizedrawsdaily.co.uk — @prizedrawsdaily (18+, UK only).`;
  return [intro, ...draws, cta];
}
