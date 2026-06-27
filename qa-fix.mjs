// Per-draw field corrector for DRAFT draws — grounds every value in the operator's own clean
// per-competition source (WooCommerce product description + stock), NOT the noisy full page.
//
// Fixes the three reported error classes:
//   1. total_entries = the per-person cap, or a progress bar belonging to a DIFFERENT comp.
//      → the true total is the page bar "sold/total" where sold + (API remaining) == total.
//   2. grand_prize = the competition's game/marketing NAME instead of the prize.
//      → read "£X MAIN PRIZE" / "N x £Y" / "£X end prize" from the product description.
//   3. wrong category (e.g. "Van Gogh" → car). → fixCategory with the hardened rules below.
//
//   DRY_RUN=true (default) report old→new;  DRY_RUN=false apply PATCHes.  ONLY=slug to scope.
import { UA } from "./lib/parse.mjs";
const URL = "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN !== "false";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const ID = process.env.ID || null;
if (!DRY && !KEY) { console.error("DRY_RUN=false needs SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const READ = KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const H = { apikey: READ, Authorization: `Bearer ${READ}` };
const ops = await Bun.file("operators.json").json();
const opBy = Object.fromEntries(ops.map((o) => [o.slug, o]));
const slugFromUrl = (u) => (u || "").replace(/[#?].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
const clean = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/&#8211;|&#8217;|&pound;/g, (m) => ({ "&#8211;": "–", "&#8217;": "’", "&pound;": "£" }[m])).replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

// ---- category (hardened: kill the "van gogh"→car bug; pokémon/graded → collectibles) ----
const CAT = [
  // collectibles: only UNAMBIGUOUS tokens — "booster" alone matches "odds booster", "ace 10"
  // alone matches non-card titles, so require the card-specific forms.
  ["collectibles", /\b(lego|warhammer|pok[eé]mon|pikachu|charizard|tcg|trading cards?|graded card|psa ?10|gem ?mint|booster box|booster pack|elite trainer box|funko|first edition|sealed (?:box|case|booster))\b/i],
  ["house-draws", /\b(house|home(?! ?bargains)|flat|apartment|bungalow|property|villa|mortgage|lodge|cabin|caravan)\b/i],
  ["car-draws", /\b(car|bmw|audi|mercedes|merc|amg|porsche|ford|focus|fiesta|fiat|volkswagen|vw|golf gti|polo|gtr|tesla|ferrari|lamborghini|lambo|range ?rover|land ?rover|defender|nissan|toyota|supra|honda civic|jaguar|bentley|aston ?martin|mclaren|maserati|vauxhall|corsa|astra|peugeot|renault|kia|hyundai|mazda|seat|skoda|suzuki|volvo|citroen|dacia|mini cooper|supercar|hypercar|motorbike|motorcycle|campervan|transit van)\b/i],
  ["tech-giveaways", /\b(iphone|ipad|macbook|imac|apple ?watch|laptop|ps5|ps4|playstation|xbox|nintendo|console|oled|qled|gpu|rtx|gaming pc|airpods|samsung galaxy|pixel|smartphone|tablet|drone|dyson|vacuum|air ?fryer|ninja|shark|nespresso|fridge|freezer|washing machine|dishwasher|soundbar|headphones|earbuds|monitor|smartwatch|garmin|gopro|projector|robot vacuum|alexa|echo|meta quest|vr headset|tool|drill|toolkit)\b/i],
  ["luxury", /\b(rolex|omega|tudor|breitling|tag ?heuer|cartier|watch|jewellery|jewelry|diamond|gold (?:bar|bullion|coin)|silver (?:bar|coin)|designer|holiday|getaway|cruise|hot ?tub|lay-?z-?spa|jacuzzi|spa|champagne|prosecco|whisky|whiskey|handbag|chanel|gucci|louis vuitton|prada|fishing|tackle|carp|golf|ping|taylormade|callaway|titleist)\b/i],
  ["cash-prizes", /\b(cash|money|jackpot|tax[- ]?free|instant win|site credit|gift card|voucher|£\d)\b/i],
];
function fixCategory(title, gp, url) {
  const hay = `${title || ""} ${gp || ""} ${url || ""}`.replace(/van gogh/ig, "vangogh"); // neutralise "van"
  for (const [c, rx] of CAT) if (rx.test(hay)) return c;
  return null;
}

// ---- total entries: the page bar "sold/total" confirmed by API remaining; veto per-person ----
function realEntries(pageText, apiRemaining) {
  const bars = [...pageText.matchAll(/([\d,]{2,})\s*\/\s*([\d,]{2,})/g)].map((m) => [+m[1].replace(/,/g, ""), +m[2].replace(/,/g, "")]);
  if (apiRemaining != null) {
    for (const [sold, total] of bars) if (total > sold && Math.abs(sold + apiRemaining - total) <= 2) return { value: total, how: `bar ${sold}/${total} ✓ sold+remaining` };
  }
  // labelled total, explicitly NOT per-person
  const lab = pageText.match(/([\d,]{3,})\s*(?:max(?:imum)?\.?\s*(?:tickets?|entries?)|total\s*(?:tickets?|entries?|shots?))(?!\s*per)/i);
  if (lab) { const n = +lab[1].replace(/,/g, ""); const near = pageText.slice(Math.max(0, lab.index - 12), lab.index + lab[0].length + 14); if (!/per\s*person|per\s*entry/i.test(near)) return { value: n, how: `labelled ${lab[0].trim()}` }; }
  if (apiRemaining != null && bars.length === 0) return { value: null, how: "no bar" };
  return { value: null, how: "unresolved" };
}

// ---- grand prize: the real MAIN prize from the description (not the comp's game name) ----
const GAMEY = /^(?:[^£$]*\b(?:bounty|cracker|riches|balloon|cork|pinata|spin|hunt|emoji|escape|smash|pop|shoot|wheel|madness|bonanza|frenzy|mania|race|rush|fever|night|day|draw|comp|competition|instant ?wins?|mystery|lucky|jackpot|bundle|club|paradise)\b[^£$]*)$/i;
function realGrandPrize(desc, title) {
  const d = clean(desc);
  // explicit "N x £Y main prize(s)"
  let m = d.match(/(\d+)\s*x\s*£([\d,]+)\s*main\s*prize/i);
  if (m) return { value: `${m[1]} × £${m[2]} Cash`, how: "N×£ main prize" };
  // "£X main prize" / "main prize ... £X" / "£X end prize"
  m = d.match(/£([\d,]+)\s*(?:main|top|end)\s*prize/i) || d.match(/(?:main|top|end)\s*prize[^£\d]{0,12}£([\d,]+)/i);
  if (m) return { value: `£${m[1]} Cash`, how: "£ main prize" };
  // physical headline item right after a "win"
  m = d.match(/\bwin\s+(?:a|an|this|the)?\s*([A-Z0-9][^.!£\n]{6,60}?)(?:\s*(?:or\s*£|–|—|\(|!|\.|$))/);
  if (m && !/instant|every|chance|up to/i.test(m[1])) return { value: m[1].trim(), how: "win <item>" };
  // title is itself a real prize (contains £ or a clear product) → keep it
  if (/£\d/.test(title || "")) return { value: null, how: "title already names a £ prize" };
  return { value: null, how: "no clear main prize in description" };
}

async function fetchComp(op, slug, entry_url) {
  if (op.method === "woo") {
    const arr = await (await fetch(`${op.base}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).json().catch(() => []);
    const p = Array.isArray(arr) ? arr[0] : null;
    if (!p) return null;
    const remTxt = p.stock_availability?.text || "";
    const rem = /(\d[\d,]*)\s*in stock/i.test(remTxt) ? +remTxt.match(/(\d[\d,]*)\s*in stock/i)[1].replace(/,/g, "") : null;
    let pageText = "";
    try { pageText = clean(await (await fetch(entry_url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text()); } catch {}
    return { desc: p.description || "", purchasable: p.is_purchasable, remaining: rem, pageText };
  }
  return null; // shopify/render handled by the vision pass
}

const all = await (await fetch(`${URL}/rest/v1/draws?status=eq.draft&select=id,title,grand_prize,total_entries,entry_url,image_url,categories(slug),operators(slug,name)`, { headers: H })).json();
let draws = ID ? all.filter((d) => d.id === ID) : all;
if (ONLY) draws = draws.filter((d) => ONLY.has(d.operators?.slug));
console.log(`${DRY ? "DRY RUN" : "LIVE"} — ${draws.length} draft draws\n`);

let fixed = 0, flagged = 0, skipped = 0;
const flags = [];
for (const d of draws) {
  const op = opBy[d.operators?.slug];
  if (!op || op.method !== "woo") { skipped++; continue; }
  const c = await fetchComp(op, slugFromUrl(d.entry_url), d.entry_url);
  if (!c) { skipped++; continue; }
  const patch = {}; const notes = [];

  // entries
  const ent = realEntries(`${c.pageText} ${clean(c.desc)}`, c.remaining);
  if (ent.value && ent.value !== d.total_entries) { patch.total_entries = ent.value; notes.push(`entries ${d.total_entries}→${ent.value} (${ent.how})`); }

  // grand_prize: too much judgment for regex (instant "up to £X" vs fixed "£Y main prize",
  // prize printed only on the image) — hand EVERY name-as-prize draw to the LLM/vision routine.
  const curIsName = (d.grand_prize || "").trim() === (d.title || "").trim() || !/£\d|\bcash\b/i.test(d.grand_prize || "");
  if (curIsName) flags.push({ id: d.id, op: d.operators?.slug, base: op.base, method: op.method, entry_url: d.entry_url, title: d.title, cur_grand_prize: d.grand_prize, cur_category: d.categories?.slug, image_url: d.image_url });

  // category — conservative: only assign a SPECIFIC category (never auto-downgrade to the
  // cash-prizes fallback, which is how a real car/collectible would get mislabelled).
  const cat = fixCategory(d.title, patch.grand_prize || d.grand_prize, d.entry_url);
  if (cat && cat !== "cash-prizes" && cat !== d.categories?.slug) { patch._category = cat; notes.push(`category ${d.categories?.slug}→${cat}`); }

  if (Object.keys(patch).length) {
    fixed++;
    console.log(`  ${DRY ? "would fix" : "✅"} [${d.operators?.slug}] ${(d.title || "").slice(0, 40)}\n      ${notes.join("\n      ")}`);
    if (!DRY) {
      const body = { ...patch }; delete body._category;
      if (patch._category) {
        const cats = await (await fetch(`${URL}/rest/v1/categories?slug=eq.${patch._category}&select=id`, { headers: H })).json();
        if (cats[0]) body.category_id = cats[0].id;
      }
      const pr = await fetch(`${URL}/rest/v1/draws?id=eq.${d.id}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) });
      if (!pr.ok) console.log(`      ! PATCH ${pr.status} ${(await pr.text()).slice(0, 70)}`);
    }
  }
}
flagged = flags.length;
console.log(`\n==== ${DRY ? "would fix" : "fixed"} ${fixed} · ${flagged} flagged for vision review · ${skipped} skipped (non-woo) ====`);
if (flagged) { await Bun.write(`${process.env.HOME}/Desktop/pdd-draft-needs-vision.json`, JSON.stringify(flags, null, 2)); console.log(`flagged list → ~/Desktop/pdd-draft-needs-vision.json`); }
