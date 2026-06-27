// Manager / validator-QA. Deterministic field rules (extends the old run.mjs supervisor)
// + a live image check + an operator health report. The cowork/Claude routine layers
// judgment (description quality, category sanity) on top of these and owns the publish
// decision; these functions give it the deterministic backbone and let run.mjs flag
// suspicious draws to 'draft' at scrape time.
import { CATEGORIES, UA } from "./parse.mjs";

// Keyword sets to sanity-check the assigned category against the prize text.
// Kept in sync with CAT_RULES in lib/parse.mjs: if inferCategory assigns a category, fieldFlags
// must recognise the same keywords, or it needlessly draft-holds a correctly-categorised draw.
const CAT_KW = {
  "car-draws": /\b(cars?|van|bike|motor|motorbike|motorcycle|audi|bmw|mercedes|merc|amg|porsche|ford|focus|fiesta|vw|volkswagen|golf|polo|gti|gtr|tesla|ferrari|lamborghini|lambo|range\s?rover|land\s?rover|defender|nissan|toyota|honda|civic|jaguar|bentley|aston\s?martin|mclaren|maserati|vehicle|supercar|hypercar|campervan)\b/i,
  "house-draws": /\b(house|home|flat|apartment|bungalow|property|villa|mortgage)\b/i,
  "tech-giveaways": /\b(iphone|ipad|macbook|imac|apple ?watch|laptop|notebook|pc|ps5|ps4|playstation|xbox|nintendo|switch|console|tv|oled|qled|gpu|rtx|graphics card|gaming|airpods|samsung|galaxy|google pixel|smartphone|tablet|drone|gadget|dyson|vacuum|hoover|air ?fryer|ninja|shark|kitchenaid|nespresso|coffee machine|fridge|freezer|washing machine|dishwasher|microwave|soundbar|speaker|headphones|earbuds|monitor|smartwatch|garmin|fitbit|gopro|projector|e-?bike|e-?scooter|electric scooter|alexa|echo)\b/i,
  "luxury": /\b(rolex|omega|tudor|breitling|tag ?heuer|cartier|watch|jewellery|jewelry|diamond|designer|holiday|getaway|cruise|hot ?tub|lay-?z-?spa|jacuzzi|spa|champagne|prosecco|whisky|whiskey|perfume|aftershave|fragrance|sunglasses|ray-?ban|tackle|fishing|carp|handbag|chanel|gucci|louis vuitton|prada|dior|burberry|hermes)\b/i,
  "collectibles": /\b(lego|warhammer|sigmar|slaanesh|games workshop|citadel|gundam|model kit|pok[eé]mon|tcg|trading card|funko|graded|holo|slab|collectible|booster|elite trainer|sealed)\b/i,
  "cash-prizes": /\b(cash|money|jackpot|tax[- ]?free|instant win|gift card|voucher|e-?gift|£)\b/i,
};

// Synchronous flags. Any flag → the draw is held as 'draft' for review (never dropped here).
export function fieldFlags(draw) {
  const flags = [];
  const price = Number(draw.ticket_price), ent = Number(draw.total_entries);
  const pool = (price || 0) * (ent || 0);
  if (price > 50) flags.push(`ticket £${price} >£50?`);
  if (ent > 5_000_000) flags.push(`${ent} entries >5M?`);
  if (pool > 50_000_000) flags.push(`pool £${Math.round(pool)} >£50M?`);
  if (["car-draws", "house-draws"].includes(draw.category) && pool < 5000) flags.push(`${draw.category} pool only £${Math.round(pool)}`);
  if (!/^https?:\/\/.+/i.test(draw.image_url || "")) flags.push("missing/bad image");
  if (!/^https?:\/\/.+/i.test(draw.entry_url || "")) flags.push("bad entry_url");
  if (draw.category && !CATEGORIES.includes(draw.category)) flags.push(`bad category ${draw.category}`);
  if (!draw.description || draw.description.length < 20) flags.push("thin description");
  if (!draw.title || draw.title.trim().length < 5) flags.push("thin title");
  const kw = CAT_KW[draw.category];
  if (kw && draw.grand_prize && !kw.test(`${draw.title} ${draw.grand_prize}`)) flags.push(`category '${draw.category}' may not match prize`);
  return flags;
}

// Live image check. A definitive non-2xx → block (flag). A timeout/network error returns
// ok:null = "unverified, don't block" so a flaky CDN never buries a good draw.
export async function checkImage(url, { timeoutMs = 5000 } = {}) {
  if (!/^https?:\/\/.+/i.test(url || "")) return { ok: false, reason: "no url" };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      r = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA, Range: "bytes=0-0" } });
    }
    if (r.status >= 200 && r.status < 300) {
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      return { ok: ct === "" || /image\//.test(ct), reason: ct || "no content-type" };
    }
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: null, reason: e.name === "AbortError" ? "timeout" : (e.message || "error") };
  } finally {
    clearTimeout(to);
  }
}

// Full per-draw verdict (deterministic). status='active' only if no flags.
export async function review(draw, { checkImg = true } = {}) {
  const flags = fieldFlags(draw);
  if (checkImg) {
    const img = await checkImage(draw.image_url);
    if (img.ok === false && !flags.some((f) => /image/i.test(f))) flags.push(`image unreachable (${img.reason})`);
  }
  return { status: flags.length ? "draft" : "active", flags };
}

// ---- operator health report ----
// counts: [{ slug, scraped, inserted, published, heldDraft }]; expected = slugs in this run.
export function buildHealthReport({ counts = [], expected = [] }) {
  const bySlug = Object.fromEntries(counts.map((c) => [c.slug, c]));
  const silent = expected.filter((s) => !bySlug[s] || (bySlug[s].scraped || 0) === 0);
  const totals = counts.reduce((a, c) => ({
    scraped: a.scraped + (c.scraped || 0), inserted: a.inserted + (c.inserted || 0),
    published: a.published + (c.published || 0), heldDraft: a.heldDraft + (c.heldDraft || 0),
  }), { scraped: 0, inserted: 0, published: 0, heldDraft: 0 });
  return { perOperator: counts, silentOperators: silent, totals };
}

export function reportMarkdown(report) {
  const { totals, silentOperators, perOperator } = report;
  let md = `## Aggregator health report\n\n`;
  md += `**Totals:** scraped ${totals.scraped} · inserted ${totals.inserted} · published ${totals.published} · held-draft ${totals.heldDraft}\n\n`;
  if (silentOperators.length) md += `⚠️ **Silent operators (0 draws — check selectors / blocked):** ${silentOperators.join(", ")}\n\n`;
  md += `| operator | scraped | inserted | published | draft |\n|---|---|---|---|---|\n`;
  for (const c of perOperator) md += `| ${c.slug} | ${c.scraped || 0} | ${c.inserted || 0} | ${c.published || 0} | ${c.heldDraft || 0} |\n`;
  return md;
}

// Emit the report to the GitHub Action step summary when running there; always echo to log.
export async function writeStepSummary(report) {
  const md = reportMarkdown(report);
  console.log("\n" + md);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { await Bun.write(f, md); } catch { /* non-fatal */ } }
}
