// Measure real operator images at several webp settings so the house
// compression params are chosen from data, not taste.
//
// The site never serves the stored file directly — src/lib/img.ts proxies
// every image through images.weserv.nl at w<=960&q=60. So the stored file
// only has to be a good ENOUGH input for that re-encode. Anything beyond
// that is storage we pay for and no user ever sees.
//
//   bun measure-compression.mjs [sampleSize]

import { weservUrl } from "./lib/compress.mjs";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const N = Number(process.argv[2] || 12);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Settings to compare. w=960 matches the site's widest srcset exactly;
// 1280 is the current house value (1.33x headroom for future layout changes).
const SETTINGS = [
  { w: 1600, q: 82, label: "1600/q82  generous" },
  { w: 1280, q: 75, label: "1280/q75  CURRENT" },
  { w: 1280, q: 68, label: "1280/q68" },
  { w: 1024, q: 75, label: "1024/q75" },
  { w: 1024, q: 70, label: "1024/q70" },
  { w: 960,  q: 72, label: " 960/q72  = display width" },
];

async function pickSamples() {
  const r = await fetch(
    `${SB}/rest/v1/draws?select=slug,entry_url,operators(slug)&status=eq.active&entry_url=not.is.null&limit=${N * 4}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  );
  const rows = await r.json();
  // spread across operators so one operator's house style doesn't dominate
  const seen = new Set(), out = [];
  for (const d of rows) {
    const op = d.operators?.slug || "misc";
    if (seen.has(op)) continue;
    seen.add(op); out.push(d);
    if (out.length >= N) break;
  }
  return out;
}

async function originImage(entryUrl) {
  try {
    const r = await fetch(entryUrl, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return null;
    return new URL(m[1].replace(/&amp;/g, "&"), entryUrl).href;
  } catch { return null; }
}

async function sizeAt(url, w, q) {
  try {
    const r = await fetch(weservUrl(url, { w, q }), { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const t = (r.headers.get("content-type") || "").toLowerCase();
    if (!t.includes("image")) return null;
    return (await r.arrayBuffer()).byteLength;
  } catch { return null; }
}

const kb = (b) => (b / 1024).toFixed(0).padStart(5) + " KB";

const samples = await pickSamples();
console.log(`Sampling ${samples.length} active draws across distinct operators\n`);

const totals = Object.fromEntries(SETTINGS.map((s) => [s.label, []]));
let originBytes = [];

for (const d of samples) {
  const img = await originImage(d.entry_url);
  if (!img) { console.log(`  ✗ no og:image  ${d.slug.slice(0, 44)}`); continue; }
  const orig = await sizeAt(img, 4000, 100); // effectively the source, unresized
  if (orig) originBytes.push(orig);
  const line = [];
  for (const s of SETTINGS) {
    const b = await sizeAt(img, s.w, s.q);
    if (b) totals[s.label].push(b);
    line.push(b ? (b / 1024).toFixed(0) : "—");
  }
  console.log(`  ✓ ${d.slug.slice(0, 40).padEnd(40)} ${line.map((x) => String(x).padStart(6)).join("")}`);
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log("\n" + "═".repeat(66));
console.log(`  source (unresized)      avg ${kb(avg(originBytes))}`);
console.log("─".repeat(66));
const base = avg(totals["1280/q75  CURRENT"]);
for (const s of SETTINGS) {
  const a = avg(totals[s.label]);
  const rel = base ? ((a / base - 1) * 100).toFixed(0) : "0";
  const proj = (a * 3114) / 1024 / 1024 / 1024;
  console.log(`  ${s.label.padEnd(24)} avg ${kb(a)}   ${(rel > 0 ? "+" : "") + rel}% vs current   →  ${proj.toFixed(2)} GB for 3,114 draws`);
}
console.log("═".repeat(66));
console.log("\n  Free quota is 1 GB. Pick the largest setting that stays comfortably under it.");
