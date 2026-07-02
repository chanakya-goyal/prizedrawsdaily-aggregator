// carousel/preview-sheet.mjs — one real slide per theme → single approval sheet.
// Run: bun carousel/preview-sheet.mjs   → ~/Desktop/pdd-theme-preview.png
// NOTE: each theme renders in an ISOLATED subprocess (self-exec via PREVIEW_ONE).
// Re-entering renderSlides() twice in one Bun process trips a Bun v1.3.14+Playwright
// quirk: the second chromium.launch()'s devtools pipe dies instantly and launch times
// out. Production is unaffected (build.mjs calls renderSlides once per process); this
// mirrors the isolated-subprocess pattern build.mjs already uses for freehero.mjs.
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { renderSlides } from "./render.mjs";
import { catCfg, themeOf } from "./config.mjs";

const SAMPLES = {
  "car-draws":      { type: "draw", n: 1, title: "BMW M340d Touring", price: "99p", cashAlt: "£30,000 TAX-FREE CASH", closes: "CLOSES TONIGHT", odds: "1 IN 4,999" },
  "tech-giveaways": { type: "draw", n: 2, title: "iPhone 17 Pro Max", price: "£1.49", cashAlt: "£950 TAX-FREE CASH", closes: "CLOSES TOMORROW (WED)", odds: "1 IN 2,500" },
  "luxury":         { type: "draw", n: 3, title: "Rolex GMT Batman", price: "£4.97", cashAlt: "£16,000 TAX-FREE CASH", closes: "CLOSES FRI 10 JUL", odds: "1 IN 799" },
  "cash-prizes":    { type: "draw", n: 4, title: "£10,000 Tax-Free Cash", price: "50p", closes: "CLOSES TONIGHT", odds: "1 IN 9,999" },
  "house-draws":    { type: "draw", n: 5, title: "4-Bed Cheshire Home", price: "£2", cashAlt: "£500,000 TAX-FREE CASH", closes: "CLOSES SUN 12 JUL" },
  "collectibles":   { type: "draw", n: 6, title: "Pokemon 151 UPC", price: "3p", closes: "CLOSES TOMORROW (WED)", odds: "1 IN 1,200" },
};

// child mode: render ONE theme (single renderSlides call per process) and exit
if (process.env.PREVIEW_ONE) {
  const slug = process.env.PREVIEW_ONE;
  const [png] = await renderSlides([SAMPLES[slug]], themeOf(slug), catCfg(slug).particles);
  await Bun.write(process.env.PREVIEW_OUT, png);
  process.exit(0);
}

const shots = [];
for (const slug of Object.keys(SAMPLES)) {
  const file = `${tmpdir()}/pdd-preview-${slug}.png`;
  const proc = Bun.spawn(["bun", import.meta.path], {
    env: { ...process.env, PREVIEW_ONE: slug, PREVIEW_OUT: file },
    stdout: "inherit", stderr: "inherit",
  });
  if ((await proc.exited) !== 0) throw new Error(`preview render failed for ${slug} — see error above (hard render gate?)`);
  const png = Buffer.from(await Bun.file(file).arrayBuffer());
  shots.push({ slug, b64: png.toString("base64") });
  console.log(`✓ rendered ${slug} (${themeOf(slug)})`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 3300, height: 1450 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:10px;padding:10px">
  ${shots.map((s) => `<div style="text-align:center;color:#fff;font:700 20px sans-serif">
    <img src="data:image/png;base64,${s.b64}" style="width:520px;display:block;margin-bottom:6px">${s.slug}</div>`).join("")}
</body>`);
const out = `${process.env.HOME}/Desktop/pdd-theme-preview.png`;
await Bun.write(out, await page.screenshot({ type: "png", fullPage: true }));
await browser.close();
console.log(`\nPreview sheet → ${out}`);
