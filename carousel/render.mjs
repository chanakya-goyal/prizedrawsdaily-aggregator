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
// Vertical padding on the odds block, top AND bottom. The stylesheet reads it back as
// --odds-pad, so there is exactly one number: the height the layout RESERVES and the height the
// CSS PAINTS cannot drift. It was hardcoded in both places once, they disagreed by 10px, and
// the photo well overran the operator lockup by exactly that — invisible in review, obvious on
// the render.
export const ODDS_PAD = 28;
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

// Every cover headline is two sentences: the count, then the hook. Amber goes behind the
// SECOND one, which is a meaningful split rather than a decorative one — "8 DRAWS." is the fact
// and "HOW MANY TICKETS?" is the thing being asked. The <em> is the marker's extent; the CSS
// paints it as a gradient on the inline box so the amber follows the copy across line breaks
// instead of being one rectangle behind the whole block.
function headlineHtml(text) {
  const t = String(text || "");
  const m = t.match(/^(.*?[.?!])\s+(.+)$/s);
  return m ? `${esc(m[1])} <em>${esc(m[2])}</em>` : `<em>${esc(t)}</em>`;
}

function coverHtml(d, scene) {
  const board = (d.board || []).slice(0, 4).map((r, i) =>
    `<div class="row">`
    + `<span class="ix">${r.more ? "" : String(i + 1).padStart(2, "0")}</span>`
    + (r.more
      ? `<span class="pz more">${esc(r.more)}</span><span class="cl"></span>`
      : `<span class="pz" data-full="${esc(nbh(r.prize))}">${esc(nbh(r.prize))}</span><span class="cl${r.soon ? " soon" : ""}">${esc(r.closes)}</span>`)
    + `</div>`).join("");
  return `<div class="slide">
    ${sceneHost(scene, "cover")}
    ${masthead(d.stamp, true)}
    ${sheetEdge(0, 0)}
    <div class="dateline">${esc(d.dateline)}</div>
    <div class="headline">${headlineHtml(d.headline)}</div>
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
  // E2's full-bleed ground costs vertical padding, and it comes out of the photo well rather
  // than the column: the well is the flex residual, the column has none to give.
  const stackH = 45 + 10 + Math.min(lines, 2) * fit.lh + 20 + 240 + ODDS_PAD * 2;
  const photoH = Math.max(500, 1050 - stackH);                        // the flex residual, floored
  return `<div class="slide">
    ${sceneHost(scene, "draw")}
    <div class="photo" style="height:${photoH}px">
      ${d.photo ? `<img src="${d.photo}">` : ""}
      ${d.closesChip ? `<div class="closes-chip">${esc(d.closesChip)}</div>` : ""}
    </div>
    ${masthead(d.stamp)}
    ${sheetEdge(d.n, d.total)}
    ${d.stampWord ? `<div class="stamp">${esc(d.stampWord)}</div>` : ""}
    <div class="stack">
      ${lockup(d)}
      <div style="height:10px"></div>
      <div class="prize" style="font-size:${fit.px}px;line-height:${fit.lh}px">${esc(nbh(d.title))}</div>
      <div style="height:20px"></div>
      <div class="oddsblock" style="--odds-pad:${ODDS_PAD}px">
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

export function buildHtml(slide, categorySlug = "") {
  const scene = sceneFor(categorySlug);
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
<body data-pdd-role="${slide.type}"${tok ? ` style="${tok}"` : ""}>${body}<script>${READY_SCRIPT}</script></body></html>`;
}

export async function renderSlides(slides, categorySlug = "") {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
  const out = [];
  for (const s of slides) {
    // `domcontentloaded`, not `load`. The page inlines ~1.5MB of base64 woff2, and waiting for
    // the load event means waiting for all of it to be parsed — which stalled past 60s whenever
    // something else on the machine was busy. window.__ready is the stricter gate anyway: it
    // awaits document.fonts.ready AND every image.
    await page.setContent(buildHtml(s, categorySlug), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(async () => {
      await browser.close();
      throw new Error(`render not ready (fonts/images failed) on slide type=${s.type} title=${s.title || ""} — refusing to ship a degraded slide`);
    });
    // Word-boundary truncation of the board's prize column, MEASURED in the real font. A
    // character budget cannot work: Inter 600 at 44px advances 40.58px for "M" and a fraction of
    // that for "I", so any single number is either too generous — and the ellipsis itself gets
    // clipped, which is how "12 DOZEN BRIDGESTONE…" rendered as "12 DOZEN BRIDGESTO" — or so
    // pessimistic it throws away most of the column. CSS ellipsis alone cuts mid-word, which
    // reads as a rendering fault; a word boundary reads as an abbreviation.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".board .pz[data-full]")) {
        if (el.scrollWidth <= el.clientWidth) continue;
        const words = (el.dataset.full || "").split(/\s+/);
        while (words.length > 1) {
          words.pop();
          el.textContent = words.join(" ").replace(/[\s,.;:\u2013\u2014-]+$/, "") + "\u2026";
          if (el.scrollWidth <= el.clientWidth) break;
        }
      }
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
      // A conditions-band line is never shrunk and a legal line is never truncated, so an
      // overflow is a build failure rather than a cosmetic one. This band is the CAP 8.17
      // significant-conditions surface: what an overflow loses is a required condition.
      const bandOver = [...document.querySelectorAll(".band .l")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${Math.round(el.scrollWidth - el.clientWidth)}px over: ${el.textContent.slice(0, 64)}`);
      return { over, broken, bandOver };
    });
    if (checks.bandOver.length) {
      await browser.close();
      throw new Error(`conditions band overflows its 950px track on slide type=${s.type} — refusing to ship a degraded slide\n  ${checks.bandOver.join("\n  ")}`);
    }
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
