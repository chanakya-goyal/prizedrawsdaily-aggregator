// Renders SAMPLE slides (intro + one draw) from a real live draw for design sign-off.
// Run from ~/pdd-aggregator so Bun auto-loads .env: `bun run carousel/sample.mjs`
import { renderSlides } from "./render.mjs";
import { genHero } from "./aihero.mjs";
import { mkdir } from "node:fs/promises";

// Mirror run.mjs: hardcoded fallbacks for local reads (publishable/anon key is public).
const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";

// ---- formatting helpers ----
const LDN = "Europe/London";
function priceLabel(p) {
  if (p == null) return null;
  const n = Number(p);
  if (!isFinite(n) || n <= 0) return null;
  if (n < 1) return `${Math.round(n * 100)}p`;
  return n % 1 === 0 ? `£${n}` : `£${n.toFixed(2)}`;
}
function cashAlt(text = "") {
  const m = String(text).match(/£\s?([\d,]{3,})\s*(?:tax[-\s]?free\s*)?(?:cash|alternative)/i)
        || String(text).match(/\bor\s*£\s?([\d,]{3,})/i);
  return m ? `£${m[1].replace(/,/g, ",")} TAX-FREE CASH` : null;
}
function closesLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const day = (x) => x.toLocaleDateString("en-GB", { timeZone: LDN, year: "numeric", month: "2-digit", day: "2-digit" });
  const diffDays = Math.round((new Date(day(d)) - new Date(day(now))) / 86400000);
  const dn = d.toLocaleDateString("en-GB", { timeZone: LDN, weekday: "short" }).toUpperCase();
  const dm = d.toLocaleDateString("en-GB", { timeZone: LDN, day: "numeric", month: "short" }).toUpperCase();
  if (diffDays <= 0) return "CLOSES TONIGHT";
  if (diffDays === 1) return `CLOSES TOMORROW (${dn})`;
  return `CLOSES ${dn} ${dm}`;
}
function cleanTitle(t = "") {
  return String(t).replace(/\s*[-–|+].*$/, "").replace(/\bcompetition\b/i, "").replace(/\s+/g, " ").trim() || t;
}

// ---- fetch live draws ----
const now = new Date().toISOString();
const u = new URL(SUPABASE_URL + "/rest/v1/draws");
u.searchParams.set("select", "title,grand_prize,prize_description,image_url,ticket_price,total_entries,draw_date,entry_url,categories(slug,name),operators(name)");
u.searchParams.set("status", "eq.active");
u.searchParams.append("draw_date", "gte." + now);
u.searchParams.set("image_url", "not.is.null");
u.searchParams.set("order", "draw_date.asc");
u.searchParams.set("limit", "150");

const res = await fetch(u, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
const draws = await res.json();
if (!Array.isArray(draws) || !draws.length) { console.error("No draws returned:", draws); process.exit(1); }

const slug = (d) => d.categories?.slug || "";
const withImg = draws.filter((d) => d.image_url);
const toDrawSlide = (d, n) => ({
  type: "draw", n,
  price: priceLabel(d.ticket_price),
  title: cleanTitle(d.title),
  cashAlt: cashAlt(d.grand_prize) || cashAlt(d.prize_description),
  closes: closesLabel(d.draw_date),
  odds: d.total_entries ? `1 IN ${Number(d.total_entries).toLocaleString("en-GB")}` : null,
  image: d.image_url,
});

// 3 representative draws to compare AI-cleaned heroes against the raw operator images
const cats = ["tech-giveaways", "car-draws", "collectibles"];
const picks = [];
for (const c of cats) { const d = withImg.find((x) => slug(x) === c); if (d) picks.push(d); }

const outDir = "/Users/chanakyagoyal/Desktop/pdd-carousel-samples";
await mkdir(outDir, { recursive: true });

console.log("Generating AI heroes (Gemini) for", picks.length, "draws…");
const drawSlides = [];
for (let i = 0; i < picks.length; i++) {
  const d = picks[i];
  console.log(` ${i + 1}. [${slug(d)}] ${d.title}`);
  const s = toDrawSlide(d, i + 1);
  const t = Date.now();
  const heroPng = await genHero(d.image_url);
  if (heroPng) {
    await Bun.write(`${outDir}/hero-${slug(d)}.png`, heroPng);      // raw cleaned product
    s.heroDataUrl = `data:image/png;base64,${heroPng.toString("base64")}`;
    console.log(`    ✓ AI hero in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } else {
    console.log("    ✗ AI hero failed — falling back to operator image");
  }
  drawSlides.push(s);
}

const introSlide = { type: "intro", count: 5, category: "LUXURY", dateRange: "this week" };
const slides = [introSlide, ...drawSlides, { type: "cta" }];
const pngs = await renderSlides(slides);
const names = ["01-intro", ...picks.map((d, i) => `0${i + 2}-${slug(d)}`), `0${picks.length + 2}-cta`];
for (let i = 0; i < pngs.length; i++) await Bun.write(`${outDir}/${names[i]}.png`, pngs[i]);
console.log("Wrote", pngs.length, "slides +", "heroes to", outDir);
