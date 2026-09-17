// BUILD step: render the full carousel from today's selection + prize photos.
// Photo source per draw (priority): (1) a photo YOU dropped in ~/Desktop/pdd-today/
// (named 1–5 or by slug), (2) the auto-fetched photo from the draw's page
// (.fetched/{slug}/pick.txt — set by fetchimg.mjs, QA'd by Claude), (3) typographic card.
// Run: bun run carousel/build.mjs   (after plan.mjs + fetchimg.mjs)
import { renderSlides } from "./render.mjs";
import { buildCaption } from "./caption.mjs";
import { buildBriefing } from "./brief.mjs";
import { recentPosts } from "./state.mjs";
import { cleanTitle, closesLabel, cashAlt, priceLabel } from "./format.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import { sceneFor } from "./scene.mjs";
import { readdir, mkdir } from "node:fs/promises";
import { workDir, catCfg } from "./config.mjs";
import { valueLine, altTexts } from "./honesty.mjs";
import { minDimOk } from "./imgcheck.mjs";
import { chromium } from "playwright";
import { openEngine, normalise } from "./normalise.mjs";

const DIR = workDir();
const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
const files = await readdir(DIR);

const IMG_EXT = /\.(jpe?g|png|webp)$/i;
// normalise a filename → its base: trim, drop the real image extension AND any redundant
// image extension chain ("yamaha.jpg.webp" → "yamaha", "vw.jpg.jpg" → "vw"; macOS hides
// the real ext so people append ".jpg" from the shot list). Tolerant by design.
const baseOf = (f) => f.trim().replace(IMG_EXT, "").replace(IMG_EXT, "").trim().toLowerCase();
// match a clean upload by slug OR by its 1-based rank in the shot list (e.g. "1.jpg")
const findClean = (slug, rank) => {
  const f = files.find((f) => {
    if (f.startsWith("REF-") || !IMG_EXT.test(f.trim())) return false;
    const b = baseOf(f);
    return b === slug.toLowerCase() || b === String(rank);
  });
  return f ? `${DIR}/${f}` : null;
};
async function toDataUrl(path) {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const ext = path.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// CARD style: "photo" (B, default) = original photo full-frame in the card;
// "cutout" (A) = background-removed product on the branded card.
const CARD = (process.env.CARD || "photo").toLowerCase();

// auto-fetched photo for a draw (.fetched/{slug}/pick.txt → chosen candidate file)
const FETCHED = `${DIR}/.fetched`;
async function fetchedPath(slug) {
  const pick = Bun.file(`${FETCHED}/${slug}/pick.txt`);
  if (!(await pick.exists())) return null;
  const name = (await pick.text()).trim();
  const p = `${FETCHED}/${slug}/${name}`;
  return name && (await Bun.file(p).exists()) ? p : null;
}

// resolve each draw's hero source: your dropped photo > auto-fetched pick > none
const srcPath = {}; const srcKind = {};
for (let i = 0; i < sel.draws.length; i++) {
  const d = sel.draws[i];
  const mine = findClean(d.slug, i + 1);
  if (mine) { srcPath[d.slug] = mine; srcKind[d.slug] = "your photo"; continue; }
  const auto = await fetchedPath(d.slug);
  if (auto) {
    if (await minDimOk(auto, 500)) { srcPath[d.slug] = auto; srcKind[d.slug] = "auto-fetched"; }
    else console.log(`  ⚠ ${d.slug}: auto-fetched pick is under 500px — rejected (typographic fallback). Repick in .fetched/${d.slug}/pick.txt`);
  }
}
const haveSlugs = sel.draws.filter((d) => srcPath[d.slug]).map((d) => d.slug);
console.log(`Card style: ${CARD}  |  Photos: ${haveSlugs.length}/${sel.draws.length}`);
sel.draws.forEach((d, i) => console.log(`  ${i + 1}. ${d.slug.slice(0, 44).padEnd(46)} ${srcKind[d.slug] || "— typographic card"}`));

const photoData = {};
for (const s of haveSlugs) photoData[s] = await toDataUrl(srcPath[s]);

// ---- asset normalisation and the collage gate (spec §9, §5.6) --------------------------
// Every photograph that reaches a slide goes through one normaliser first: one master size, a
// trimmed border, and a conservative tone pass. The border trim is the part that earns its keep
// beyond looks — Instagram's own ranking note makes content "less visible" when it carries
// borders, and a good third of operator artwork ships inside a coloured frame.
//
// The transform is honestly modest on this inventory, because most of what operators publish is
// MARKETING ARTWORK rather than product photography. So the valuable output is not the pixels,
// it is the CLASSIFICATION: a draw whose image reads as a poster is swapped for a backup rather
// than shipped, which is the image-quality gate §5.6 asks for. The deck loses a draw it could
// not show well and gains one it can.
// ONE launch for the whole build: the normaliser and the renderer share it.
const browser = await chromium.launch();
const engine = await openEngine(browser);
const sheet = [];
const posterRisk = {};
try {
  for (const d of [...sel.draws, ...(sel.backups || [])]) {
    const src = photoData[d.slug] || d.image_url;
    if (!src) continue;
    const buf = src.startsWith("data:")
      ? Buffer.from(src.split(",")[1], "base64")
      : await (async () => { const r = await fetch(src); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; })();
    if (!buf) { sheet.push({ slug: d.slug, ok: false, reason: "fetch-failed" }); continue; }
    let n;
    try { n = await normalise(engine, buf); }
    catch (e) { sheet.push({ slug: d.slug, ok: false, reason: "normalise-threw", detail: String(e.message).slice(0, 90) }); continue; }
    if (!n.ok) { sheet.push({ slug: d.slug, ok: false, reason: n.reason, detail: n.detail }); continue; }
    photoData[d.slug] = `data:image/jpeg;base64,${n.buffer.toString("base64")}`;
    posterRisk[d.slug] = n.poster;
    sheet.push({
      slug: d.slug, ok: true, ground: n.ground, poster: n.poster,
      source: srcKind[d.slug] || "stored image_url",
      padded: n.m.padded, edgeGuard: n.guard.pass, tone: n.plan.notes,
      was: `${n.m.width}x${n.m.height}`,
    });
  }
} finally { await engine.close(); }

// The swap. A backup only replaces a draw if the backup's own image is BETTER — otherwise the
// deck would trade a known-poor image for an unknown one, and a draw the selector already
// ranked lower.
const RANK = { low: 0, medium: 1, high: 2 };
const spare = (sel.backups || []).filter((b) => photoData[b.slug] && RANK[posterRisk[b.slug] ?? "high"] === 0);
for (let i = 0; i < sel.draws.length && spare.length; i++) {
  const d = sel.draws[i];
  if (RANK[posterRisk[d.slug] ?? "low"] < 2) continue;      // only a HIGH risk is worth a swap
  const b = spare.shift();
  console.log(`  ⇄ ${d.slug.slice(0, 40)} reads as a collage — swapped for ${b.slug.slice(0, 40)}`);
  sel.draws[i] = b;
}
const collages = sel.draws.filter((d) => posterRisk[d.slug] === "high");
if (collages.length) console.log(`  ⚠ ${collages.length} slide(s) still carry poster-like artwork (no clean backup left): ${collages.map((d) => d.slug.slice(0, 30)).join(", ")}`);

// The swap happens here but publish.mjs re-reads selection.json, and it is publish.mjs that
// records draw_slugs into carousel_posts. Without writing the decision back, the state row would
// name the draws we REJECTED and every later report would be reading the wrong deck. Write it.
await Bun.write(`${DIR}/selection.json`, JSON.stringify(sel, null, 2));

// (mode A only) free bg-removal in an ISOLATED subprocess — the @imgly WASM model
// otherwise poisons this process so the render browser's setContent hangs.
const cutBySlug = {};
if (CARD === "cutout" && haveSlugs.length) {
  const cutDir = `${DIR}/.cuts`;
  await mkdir(cutDir, { recursive: true });
  const isFresh = async (s) => {
    if (process.env.FORCE_CUT) return false;
    const cut = Bun.file(`${cutDir}/${s}.png`);
    if (!(await cut.exists())) return false;
    return cut.lastModified >= Bun.file(srcPath[s]).lastModified;
  };
  const todo = [];
  for (const s of haveSlugs) (await isFresh(s)) ? null : todo.push(s);
  if (todo.length) {
    const manifestPath = `${cutDir}/manifest.json`;
    await Bun.write(manifestPath, JSON.stringify({
      outDir: cutDir,
      items: await Promise.all(todo.map(async (s) => ({ slug: s, src: photoData[s] }))),
    }));
    console.log(`Removing backgrounds (isolated subprocess) for ${todo.length} photo(s)…`);
    const proc = Bun.spawn(["bun", new URL("./freehero.mjs", import.meta.url).pathname, manifestPath], {
      cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit",
    });
    await proc.exited;
  } else { console.log("All cutouts cached (fresh) — skipping bg-removal."); }
  for (const s of haveSlugs) {
    if (await Bun.file(`${cutDir}/${s}.png`).exists()) cutBySlug[s] = await toDataUrl(`${cutDir}/${s}.png`);
  }
  console.log(`Cutouts ready: ${Object.keys(cutBySlug).length}/${haveSlugs.length}`);
}

// ---- deck assembly -------------------------------------------------------------------
// Ten slides: cover, count, one per remaining draw, closing. Every count on the frame is
// derived from what ACTUALLY RENDERED, never from config.drawsPerDeck — on a degraded run a
// cover reading "of the eight" is a false checkable claim, which is the one kind of error the
// cover's proof line exists to rule out.
const heroOf = (slug) => CARD === "cutout" ? cutBySlug[slug] : photoData[slug];
const N = sel.draws.length;
const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).toUpperCase();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "each operator's own site"; } };
const soonOf = (d) => d && (new Date(d) - Date.now()) < 48 * 3600e3;
const todayOf = (d) => d && fmtDay(d) === fmtDay(new Date().toISOString());
const capOf = (d) => Number(d.total_entries) || null;

// THE READ-AT STAMP IS NEVER APPROXIMATED. It renders from the oldest stored observation across
// the deck, or not at all — a false provenance claim is worse than no claim, which is why there
// is no "now()" fallback here.
const checked = sel.draws.map((d) => d.figures_checked_at).filter(Boolean).sort();
const stamp = checked.length
  ? oddsCopy.stampShort(new Date(checked[0]).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }))
  : null;
if (!stamp) console.log("  ⚠ no figures_checked_at on any draw — the read-at stamp will not render (Stage 0 not applied?)");

// Slide 2 carries the LOWEST ticket cap in the deck, not the soonest close. It is the one slide
// that carries the full dot grid, and the grid is only countable below the ceiling — so the
// draw with the shortest cap is the one where the device does its best work.
const capped = sel.draws.filter((d) => capOf(d));
if (!capped.length) throw new Error("no draw in the selection carries a ticket cap — the odds device cannot render, refusing to build");
const countDraw = capped.reduce((a, b) => (capOf(a) <= capOf(b) ? a : b));
const rest = sel.draws.filter((d) => d !== countDraw);

const prices = sel.draws.map((d) => Number(d.ticket_price)).filter((p) => isFinite(p) && p > 0);
const fromPrice = prices.length ? priceLabel(Math.min(...prices)) : null;
const lowestCap = Math.min(...capped.map(capOf));
const maxDate = Math.max(...sel.draws.map((d) => +new Date(d.draw_date)).filter(isFinite));
const closesWithinDays = Math.max(1, Math.ceil((maxDate - Date.now()) / 86400000));

const deckBand = oddsCopy.bandLines({ role: "cover", drawsRendered: N, fromPrice: fromPrice || "n/a" });
const drawBand = (d) => oddsCopy.bandLines({
  role: "draw",
  closesText: closesLabel(d.draw_date),
  price: priceLabel(d.ticket_price) || "n/a",
  host: hostOf(d.entry_url),
  freeEntryRoute: d.free_entry_route || "unknown",
});

const lockupOf = (d) => ({
  operator: d.operators?.name || null,
  // The Trust Score is PDD's own assessment, so the chip says "PDD" and renders as ink on paper
  // rather than in a verdict colour. One decimal: the stored spread is 3.0-4.8.
  rating: Number.isFinite(Number(d.operators?.rating)) ? Number(d.operators.rating).toFixed(1) : null,
});

const now = new Date();
const dateline = [
  now.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase().replace(/,/g, ""),
  stamp,
].filter(Boolean).join(" \u00b7 ");

const coverSlide = {
  type: "cover", stamp, dateline,
  headline: oddsCopy.headline(sel.archetype, {
    drawsRendered: N, fromPrice: fromPrice || "n/a",
    cashAlt: cashAlt(countDraw.grand_prize, countDraw.prize_description),
    price: priceLabel(countDraw.ticket_price),
  }),
  // Figures wrapped so the renderer can set them in the one place green is authorised.
  proof: oddsCopy.proofLine({ drawsRendered: N, closesWithinDays, lowestCap })
    .map((l) => l.replace(/([\d,]+)/g, "<b>$1</b>")),
  band: deckBand,
  board: [
    ...sel.draws.slice(0, 3).map((d) => ({
      prize: cleanTitle(d.grand_prize || d.title),
      closes: fmtDay(d.draw_date),
      soon: soonOf(d.draw_date),
    })),
    N >= 5 ? { more: `+${N - 3} more inside` } : null,
  ].filter(Boolean),
};

const countSlide = {
  type: "count", stamp, n: 2, total: N + 2,
  index: sel.draws.indexOf(countDraw) + 1, drawsRendered: N,
  title: cleanTitle(countDraw.grand_prize || countDraw.title),
  cap: capOf(countDraw), ...lockupOf(countDraw),
  soon: soonOf(countDraw.draw_date), band: drawBand(countDraw),
};

const drawSlides = rest.map((d, i) => ({
  type: "draw", stamp, n: i + 3, total: N + 2,
  title: cleanTitle(d.grand_prize || d.title),
  // Photo priority: a photograph you dropped in the work dir, then fetchimg's QA'd pick, then
  // the draw's own stored image_url. That last one is not a consolation prize — it is already
  // re-hosted on our storage and it is what the website shows for the same draw, so the deck
  // and the site agree. Without it a build that skipped fetchimg rendered an empty white well,
  // which looks like a broken slide and passes every check that only counts elements.
  cap: capOf(d), photo: heroOf(d.slug) || d.image_url || null,
  ...lockupOf(d),
  soon: soonOf(d.draw_date),
  closesChip: soonOf(d.draw_date) ? closesLabel(d.draw_date) : null,
  // The press stamp only renders on a claim that is true today.
  stampWord: todayOf(d.draw_date) ? "CLOSES TODAY" : null,
  band: drawBand(d),
  slug: d.slug,
}));

const slides = [coverSlide, countSlide, ...drawSlides, { type: "closing", stamp, band: deckBand }];

// ONE facts table, derived from the selection rather than from the render slides. The slides
// carry what the FRAME needs and nothing else; the caption, the briefing and the alt text need
// the draw's own data. Deriving the second from the first is how the caption silently lost
// every ticket price and the briefing filled its table with "?" — both read as working output,
// which is the worst kind of broken.
//
// It also covers all N draws in selection order. The render slides cannot: slide 2 pulls the
// lowest-cap draw out of sequence, so a list built from drawSlides is one draw short.
const facts = sel.draws.map((d, i) => ({
  n: i + 1,
  slug: d.slug,
  title: cleanTitle(d.grand_prize || d.title),
  price: priceLabel(d.ticket_price),
  cap: capOf(d),
  odds: capOf(d) ? `1 IN ${capOf(d).toLocaleString("en-GB")}` : null,
  closes: closesLabel(d.draw_date),
  cashAlt: cashAlt(d.grand_prize, d.prize_description),
  operator: d.operators?.name || null,
}));
const missing = drawSlides.filter((s) => !s.photo);
if (missing.length) console.log(`  \u26a0 ${missing.length} draw slide(s) have no photograph: ${missing.map((s) => s.slug).join(", ")}`);

console.log(`Category: ${sel.slug}  |  scene: ${sceneFor(sel.slug).title}  |  ${slides.length} slides (${N} draws)`);
const pngs = await renderSlides(slides, sel.slug, { browser });
await browser.close();
const outDir = `${DIR}/out`;
await mkdir(outDir, { recursive: true });
const slideName = (i) => i === 0 ? "cover" : i === 1 ? "count" : i === slides.length - 1 ? "closing" : drawSlides[i - 2].slug.slice(0, 40);
for (let i = 0; i < pngs.length; i++) await Bun.write(`${outDir}/${String(i + 1).padStart(2, "0")}-${slideName(i)}.png`, pngs[i]);
await Bun.write(`${outDir}/alt.json`, JSON.stringify(altTexts(sel, facts), null, 2));
// One row per asset considered, so the accept/reject decisions are reviewable rather than
// buried in a log line. This is the operator-facing half of §9.
await Bun.write(`${outDir}/images.json`, JSON.stringify(sheet, null, 2));

let recentOpeners = [];
try { recentOpeners = (await recentPosts(14)).map((r) => (r.caption || "").split("\n")[0]).filter(Boolean); } catch {}
const caption = buildCaption(sel.name, sel.slug, facts, sel.seoKeyword);
await Bun.write(`${outDir}/CAPTION_FALLBACK.txt`, caption);
await Bun.write(`${outDir}/BRIEFING.md`, buildBriefing({ sel, drawSlides: facts, recentOpeners }));
console.log("\n--- FALLBACK CAPTION (written to CAPTION_FALLBACK.txt; Claude: write CAPTION.txt + FB_CAPTION.txt from BRIEFING.md) ---\n" + caption);
console.log(`\nWrote ${pngs.length} slides → ${outDir}`);
