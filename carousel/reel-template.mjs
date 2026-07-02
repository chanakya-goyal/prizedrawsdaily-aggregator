// carousel/reel-template.mjs — the animated Reel timeline (spec §4.4).
// One HTML document IS the whole Reel: a single deterministic timeline of scenes,
// kinetic type, 3-layer parallax, seeded drifting particles, THE PRICE STAMP and a
// loop outro — all CSS keyframes with explicit delay/duration (WAAPI-seekable), so
// capture.mjs can pause everything and screenshot frame-by-frame at 1080×1920.
//
// Anti-ordinary rules enforced here (spec §4.4 — "NOT a slideshow"):
//   · photos are NEVER scale-animated: the WORLD moves (particles 1.0×, card 0.4×
//     translate + ±1.5° rotate3d sway, text 0.2×, one specular sweep per scene)
//   · every cut/slam/stamp time is quantize(t, beatGrid(audioMeta, durationMs))
//   · cold open 0–1200ms: hero at t=0 → 1-frame white flash (~150ms, frame-grid
//     quantized: exactly frame 5 @30fps) → price stamp (scale 3→1 overshoot,
//     2-frame chromatic split, body shake) → TRUE-fact kicker
//   · loop outro: stamp-out in the final 400ms so last frame ≈ frame 0; URL/handle
//     lower-third rides the FINAL scene (no dead outro card)
//   · compliance footer on every frame
// Determinism: no Date.now()/Math.random() — particles seed from
// sel.slug.length*7 + arm.charCodeAt(0) via mulberry32; countdowns use build-time ISO.
import { themeOf, catCfg } from "./config.mjs";
import { fontFaceCss } from "./fonts.mjs";
import { beatGrid, quantize } from "./beat.mjs";

const FONT_CSS = await fontFaceCss();
const STYLES_TEXT = await Bun.file(new URL("./styles.css", import.meta.url)).text();

// ---- theme inheritance: lift the :root + [data-theme] TOKEN blocks (and the
// parameterized particle skeletons) out of styles.css so var(--accent) etc. resolve
// per category exactly like the carousel. Descendant rules are intentionally skipped.
const TOKEN_CSS = (() => {
  const out = [];
  for (const m of STYLES_TEXT.matchAll(/(?:^|\n)\s*(?::root|\[data-theme="[^"]+"\])\s*\{[^}]*\}/g)) out.push(m[0].trim());
  for (const m of STYLES_TEXT.matchAll(/(?:^|\n)\s*\.p-(?:embers|golddust|fireflies|holo)\s*\{[^}]*\}/g)) out.push(m[0].trim());
  return out.join("\n");
})();

const FPS = 30, FRAME = 1000 / FPS;

const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nbh = (s = "") => String(s).replace(/(\w)-(\w)/g, "$1‑$2"); // keep T-ROC etc. on one line

// ---------------------------------------------------------------- fixed pieces
// The seek runtime (shared with capture.mjs and story.mjs) — verbatim per the plan.
export const SEEK_RUNTIME = `
window.__vt = 0; // virtual clock for JS-driven counters (rAF replaced)
window.__seek = (tMs) => {
  window.__vt = tMs;
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = tMs; }
  for (const el of document.querySelectorAll("[data-counter]")) {
    const { from, to, start, end } = JSON.parse(el.dataset.counter);
    const p = Math.min(1, Math.max(0, (tMs - start) / (end - start)));
    el.textContent = Math.round(from + (to - from) * p).toLocaleString("en-GB");
  }
  for (const el of document.querySelectorAll("[data-countdown]")) {
    const closeMs = Number(el.dataset.countdown);
    const left = Math.max(0, closeMs - (Date.parse(el.dataset.now) + tMs));
    const h = Math.floor(left / 3600000), m = Math.floor(left / 60000) % 60, s = Math.floor(left / 1000) % 60;
    el.textContent = \`\${String(h).padStart(2,"0")}:\${String(m).padStart(2,"0")}:\${String(s).padStart(2,"0")}\`;
  }
};
(async () => {
  try { await document.fonts.ready; } catch {}
  const wait = (im) => (!im || im.complete) ? null : new Promise((r) => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  for (const a of document.getAnimations()) a.pause();
  window.__ready = true;
})();`;

// THE PRICE STAMP — identical keyframe names/durations across arms and themes;
// themed only via var(--accent)/var(--gold-2)/var(--stroke). Verbatim per the plan.
export const stampCss = () => `
@keyframes stamp-in { 0%{transform:scale(3);opacity:0} 55%{transform:scale(.92);opacity:1} 75%{transform:scale(1.06)} 100%{transform:scale(1)} }
@keyframes stamp-shake { 0%,100%{transform:translate(0,0)} 33%{transform:translate(3px,-2px)} 66%{transform:translate(-3px,2px)} }
@keyframes stamp-ring { 0%{transform:scale(.6);opacity:.9} 100%{transform:scale(1.6);opacity:0} }
@keyframes stamp-out { 0%{transform:scale(1);opacity:1} 100%{transform:scale(3);opacity:0} }
.stamp { position:absolute; z-index:40; width:430px; height:430px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; text-align:center;
  background: radial-gradient(circle at 35% 30%, rgba(255,255,255,.16), transparent 60%), var(--accent);
  border: 10px solid var(--gold-2); box-shadow: 0 24px 60px rgba(0,0,0,.5);
  font-family: var(--font-display), 'Anton', sans-serif; font-size:72px; line-height:.95; color:#fff;
  -webkit-text-stroke: 2px var(--stroke); paint-order: stroke fill;
  transform: rotate(-8deg); }
.stamp-ring { position:absolute; inset:-14px; border-radius:50%; border: 6px solid var(--gold-2); }`;
export const stampHtml = (text) => `<div class="stamp"><div class="stamp-ring"></div><span>${text}</span></div>`;

// seeded PRNG — deterministic particle layouts. Verbatim per the plan.
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------- flip clock (arm C + story.mjs)
// Split-flap card: mono digits over a two-tone card with a hairline split — the
// [data-countdown] element's textContent is rewritten wholesale by __seek, so the
// chrome lives AROUND the text node, never inside it.
export const flipClockCss = () => `
.flipclock { position:relative; display:flex; flex-direction:column; align-items:center; gap:16px; }
.fc-card { position:relative; padding: 34px 52px 30px; border-radius: 30px;
  background: linear-gradient(180deg, #272c35 0%, #171b22 49.7%, #0a0d12 50.3%, #131820 100%);
  border: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 30px 70px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.16), 0 0 80px rgba(var(--accent-rgb), .22); }
.fc-time { font-family:'JetBrains Mono', monospace; font-weight:700; font-size:148px; line-height:1;
  letter-spacing: 6px; color:#fff; font-variant-numeric: tabular-nums;
  text-shadow: 0 4px 18px rgba(0,0,0,.65), 0 0 44px rgba(var(--accent-rgb),.35); }
.fc-split { position:absolute; left:26px; right:26px; top:50%; height:2px;
  background: rgba(0,0,0,.6); box-shadow: 0 1px 0 rgba(255,255,255,.07); pointer-events:none; }
.fc-labels { display:flex; width:100%; justify-content:space-between; padding: 0 44px; }
.fc-labels b { flex:1; text-align:center; font-family:'Oswald',sans-serif; font-weight:700; font-size:24px;
  letter-spacing:5px; color:rgba(255,255,255,.62); text-transform:uppercase; }`;

const pad2 = (n) => String(n).padStart(2, "0");
export const countdownHtml = (closeIso, nowIso) => {
  const closeMs = Date.parse(closeIso), nowMs = Date.parse(nowIso);
  const left = Math.max(0, closeMs - nowMs); // initial (t=0) reading; __seek re-derives per frame
  const txt = `${pad2(Math.floor(left / 3600000))}:${pad2(Math.floor(left / 60000) % 60)}:${pad2(Math.floor(left / 1000) % 60)}`;
  return `<div class="flipclock"><div class="fc-card"><span class="fc-time" data-countdown="${closeMs}" data-now="${esc(nowIso)}">${txt}</span><i class="fc-split"></i></div>
  <div class="fc-labels"><b>Hours</b><b>Minutes</b><b>Seconds</b></div></div>`;
};

// deterministic default clock for callers that don't pass real times (tests):
// a fixed sentinel "now" and a close 03:47:22 later — reads like a live countdown.
const DEFAULT_NOW = "2026-01-01T18:00:00.000Z";
const DEFAULT_LEFT_MS = 3 * 3600000 + 47 * 60000 + 22000;

// ---------------------------------------------------------------- reel-scoped CSS
// Glossy type + card + FX recipes are copied from styles.css class definitions into
// reel-scoped classes (per the plan) so 1080×1920 layout never fights the 1350 CSS.
const REEL_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1080px; height:1920px; overflow:hidden; }
body { background: var(--bg-solid); color:#fff; font-family:'Oswald', ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing:antialiased; text-rendering:geometricPrecision; }
.reel { position:absolute; inset:0; overflow:hidden;
  background:
    radial-gradient(120% 70% at 50% 12%, rgba(var(--glow-rgb),.22) 0%, rgba(var(--accent-rgb),0) 48%),
    radial-gradient(130% 90% at 50% 96%, rgba(var(--accent-deep-rgb),.18) 0%, rgba(0,0,0,0) 52%),
    radial-gradient(130% 92% at 50% 44%, var(--bg-1) 0%, var(--bg-2) 56%, var(--bg-3) 100%); }
.vign { position:absolute; inset:0; z-index:34; pointer-events:none; box-shadow: inset 0 0 240px rgba(0,0,0,.5); }

/* ---- scenes: absolutely stacked, visibility = opacity keyframes on ONE timeline ---- */
.scene { position:absolute; inset:0; z-index:10; opacity:0; pointer-events:none; }
.layer-bg, .layer-card, .layer-text { position:absolute; inset:0; }
.layer-bg { z-index:1; } .layer-card { z-index:3; perspective:1200px; } .layer-text { z-index:5; }
.hd-drift, .b-pan, .c-in, .c-float, .t-drift { position:absolute; inset:0; }

/* full-bleed hero (cold open / reprise): blurred cover fill + sharp contain on top —
   full-bleed WITHOUT cropping the prize, and never scale-animated */
.hf-bg { position:absolute; inset:-48px; }
.hf-bg img { width:100%; height:100%; object-fit:cover; filter: blur(42px) saturate(1.55) brightness(.92); opacity:.62; }
.hf-main { position:absolute; inset:70px 34px 640px; display:flex; align-items:center; justify-content:center; }
.hf-main img { max-width:100%; max-height:100%; object-fit:contain; filter: drop-shadow(0 28px 46px rgba(0,0,0,.6)); }
.scrim-b { position:absolute; inset:0; z-index:2;
  background: linear-gradient(180deg, rgba(var(--scrim-rgb),.30) 0%, rgba(var(--scrim-rgb),0) 22%, rgba(var(--scrim-rgb),0) 46%, rgba(var(--scrim-rgb),.78) 76%, rgba(var(--scrim-rgb),.97) 100%); }

/* framed prize card (scene hero) — the carousel .card recipe, reel-sized */
.pcard { position:absolute; left:64px; right:64px; top:240px; height:950px; border-radius:40px; overflow:hidden;
  background: radial-gradient(circle at 50% 36%, rgba(var(--accent-rgb),.30) 0%, rgba(var(--card-rgb),.97) 60%);
  border: 3px solid rgba(var(--ray-rgb),.65);
  box-shadow: 0 30px 70px rgba(0,0,0,.62), 0 0 90px rgba(var(--accent-rgb),.38),
              inset 0 0 0 1px rgba(var(--gold-rgb),.5), inset 0 1px 0 rgba(255,255,255,.16); }
.pcard .cbg { position:absolute; inset:0; }
.pcard .cbg img { width:100%; height:100%; object-fit:cover; transform:scale(1.5); /* static fill, not animated */
  filter: blur(40px) saturate(1.6) brightness(1.1); opacity:.55; }
.pcard .photo { position:absolute; inset:0; }
.pcard .photo.contain { display:flex; align-items:center; justify-content:center; padding:46px; }
.pcard .photo.contain img { max-width:100%; max-height:100%; object-fit:contain; filter: drop-shadow(0 22px 34px rgba(0,0,0,.55)); }
.pgrad { position:absolute; inset:0; box-shadow: inset 0 0 90px rgba(0,0,0,.42), inset 0 0 0 1px rgba(var(--ray-rgb),.15);
  background: linear-gradient(180deg, rgba(0,0,0,0) 58%, rgba(0,0,0,.42) 100%); }
.win-tab { position:absolute; top:26px; left:26px; z-index:6; padding:10px 24px; border-radius:12px;
  font-family: var(--font-display),'Anton',sans-serif; font-size:27px; letter-spacing:3px; text-transform:uppercase; color:#3a2400;
  background: linear-gradient(180deg, var(--gold-1) 0%, var(--gold-2) 55%, var(--gold-3) 100%);
  border-top: 2px solid rgba(255,255,255,.55); box-shadow: 0 8px 20px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.5); }

/* one specular sweep per scene — a rotated light strip translating across its host */
.sweep { position:absolute; top:-16%; bottom:-16%; left:0; width:300px; z-index:6; pointer-events:none;
  transform: translateX(-460px) rotate(14deg); mix-blend-mode:screen;
  background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.32) 46%, rgba(255,255,255,0) 100%); }
@keyframes rl-sweep { from { transform: translateX(-460px) rotate(14deg); } to { transform: translateX(1420px) rotate(14deg); } }

/* atmosphere (reel-scoped copies of the carousel FX, themed by tokens) */
.rl-glow { position:absolute; left:50%; top:38%; width:1150px; height:1150px; transform:translate(-50%,-50%); z-index:1;
  background: radial-gradient(circle, var(--glow) 0%, rgba(var(--accent-rgb),.42) 28%, rgba(0,0,0,0) 64%);
  opacity:.75; filter: blur(20px); mix-blend-mode:screen; pointer-events:none; }
.rl-bloom { position:absolute; left:50%; top:-8%; width:1400px; height:1100px; transform:translateX(-50%); z-index:1;
  background: radial-gradient(ellipse 50% 60% at 50% 0%, rgba(var(--accent-lt-rgb),.36) 0%, rgba(var(--glow-rgb),.13) 38%, rgba(0,0,0,0) 66%);
  mix-blend-mode:screen; filter: blur(8px); pointer-events:none; }
.rl-rays { position:absolute; left:50%; top:-16%; width:1900px; height:1700px; transform:translateX(-50%); z-index:1; opacity:.24;
  background: conic-gradient(from 162deg at 50% 0%,
    transparent 0deg, rgba(var(--ray-rgb),.55) 5deg, transparent 11deg, transparent 21deg,
    rgba(var(--ray-rgb),.42) 27deg, transparent 33deg, transparent 49deg, rgba(var(--ray-rgb),.5) 55deg,
    transparent 61deg, transparent 77deg, rgba(var(--ray-rgb),.4) 83deg, transparent 89deg,
    transparent 105deg, rgba(var(--ray-rgb),.46) 111deg, transparent 117deg);
  -webkit-mask-image: radial-gradient(ellipse 62% 78% at 50% 0%, #000 0%, transparent 72%);
  mask-image: radial-gradient(ellipse 62% 78% at 50% 0%, #000 0%, transparent 72%);
  mix-blend-mode:screen; filter: blur(3px); pointer-events:none; }

/* ---- kinetic type ---- */
.wd { display:inline-block; animation-name: rl-word; animation-duration:460ms;
  animation-timing-function: cubic-bezier(.2,1.9,.3,1); animation-fill-mode:both; }
@keyframes rl-word { 0% { opacity:0; transform: translateY(92px) scale(1.35) rotate(2deg); }
  70% { opacity:1; transform: translateY(-8px) scale(.98) rotate(0deg); } 100% { opacity:1; transform:none; } }
/* glossy headline recipe (styles.css .hl), reel-scoped and applied per WORD so
   per-word transforms never break background-clip */
.rl-title .wd, .rl-giant .gw, .l3-url, .giantq {
  font-family: var(--font-display),'Anton',sans-serif; font-weight:400; text-transform:uppercase; letter-spacing:.5px;
  background: linear-gradient(180deg, #ffffff 0%, #ffffff 46%, var(--ink-end) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  -webkit-text-stroke: 6px var(--stroke); paint-order: stroke fill;
  filter: drop-shadow(0 6px 18px rgba(0,0,0,.72)) drop-shadow(0 0 50px rgba(var(--accent-rgb),.55)); }
.gold-ink.wd, .giantq, .rl-cash b {
  background: linear-gradient(180deg, var(--gold-1) 0%, var(--gold-2) 52%, var(--gold-3) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  filter: drop-shadow(0 5px 14px rgba(0,0,0,.72)) drop-shadow(0 0 50px rgba(var(--gold-rgb),.9)); }
.rl-title { font-size:106px; line-height:.94; text-transform:uppercase; }
.rl-title.long { font-size:78px; }
.rl-giant { font-size:126px; line-height:.92; text-transform:uppercase; text-align:center; }
.rl-giant.long { font-size:88px; }
.rl-giant .gw { display:inline-block; }
.giantq { font-size:300px; line-height:.85; letter-spacing:2px; -webkit-text-stroke:8px var(--stroke); }

.scenekick { display:inline-block; font-family:'Oswald',sans-serif; font-weight:700; font-size:30px; letter-spacing:5px;
  color: var(--accent); text-transform:uppercase; margin-bottom:24px; text-shadow: 0 0 22px rgba(var(--accent-rgb),.65);
  animation-name: rl-kick; animation-duration:420ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.kickline { position:absolute; left:56px; right:56px; bottom:330px; z-index:8; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:600; font-size:46px; letter-spacing:.5px; text-transform:uppercase; color:#fff;
  text-shadow: 0 2px 12px rgba(0,0,0,.85);
  animation-name: rl-kick; animation-duration:480ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.kickline b { color: var(--hot); font-weight:700; }
@keyframes rl-kick { from { opacity:0; transform: translateY(72px) scale(1.1); } to { opacity:1; transform:none; } }

.rl-cash { margin-top:20px; font-family: var(--font-display),'Anton',sans-serif; font-size:52px; text-transform:uppercase;
  -webkit-text-stroke: 4px var(--stroke); paint-order: stroke fill; color:#fff;
  animation-name: rl-kick; animation-duration:440ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.rl-closes { margin-top:18px; font-family:'Oswald',sans-serif; font-weight:600; font-size:34px; letter-spacing:.5px;
  text-transform:uppercase; color:#fff; text-shadow: 0 2px 10px rgba(0,0,0,.85);
  animation-name: rl-kick; animation-duration:440ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.rl-closes b { color: var(--hot); font-weight:700; }
.rl-pill { display:inline-flex; margin-top:30px; padding:16px 32px; border-radius:14px;
  font-family: var(--font-display),'Anton',sans-serif; font-size:37px; letter-spacing:.4px; text-transform:uppercase; color:#fff;
  background: linear-gradient(135deg, var(--pill-1) 0%, var(--pill-2) 52%, var(--pill-3) 100%);
  border: 2px solid rgba(var(--pill-edge-rgb),.6); text-shadow: 0 2px 4px rgba(var(--pill-ink-rgb),.6);
  box-shadow: 0 12px 32px rgba(var(--accent-deep-rgb),.55), inset 0 1px 0 rgba(255,255,255,.35);
  animation-name: rl-pop; animation-duration:460ms; animation-timing-function:cubic-bezier(.2,1.8,.3,1); animation-fill-mode:both; }
@keyframes rl-pop { from { opacity:0; transform: scale(2.1) rotate(-5deg); } 65% { opacity:1; transform: scale(.94) rotate(0deg); } to { opacity:1; transform: scale(1); } }

.tblock { position:absolute; left:64px; right:64px; bottom:300px; z-index:5; }
.tblock.center { top:130px; bottom:250px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }

/* lower-third (final scene) */
.lower3 { position:absolute; left:0; right:0; bottom:200px; z-index:20; display:flex; flex-direction:column; align-items:center; gap:10px;
  animation-name: rl-lower3; animation-duration:620ms; animation-timing-function:cubic-bezier(.2,1.5,.3,1); animation-fill-mode:both; }
@keyframes rl-lower3 { from { opacity:0; transform: translateY(340px); } to { opacity:1; transform:none; } }
.l3-url { font-size:64px; letter-spacing:1px; -webkit-text-stroke:4px var(--stroke);
  background: linear-gradient(180deg, var(--grad-1) 0%, var(--grad-2) 56%, var(--grad-3) 100%);
  -webkit-background-clip:text; background-clip:text; }
.l3-handle { font-family:'Oswald',sans-serif; font-weight:600; font-size:36px; letter-spacing:1px; color:rgba(255,255,255,.92); }
.l3-line { font-family:'Oswald',sans-serif; font-weight:600; font-size:27px; letter-spacing:4px; color:rgba(255,255,255,.66); text-transform:uppercase; }

/* ---- layer motion (parallax rates: particles 1.0×, card 0.4×, text 0.2×) ---- */
@keyframes rl-colddrift { from { transform: translateY(14px); } to { transform: translateY(-22px); } }
@keyframes rl-bgpan { from { transform: translateY(0); } to { transform: translateY(-26px); } }
@keyframes rl-cardin { from { opacity:0; transform: translateY(150px); } 70% { opacity:1; transform: translateY(-12px); } to { opacity:1; transform:none; } }
@keyframes rl-float { 0% { transform: translateY(12px) rotate3d(.06,1,.02,-1.5deg); }
  50% { transform: translateY(-14px) rotate3d(.06,1,.02,1.5deg); } 100% { transform: translateY(8px) rotate3d(.06,1,.02,-1deg); } }
@keyframes rl-textdrift { from { transform: translateY(8px); } to { transform: translateY(-8px); } }

/* ---- seeded particle field: global, continuous, in FRONT of scenes ---- */
.pfield { position:absolute; inset:0; z-index:30; pointer-events:none; }
.pw { position:absolute; animation-name: rl-drift; animation-timing-function:linear; animation-iteration-count:infinite; }
.pfield .pw > span { animation-name: rl-psway; animation-timing-function:ease-in-out; animation-iteration-count:infinite; animation-direction:alternate; }
.pfield .p-holo { --rot: 45deg; }
@keyframes rl-drift { from { transform: translateY(0); } to { transform: translateY(-2250px); } }
@keyframes rl-psway { from { transform: translateX(calc(var(--amp,12px) * -1)) rotate(var(--rot,0deg)); }
  to { transform: translateX(var(--amp,12px)) rotate(var(--rot,0deg)); } }

/* ---- the stamp slot: identical position/size in every arm and theme ---- */
.stamp-slot { position:absolute; left:50%; top:46%; width:430px; height:430px; margin:-215px 0 0 -215px; z-index:24; }
.s-wrap, .s-pop, .s-chroma { position:relative; width:100%; height:100%; }
.stamp span { display:block; padding:0 34px; }
.stamp-slot .stamp-ring { animation: stamp-ring 700ms ease-out var(--t-in,0ms) both; }
@keyframes rl-chroma { from { filter: drop-shadow(7px 0 0 rgba(255,45,85,.85)) drop-shadow(-7px 0 0 rgba(0,229,255,.8)); }
  to { filter:none; } }

/* ---- cold-open white flash: ≤1 frame (frames 0–4 dark, frame 5 white, frame 6 clear) ---- */
.flash { position:absolute; inset:0; z-index:70; background:#fff; opacity:0; pointer-events:none;
  animation: rl-flash 50ms linear 150ms both; }
@keyframes rl-flash { 0% { opacity:0; } 25% { opacity:1; } 75% { opacity:1; } 100% { opacity:0; } }

/* ---- persistent compliance footer: every frame, ≥12px ---- */
.rfoot { position:absolute; left:0; right:0; bottom:36px; z-index:60; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:600; font-size:24px; letter-spacing:3px;
  color: rgba(255,255,255,.78); text-shadow: 0 2px 10px rgba(0,0,0,.85); }

/* arm C countdown layout */
.cd-kick { position:absolute; left:56px; right:56px; top:130px; z-index:6; text-align:center; }
.cd-card { top:230px; height:760px; }
.cd-clock { position:absolute; left:0; right:0; top:1090px; z-index:8; display:flex; justify-content:center;
  animation-name: rl-pop; animation-duration:540ms; animation-timing-function:cubic-bezier(.2,1.8,.3,1); animation-fill-mode:both; }
.cd-pill { position:absolute; left:0; right:0; top:1470px; z-index:8; display:flex; justify-content:center; }
.cd-typo { position:absolute; left:70px; right:70px; top:300px; bottom:900px; z-index:5;
  display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }

/* arm B question layout */
.q-wrap { position:absolute; left:56px; right:56px; top:0; bottom:250px; z-index:8;
  display:flex; flex-direction:column; align-items:center; justify-content:flex-end; text-align:center; padding-bottom:290px; }
.q-line { margin-top:26px; font-size:64px; line-height:.95; text-transform:uppercase; }
.q-line .wd { -webkit-text-stroke:4px var(--stroke); }
`;

// ---------------------------------------------------------------- small builders
const wordSpans = (text, t0, { stagger = 90, cls = "" } = {}) =>
  nbh(esc(String(text))).split(/\s+/).map((w, i) =>
    `<span class="wd${cls ? " " + cls : ""}" style="animation-delay:${t0 + i * stagger}ms">${w}</span>`).join(" ");

// scene visibility on the single timeline: opacity keyframes with a 1ms edge so the
// NEW scene owns the exact cut frame (cuts land on frame boundaries: 500ms ⊂ 33.33ms grid).
function sceneKeyframes(name, a, b, dur) {
  const p = (t) => +((t / dur) * 100).toFixed(4);
  const rows = [];
  if (a <= 0) rows.push("0%{opacity:1}");
  else rows.push("0%{opacity:0}", `${p(a - 1)}%{opacity:0}`, `${p(a)}%{opacity:1}`);
  if (b >= dur) rows.push("100%{opacity:1}");
  else rows.push(`${p(b - 1)}%{opacity:1}`, `${p(b)}%{opacity:0}`, "100%{opacity:0}");
  return `@keyframes ${name} { ${rows.join(" ")} }`;
}

const stampText = (slide, sel) =>
  slide?.price ? `JUST ${String(slide.price).toUpperCase()} A TICKET` : `LIVE ${String(sel.name || "UK DRAWS").toUpperCase()}`;

// THE PRICE STAMP at a moment on the timeline. stamp-in/ring/chroma on wrappers so
// stampHtml stays verbatim; optional stamp-out (loop outro) on its own wrapper —
// its 0% state is identity, so it can't mask the entrance.
function stampBlock(text, inMs, outMs = null) {
  const out = outMs != null ? ` style="animation: stamp-out 400ms cubic-bezier(.55,0,.85,.36) ${outMs}ms both"` : "";
  return `<div class="stamp-slot" style="--t-in:${inMs}ms"><div class="s-wrap"${out}>
    <div class="s-pop" style="animation: stamp-in 560ms cubic-bezier(.2,2,.3,1) ${inMs}ms both">
      <div class="s-chroma" style="animation: rl-chroma 67ms linear ${inMs}ms both">${stampHtml(esc(text))}</div>
    </div></div></div>`;
}

// seeded, continuously-drifting particle field (positions/speeds from mulberry32)
function particleField(profile, seed) {
  const { type = "embers", count = 46 } = profile || {};
  if (type === "none" || count <= 0) return "";
  const rnd = mulberry32(seed);
  let s = "";
  for (let i = 0; i < count; i++) {
    const left = (rnd() * 100).toFixed(2), top = (rnd() * 112 - 6).toFixed(2);
    const size = (3 + rnd() * 9).toFixed(1), op = (0.2 + rnd() * 0.5).toFixed(2);
    const dDur = Math.round(9000 + rnd() * 11000);           // 1.0× parallax layer
    const sDur = Math.round(2400 + rnd() * 3200), sDel = Math.round(rnd() * 800);
    const amp = (6 + rnd() * 16).toFixed(1);
    s += `<i class="pw" style="left:${left}%;top:${top}%;animation-duration:${dDur}ms"><span class="p-${type}" style="width:${size}px;height:${size}px;opacity:${op};--amp:${amp}px;animation-duration:${sDur}ms;animation-delay:${sDel}ms"></span></i>`;
  }
  return `<div class="pfield">${s}</div>`;
}

// £-amount count-up from cashAlt text ("£15,000 TAX-FREE CASH") via data-counter
function cashLine(cashAlt, startMs, endMs) {
  if (!cashAlt) return "";
  const m = /£?\s?(\d[\d,]*)/.exec(String(cashAlt));
  if (!m) return `<div class="rl-cash" style="animation-delay:${startMs}ms">OR ${esc(cashAlt)}</div>`;
  const to = parseInt(m[1].replace(/,/g, ""), 10);
  const suffix = String(cashAlt).slice(m.index + m[0].length).trim();
  const spec = JSON.stringify({ from: 0, to, start: startMs, end: endMs });
  return `<div class="rl-cash" style="animation-delay:${startMs}ms">OR <b>£<span data-counter='${spec}'>0</span></b> ${esc(suffix)}</div>`;
}

const sweepAt = (t, dur = 900) =>
  `<i class="sweep" style="animation: rl-sweep ${dur}ms cubic-bezier(.45,0,.2,1) ${t}ms both"></i>`;

// ---------------------------------------------------------------- scene builders
// Cold open / reprise: full-bleed hero (or typographic hero when no photo).
function heroScene({ idx, a, b, dur, slide, hero, stampT, kickT, lower3T = null, outT = null, sel }) {
  const len = b - a;
  const long = (slide.title || "").length > 22;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg"><img src="${hero}"></div></div></div>
       <div class="layer-card"><div class="hd-drift" style="animation: rl-colddrift ${len}ms ease-in-out ${a}ms both"><div class="photo contain hf-main"><img src="${hero}"></div></div>
         ${sweepAt(a + Math.round(len * 0.42), 1000)}</div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="hd-drift" style="animation: rl-colddrift ${len}ms ease-in-out ${a}ms both">
         <div class="cd-typo"><div class="rl-giant${long ? " long" : ""}">${nbh(esc(slide.title)).split(/\s+/).map((w) => `<span class="gw">${w}</span>`).join(" ")}</div></div>
       </div>${sweepAt(a + Math.round(len * 0.42), 1000)}</div>`;
  const kicker = kickT != null
    ? `<div class="kickline" style="animation-delay:${kickT}ms">${esc(slide.title)} · <b>${esc(slide.closes || "")}</b></div>` : "";
  const lower3 = lower3T != null
    ? `<div class="lower3" style="animation-delay:${lower3T}ms"><div class="l3-url">PRIZEDRAWSDAILY.CO.UK</div>
       <div class="l3-handle">@prizedrawsdaily</div><div class="l3-line">${esc(String(sel.seoKeyword || "every live UK draw").toUpperCase())} · UPDATED DAILY</div></div>` : "";
  return `<section class="scene" style="animation: scene-${idx} ${dur}ms linear both">${media}
    <div class="scrim-b"></div>${kicker}${lower3}${stampT != null ? stampBlock(stampText(slide, sel), stampT, outT) : ""}</section>`;
}

// Prize scene (arm A): framed floating card + kinetic title + price pill (+£ count-up).
function prizeScene({ idx, a, b, dur, slide, hero, i, n, qz }) {
  const len = b - a;
  const long = (slide.title || "").length > 24;
  const pillT = qz(a + 700);
  const counterStart = qz(a + 700), counterEnd = Math.min(counterStart + 900, b - 200);
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg"><img src="${hero}"></div></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-in" style="animation: rl-cardin 520ms cubic-bezier(.2,1.6,.3,1) ${a}ms both"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="pcard"><div class="cbg"><img src="${hero}"></div><div class="photo contain"><img src="${hero}"></div>
           ${sweepAt(a + Math.round(len * 0.34))}<div class="pgrad"></div><div class="win-tab">WIN THIS</div></div>
       </div></div></div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card">${sweepAt(a + Math.round(len * 0.34), 1000)}</div>`;
  const tCenter = hero ? "" : " center";
  return `<section class="scene" style="animation: scene-${idx} ${dur}ms linear both">${media}
    <div class="scrim-b"></div>
    <div class="layer-text"><div class="t-drift" style="animation: rl-textdrift ${len}ms ease-in-out ${a}ms both">
      <div class="tblock${tCenter}">
        <div class="scenekick" style="animation-delay:${a}ms">PRIZE ${i} OF ${n} · ${esc(slide.closes || "")}</div>
        <h2 class="rl-title${long ? " long" : ""}">${wordSpans(slide.title, a + 60)}</h2>
        ${cashLine(slide.cashAlt, counterStart, counterEnd)}
        ${slide.odds ? `<div class="rl-closes" style="animation-delay:${a + 240}ms">ODDS <b>${esc(slide.odds)}</b></div>` : ""}
        ${slide.price ? `<div class="rl-pill" style="animation-delay:${pillT}ms">JUST ${esc(String(slide.price).toUpperCase())} A TICKET</div>` : ""}
      </div>
    </div></div></section>`;
}

// Arm B hook scene: cold open events + giant price + question line.
function questionScene({ idx, a, b, dur, slide, hero, stampT, kickT, giantT, qT, sel }) {
  const len = b - a;
  const giant = slide.odds ? esc(slide.odds) : esc(String(slide.price || "").toUpperCase());
  const qLine = slide.odds ? `COULD BE YOU. WORTH A GO?` : `FOR A ${slide.title.toUpperCase()}?`;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg"><img src="${hero}"></div></div></div>
       <div class="layer-card"><div class="hd-drift" style="animation: rl-colddrift ${len}ms ease-in-out ${a}ms both"><div class="photo contain hf-main"><img src="${hero}"></div></div>
         ${sweepAt(a + Math.round(len * 0.5), 1000)}</div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card">${sweepAt(a + Math.round(len * 0.5), 1000)}</div>`;
  return `<section class="scene" style="animation: scene-${idx} ${dur}ms linear both">${media}
    <div class="scrim-b"></div>
    <div class="q-wrap"><div class="giantq wd" style="animation-delay:${giantT}ms">${giant}</div>
      <div class="q-line rl-title">${wordSpans(qLine, qT, { stagger: 70 })}</div></div>
    <div class="kickline" style="animation-delay:${kickT}ms">${esc(slide.title)} · <b>${esc(slide.closes || "")}</b></div>
    ${stampBlock(stampText(slide, sel), stampT)}</section>`;
}

// Arm C countdown scene: flip-clock ticking to the earliest close.
function countdownScene({ idx, a, b, dur, slide, hero, clockT, pillT, closeIso, nowIso }) {
  const len = b - a;
  const long = (slide.title || "").length > 22;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg"><img src="${hero}"></div></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-in" style="animation: rl-cardin 520ms cubic-bezier(.2,1.6,.3,1) ${a}ms both"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="pcard cd-card"><div class="cbg"><img src="${hero}"></div><div class="photo contain"><img src="${hero}"></div>
           ${sweepAt(a + Math.round(len * 0.3))}<div class="pgrad"></div></div>
       </div></div></div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="cd-typo"><div class="rl-giant${long ? " long" : ""}">${wordSpans(slide.title, a + 60)}</div></div>
       </div>${sweepAt(a + Math.round(len * 0.3), 1000)}</div>`;
  return `<section class="scene" style="animation: scene-${idx} ${dur}ms linear both">${media}
    <div class="scrim-b"></div>
    <div class="cd-kick"><span class="scenekick" style="animation-delay:${a}ms;font-size:33px">⏳ <b>${esc(slide.closes || "CLOSES SOON")}</b> · ${esc(slide.title)}</span></div>
    <div class="cd-clock" style="animation-delay:${clockT}ms">${countdownHtml(closeIso, nowIso)}</div>
    ${slide.price ? `<div class="cd-pill"><span class="rl-pill" style="animation-delay:${pillT}ms">JUST ${esc(String(slide.price).toUpperCase())} A TICKET</span></div>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- the timeline
export function buildReelTimeline({ sel, slides, heroes, arm, audioMeta, nowIso = DEFAULT_NOW, closeIso = null }) {
  if (!slides?.length) throw new Error("buildReelTimeline: need at least one slide");
  const theme = themeOf(sel.slug);
  const cfg = catCfg(sel.slug);
  const seed = sel.slug.length * 7 + arm.charCodeAt(0);
  const heroOf = (s) => heroes?.[s.slug] ?? null;
  const top = slides[0];

  // ---- durations first, then the beat grid, then quantize every cut/slam/stamp
  const N = Math.min(slides.length, 5);
  const coldEndRaw = Math.min(Math.max(audioMeta?.dropMs ?? 2000, 2000), 4000); // scene 1 lands on the drop when it's early enough
  const durationMs =
    arm === "A" ? Math.min(18000, Math.max(14000, coldEndRaw + N * 3000 + 2500)) :
    arm === "B" ? 7500 : 10000;
  const grid = audioMeta?.bpm > 0 ? beatGrid(audioMeta, durationMs) : [];
  const qz = (t) => Math.round(quantize(t, grid));
  const step = grid.length > 1 ? grid[1] - grid[0] : 500;

  const scenes = [], dynKf = [], cutTimesMs = [], stampTimesMs = [];
  const stamp1 = qz(500);              // cold-open stamp — scale 3→1 + chroma + body shake by ~500ms
  const kick1 = qz(900);               // TRUE-fact kicker by ~900ms (next beat)
  const outT = durationMs - 400;       // loop outro: stamp winds back out
  let sceneIdx = 0;
  const addScene = (html, a, b) => { dynKf.push(sceneKeyframes(`scene-${sceneIdx}`, a, b, durationMs)); scenes.push(html); sceneIdx++; };

  if (arm === "A") {
    // multi-prize: cold open → a scene per prize (cuts on beats) → top-prize reprise
    const coldEnd = qz(coldEndRaw);
    const repriseStart = qz(durationMs - 2500);
    const bounds = [coldEnd];
    for (let i = 1; i < N; i++) bounds.push(qz(coldEnd + Math.round(((repriseStart - coldEnd) * i) / N)));
    bounds.push(repriseStart);
    for (let i = 1; i < bounds.length; i++) if (bounds[i] <= bounds[i - 1]) bounds[i] = bounds[i - 1] + step; // beat-spaced safety
    cutTimesMs.push(...bounds);
    stampTimesMs.push(stamp1, qz(repriseStart + 800));

    addScene(heroScene({ idx: 0, a: 0, b: bounds[0], dur: durationMs, slide: top, hero: heroOf(top), stampT: stamp1, kickT: kick1, sel }), 0, bounds[0]);
    for (let i = 0; i < N; i++) {
      const a = bounds[i], b = bounds[i + 1];
      addScene(prizeScene({ idx: sceneIdx, a, b, dur: durationMs, slide: slides[i], hero: heroOf(slides[i]), i: i + 1, n: N, qz }), a, b);
    }
    addScene(heroScene({ idx: sceneIdx, a: repriseStart, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(repriseStart + 400), sel }), repriseStart, durationMs);
  } else if (arm === "B") {
    // single-prize hook: giant price/odds question → hard cut to CTA
    const ctaCut = qz(5500);
    cutTimesMs.push(ctaCut);
    stampTimesMs.push(stamp1, qz(6000));
    addScene(questionScene({ idx: 0, a: 0, b: ctaCut, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stamp1, kickT: kick1, giantT: qz(2000), qT: qz(2500), sel }), 0, ctaCut);
    addScene(heroScene({ idx: 1, a: ctaCut, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(ctaCut + 400), sel }), ctaCut, durationMs);
  } else {
    // arm C: closing-tonight countdown (earliest close = slides[0] upstream)
    const cIso = closeIso ?? new Date(Date.parse(nowIso) + DEFAULT_LEFT_MS).toISOString();
    const coldEnd = qz(2000), finStart = qz(7500);
    cutTimesMs.push(coldEnd, finStart);
    stampTimesMs.push(stamp1, qz(finStart + 800));
    addScene(heroScene({ idx: 0, a: 0, b: coldEnd, dur: durationMs, slide: top, hero: heroOf(top), stampT: stamp1, kickT: kick1, sel }), 0, coldEnd);
    addScene(countdownScene({ idx: 1, a: coldEnd, b: finStart, dur: durationMs, slide: top, hero: heroOf(top),
      clockT: qz(coldEnd + 500), pillT: qz(coldEnd + 1000), closeIso: cIso, nowIso }), coldEnd, finStart);
    addScene(heroScene({ idx: 2, a: finStart, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(finStart + 400), sel }), finStart, durationMs);
  }

  // body shake rides every stamp-in (3-frame stamp-shake from stampCss)
  const shake = stampTimesMs.map((t) => `stamp-shake 100ms linear ${t}ms both`).join(", ");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>${TOKEN_CSS}</style>
<style>${stampCss()}</style>
<style>${flipClockCss()}</style>
<style>${REEL_CSS}</style>
<style>${dynKf.join("\n")}</style>
</head><body data-theme="${theme}" data-arm="${arm}">
<!-- reel arm=${arm} dur=${durationMs} cuts=[${cutTimesMs.join(",")}] stamps=[${stampTimesMs.join(",")}] fps=${FPS} -->
<div class="reel" style="animation: ${shake}">
${scenes.join("\n")}
${particleField(cfg.particles, seed)}
<div class="vign"></div>
<div class="flash"></div>
<footer class="rfoot">18+ · UK ONLY · PLAY RESPONSIBLY</footer>
</div>
<script>${SEEK_RUNTIME}</script>
</body></html>`;

  // cover: "{PRIZE NOUN} · {price}" (≤4 words) for reel.mjs's dedicated cover card
  const words = String(top.title || "").trim().split(/\s+/);
  const last = words[words.length - 1] || "";
  const noun = (last.length >= 4 ? last : words.slice(-2).join(" ")).toUpperCase();
  const coverText = top.price ? `${noun} · ${top.price}` : noun;

  return { html, durationMs, stampTimesMs, cutTimesMs, coverText };
}
