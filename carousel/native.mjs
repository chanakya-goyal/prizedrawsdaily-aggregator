// carousel/native.mjs — renders the native deck (see native-copy.mjs for the words and why).
//
// Instagram's own vocabulary, rebuilt in CSS: "Classic" text with a white background (one
// rounded highlight per line), the condensed "Strong" sticker for the price, a countdown-style
// card for the closing day, a location-style pill for the operator, and link + question stickers
// on the last slide. The site watermark runs faintly behind every frame and a small © mark sits
// on every photograph, so a repost still carries the source.
//
// Layout is FLOW, not hand-placed: titles run from 6 to 45 characters, so every zone sizes to its
// words and the photograph takes what is left. Two gates refuse a frame rather than ship it
// degraded — an image that did not decode, and text that leaves the frame, overflows its box or
// lands on other text. Both throw; build.mjs turns a throw into "no post today".
import { chromium } from "playwright";
import { fontFaceCss } from "./fonts.mjs";
import { SITE, hashOf } from "./native-copy.mjs";

const FONT_CSS = await fontFaceCss();
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const IG_GRAD = "linear-gradient(90deg,#7b2ff7 0%,#e1306c 55%,#f77737 100%)";
export const W = 1080;
export const H = 1350;
export const STORY_H = 1920;
// Meta's 9:16 safe box and the reply-composer notch — the same numbers story.mjs and
// reel-template.mjs use (a test pins them equal). Every glyph on a Story sits inside the box.
export const SAFE = { x: 65, y: 269, w: 950, h: 883 };
export const L_NOTCH = { x: 853, y: 1152, w: 227, h: 768 };

// A small, seeded tilt per element, so the deck looks hand-placed and renders identically twice.
const tilt = (key, max = 2.5) => ((hashOf(key) % 1000) / 1000 * 2 - 1) * max;
const rot = (key, max) => `transform:rotate(${tilt(key, max).toFixed(2)}deg)`;

// Bubble type size steps down with length so a long prize name stays two lines at most.
const leadSize = (t) => (t.length <= 18 ? 58 : t.length <= 28 ? 50 : t.length <= 38 ? 44 : 38);
const stickerSize = (t) => (t.length <= 3 ? 150 : t.length <= 5 ? 124 : t.length <= 8 ? 104 : 88);

const CSS = `
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:var(--h)}
body{overflow:hidden;position:relative;font-family:Inter,system-ui,'Apple Color Emoji',sans-serif;background:#141414;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:-90px;background-size:cover;background-position:center;filter:blur(46px) saturate(1.3) brightness(.7)}
.wm{position:absolute;inset:-320px;transform:rotate(-24deg);display:flex;flex-direction:column;gap:70px;
  font:700 40px Inter;color:#fff;opacity:.075;white-space:nowrap;letter-spacing:.02em;pointer-events:none}
.wm div:nth-child(even){margin-left:-260px}
.frame{position:absolute;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;row-gap:30px;padding:60px 0 50px}
.zone{display:flex;flex-direction:column;align-items:center;gap:20px;padding:0 60px}
.row{display:flex;align-items:center;justify-content:center;gap:24px;flex-wrap:nowrap}
.bub{line-height:1.42;text-align:center;max-width:960px}
.bub.left{text-align:left}
.bub span{background:#fff;color:#0b0b0b;font-weight:700;padding:.08em .42em;border-radius:.32em;
  -webkit-box-decoration-break:clone;box-decoration-break:clone}
.bub.green span{background:#1fbf5b;color:#fff}
.bub.blk span{background:#0b0b0b;color:#fff}
.strong{font:400 150px/1 Anton;text-transform:uppercase;color:#111;background:#ffe14d;white-space:nowrap;
  padding:14px 30px 10px;border-radius:22px;box-shadow:0 14px 34px rgba(0,0,0,.35);letter-spacing:.01em;flex:none}
.strong.pink{background:#ff3d8b;color:#fff}
.photo-wrap{position:relative;min-height:0}
.photo{position:absolute;inset:0;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.35);background:rgba(0,0,0,.18)}
.photo img{width:100%;height:100%;object-fit:cover;object-position:50% 58%;display:block}
.mark{position:absolute;right:24px;bottom:16px;font:600 24px Inter;color:#fff;opacity:.62;text-shadow:0 1px 4px rgba(0,0,0,.55)}
.emo{position:absolute;font-size:116px;line-height:1;filter:drop-shadow(0 10px 18px rgba(0,0,0,.35))}
.cd{background:#fff;border-radius:30px;padding:18px 32px 20px;text-align:center;box-shadow:0 14px 34px rgba(0,0,0,.35);flex:none}
.cd .t{font:700 25px Inter;letter-spacing:.14em;text-transform:uppercase;background:${IG_GRAD};-webkit-background-clip:text;color:transparent}
.cd .v{font:400 64px/1.05 Anton;text-transform:uppercase;color:#111;margin-top:4px;display:flex;gap:10px;justify-content:center;white-space:nowrap}
.cd .v b{font-weight:400;background:#f0f0f0;border-radius:12px;padding:2px 14px}
.loc{background:#fff;border-radius:16px;padding:12px 24px;white-space:nowrap;box-shadow:0 10px 26px rgba(0,0,0,.3);display:flex;align-items:center;gap:10px;max-width:960px}
.loc span{font:700 30px Inter;text-transform:uppercase;letter-spacing:.02em;background:${IG_GRAD};-webkit-background-clip:text;color:transparent;overflow:hidden}
.loc.sm span{font-size:24px}
.loc i{font-style:normal;font-size:30px}
.link{background:#fff;border-radius:18px;padding:18px 30px;display:flex;align-items:center;gap:14px;box-shadow:0 14px 34px rgba(0,0,0,.35);white-space:nowrap}
.link span{font:700 40px Inter;color:#2e7bf6;text-transform:uppercase;letter-spacing:.01em}
.link i{font-style:normal;font-size:40px}
.q{position:relative;width:720px;background:#fff;border-radius:34px;padding:70px 40px 34px;text-align:center;box-shadow:0 14px 34px rgba(0,0,0,.35)}
.q .av{position:absolute;top:-46px;left:50%;transform:translateX(-50%);width:92px;height:92px;border-radius:50%;padding:5px;background:${IG_GRAD}}
.q .av div{width:100%;height:100%;border-radius:50%;border:5px solid #fff;background:linear-gradient(135deg,#ff6a00,#ffb300);display:grid;place-items:center;font:400 34px Anton;color:#fff}
.q .t{font:700 46px/1.2 Inter;color:#111}
.q .f{margin-top:22px;background:#efefef;border-radius:16px;padding:20px;font:600 30px Inter;color:#8a8a8a}
.fine{position:absolute;left:70px;right:70px;bottom:36px;text-align:center;color:rgba(255,255,255,.88);font:600 23px/1.35 Inter}
.dump{position:relative}
.pol{position:absolute;background:#fff;padding:16px 16px 20px;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.pol img{display:block;width:500px;height:400px;object-fit:cover;border-radius:4px}
.end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;padding:0 60px 150px}
`;

// The page script: fonts, decode, choose cover vs contain per photo, then expose the layout gate.
// cover is used only when it crops at most 30% of the image — a square product shot in a wide band
// would otherwise lose its top and bottom, so it sits whole on the blurred ground instead.
const SCRIPT = `
(async () => {
  await document.fonts.ready;
  const imgs = [...document.images];
  await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
  for (const img of document.querySelectorAll('.photo img')) {
    const b = img.parentElement.getBoundingClientRect();
    if (!img.naturalWidth || !b.height) continue;
    const ir = img.naturalWidth / img.naturalHeight, br = b.width / b.height;
    img.style.objectFit = (1 - Math.min(ir / br, br / ir)) <= 0.30 ? 'cover' : 'contain';
  }
  window.__ready = true;
})();
window.__layout = () => {
  const W = innerWidth, H = innerHeight, out = [];
  const els = [...document.querySelectorAll('[data-t]')].map((e) => [e, e.getBoundingClientRect()]);
  for (const [e, r] of els) {
    if (r.left < 4 || r.top < 4 || r.right > W - 4 || r.bottom > H - 4) out.push(e.dataset.t + ' leaves the frame (' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ')');
    for (const c of [e, ...e.querySelectorAll('span')]) if (c.scrollWidth > c.clientWidth + 2 && getComputedStyle(c).whiteSpace === 'nowrap') out.push(e.dataset.t + ' overflows its box');
  }
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const [a, ra] = els[i], [b, rb] = els[j];
    if (a.dataset.g && a.dataset.g === b.dataset.g) continue;
    const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
    const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
    const small = Math.min(ra.width * ra.height, rb.width * rb.height) || 1;
    if (x * y / small > 0.12) out.push(a.dataset.t + ' lands on ' + b.dataset.t);
  }
  const ph = document.querySelector('.photo');
  if (ph && ph.getBoundingClientRect().height < 420) out.push('photo squeezed to ' + Math.round(ph.getBoundingClientRect().height) + 'px (floor 420)');
  return out;
};
`;

const wm = () => `<div class="wm" aria-hidden="true">${Array.from({ length: 16 }, () =>
  `<div>${Array.from({ length: 6 }, () => SITE).join("&nbsp;&nbsp;·&nbsp;&nbsp;")}</div>`).join("")}</div>`;
const lines = (arr) => arr.filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join("<br>");
const page = (body, h = H) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}\n:root{--h:${h}px}\n${CSS}</style></head><body>${body}<script>${SCRIPT}</script></body></html>`;
const bg = (src) => (src ? `<div class="bg" style="background-image:url('${src}')"></div>` : "");

function coverHtml(s) {
  const c = s.copy;
  const spots = [
    { left: 60, top: 40, r: -7 }, { left: 500, top: 120, r: 6 }, { left: 210, top: 400, r: -2 },
  ];
  const pols = s.photos.map((src, i) => {
    const p = s.photos.length === 1 ? { left: 270, top: 160, r: -3 } : spots[i];
    return `<div class="pol" style="left:${p.left}px;top:${p.top}px;transform:rotate(${p.r}deg)"><img src="${src}" alt=""></div>`;
  }).join("");
  return page(`${bg(s.photos[0])}${wm()}
  <div class="frame" style="grid-template-rows:minmax(0,1fr) auto">
    <div class="dump">${pols}<div class="emo" style="right:70px;top:-10px;transform:rotate(14deg)">${esc(s.emoji)}</div></div>
    <div class="zone">
      <div class="bub" data-t="cover line" style="font-size:${leadSize(c.line.text) - 4}px;${rot("cover-line", 1.8)}">${lines([c.line.text])}</div>
      ${c.sticker ? `<div class="strong" data-t="from sticker" style="font-size:${Math.min(128, stickerSize(c.sticker.text) + 24)}px;${rot("cover-st", 4)}">${esc(c.sticker.text)}</div>` : ""}
      <div class="bub blk" data-t="swipe" style="font-size:42px;${rot("cover-sw", 2)}">${lines([c.swipe.text])}</div>
    </div>
  </div>`);
}

function prizeHtml(s) {
  const c = s.copy;
  const sticker = `<div class="strong ${s.tone === "pink" ? "pink" : ""}" data-t="price" data-g="top" style="font-size:${stickerSize(c.price.text)}px;${rot(`${s.slug}-st`, 6)}">${esc(c.price.text)}</div>`;
  const top = s.variant === "price-first"
    ? `<div class="row">${sticker}<div class="bub left" data-t="lead" data-g="top" style="font-size:${leadSize(c.lead.text)}px;max-width:620px;${rot(`${s.slug}-ld`)}">${lines([c.lead.text, c.flavour.text])}</div></div>`
    : `<div class="bub" data-t="lead" data-g="top" style="font-size:${leadSize(c.lead.text)}px;${rot(`${s.slug}-ld`)}">${lines([c.lead.text])}</div>
       <div class="row">${sticker}<div class="bub" data-t="flavour" data-g="top" style="font-size:44px;max-width:560px;${rot(`${s.slug}-fl`)}">${lines([c.flavour.text])}</div></div>`;
  const parts = s.closes.length === 1 ? [s.closes[0]] : s.closes;
  return page(`${bg(s.photo)}${wm()}
  <div class="frame">
    <div class="zone">${top}</div>
    <div class="photo-wrap">
      <div class="photo"><img src="${s.photo}" alt=""></div>
      <div class="mark" data-t="mark">© ${SITE}</div>
      <div class="emo" style="right:46px;top:-58px;${rot(`${s.slug}-em`, 14)}">${esc(s.emoji)}</div>
    </div>
    <div class="zone" style="gap:22px">
      ${c.cash ? `<div class="bub green" data-t="cash" style="font-size:42px;${rot(`${s.slug}-ca`, 1.8)}">${lines([c.cash.text])}</div>` : ""}
      <div class="cd" data-t="closes" style="${rot(`${s.slug}-cd`, 3)}"><div class="t">${esc(c.closesLabel.text)}</div><div class="v">${parts.map((p) => `<b>${esc(p)}</b>`).join("")}</div></div>
      ${c.operator ? `<div class="loc ${c.operator.text.length > 26 ? "sm" : ""}" data-t="operator" style="${rot(`${s.slug}-op`, 1.6)}"><i>📍</i><span>${esc(c.operator.text)}</span></div>` : ""}
    </div>
  </div>`);
}

function endHtml(s) {
  const c = s.copy;
  // two of the deck's photographs tucked into the corners, photo-dump style, behind the stickers
  const corners = (s.corners || []).map((src, i) => {
    const p = i === 0 ? "left:-110px;top:-70px;transform:rotate(-9deg) scale(.72)" : "right:-110px;bottom:120px;transform:rotate(8deg) scale(.72)";
    return `<div class="pol" style="${p};transform-origin:center"><img src="${src}" alt=""></div>`;
  }).join("");
  return page(`${bg(s.photo)}${wm()}${corners}
  <div class="end">
    <div class="bub" data-t="more" style="font-size:54px;${rot("end-more", 2)}">${lines([c.more.text])}</div>
    <div class="link" data-t="site" style="${rot("end-site", 1.6)}"><i>🔗</i><span>${esc(c.site.text)}</span></div>
    <div class="q" data-t="prompt" style="margin-top:50px;${rot("end-q", 1.6)}"><div class="av"><div>P</div></div>
      <div class="t">${esc(c.prompt.text)}</div><div class="f">${esc(c.field.text)}</div></div>
    <div class="bub blk" data-t="follow" style="font-size:44px;${rot("end-fol", 2)}">${lines([c.follow.text])}</div>
  </div>
  <div class="fine" data-t="fine print">${esc(c.fine.text)}</div>`);
}

// The Story: ONE draw, every word inside Meta's safe box. The photograph and the decoration may
// run outside it; text may not.
function storyHtml(s) {
  const c = s.copy;
  const parts = s.closes;
  const decor = (s.decor || []).slice(0, 2).map((src, i) => {
    const p = i === 0 ? "left:40px;top:1260px;transform:rotate(-8deg) scale(.82)" : "left:330px;top:1420px;transform:rotate(6deg) scale(.82)";
    return `<div class="pol" style="${p};transform-origin:top left"><img src="${src}" alt=""></div>`;
  }).join("");
  return page(`${bg(s.photo)}${wm()}${decor}
  <div style="position:absolute;left:${SAFE.x}px;top:${SAFE.y + 16}px;width:${SAFE.w}px;display:flex;justify-content:center">
    <div class="row">
      <div class="strong ${s.tone === "pink" ? "pink" : ""}" data-t="price" data-g="top" style="font-size:${Math.min(130, stickerSize(c.price.text))}px;${rot(`${s.slug}-sst`, 5)}">${esc(c.price.text)}</div>
      <div class="bub left" data-t="lead" data-g="top" style="font-size:${Math.min(50, leadSize(c.lead.text))}px;max-width:560px;${rot(`${s.slug}-sld`)}">${lines([c.lead.text, c.flavour.text])}</div>
    </div>
  </div>
  <div class="photo-wrap" style="position:absolute;left:0;width:${W}px;top:530px;height:470px">
    <div class="photo"><img src="${s.photo}" alt=""></div>
    <div class="mark" data-t="mark" style="right:90px">© ${SITE}</div>
    <div class="emo" style="right:90px;top:-70px;${rot(`${s.slug}-sem`, 14)}">${esc(s.emoji)}</div>
  </div>
  ${c.cash ? `<div class="bub green" data-t="cash" style="position:absolute;left:${SAFE.x + 10}px;top:930px;font-size:38px;${rot(`${s.slug}-sca`, 1.6)}">${lines([c.cash.text])}</div>` : ""}
  <div class="row" style="position:absolute;left:${SAFE.x}px;width:${SAFE.w}px;top:1012px;gap:18px">
    <div class="cd" data-t="closes" style="padding:12px 26px 14px;${rot(`${s.slug}-scd`, 2.5)}"><div class="t">${esc(c.closesLabel.text)}</div><div class="v" style="font-size:52px">${parts.map((p) => `<b>${esc(p)}</b>`).join("")}</div></div>
    ${c.operator ? `<div class="loc sm" data-t="operator" style="${rot(`${s.slug}-sop`, 1.6)}"><i>📍</i><span>${esc(c.operator.text)}</span></div>` : ""}
  </div>`, STORY_H);
}

export function slideHtml(s) {
  if (s.type === "cover") return coverHtml(s);
  if (s.type === "prize") return prizeHtml(s);
  if (s.type === "end") return endHtml(s);
  throw new Error(`native: unknown slide type ${s.type}`);
}

// The Story still. Same two gates as the deck, plus the safe box: no glyph outside it, none in the notch.
export async function renderNativeStory(s, { browser: borrowed = null } = {}) {
  const browser = borrowed || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: STORY_H }, deviceScaleFactor: 1 });
  try {
    if (!s.photo) throw new Error("native story: no photograph — refusing an empty frame");
    await page.setContent(storyHtml(s), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 30000 });
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
    if (broken) throw new Error(`native story: ${broken} image(s) failed to decode — refusing a degraded frame`);
    const problems = await page.evaluate(() => window.__layout());
    const outside = await page.evaluate(({ box, notch }) => [...document.querySelectorAll("[data-t]")].flatMap((e) => {
      const r = e.getBoundingClientRect(), out = [];
      if (r.left < box.x || r.top < box.y || r.right > box.x + box.w || r.bottom > box.y + box.h) out.push(`${e.dataset.t} outside Meta's safe box`);
      if (r.right > notch.x && r.bottom > notch.y) out.push(`${e.dataset.t} inside the reply notch`);
      return out;
    }), { box: SAFE, notch: L_NOTCH });
    // the photo floor is 420px on the deck; the Story's band is fixed at 470, so only overlap/box apply
    const refused = [...problems.filter((p) => !p.startsWith("photo squeezed")), ...outside];
    if (refused.length) throw new Error(`native story layout refused:\n  ${refused.join("\n  ")}`);
    return await page.screenshot({ type: "png", timeout: 60000 });
  } finally {
    await page.close().catch(() => {});
    if (!borrowed) await browser.close();
  }
}

// Renders cover → prizes → end. Throws on the first frame either gate refuses.
export async function renderNative(deck, { browser: borrowed = null } = {}) {
  const browser = borrowed || await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const slides = [deck.cover, ...deck.prizes, deck.end];
  const out = [];
  try {
    for (const [i, s] of slides.entries()) {
      if (s.type === "prize" && !s.photo) throw new Error(`native: prize slide ${s.slug} has no photograph — refusing an empty frame`);
      await page.setContent(slideHtml(s), { waitUntil: "load", timeout: 60000 });
      await page.waitForFunction("window.__ready === true", { timeout: 30000 });
      const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
      if (broken) throw new Error(`native: slide ${i + 1} (${s.slug || s.type}): ${broken} image(s) failed to decode — refusing a degraded frame`);
      const problems = await page.evaluate(() => window.__layout());
      if (problems.length) throw new Error(`native: slide ${i + 1} (${s.slug || s.type}) layout refused:\n  ${problems.join("\n  ")}`);
      out.push(await page.screenshot({ type: "png", timeout: 60000 }));
    }
    return out;
  } finally {
    await page.close().catch(() => {});
    if (!borrowed) await browser.close();
  }
}
