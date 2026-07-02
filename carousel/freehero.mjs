// FREE background removal — runs @imgly/background-removal in Playwright Chromium
// (no npm install, no API key, no billing). Cuts the product out and floats it on
// the dark template. Caveat: removes the BACKGROUND only; text/logos baked into a
// flat marketing collage are not erased (so the user uploads clean product photos).
//
// IMPORTANT — process isolation: the @imgly model loads a large WASM blob that leaves
// the Bun+Chromium process in a state where a *subsequent* second browser's setContent
// hangs (reproduced: 60s timeout). So this module is also runnable as a STANDALONE CLI
// that writes cutout PNGs to disk and exits, giving the renderer a clean process.
//   bun carousel/freehero.mjs <manifest.json>
//   manifest = { "outDir": "...", "items": [ { "slug": "...", "src": "<path|dataURL|url>" } ] }
//   → writes {outDir}/{slug}.png per success, prints JSON { slug: true|false } to stdout.
import { chromium } from "playwright";

const proxied = (url, w = 1024) =>
  `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&output=png&we`;

// Downscale + bg-remove inside the page. maxW caps the cutout so embedded data URLs
// stay light (full-res 1920px ≈ 2MB → 1080px ≈ 0.8MB) without losing crispness at 1080×1350.
async function removeInPage(page, srcUrl, maxW = 1080) {
  return await page.evaluate(async ({ src, maxW }) => {
    const mod = await import("https://esm.sh/@imgly/background-removal@1.5.7");
    const blob = await mod.removeBackground(src, { output: { format: "image/png" } });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return c.toDataURL("image/png");
  }, { src: srcUrl, maxW });
}

// Returns an array of transparent-PNG data URLs (or null) aligned to imageUrls.
export async function makeCutouts(imageUrls) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // a real https origin so cross-origin module + model-asset fetches are allowed
  await page.goto("https://prizedrawsdaily.co.uk/", { waitUntil: "domcontentloaded" }).catch(() => {});
  const out = [];
  for (const url of imageUrls) {
    const t = Date.now();
    try {
      const src = url.startsWith("data:") ? url : proxied(url, 1024); // local clean uploads pass through as-is
      out.push(await removeInPage(page, src));
      console.log(`    ✓ cutout in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error("    ✗ cutout failed:", String(e.message || e).slice(0, 160));
      out.push(null);
    }
  }
  await browser.close();
  return out;
}

// ---- standalone CLI (process isolation) ----
if (import.meta.main) {
  const manifestPath = process.argv[2];
  if (!manifestPath) { console.error("usage: bun freehero.mjs <manifest.json>"); process.exit(1); }
  const { outDir, items } = JSON.parse(await Bun.file(manifestPath).text());
  const srcs = items.map((it) => it.src);
  const cuts = await makeCutouts(srcs);
  const result = {};
  for (let i = 0; i < items.length; i++) {
    const { slug } = items[i];
    if (cuts[i]) {
      const buf = Buffer.from(cuts[i].split(",")[1], "base64");
      await Bun.write(`${outDir}/${slug}.png`, buf);
      result[slug] = true;
    } else {
      result[slug] = false;
    }
  }
  // machine-readable result on the last line
  console.log("RESULT " + JSON.stringify(result));
}
