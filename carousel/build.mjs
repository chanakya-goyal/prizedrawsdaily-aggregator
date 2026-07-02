// BUILD step: render the full carousel from today's selection + prize photos.
// Photo source per draw (priority): (1) a photo YOU dropped in ~/Desktop/pdd-today/
// (named 1–5 or by slug), (2) the auto-fetched photo from the draw's page
// (.fetched/{slug}/pick.txt — set by fetchimg.mjs, QA'd by Claude), (3) typographic card.
// Run: bun run carousel/build.mjs   (after plan.mjs + fetchimg.mjs)
import { renderSlides } from "./render.mjs";
import { buildCaption } from "./caption.mjs";
import { toDrawSlide, catLabel, hookLabel, priceLabel } from "./format.mjs";
import { readdir, mkdir } from "node:fs/promises";
import { workDir, themeOf, catCfg } from "./config.mjs";

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
  if (auto) { srcPath[d.slug] = auto; srcKind[d.slug] = "auto-fetched"; }
}
const haveSlugs = sel.draws.filter((d) => srcPath[d.slug]).map((d) => d.slug);
console.log(`Card style: ${CARD}  |  Photos: ${haveSlugs.length}/${sel.draws.length}`);
sel.draws.forEach((d, i) => console.log(`  ${i + 1}. ${d.slug.slice(0, 44).padEnd(46)} ${srcKind[d.slug] || "— typographic card"}`));

const photoData = {};
for (const s of haveSlugs) photoData[s] = await toDataUrl(srcPath[s]);

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

// per-draw hero image for the chosen mode
const heroOf = (slug) => CARD === "cutout" ? cutBySlug[slug] : photoData[slug];
const drawSlides = sel.draws.map((d, i) => {
  const s = toDrawSlide(d, i + 1);
  const img = heroOf(d.slug);
  if (img) {
    if (CARD === "cutout") s.cutoutDataUrl = img;
    else {
      s.framePhoto = img;
      // operator/auto-fetched shots → contain (never crop the prize); our generated
      // heroes are framed with margin, so cover fills the card cleanly.
      s.framePhotoContain = srcKind[d.slug] === "auto-fetched";
    }
  }
  return s;
});
// intro hero card: banner, big category hook, cheapest-ticket hook, thumbnail strip,
// a faded backdrop of the top prize, and a smart closing line.
const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).toUpperCase();
const dates = sel.draws.map((d) => d.draw_date).filter(Boolean).sort();
const allSame = dates.length && fmtDay(dates[0]) === fmtDay(dates[dates.length - 1]);
const endLine = !dates.length ? "ENDING THIS WEEK"
  : allSame ? `ENDING THIS WEEK · CLOSING ${fmtDay(dates[0])}`
  : `ENDING THIS WEEK · FIRST CLOSES ${fmtDay(dates[0])}`;
const prices = sel.draws.map((d) => Number(d.ticket_price)).filter((p) => isFinite(p) && p > 0);
const from = prices.length ? `FROM JUST ${priceLabel(Math.min(...prices))} A TICKET` : "";
// cheapest ticket as the gold "FROM JUST __" hero (true, irresistible: dream prize / tiny entry)
const fromAmount = prices.length ? priceLabel(Math.min(...prices)) : "";
// total prize value → supporting hook, rounded DOWN to nearest £1,000 so we never overstate
const totalValue = sel.draws.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
const value = totalValue >= 1000
  ? `£${(Math.floor(totalValue / 1000) * 1000).toLocaleString("en-GB")}+`
  : "";
const introImgs = sel.draws.map((d) => heroOf(d.slug) || null);
const intro = {
  type: "intro",
  banner: `${sel.draws.length} ${catLabel(sel.name)} DRAWS`,
  hook: hookLabel(sel.slug, sel.name),
  value,
  fromAmount,
  count: sel.draws.length,
  from,
  endLine,
  bg: introImgs.find(Boolean) || null,
  thumbs: introImgs,
  thumbMode: CARD,
};
const slides = [intro, ...drawSlides, { type: "cta" }];

// per-category visual identity (CSS theme tokens live in styles.css [data-theme=…]).
// default/unmapped → the fiery orange look.
const theme = themeOf(sel.slug);
console.log(`Theme: ${theme}`);
const pngs = await renderSlides(slides, theme, catCfg(sel.slug).particles);
const outDir = `${DIR}/out`;
await mkdir(outDir, { recursive: true });
const slideName = (i) => i === 0 ? "intro" : i === slides.length - 1 ? "cta" : sel.draws[i - 1].slug.slice(0, 40);
for (let i = 0; i < pngs.length; i++) await Bun.write(`${outDir}/${String(i + 1).padStart(2, "0")}-${slideName(i)}.png`, pngs[i]);

const caption = buildCaption(sel.name, sel.slug, drawSlides.map((s) => ({ title: s.title, price: s.price })));
await Bun.write(`${outDir}/CAPTION.txt`, caption);
console.log("\n--- CAPTION ---\n" + caption);
console.log(`\nWrote ${pngs.length} slides → ${outDir}`);
