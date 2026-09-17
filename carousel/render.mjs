// Renders the 4:5 carousel to PNG buffers via Playwright.
// 1080x1350 at deviceScaleFactor 2 -> 2160x2700 output.
//
// WHAT CHANGED, AND WHY IT IS THE WHOLE POINT
// The old deck rendered the ticket cap as a trailing fragment: `<b>{closes}</b> · {odds}` at
// 33px, after the closing date, under a 98px prize name. The single most defensible fact PDD
// holds was the smallest type on the slide. That is a design flaw, a strategic flaw — the odds
// are the one thing an operator will not print — and a distribution risk, because Instagram's
// Recommendation Guidelines exclude content "largely repurposed from another source with only
// minor, immaterial edits, without adding material value". A daily post of other operators'
// photographs and prize data has to add something. The added thing is the number.
//
// So the cap is now the largest figure on the frame, and on the count slide it is drawn as one
// dot per ticket with exactly one marked.
import { chromium } from "playwright";
import { fontFaceCss } from "./fonts.mjs";
import { sceneFor, sceneCss, sceneBack, sceneMotion } from "./scene.mjs";
import * as C from "./odds-copy.mjs";

const CSS = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const FONT_CSS = await fontFaceCss();
const SCENE_CSS = sceneCss();

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Keep hyphenated model names (T-ROC, X-TRIBUTE) from breaking across lines.
const nbh = (s = "") => String(s).replace(/(\w)-(\w)/g, "$1‑$2");

// Readiness resolves on BOTH load and error, deliberately — a hung image must not stall the
// render forever. The consequence is that "ready" does not mean "painted", so the decoded width
// of every image is asserted separately below. Without that second check a failed fetch renders
// a blank white well and ships, which is exactly what happened on the first live deck: eight
// draw slides, every photograph missing, and nothing in the pipeline objected.
const READY_SCRIPT = `
(async () => {
  try { await document.fonts.ready; } catch (e) {}
  const wait = (im) => (!im || im.complete) ? null : new Promise(r => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  try { await document.fonts.ready; } catch (e) {}
  window.__ready = true;
})();
`;

// ---- type fitting ---------------------------------------------------------
// Bricolage Grotesque 800 advances 0.6573em, measured from the bundled woff2. The ladder is
// 88 -> 68 -> 56 and the prize name is capped at TWO lines: three lines at 56 would break the
// photo well's own floor. This replaces a binary at the old `length > 26`, which fired on
// roughly half of 880 live titles — a "long title" branch that was the common case.
const TRACK = 895;
// Vertical padding a vibe's odds block adds, top AND bottom. The stylesheet reads it back as
// --odds-pad, so there is exactly one number: the height the layout RESERVES and the height the
// CSS PAINTS cannot drift. The first version hardcoded it in both places, they disagreed, and
// the photo well overran the operator lockup by the difference — invisible in review, obvious
// on the render.
export const ODDS_PAD = { block: 28, loud: 28 };
const BRICOLAGE_ADV = 0.6573;
export function fitPrize(title, { maxLines = 2 } = {}) {
  const len = String(title || "").length;
  for (const px of [88, 68, 56]) {
    const perLine = Math.floor(TRACK / (px * BRICOLAGE_ADV));
    if (Math.ceil(len / perLine) <= maxLines) return { px, lh: px === 88 ? 90 : px === 68 ? 70 : 60 };
  }
  return { px: 56, lh: 60, clamp: maxLines };
}

// ---- the dot grid ---------------------------------------------------------
// One dot is one ticket, 60 to a row on a 15px pitch across the 895px band. Above 1,440 the
// grid stops being countable, so it CLIPS rather than getting denser, and the clipped state
// carries a mandatory correction row — a partial picture of a cap is otherwise an understated
// claim about the odds, which is the direction CAP 8.20 cares about.
function gridHtml(cap) {
  const shown = Math.min(cap, C.GRID_CEILING);
  const rows = Math.ceil(shown / C.GRID_COLS);
  // The marked dot's position is arbitrary and the legend says so. It is derived from the cap
  // so a given draw always renders identically, which is what lets the build assert a frozen
  // fixture; it is not a claim about which ticket wins.
  const hit = cap % shown;
  let s = "";
  for (let i = 0; i < shown; i++) s += `<i${i === hit ? ' class="hit"' : ""}></i>`;
  return { html: `<div class="grid">${s}</div>`, rows, shown, clipped: cap > C.GRID_CEILING };
}

// ---- standing chrome ------------------------------------------------------
// Present and identical on every slide, which is what makes each slide a valid cold entry
// point. Instagram gives a carousel a "second chance" from slide 2 when a viewer does not
// swipe, so slide 2 in particular has to stand on its own.
const masthead = (stamp, suppressStamp) =>
  `<div class="masthead"><span class="mh-a">PRIZEDRAWSDAILY</span>`
  + (suppressStamp || !stamp ? "" : `<span class="mh-b">${esc(stamp)}</span>`)
  + `</div>`;

// Three lines, 38px, on every asset. The ASA does not treat a social post as space-limited and
// "link in bio" discharges nothing, so every significant condition ships on the frame.
const bandHtml = (lines, soon) =>
  `<div class="band">`
  + `<div class="l l1${soon ? " soon" : ""}">${esc(lines[0])}</div>`
  + `<div class="l l2">${esc(lines[1])}</div>`
  + `<div class="l l3">${esc(lines[2])}</div></div>`;

// The swipe affordance and the counter are SIBLINGS, not nested: the counter is positioned
// against the slide, and the sheet strip is only 65px wide.
const sheetEdge = (n, total) =>
  `<div class="sheet"></div>` + (n ? `<div class="counter">${n}/${total}</div>` : "");

// §5.12 prize-title cleaning. Operator titles carry mechanic prefixes and instance numbers that
// are noise to a reader and cost real characters against the 895px track — "AUTO-DRAW: WIN A
// MOTOCADDY SE ELECTRIC TROLLEY #13" is 50 characters of which 15 say nothing about the prize,
// and those 15 are what push the name off the top of the type ladder.
export function cleanTitle(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^\s*(?:auto[\s-]*draw|instant\s*win|main\s*draw|competition|comp)\s*[:\u2013\u2014-]\s*/i, "");
  // Alternation is longest-first on purpose: `a` before `an` turns "Win an OGIO" into "n OGIO".
  t = t.replace(/^\s*win\s+(?:an|a|the)\s+/i, "").replace(/^\s*win\s+/i, "");
  t = t.replace(/\s*#\d+\s*$/, "");                           // operator instance number
  t = t.replace(/\s*[|\u2013\u2014-]\s*[^|\u2013\u2014-]*(?:competitions?|draws?|giveaways?)\s*$/i, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  // A result under three characters means the cleaner ate the prize rather than the noise
  // ("WIN A" -> "A"). Keep the original: a noisy title beats a meaningless one.
  return t.length >= 3 ? t : String(raw || "").trim();
}

const sceneHost = (scene, role) =>
  `<div class="scene-host">${sceneBack(scene, "still-4x5", { role })}</div>`;

// ---- slides ---------------------------------------------------------------

// Every cover headline is two sentences: the count, then the hook. The `loud` vibe lays amber
// behind the SECOND one, which is a meaningful split rather than a decorative one — "8 DRAWS."
// is the fact and "HOW MANY TICKETS?" is the thing being asked. Marked up as a gradient on the
// inline box so the amber follows the copy across line breaks instead of being a rectangle
// behind the whole block.
function headlineHtml(text, vibe) {
  const t = String(text || "");
  if (vibe !== "loud") return esc(t);
  const m = t.match(/^(.*?[.?!])\s+(.+)$/s);
  return m ? `${esc(m[1])} <em>${esc(m[2])}</em>` : `<em>${esc(t)}</em>`;
}

// The board's prize column fits roughly 21 glyphs of Inter 600 at 44px. CSS ellipsis cuts
// mid-word ("SHOT SCOPE LM1 L…"), which reads as a rendering fault; a word boundary reads as an
// abbreviation. The column keeps its CSS ellipsis as the backstop for one very long word.
const BOARD_GLYPHS = 21;
export function boardPrize(t) {
  const s = String(t || "").trim();
  if (s.length <= BOARD_GLYPHS) return s;
  const cut = s.slice(0, BOARD_GLYPHS);
  const sp = cut.lastIndexOf(" ");
  return (sp > 8 ? cut.slice(0, sp) : cut).replace(/[\s,.;:\-]+$/, "") + "\u2026";
}

function coverHtml(d, scene) {
  const board = (d.board || []).slice(0, 4).map((r, i) =>
    `<div class="row">`
    + `<span class="ix">${r.more ? "" : String(i + 1).padStart(2, "0")}</span>`
    + (r.more
      ? `<span class="pz more">${esc(r.more)}</span><span class="cl"></span>`
      : `<span class="pz">${esc(nbh(boardPrize(r.prize)))}</span><span class="cl${r.soon ? " soon" : ""}">${esc(r.closes)}</span>`)
    + `</div>`).join("");
  return `<div class="slide">
    ${sceneHost(scene, "cover")}
    ${masthead(d.stamp, true)}
    ${sheetEdge(0, 0)}
    <div class="dateline">${esc(d.dateline)}</div>
    <div class="headline">${headlineHtml(d.headline, d.vibe)}</div>
    <div class="proof">${d.proof.map((p) => `<div>${p}</div>`).join("")}</div>
    <div class="board">${board}</div>
    ${bandHtml(d.band)}
  </div>`;
}

function countHtml(d, scene) {
  const g = gridHtml(d.cap);
  // The count slide's prize name is FIXED at --fs-title 68/70, not stepped from the top of the
  // ladder. Its column is a fixed 675px vertical budget plus the band, and 140px is what that
  // budget reserves for the name; letting it step up to 88px spends 40px the band needs and
  // pushes the legend's last line through the conditions band. The draw slides step freely
  // because their photo well is the flex residual and can absorb the difference.
  const fit = { px: 68, lh: 70 };
  const legend = (g.clipped ? C.legendClipped(d.cap) : C.legendFull(d.cap))
    .map((l) => `<div>${esc(l)}</div>`).join("");
  return `<div class="slide">
    ${sceneHost(scene, "count")}
    ${masthead(d.stamp)}
    ${sheetEdge(d.n, d.total)}
    <div class="col">
      <div class="chip"><span>DRAW ${d.index} OF ${d.drawsRendered}</span></div>
      <div style="height:10px"></div>
      ${lockup(d)}
      <div style="height:10px"></div>
      <div class="prize" style="font-size:${fit.px}px;line-height:${fit.lh}px">${esc(nbh(d.title))}</div>
      <div style="height:20px"></div>
      <div class="eyebrow">${C.eyebrow()}</div>
      <div style="height:10px"></div>
      <div class="figure">${C.capFigure(d.cap)}</div>
      <div style="height:10px"></div>
      ${g.html}
      <div style="height:10px"></div>
      ${g.clipped ? `<div class="annot" style="width:895px">${esc(C.annotation(g.shown, d.cap))}</div><div style="height:10px"></div>` : ""}
      <div class="legend">${legend}</div>
    </div>
    ${bandHtml(d.band, d.soon)}
  </div>`;
}

// The Trust Score renders as ink on paper inside a rule border, NOT on the mint tint. It is
// PDD's own computed assessment, not a verified third-party fact, and green is reserved here
// for evidence — spending it on a self-issued rating devalues the signal.
const lockup = (d) =>
  `<div class="lockup"><span class="op">${esc(d.operator || "")}</span>`
  + (d.rating ? `<span class="ts">PDD ${esc(d.rating)}</span>` : "")
  + `</div>`;

function drawHtml(d, scene) {
  const fit = fitPrize(d.title);
  const lines = Math.ceil(String(d.title || "").length / Math.floor(TRACK / (fit.px * BRICOLAGE_ADV)));
  // The `block` vibe gives E2 its own full-bleed ground, which costs 52px of padding. That
  // comes out of the photo well rather than out of the column, because the well is the flex
  // residual and the column has none to give.
  // A vibe that gives E2 its own full-bleed ground costs vertical padding, and it comes out of
  // the photo well rather than the column: the well is the flex residual, the column has none.
  const pad = ODDS_PAD[d.vibe] || 0;
  const stackH = 45 + 10 + Math.min(lines, 2) * fit.lh + 20 + 240 + pad * 2;
  const photoH = Math.max(500, 1050 - stackH);                        // the flex residual, floored
  return `<div class="slide">
    ${sceneHost(scene, "draw")}
    <div class="photo" style="height:${photoH}px">
      ${d.photo ? `<img src="${d.photo}">` : ""}
      ${d.closesChip ? `<div class="closes-chip">${esc(d.closesChip)}</div>` : ""}
    </div>
    ${masthead(d.stamp)}
    ${sheetEdge(d.n, d.total)}
    ${d.vibe === "loud" && d.stampWord ? `<div class="stamp">${esc(d.stampWord)}</div>` : ""}
    <div class="stack">
      ${lockup(d)}
      <div style="height:10px"></div>
      <div class="prize" style="font-size:${fit.px}px;line-height:${fit.lh}px">${esc(nbh(d.title))}</div>
      <div style="height:20px"></div>
      <div class="oddsblock" style="--odds-pad:${pad}px">
        <div class="eyebrow">${C.eyebrow()}</div>
        <div style="height:10px"></div>
        <div class="figure">${C.capFigure(d.cap)}</div>
        <div style="height:10px"></div>
        <div class="cond">${esc(C.conditional(d.cap))}</div>
      </div>
    </div>
    ${bandHtml(d.band, d.soon)}
  </div>`;
}

// Not a call to action. A statement of what PDD is, which is the one thing that separates a
// directory from the operators it lists — and the only claim on the deck that is about us.
function closingHtml(d, scene) {
  return `<div class="slide">
    ${sceneHost(scene, "closing")}
    ${masthead(d.stamp)}
    <div class="closing">
      <div class="h">${esc(C.closingHeadline())}</div>
      <div class="s">${esc(C.closingSubLine())}</div>
      <div class="u">${esc(C.signOffStrapline())}</div>
    </div>
    ${bandHtml(d.band)}
  </div>`;
}

export function buildHtml(slide, categorySlug = "", vibe = "") {
  const scene = sceneFor(categorySlug);
  slide = vibe ? { ...slide, vibe } : slide;
  const body = slide.type === "cover" ? coverHtml(slide, scene)
    : slide.type === "count" ? countHtml(slide, scene)
    : slide.type === "closing" ? closingHtml(slide, scene)
    : drawHtml(slide, scene);
  // Scene tokens go on <body> as an inline style attribute, never as a :root or [data-theme]
  // block. An inline declaration resolves on the elements inside it, so no composite can ever
  // be evaluated against the wrong theme — the failure the old per-theme blocks invited.
  const tok = Object.entries(scene.tokens || {}).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>${CSS}</style>
<style>${SCENE_CSS}</style>
<style>${sceneMotion(scene, "still-4x5")}</style></head>
<body data-pdd-role="${slide.type}"${vibe ? ` data-vibe="${vibe}"` : ""}${tok ? ` style="${tok}"` : ""}>${body}<script>${READY_SCRIPT}</script></body></html>`;
}

export async function renderSlides(slides, categorySlug = "", vibe = "") {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
  const out = [];
  for (const s of slides) {
    await page.setContent(buildHtml(s, categorySlug, vibe), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(async () => {
      await browser.close();
      throw new Error(`render not ready (fonts/images failed) on slide type=${s.type} title=${s.title || ""} — refusing to ship a degraded slide`);
    });
    const checks = await page.evaluate(() => {
      // The column must close inside the well. An overflow here is a compliance failure rather
      // than a cosmetic one, because the thing pushed off the frame is the conditions band.
      const c = document.querySelector(".col, .stack, .closing");
      const over = c ? Math.max(0, 132 - c.getBoundingClientRect().top) : 0;
      // Every <img> must have actually decoded. A photograph that 404s or is rate-limited paints
      // the well's own white background and looks, to every automated check, like a valid slide.
      const broken = [...document.images]
        .filter((im) => !im.naturalWidth)
        .map((im) => im.currentSrc || im.src);
      return { over, broken };
    });
    if (checks.over > 0) {
      await browser.close();
      throw new Error(`slide column overflows the well by ${Math.round(checks.over)}px (type=${s.type} title=${s.title || ""}) — refusing to ship a degraded slide`);
    }
    // One retry before condemning the slide. Storage can refuse a burst of sequential requests
    // from one client, and a transient 429 on slide 3 of 10 is not the same thing as a dead
    // asset — but it looks identical to a naturalWidth check, so distinguish them by retrying
    // rather than by lowering the bar.
    let broken = checks.broken;
    if (broken.length) {
      broken = await page.evaluate(async (urls) => {
        await new Promise((r) => setTimeout(r, 1200));
        await Promise.all([...document.images].filter((im) => !im.naturalWidth).map((im) => {
          const src = im.src;
          return new Promise((r) => { im.onload = r; im.onerror = r; im.src = ""; im.src = src; });
        }));
        return [...document.images].filter((im) => !im.naturalWidth).map((im) => im.currentSrc || im.src);
      }, broken);
    }
    if (broken.length) {
      await browser.close();
      throw new Error(`${broken.length} image(s) failed to decode on slide type=${s.type} title=${s.title || ""} — refusing to ship a degraded slide\n  ${broken.map((u) => String(u).slice(0, 110)).join("\n  ")}`);
    }
    out.push(await page.screenshot({ type: "png", timeout: 60000, animations: "disabled" }));
  }
  await browser.close();
  return out;
}
