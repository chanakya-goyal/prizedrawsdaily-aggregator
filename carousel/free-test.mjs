// Test the FREE background-removal hero path on real draws. Run: bun run carousel/free-test.mjs
import { renderSlides } from "./render.mjs";
import { makeCutouts } from "./freehero.mjs";
import { mkdir } from "node:fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";

const priceLabel = (p) => { const n = Number(p); if (!isFinite(n) || n <= 0) return null; return n < 1 ? `${Math.round(n * 100)}p` : (n % 1 === 0 ? `£${n}` : `£${n.toFixed(2)}`); };
const cleanTitle = (t = "") => String(t).replace(/\s*[-–|+].*$/, "").replace(/\bcompetition\b/i, "").replace(/\s+/g, " ").trim() || t;
const closesLabel = (iso) => { const d = new Date(iso); return "CLOSES " + d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short" }).toUpperCase(); };

const u = new URL(SUPABASE_URL + "/rest/v1/draws");
u.searchParams.set("select", "title,grand_prize,prize_description,image_url,ticket_price,total_entries,draw_date,categories(slug,name)");
u.searchParams.set("status", "eq.active");
u.searchParams.append("draw_date", "gte." + new Date().toISOString());
u.searchParams.set("image_url", "not.is.null");
u.searchParams.set("order", "draw_date.asc");
u.searchParams.set("limit", "150");
const draws = await (await fetch(u, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } })).json();
const slug = (d) => d.categories?.slug || "";

const cats = ["tech-giveaways", "car-draws", "collectibles"];
const picks = cats.map((c) => draws.find((d) => slug(d) === c && d.image_url)).filter(Boolean);

console.log("Removing backgrounds (free, in-browser) for", picks.length, "draws…");
picks.forEach((d, i) => console.log(` ${i + 1}. [${slug(d)}] ${d.title}`));
const cutouts = await makeCutouts(picks.map((d) => d.image_url));

const slides = picks.map((d, i) => ({
  type: "draw", n: i + 1,
  price: priceLabel(d.ticket_price),
  title: cleanTitle(d.title),
  closes: closesLabel(d.draw_date),
  odds: d.total_entries ? `1 IN ${Number(d.total_entries).toLocaleString("en-GB")}` : null,
  image: d.image_url,
  cutoutDataUrl: cutouts[i] || undefined,
}));

const outDir = "/Users/chanakyagoyal/Desktop/pdd-carousel-samples";
await mkdir(outDir, { recursive: true });
const pngs = await renderSlides(slides);
for (let i = 0; i < pngs.length; i++) await Bun.write(`${outDir}/free-${slug(picks[i])}.png`, pngs[i]);
console.log("Wrote", pngs.length, "FREE-hero slides to", outDir);
