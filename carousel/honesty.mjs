// carousel/honesty.mjs — truth guards (spec §7.1) + IG-SEO alt text (spec §4.6).
// total_prize_value is GROSS TICKET REVENUE (entries × price), NOT prize worth —
// the "£X+ IN PRIZES" line only renders past a per-category defensibility bar.
import { catCfg } from "./config.mjs";

export function valueLine(totalPrizeValue, slug) {
  const total = Number(totalPrizeValue) || 0;
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
