// carousel/preview-sheet.mjs — one slide per CATEGORY SCENE, on one approval sheet.
//
//   bun carousel/preview-sheet.mjs        -> ~/Desktop/pdd-scene-preview.png
//
// WHAT CHANGED
// This used to render one slide per THEME, and themes are gone: the newsprint system has a
// single palette, and what varies per category is STRUCTURE — the scene. So the sheet now shows
// all eight scenes at once, which is the thing actually worth eyeballing, since the scenes are
// the one part of the design that no single production run can show you (a build renders one
// category a day).
//
// Each scene renders in an ISOLATED SUBPROCESS. Launching chromium a second time in one Bun
// process hangs — the same issue that made the whole build hang once normalisation was added
// ahead of rendering — so the parent forks itself per scene rather than looping.
import { chromium } from "playwright";
import { renderSlides } from "./render.mjs";
import { ALL_SCENE_IDS, sceneFor } from "./scene.mjs";
import { catCfg } from "./config.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import { mkdir, rm } from "node:fs/promises";

const OUT = `${process.env.HOME}/Desktop/pdd-scene-preview.png`;
const TMP = "/tmp/pdd-scene-preview";
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// A representative draw per category, so each scene is judged against copy of a realistic
// length rather than lorem. Caps are real orders of magnitude for each category.
const SAMPLE = {
  "car-draws":       { title: "BMW M3 Competition",           cap: 1399999, price: "9p" },
  "cash-prizes":     { title: "£10,000 Tax-Free Cash",         cap: 36999,   price: "79p" },
  "house-draws":     { title: "Four-Bed Cotswolds Cottage",    cap: 250000,  price: "£2" },
  "tech-giveaways":  { title: "MacBook Pro 16in M5 Max",       cap: 9999,    price: "£1.99" },
  "luxury":          { title: "Rolex Submariner Hulk",         cap: 1680,    price: "£10" },
  "collectibles":    { title: "LEGO Lamborghini Countach",     cap: 99,      price: "£3.33" },
  "sports-outdoors": { title: "Shot Scope LM1 Launch Monitor", cap: 2499,    price: "20p" },
  "home-garden":     { title: "Ooni Karu 16 Pizza Oven",       cap: 1499,    price: "£1.49" },
};

function slideFor(slug) {
  const s = SAMPLE[slug];
  return {
    type: "draw", stamp: oddsCopy.stampShort("09:04"), n: 3, total: 10,
    title: s.title, cap: s.cap, photo: PIXEL,
    operator: catCfg(slug).name, rating: "4.2", soon: false,
    band: oddsCopy.bandLines({
      role: "draw", closesText: "CLOSES SAT 20 SEP", price: s.price,
      host: "operator.co.uk", freeEntryRoute: "unknown",
    }),
  };
}

// ---- child: render exactly one scene, then exit (one chromium launch per process)
if (process.env.PREVIEW_ONE) {
  const slug = process.env.PREVIEW_ONE;
  const [png] = await renderSlides([slideFor(slug)], slug);
  await Bun.write(`${TMP}/${slug}.png`, png);
  process.exit(0);
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
for (const slug of ALL_SCENE_IDS) {
  const p = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, PREVIEW_ONE: slug }, stdout: "inherit", stderr: "inherit",
  });
  const code = await p.exited;
  if (code !== 0) { console.error(`✗ ${slug} failed (exit ${code})`); process.exit(1); }
  console.log(`✓ ${slug.padEnd(17)} ${sceneFor(slug).title}`);
}

// ---- composite, in the browser, because there is no image library in this project
const COLS = 4, TH = 460, TW = Math.round(TH * 1080 / 1350);
const imgs = await Promise.all(ALL_SCENE_IDS.map(async (slug) =>
  `data:image/png;base64,${Buffer.from(await Bun.file(`${TMP}/${slug}.png`).arrayBuffer()).toString("base64")}`));

const rows = Math.ceil(ALL_SCENE_IDS.length / COLS);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${COLS * (TW + 16) + 16}px;background:#fff;font:600 15px/1.3 -apple-system,system-ui,sans-serif;padding:16px}
.grid{display:grid;grid-template-columns:repeat(${COLS},${TW}px);gap:16px}
figure{margin:0}
img{width:${TW}px;height:${TH}px;display:block;border:1px solid #D8D3C8}
figcaption{padding:6px 2px 0;color:#14161A}
figcaption b{color:#14385F}
</style></head><body><div class="grid">
${ALL_SCENE_IDS.map((slug, i) => `<figure><img src="${imgs[i]}"><figcaption>${slug} — <b>${sceneFor(slug).title}</b><br><span style="color:#5A5F66;font-weight:400">${sceneFor(slug).loopMs ? `${sceneFor(slug).loopMs}ms loop · ${sceneFor(slug).amplitudeClass} ${sceneFor(slug).amplitudePx}px` : "static"}</span></figcaption></figure>`).join("\n")}
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: COLS * (TW + 16) + 16, height: rows * (TH + 48) + 32 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load", timeout: 60000 });
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log(`\n✓ ${ALL_SCENE_IDS.length} scenes → ${OUT}`);
