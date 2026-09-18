// carousel/scene-ink.mjs — MEASURE what each scene actually paints.
//
//   bun carousel/scene-ink.mjs              (table to stdout)
//   bun carousel/scene-ink.mjs --json       (machine-readable, for the gates)
//
// WHY MEASURED RATHER THAN DERIVED
// The design document derives every per-scene ink figure from geometry: count the strokes,
// multiply by lengths and alphas, divide by the lane area. That is fine as an estimate and it is
// how the figures were first produced — but it drifted. The lane moved three times (h 272 -> 285
// -> 346) and each move invalidated every figure computed against the previous denominator,
// which is why they were marked stale rather than rescaled: a taller lane lengthens every
// vertical stroke, so the ink moves WITH the denominator and no rescale is correct.
//
// Now that the scenes are implemented, the honest number is the one the renderer produces. This
// reads real pixels out of a real render, so it cannot drift from what ships: change a scene and
// re-run it.
//
// TWO FIGURES PER SCENE PER LANE
//   geometric — the share of pixels the scene TOUCHES at all.
//   weighted  — the same, weighted by how HARD it touches them: mean |delta| over the whole lane
//               as a share of full black. THIS is the figure the 6% ceiling is about, and
//               conflating it with the geometric one is an easy mistake to make — a mown-stripe
//               field touches HALF its lane geometrically and is nowhere near the ceiling,
//               because it touches it at 5% ink.
//   tone      — mean |delta L*| across the lane: how much darker it reads, perceptually.
import { chromium } from "playwright";
import { tokenCss } from "./tokens.mjs";
import { sceneFor, ALL_SCENE_IDS, LANES } from "./scene.mjs";

const LANE_C = LANES["reel-9x16"][1];   // the insert card: the only animated lane
const LANE_R = LANES["reel-9x16"][0];   // the brand rail: static on every surface

const MEASURE = `
({ html, w, h, ground }) => {
  const host = document.getElementById("host");
  host.style.width = w + "px"; host.style.height = h + "px"; host.style.background = ground;
  host.innerHTML = html;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return { w, h };
}`;

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const Lstar = (r, g, b) => {
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

async function inkOf(page, scene, lane) {
  // The scene is rendered ALONE on its lane's bare ground, at dpr 1, with no chrome and no
  // photograph — so what is measured is the scene and nothing else.
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${tokenCss()}</style>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${lane.w}px;height:${lane.h}px}
.sc-box{position:absolute;overflow:hidden}.sc-svg{display:block;position:absolute;left:0;top:0}</style>
</head><body><div id="box" style="position:absolute;left:0;top:0;width:${lane.w}px;height:${lane.h}px;
  background:${lane.ground === "rail" ? "var(--rail)" : "var(--ground)"}">${
    scene.back({ ...lane, x: lane.x, y: lane.y, variant: null, index: 0 })
  }</div></body></html>`;
  await page.setViewportSize({ width: lane.w, height: lane.h });
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
  const withScene = await page.screenshot({ type: "png", animations: "disabled" });

  // The same lane with the scene removed, so the comparison is against the ground this scene
  // actually sits on rather than against an assumed hex.
  await page.setContent(html.replace(/>\s*<svg[\s\S]*<\/svg>\s*</, "><"), { waitUntil: "domcontentloaded", timeout: 30000 });
  const bare = await page.screenshot({ type: "png", animations: "disabled" });

  const px = async (buf) => page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    return Array.from(x.getImageData(0, 0, img.width, img.height).data);
  }, buf.toString("base64"));

  const a = await px(withScene), b = await px(bare);
  let differing = 0, toneSum = 0, weightSum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
    if (dr + dg + db > 2) differing++;                      // 2/765: below this is PNG rounding
    weightSum += (dr + dg + db) / 3;
    toneSum += Math.abs(Lstar(a[i], a[i + 1], a[i + 2]) - Lstar(b[i], b[i + 1], b[i + 2]));
  }
  return {
    geometric: (differing / n) * 100,
    weighted: (weightSum / n / 255) * 100,
    tone: toneSum / n, pixels: n, inkPx: differing,
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const rows = [];
for (const id of ALL_SCENE_IDS) {
  const scene = sceneFor(id);
  const c = await inkOf(page, scene, LANE_C);
  const r = await inkOf(page, scene, LANE_R);
  rows.push({ id, title: scene.title, laneC: c, laneR: r,
    loopMs: scene.loopMs, amplitudeClass: scene.amplitudeClass, amplitudePx: scene.amplitudePx });
}
await browser.close();

// The two ceilings the gates enforce. Both are per-lane, both measured here rather than assumed.
const WEIGHTED_CEILING = 6.0;   // % of full black averaged over the lane — the real ceiling
const TONE_CEILING = 10.0;      // mean |delta L*| across the lane

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    laneC: { ...LANE_C, area: LANE_C.w * LANE_C.h },
    laneR: { ...LANE_R, area: LANE_R.w * LANE_R.h },
    ceilings: { weighted: WEIGHTED_CEILING, tone: TONE_CEILING },
    scenes: rows,
  }, null, 2));
} else {
  console.log(`Lane C (insert card) ${LANE_C.w}x${LANE_C.h} = ${(LANE_C.w * LANE_C.h).toLocaleString("en-GB")} px${"²"}, newsprint`);
  console.log(`Lane R (brand rail)  ${LANE_R.w}x${LANE_R.h} = ${(LANE_R.w * LANE_R.h).toLocaleString("en-GB")} px${"²"}, rail blue\n`);
  console.log("scene              title                   LANE C: geom  weighted   tone     LANE R: geom  weighted   motion");
  console.log("-".repeat(114));
  const sorted = [...rows].sort((x, y) => y.laneC.weighted - x.laneC.weighted);
  for (const r of sorted) {
    const over = r.laneC.weighted > WEIGHTED_CEILING || r.laneC.tone > TONE_CEILING;
    console.log(
      `${r.id.padEnd(18)} ${r.title.padEnd(23)} `
      + `${r.laneC.geometric.toFixed(2).padStart(6)}%  ${r.laneC.weighted.toFixed(3).padStart(7)}%  ${r.laneC.tone.toFixed(3).padStart(6)}  `
      + `${r.laneR.geometric.toFixed(2).padStart(12)}%  ${r.laneR.weighted.toFixed(3).padStart(7)}%  `
      + `${r.loopMs ? `${r.loopMs}ms ${r.amplitudeClass} ${r.amplitudePx}px` : "static"}${over ? "   OVER" : ""}`);
  }
  const over = rows.filter((r) => r.laneC.weighted > WEIGHTED_CEILING || r.laneC.tone > TONE_CEILING);
  console.log(`\nceilings: weighted ink ${WEIGHTED_CEILING}% of full black, tone ${TONE_CEILING} mean absolute delta-L*`);
  console.log("geometric coverage is reported but NOT gated: a stripe field touches half its lane by design");
  console.log(over.length ? `\n${over.length} scene(s) OVER: ${over.map((r) => r.id).join(", ")}` : "\nall 8 scenes inside both ceilings");
}
