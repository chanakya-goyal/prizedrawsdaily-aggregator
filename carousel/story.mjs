// The 9:16 Story — a STILL, not a video.
//
//   bun carousel/story.mjs            (reads selection.json, writes out/story.png)
//
// WHY A STILL
// A Story is delivered to existing followers with a 24-hour life. It is not in the Reels
// chaining system, so there is no length cohort and no watch-duration head ranking it, audio is
// not required, and the "majority text" demotion does not apply. The only thing motion bought
// here was cost: a twelve-second timeline, a frame loop, an ffmpeg encode and an audio mux, for
// a surface nobody scrubs. The scene lanes render at phase 0 and the whole thing is one PNG.
//
// WHY THE BANDS ARE ASSERTED RATHER THAN TRUSTED
// Meta's own 9:16 diagram gives a safe box of x 65..1015 by y 269..1152 — 883px of usable
// height. The five bands sum to 863px plus four 5px gutters, which is 883 EXACTLY, with no
// slack anywhere except the 5px inside band 4. A table that closes exactly is a table that
// breaks silently when one height changes, so the renderer checks the sum and the chain before
// it draws, in the style of assertVideoContract.
import { chromium } from "playwright";
import { fontFaceCss } from "./fonts.mjs";
import { tokenCss } from "./tokens.mjs";
import { sceneFor, sceneBack } from "./scene.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import { cleanTitle, closesLabel, priceLabel } from "./format.mjs";
import { workDir } from "./config.mjs";
import { mkdir } from "node:fs/promises";

const FONT_CSS = await fontFaceCss();
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Meta's Derived Safe Box A, edge-detected from their own diagram.
export const SAFE = { x: 65, y: 269, w: 950, h: 883 };
// The L-notch: the reply composer and the tap targets over it. A GROUND may pass under it —
// the lower rail band does — but no glyph and no data may.
export const L_NOTCH = { x: 853, y: 1152, w: 227, h: 768 };

// Band heights are the normative table. Positions are derived from them, never typed, so the
// chain cannot drift out of step with the heights.
export const BANDS = [
  { id: "dateline",   h: 55,  note: "the run-level read-at stamp" },
  { id: "prize",      h: 145, note: "cleanTitle output, max 2 lines, carries the CAP 8.17 prize name" },
  { id: "photo",      h: 273, note: "normalised operator photo, full 950 width" },
  { id: "odds",       h: 245, note: "E2 consumed whole at 240px, plus 5px of slack" },
  { id: "conditions", h: 145, note: "the conditions band" },
];
export const GUTTER = 5;

export function bandRects() {
  let y = SAFE.y;
  const out = {};
  BANDS.forEach((b, i) => {
    out[b.id] = { y, h: b.h, bottom: y + b.h };
    y += b.h + (i < BANDS.length - 1 ? GUTTER : 0);
  });
  out.__end = y;
  return out;
}

// The assertion, exported so a test can run it without a browser.
export function assertBands() {
  const sum = BANDS.reduce((a, b) => a + b.h, 0);
  const total = sum + (BANDS.length - 1) * GUTTER;
  const r = bandRects();
  const problems = [];
  if (total !== SAFE.h) problems.push(`bands sum to ${sum} + ${(BANDS.length - 1) * GUTTER} gutters = ${total}, not the ${SAFE.h}px safe box`);
  if (r.__end !== SAFE.y + SAFE.h) problems.push(`band chain ends at y ${r.__end}, not ${SAFE.y + SAFE.h}`);
  for (const b of BANDS) {
    const rr = r[b.id];
    if (rr.y < SAFE.y || rr.bottom > SAFE.y + SAFE.h) problems.push(`band ${b.id} (y ${rr.y}..${rr.bottom}) leaves the safe box`);
    // A band spans the full 950px track, so it reaches x 1015. The L-notch starts at y 1152,
    // which is the safe box's bottom edge, so no band may extend past it.
    if (rr.bottom > L_NOTCH.y) problems.push(`band ${b.id} reaches y ${rr.bottom}, inside the L-notch keep-out at y ${L_NOTCH.y}`);
  }
  return problems;
}

// Bricolage Grotesque 800 advances 0.6573em, measured from the bundled woff2. Two lines
// maximum at either step; a title that will not set at 56 is truncated at a word boundary
// rather than refused — a Story is one draw, and refusing it means no Story at all.
export function fitPrize(title) {
  const len = String(title || "").length;
  for (const [px, lh] of [[68, 70], [56, 60]]) {
    if (Math.ceil(len / Math.floor(SAFE.w / (px * 0.6573))) <= 2) return { px, lh, text: title };
  }
  const per = Math.floor(SAFE.w / (56 * 0.6573));
  const cut = String(title).slice(0, per * 2 - 1);
  const sp = cut.lastIndexOf(" ");
  return { px: 56, lh: 60, text: (sp > per ? cut.slice(0, sp) : cut) + "…", truncated: true };
}

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px}
body{background:var(--ground);color:var(--ink);font-family:var(--font-text),system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.frame{position:relative;width:1080px;height:1920px;overflow:hidden}
/* The two rail bands. They are FULL BLEED and they are grounds, which is what lets the lower
   one pass under the L-notch where a glyph may not. */
.rail{position:absolute;left:0;width:1080px;background:var(--rail)}
.rail-top{top:0;height:269px}
.rail-bot{top:1152px;height:768px}
.wordmark{position:absolute;left:65px;top:96px;font-family:var(--font-chrome);font-weight:700;
  font-size:var(--fs-label);letter-spacing:var(--tr-label);color:var(--rail-ink);text-transform:uppercase;line-height:1}
.band{position:absolute;left:65px;width:950px}
.dateline{font-family:var(--font-figure);font-weight:700;font-size:var(--fs-label);
  line-height:50px;color:var(--ink);letter-spacing:.01em;white-space:nowrap}
.prize{font-family:var(--font-display);font-weight:800;letter-spacing:var(--tr-display);
  color:var(--ink);text-transform:uppercase}
/* COVER here, not contain -- and this is the one place in the system where that is right.
   The band is 950x273, a 3.48:1 letterbox, and the spec is explicit that it IS a crop. At
   'contain' a square operator asset renders 273px wide: 29% of the band, a stamp floating in
   white. A full-width horizontal slice of a motorbike is recognisable; a tiny square of one is
   not. The carousel keeps 'contain' because its well is 1.65:1 and can hold a whole product.
   (No backticks in here: this comment lives inside a JS template literal.) */
.photo{background:var(--surface);overflow:hidden;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline)}
.photo img{width:100%;height:100%;object-fit:cover;object-position:center;display:block}
.eyebrow{font-weight:600;font-size:var(--fs-label);line-height:var(--lh-label);height:50px;
  letter-spacing:var(--tr-label);text-transform:uppercase;color:var(--ink-meta)}
.figure{font-family:var(--font-figure);font-weight:700;font-size:var(--fs-figure);
  line-height:var(--lh-figure);height:120px;color:var(--ink);font-variant-numeric:tabular-nums}
.cond{font-weight:600;font-size:var(--fs-label);line-height:var(--lh-label);height:50px;color:var(--ink)}
/* The conditions band carries its OWN rail ground, flush with the lower rail band below it, so
   the two read as one continuous block. It has to: the band's type is specified as #F7F5F0 on
   #14385F, and the band sits at y 1007..1152 which is ABOVE the lower rail — so without its own
   ground the light type landed on cream paper and L2 and L3 were all but invisible. */
.conditions{display:flex;flex-direction:column;justify-content:center;
  background:var(--rail);left:0;width:1080px;padding:0 65px}
.conditions .l{font-size:var(--fs-legal);line-height:var(--lh-legal);white-space:nowrap}
.conditions .l1{font-weight:600;color:var(--rail-ink);text-transform:uppercase}
.conditions .l1.soon{color:var(--closing)}
.conditions .l2,.conditions .l3{font-weight:400;color:var(--rail-meta)}
.handle{position:absolute;left:65px;top:1330px;font-family:var(--font-figure);font-weight:700;
  font-size:var(--fs-title);line-height:1;color:var(--rail-accent)}
.sub{position:absolute;left:65px;top:1420px;width:740px;font-weight:400;
  font-size:var(--fs-body);line-height:var(--lh-body);color:var(--rail-meta)}
.scene-host{position:absolute;inset:0;overflow:hidden;pointer-events:none}
`;

const READY = `
(async()=>{try{await document.fonts.ready}catch(e){}
const w=(i)=>(!i||i.complete)?null:new Promise(r=>{i.onload=r;i.onerror=r});
await Promise.all([...document.images].map(w).filter(Boolean));
try{await document.fonts.ready}catch(e){}
window.__ready=true})();`;

export function buildStoryHtml({ draw, hero, stamp, categorySlug = "" }) {
  if (!draw) throw new Error("buildStoryHtml: need a draw");
  const problems = assertBands();
  if (problems.length) throw new Error("story band table is inconsistent — refusing to render:\n  " + problems.join("\n  "));

  const r = bandRects();
  const cap = Number(draw.total_entries) || null;
  if (!cap) throw new Error(`story: draw "${draw.slug}" carries no ticket cap — the odds lockup cannot render`);
  const title = cleanTitle(draw.grand_prize || draw.title);
  const fit = fitPrize(title);
  const soon = (new Date(draw.draw_date) - Date.now()) < 48 * 3600e3;
  const host = (() => { try { return new URL(draw.entry_url).hostname.replace(/^www\./, ""); } catch { return "the operator's own site"; } })();
  const band = oddsCopy.bandLines({
    role: "story", closesText: closesLabel(draw.draw_date),
    price: priceLabel(draw.ticket_price) || "n/a", host, freeEntryRoute: draw.free_entry_route || "unknown",
  });
  const scene = sceneFor(categorySlug);

  const at = (id, extra = "") => `style="top:${r[id].y}px;height:${r[id].h}px;${extra}"`;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style><style>${tokenCss()}</style><style>${CSS}</style>
</head><body data-pdd-role="story">
<div class="frame">
  <div class="scene-host">${sceneBack(scene, "story-9x16", { draw })}</div>
  <div class="rail rail-top"></div>
  <div class="rail rail-bot"></div>
  <div class="wordmark">PRIZEDRAWSDAILY</div>

  <div class="band dateline" ${at("dateline")}>${esc(stamp || "")}</div>

  <div class="band prize" ${at("prize", `font-size:${fit.px}px;line-height:${fit.lh}px`)}
       data-pdd-claim="prize-name">${esc(fit.text)}</div>

  <div class="band photo" ${at("photo")}>${hero ? `<img src="${hero}">` : ""}</div>

  <div class="band" ${at("odds")}>
    <div class="eyebrow">${oddsCopy.eyebrow()}</div>
    <div style="height:10px"></div>
    <div class="figure">${oddsCopy.capFigure(cap)}</div>
    <div style="height:10px"></div>
    <div class="cond">${esc(oddsCopy.conditional(cap))}</div>
  </div>

  <div class="conditions" style="position:absolute;top:${r.conditions.y}px;height:${r.conditions.h}px">
    <div class="l l1${soon ? " soon" : ""}">${esc(band[0])}</div>
    <div class="l l2">${esc(band[1])}</div>
    <div class="l l3">${esc(band[2])}</div>
  </div>

  <div class="handle">@prizedrawsdaily</div>
  <div class="sub">${esc(oddsCopy.storySubLine())}</div>
</div>
<script>${READY}</script></body></html>`;
}

export async function renderStory(args, { browser: borrowed = null } = {}) {
  const browser = borrowed || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(buildStoryHtml(args), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 });
    // Same two gates the carousel runs, for the same reasons: an image that 404s paints the
    // well's own background and looks like a valid frame, and a band line that overflows its
    // track is a required condition leaving the frame.
    const checks = await page.evaluate(() => ({
      broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src),
      bandOver: [...document.querySelectorAll(".conditions .l, .dateline")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => `${Math.round(e.scrollWidth - e.clientWidth)}px over: ${e.textContent.slice(0, 56)}`),
      // Nothing carrying meaning may sit inside the L-notch.
      inNotch: [...document.querySelectorAll(".band, .wordmark, .handle, .sub")]
        .filter((e) => { const b = e.getBoundingClientRect(); return b.right > 853 && b.bottom > 1152; })
        .map((e) => e.className),
    }));
    if (checks.broken.length) throw new Error(`story: ${checks.broken.length} image(s) failed to decode — refusing to ship a degraded frame`);
    if (checks.bandOver.length) throw new Error(`story: text overflows its 950px track — refusing to ship a degraded frame\n  ${checks.bandOver.join("\n  ")}`);
    if (checks.inNotch.length) throw new Error(`story: ${checks.inNotch.join(", ")} sits inside the L-notch keep-out — refusing to ship a degraded frame`);
    return await page.screenshot({ type: "png", timeout: 60000, animations: "disabled" });
  } finally {
    await page.close().catch(() => {});
    if (!borrowed) await browser.close();
  }
}

// ---------------------------------------------------------------- CLI
if (import.meta.main) {
  const DIR = workDir();
  const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
  // One draw, the soonest-closing. Ties keep the original order.
  const draw = sel.draws.reduce((a, b) => (new Date(a.draw_date) <= new Date(b.draw_date) ? a : b));
  const facts = await Bun.file(`${DIR}/out/facts.json`).json().catch(() => null);
  const checked = sel.draws.map((d) => d.figures_checked_at).filter(Boolean).sort();
  const stamp = checked.length
    ? oddsCopy.stampLong(
        new Date(checked[0]).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }),
        new Date(checked[0]).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).toUpperCase())
    : null;
  if (!stamp) console.error("⚠ no figures_checked_at on any draw — the Story's dateline band will be empty");
  const png = await renderStory({ draw, hero: draw.image_url, stamp, categorySlug: sel.slug });
  await mkdir(`${DIR}/out`, { recursive: true });
  await Bun.write(`${DIR}/out/story.png`, png);
  console.log(`✓ story.png → ${(png.length / 1024).toFixed(0)}KB  (${draw.slug.slice(0, 44)}, closes ${closesLabel(draw.draw_date)})`);
  if (facts) console.log(`  cap ${oddsCopy.capFigure(draw.total_entries)} · ${BANDS.length} bands, ${SAFE.h}px, all inside Box A`);
}
