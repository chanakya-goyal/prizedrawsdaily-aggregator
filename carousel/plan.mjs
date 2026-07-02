// PLAN step: pick today's category + 4-5 closing-soon draws, drop a shot list + reference
// thumbnails into ~/Desktop/pdd-today/ for the user to fill with clean photos.
// Run: bun run carousel/plan.mjs   (optional: ONLY_CATEGORY=luxury)
import { fetchEndingSoon, pickBestCategory } from "./select.mjs";
import { priceLabel, closesLabel, catLabel } from "./format.mjs";
import { mkdir, writeFile, rm, readdir, rename } from "node:fs/promises";
import { workDir, GLOBAL, catCfg } from "./config.mjs";
import { recentDrawSlugs, lastCategory, todayLondon } from "./state.mjs";

const N = Number(process.env.SLIDES || 5);
const onlySlug = process.env.ONLY_CATEGORY || null;
const DAYS = Number(process.env.DAYS || 7);       // upper bound (days out)
const MIN_DAYS = Number(process.env.MIN_DAYS || 1); // runway floor — skip draws closing sooner
const DIR = workDir();
const proxied = (u, w = 900) => `https://images.weserv.nl/?url=${encodeURIComponent(u)}&w=${w}&output=jpg&we`;

// Archive the previous run instead of destroying it (spec §4.2); prune >archiveDays.
const ARCHIVE = `${DIR}/archive`;
await mkdir(ARCHIVE, { recursive: true });
try {
  const prev = (await readdir(DIR)).filter((f) => f !== "archive");
  if (prev.length) {
    const stamp = `${ARCHIVE}/${todayLondon()}-${Date.now() % 86400000}`;
    await mkdir(stamp, { recursive: true });
    for (const f of prev) await rename(`${DIR}/${f}`, `${stamp}/${f}`);
  }
  const cutoff = Date.now() - (GLOBAL.archiveDays || 14) * 86400000;
  for (const dir of await readdir(ARCHIVE)) {
    const iso = dir.slice(0, 10);
    if (new Date(iso + "T00:00:00Z").getTime() < cutoff) await rm(`${ARCHIVE}/${dir}`, { recursive: true, force: true });
  }
} catch (e) { console.error("archive step:", e.message); }

// History-aware selection (state may be unreachable → degrade gracefully, loudly).
let excludeSlugs = new Set(), avoid = null;
try { excludeSlugs = new Set(await recentDrawSlugs(7)); avoid = await lastCategory(); }
catch (e) { console.error("⚠ history unavailable (selection not history-aware):", e.message); }

const draws = await fetchEndingSoon(DAYS, MIN_DAYS);
const pick = pickBestCategory(draws, N, onlySlug, { excludeSlugs, avoidCategory: avoid });
if (!pick) { console.log("No draws closing within 7 days" + (onlySlug ? ` in ${onlySlug}` : "")); process.exit(0); }

const lines = [
  `PrizeDrawsDaily — carousel shot list (${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" })})`,
  ``,
  `Category: ${pick.name}  (${pick.count} draws closing this week, using top ${pick.draws.length})`,
  ``,
  `>> Save a CLEAN photo of each prize into THIS folder.`,
  `   EASIEST: rename each file to just its NUMBER below — 1, 2, 3, 4, 5  (no ".jpg"!).`,
  `   macOS hides extensions, so typing "1.jpg" yields "1.jpg.webp" — just use the number.`,
  `   (build also accepts the slug name.) clean = product on plain/white bg; jpg/png/webp ok.`,
  ``,
];
for (let i = 0; i < pick.draws.length; i++) {
  const d = pick.draws[i];
  try {
    const r = await fetch(proxied(d.image_url, 900));
    if (r.ok) await writeFile(`${DIR}/REF-${i + 1}-${d.slug}.jpg`, Buffer.from(await r.arrayBuffer()));
  } catch {}
  lines.push(`${i + 1}. ${d.title}`);
  lines.push(`   prize:  ${d.grand_prize || d.title}`);
  lines.push(`   price:  ${priceLabel(d.ticket_price) || "n/a"}   |   ${closesLabel(d.draw_date)}`);
  lines.push(`   ref:    REF-${i + 1}-${d.slug}.jpg  (operator's current image, for reference only)`);
  lines.push(`   SAVE AS: ${i + 1}   (rename your photo to just "${i + 1}" — or "${d.slug}")`);
  lines.push(``);
}
await writeFile(`${DIR}/SHOTLIST.txt`, lines.join("\n"));
// backups = next few draws in the same category, so a draw with blocked/branded images can be swapped
const backups = (pick.pool || []).slice(pick.draws.length, pick.draws.length + 3);
const dayOfYear = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + "-01-01")) / 86400000);
const archetype = GLOBAL.archetypes[dayOfYear % GLOBAL.archetypes.length];
await writeFile(`${DIR}/selection.json`, JSON.stringify({
  slug: pick.slug, name: pick.name, date: new Date().toISOString(),
  seoKeyword: catCfg(pick.slug).seoKeyword, archetype,
  draws: pick.draws, backups,
}, null, 2));

console.log(lines.join("\n"));
console.log(`Folder ready → ${DIR}  (reference thumbnails REF-*.jpg written; selection.json saved)`);
