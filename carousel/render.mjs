// Renders carousel slides to PNG buffers via Playwright (already a dep).
// Renders at 1080x1350 @ deviceScaleFactor 2 -> crisp 2160x2700 output.
import { chromium } from "playwright";
import { fontFaceCss } from "./fonts.mjs";

const CSS = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const FONT_CSS = await fontFaceCss(); // bundled base64 woff2 (no CDN dependency)

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// keep hyphenated model names (T-ROC, X-TRIBUTE) from breaking across lines.
const nbh = (s = "") => String(s).replace(/(\w)-(\w)/g, "$1‑$2");

const proxied = (url, w = 1200) =>
  url ? `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${w}&output=webp&q=90&we` : "";

// Wait for fonts + every image, then mark ready. (Glow is fixed brand-orange — the
// vibrant fiery look comes from the orange glow + embers, like the reference posts.)
const READY_SCRIPT = `
(async () => {
  try { await document.fonts.ready; } catch (e) {}
  const wait = (im) => (!im || im.complete) ? null : new Promise(r => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  window.__ready = true;
})();
`;

// floating ember/spark particles for the fiery backdrop
function embersHtml(n = 46) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const size = (3 + Math.random() * 9).toFixed(1);
    const left = (Math.random() * 100).toFixed(1);
    const top = (Math.random() * 100).toFixed(1);
    const op = (0.22 + Math.random() * 0.55).toFixed(2);
    s += `<span class="ember" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;opacity:${op}"></span>`;
  }
  return `<div class="embers">${s}</div>`;
}

// atmospheric FX layer: top bloom + (optional sunburst rays) + embers
const bgFx = (rays = false, n = 46) =>
  `<div class="bloom"></div>${rays ? `<div class="rays"></div>` : ""}${embersHtml(n)}`;

// celebratory gold confetti shower (intro + cta) — keeps to the upper ~56% so copy stays clean
function confettiHtml(n = 22) {
  const colors = ["var(--gold-2)", "#ffffff", "var(--accent-lt)", "var(--gold-1)"];
  let s = "";
  for (let i = 0; i < n; i++) {
    const w = (6 + Math.random() * 10).toFixed(1);
    const h = (10 + Math.random() * 16).toFixed(1);
    const left = (Math.random() * 100).toFixed(1);
    const top = (Math.random() * 56).toFixed(1);
    const rot = (Math.random() * 360).toFixed(0);
    s += `<span class="conf" style="left:${left}%;top:${top}%;width:${w}px;height:${h}px;background:${colors[i % colors.length]};transform:rotate(${rot}deg)"></span>`;
  }
  return `<div class="confetti">${s}</div>`;
}

function textOverlay(d, longTitle) {
  return `${d.price ? `<div class="pill">JUST ${esc(d.price)} A TICKET</div>` : ""}
    ${d.n ? `<div class="rank">${esc(d.n)}</div>` : ""}
    <div class="title-block">
      <div class="prize${longTitle ? " long" : ""}">${esc(nbh(d.title))}</div>
      ${d.cashAlt ? `<div class="cash">OR ${esc(d.cashAlt)}</div>` : ""}
      <div class="closes"><b>${esc(d.closes)}</b>${d.odds ? ` · ${esc(d.odds)}` : ""}</div>
    </div>
    <div class="footer"><span class="wm">PRIZEDRAWSDAILY.CO.UK</span><span class="rp">18+ · UK ONLY · PLAY RESPONSIBLY</span></div>`;
}

function drawHtml(d) {
  const longTitle = (d.title || "").length > 26;
  // (B) original photo shown full-frame inside the card.
  // contain = show the WHOLE product uncropped (operator shots, where cropping would
  // slice the prize) over a blurred fill of itself; cover = fill the card (generated
  // heroes, framed with generous margin so cover only trims dead space).
  if (d.framePhoto) {
    const fitClass = d.framePhotoContain ? " contain" : "";
    return `<div class="slide draw carded">
      ${bgFx(false)}
      <div class="stage"></div>
      <div class="glow"></div>
      <div class="podium"></div>
      <div class="card">
        <div class="win-ribbon">WIN THIS</div>
        ${d.framePhotoContain ? `<div class="cbg"><img src="${d.framePhoto}"></div>` : ""}
        <div class="photo${fitClass}"><img src="${d.framePhoto}"></div>
        <div class="photo-grad"></div>
      </div>
      ${textOverlay(d, longTitle)}
    </div>`;
  }
  // (A default) cut-out product inside a framed display card (orange-tinted bg + soft fill)
  if (d.cutoutDataUrl) {
    return `<div class="slide draw carded">
      ${bgFx(false)}
      <div class="stage"></div>
      <div class="glow"></div>
      <div class="podium"></div>
      <div class="card">
        <div class="win-ribbon">WIN THIS</div>
        <div class="cbg"><img src="${d.cutoutDataUrl}"></div>
        <div class="prod"><img src="${d.cutoutDataUrl}"></div>
      </div>
      ${textOverlay(d, longTitle)}
    </div>`;
  }
  // fallback (no clean product cutout): typographic prize card
  const longName = (d.title || "").length > 22;
  return `<div class="slide draw feature">
    <div class="glow"></div>${bgFx(true)}
    <div class="scrim"></div>
    ${d.price ? `<div class="pill">JUST ${esc(d.price)} A TICKET</div>` : ""}
    ${d.n ? `<div class="rank">${esc(d.n)}</div>` : ""}
    <div class="feat">
      <div class="feat-kicker">PRIZE DRAW</div>
      <div class="feat-name${longName ? " long" : ""}">${esc(nbh(d.title))}</div>
      ${d.cashAlt ? `<div class="feat-cash">OR ${esc(d.cashAlt)}</div>` : ""}
      <div class="feat-closes"><b>${esc(d.closes)}</b>${d.odds ? ` · ${esc(d.odds)}` : ""}</div>
    </div>
    <div class="footer"><span class="wm">PRIZEDRAWSDAILY.CO.UK</span><span class="rp">18+ · UK ONLY · PLAY RESPONSIBLY</span></div>
  </div>`;
}

function thumbsHtml(thumbs = [], mode = "photo") {
  const cls = mode === "cutout" ? "thumb thumb-cut" : "thumb thumb-photo";
  return `<div class="thumbs">` + thumbs.map((t, i) =>
    `<div class="${cls}">${t ? `<img src="${t}">` : `<span style="font-family:'Anton';font-size:42px;color:var(--accent)">${i + 1}</span>`}</div>`
  ).join("") + `</div>`;
}

function introHtml(d) {
  const kicker = d.banner ? `${esc(d.banner)} THIS WEEK` : "THIS WEEK'S BIGGEST DRAWS";
  const subBits = [];
  if (d.value) subBits.push(`${esc(d.value)} IN PRIZES`);
  if (d.count) subBits.push(`${esc(d.count)} TO WIN`);
  const sub = subBits.join(" · ");
  return `<div class="slide intro">
    ${d.bg ? `<div class="backdrop"><img src="${d.bg}"></div>` : ""}
    <div class="glow"></div>${bgFx(true, 58)}${confettiHtml(24)}
    <div class="techfloor"></div><div class="techgrid"></div>
    <div class="scrim"></div>
    <div class="intro-wrap">
      <div class="intro-kicker">🏆 ${kicker}</div>
      <div class="intro-hook hl">${esc(d.hook)}</div>
      ${d.fromAmount ? `<div class="intro-from-hero"><span class="from-lbl">FROM JUST</span><span class="from-amt hl gold">${esc(d.fromAmount)}</span><span class="from-lbl">A TICKET</span></div>` : ""}
      ${sub ? `<div class="intro-sub">${sub}</div>` : ""}
      ${d.thumbs && d.thumbs.length ? thumbsHtml(d.thumbs, d.thumbMode) : ""}
      <div class="intro-end">${esc(d.endLine)}</div>
      <div class="intro-swipe">SWIPE TO SEE ALL${d.count ? " " + esc(d.count) : ""} →</div>
    </div>
    <div class="footer"><span class="rp">18+ · UK ONLY · PLAY RESPONSIBLY</span></div>
  </div>`;
}

function ctaHtml() {
  return `<div class="slide cta">
    <div class="glow"></div>${bgFx(true, 58)}${confettiHtml(20)}
    <div class="scrim"></div>
    <div class="cta-wrap">
      <div class="cta-lead hl">SEE EVERY<br>LIVE UK DRAW</div>
      <div class="cta-url">prizedrawsdaily.co.uk</div>
      <div class="cta-handle">@prizedrawsdaily</div>
      <div class="cta-save">📌 Save &amp; send to your comp buddy</div>
    </div>
    <div class="footer"><span class="wm">PRIZEDRAWSDAILY.CO.UK</span><span class="rp">18+ · UK ONLY · PLAY RESPONSIBLY</span></div>
  </div>`;
}

export function buildHtml(slide, theme = "default") {
  const body = slide.type === "intro" ? introHtml(slide)
    : slide.type === "cta" ? ctaHtml(slide)
    : drawHtml(slide);
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>${CSS}</style></head><body data-type="${slide.type}" data-theme="${theme}">${body}<script>${READY_SCRIPT}</script></body></html>`;
}

export async function renderSlides(slides, theme = "default") {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
  const out = [];
  for (const s of slides) {
    await page.setContent(buildHtml(s, theme), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 25000 }).catch(() => {});
    out.push(await page.screenshot({ type: "png", timeout: 60000, animations: "disabled" }));
  }
  await browser.close();
  return out;
}
