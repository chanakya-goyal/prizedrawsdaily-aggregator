// carousel/reel-template.mjs — the animated Reel timeline (spec §4.4) — MOTION v2.
// One HTML document IS the whole Reel: a single deterministic timeline of scenes,
// kinetic type, 3-layer parallax, seeded drifting particles, THE PRICE STAMP and a
// loop outro — all CSS keyframes with explicit delay/duration (WAAPI-seekable), so
// capture.mjs can pause everything and screenshot frame-by-frame at 1080×1920.
//
// v2 ("hype edit" pass — user feedback: every cut must HIT, nothing floats gently):
//   · HOOK (frames 0-36): t=0 opens on the hero DARKENED (.hookdark ~.55 black) with a
//     giant gold "5P?!" (cheapest real price) slamming in by frame 3-6, then a hard
//     flash to full brightness ON the first beat as THE STAMP lands
//   · EVERY cut: 1-2 frame accent flash + 3-frame camera shake (one rl-shakes keyframe
//     track on .reel — a single animation so no same-property fill overrides) + a
//     punch-in (scale 1.06→1) on the incoming SCENE wrapper + a radial streak burst
//   · beat pulse: price pill + stamp swell 1.04→1.00 on EVERY beat (rl-beatpulse,
//     duration = beat step, infinite, delay beat-aligned)
//   · stamp landing: 10 seeded sparks radiate out (rl-spark) + a second body shake
//   · background alive: particles ~2.5× faster, a looping diagonal light sweep, and a
//     continuous zoom-drift on the BLUR fill layers only (.hf-bg/.cbg — never the photo)
//   · urgency: top progress bar (width 0→100%) + a red "CLOSES TONIGHT/TOMORROW" chip
//     that flash-pulses twice per scene (only when the real closes label says so)
//   · pacing: arm A scene holds ≤3s (slides repeat cyclically to fill the 14-18s
//     contract), arm B same 7.5s but denser (hook → stamp → giant odds → CTA)
//
// Anti-ordinary rules still enforced (spec §4.4 — "NOT a slideshow"):
//   · the raw PHOTO layer is NEVER scale-animated: punch-ins live on the scene
//     wrapper (a cut effect), zoom-drift lives on the blurred fill only
//   · every cut/slam/stamp time is quantize(t, beatGrid(audioMeta, durationMs))
//   · loop outro: stamp-out in the final 400ms so last frame ≈ frame 0; URL/handle
//     lower-third rides the FINAL scene (no dead outro card)
//   · compliance footer on every frame
// Determinism: no Date.now()/Math.random() — every jitter (shake directions, streak
// angles, sparks, word tilts) comes from mulberry32 seeded off stable inputs;
// countdowns use build-time ISO.
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

/* ---- scenes: absolutely stacked, visibility = opacity keyframes on ONE timeline.
   v2: every scene ALSO gets rl-punchin (scale 1.06→1, ~5 frames, overshoot) at its cut —
   transform on the WRAPPER (a cut impact), the photo layer itself is never scaled. ---- */
.scene { position:absolute; inset:0; z-index:10; opacity:0; pointer-events:none; }
@keyframes rl-punchin { 0% { transform: scale(1.06); } 70% { transform: scale(.992); } 100% { transform: scale(1); } }
.layer-bg, .layer-card, .layer-text { position:absolute; inset:0; }
.layer-bg { z-index:1; } .layer-card { z-index:3; perspective:1200px; } .layer-text { z-index:5; }
.hd-drift, .b-pan, .c-in, .c-float, .t-drift { position:absolute; inset:0; }

/* full-bleed hero (cold open / reprise): blurred cover fill + sharp contain on top —
   full-bleed WITHOUT cropping the prize, and never scale-animated.
   v2: the BLUR FILL (.hf-bg wrapper — not the photo) gets a continuous zoom-drift. */
.hf-bg { position:absolute; inset:-48px; }
.hf-bg img { width:100%; height:100%; object-fit:cover; filter: blur(42px) saturate(1.55) brightness(.92); opacity:.62; }
@keyframes rl-bgzoom { from { transform: scale(1.02); } to { transform: scale(1.16); } }
@keyframes rl-cbgzoom { from { transform: scale(1); } to { transform: scale(1.1); } }
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

/* v2: slow diagonal light-sweep LOOP across the whole frame — the room never sits still */
.lsweep { position:absolute; top:-25%; bottom:-25%; left:0; width:360px; z-index:32; pointer-events:none;
  mix-blend-mode:screen; opacity:.55;
  background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.13) 50%, rgba(255,255,255,0) 100%);
  animation: rl-lsweep 4800ms linear 0ms infinite; }
@keyframes rl-lsweep { from { transform: translateX(-540px) rotate(16deg); } to { transform: translateX(1620px) rotate(16deg); } }

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

/* ---- kinetic type (v2: harder — scale from 1.6, seeded ±1.6° per-word tilt that the
   word KEEPS at rest, tighter default stagger 85ms) ---- */
.wd { display:inline-block; animation-name: rl-word; animation-duration:400ms;
  animation-timing-function: cubic-bezier(.2,1.9,.3,1); animation-fill-mode:both; }
@keyframes rl-word { 0% { opacity:0; transform: translateY(100px) scale(1.6) rotate(calc(var(--tilt,0deg) * 4)); }
  65% { opacity:1; transform: translateY(-9px) scale(.97) rotate(var(--tilt,0deg)); }
  100% { opacity:1; transform: translateY(0) scale(1) rotate(var(--tilt,0deg)); } }
/* glossy headline recipe (styles.css .hl), reel-scoped and applied per WORD so
   per-word transforms never break background-clip */
.rl-title .wd, .rl-giant .gw, .l3-url, .giantq, .hookp {
  font-family: var(--font-display),'Anton',sans-serif; font-weight:400; text-transform:uppercase; letter-spacing:.5px;
  background: linear-gradient(180deg, #ffffff 0%, #ffffff 46%, var(--ink-end) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  -webkit-text-stroke: 6px var(--stroke); paint-order: stroke fill;
  filter: drop-shadow(0 6px 18px rgba(0,0,0,.72)) drop-shadow(0 0 50px rgba(var(--accent-rgb),.55)); }
.gold-ink.wd, .giantq, .rl-cash b, .hookp {
  background: linear-gradient(180deg, var(--gold-1) 0%, var(--gold-2) 52%, var(--gold-3) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  filter: drop-shadow(0 5px 14px rgba(0,0,0,.72)) drop-shadow(0 0 50px rgba(var(--gold-rgb),.9)); }
.rl-title { font-size:106px; line-height:.94; text-transform:uppercase; }
.rl-title.long { font-size:78px; }
.rl-giant { font-size:126px; line-height:.92; text-transform:uppercase; text-align:center; }
.rl-giant.long { font-size:88px; }
.rl-giant .gw { display:inline-block; }
.giantq { font-size:300px; line-height:.85; letter-spacing:2px; -webkit-text-stroke:8px var(--stroke); }
/* the giant price/odds SLAMS in (scale 2.4→1 overshoot) instead of the word entrance */
.gslam { animation: rl-gslam 300ms cubic-bezier(.16,1.7,.3,1) both; }
@keyframes rl-gslam { 0% { opacity:0; transform: scale(2.4) rotate(-5deg); }
  55% { opacity:1; transform: scale(.94) rotate(1deg); } 100% { opacity:1; transform: scale(1) rotate(-1.2deg); } }

.scenekick { display:inline-block; font-family:'Oswald',sans-serif; font-weight:700; font-size:30px; letter-spacing:5px;
  color: var(--accent); text-transform:uppercase; margin-bottom:24px; text-shadow: 0 0 22px rgba(var(--accent-rgb),.65);
  animation-name: rl-kick; animation-duration:420ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.kickline { position:absolute; left:56px; right:56px; bottom:330px; z-index:8; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:600; font-size:46px; letter-spacing:.5px; text-transform:uppercase; color:#fff;
  text-shadow: 0 2px 12px rgba(0,0,0,.85);
  animation-name: rl-kick; animation-duration:480ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.kickline b { color: var(--hot); font-weight:700; }
@keyframes rl-kick { from { opacity:0; transform: translateY(90px) scale(1.18); } to { opacity:1; transform:none; } }

.rl-cash { margin-top:20px; font-family: var(--font-display),'Anton',sans-serif; font-size:52px; text-transform:uppercase;
  -webkit-text-stroke: 4px var(--stroke); paint-order: stroke fill; color:#fff;
  animation-name: rl-kick; animation-duration:440ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.rl-closes { margin-top:18px; font-family:'Oswald',sans-serif; font-weight:600; font-size:34px; letter-spacing:.5px;
  text-transform:uppercase; color:#fff; text-shadow: 0 2px 10px rgba(0,0,0,.85);
  animation-name: rl-kick; animation-duration:440ms; animation-timing-function:cubic-bezier(.2,1.6,.3,1); animation-fill-mode:both; }
.rl-closes b { color: var(--hot); font-weight:700; }
/* v2: the price POPS — scale 2.2→1 overshoot + an accent glow bloom that flashes and settles */
.rl-pill { display:inline-flex; margin-top:30px; padding:16px 32px; border-radius:14px;
  font-family: var(--font-display),'Anton',sans-serif; font-size:37px; letter-spacing:.4px; text-transform:uppercase; color:#fff;
  background: linear-gradient(135deg, var(--pill-1) 0%, var(--pill-2) 52%, var(--pill-3) 100%);
  border: 2px solid rgba(var(--pill-edge-rgb),.6); text-shadow: 0 2px 4px rgba(var(--pill-ink-rgb),.6);
  box-shadow: 0 12px 32px rgba(var(--accent-deep-rgb),.55), inset 0 1px 0 rgba(255,255,255,.35);
  animation-name: rl-pricepop; animation-duration:420ms; animation-timing-function:cubic-bezier(.2,1.8,.3,1); animation-fill-mode:both; }
@keyframes rl-pricepop {
  0% { opacity:0; transform: scale(2.2) rotate(-6deg); box-shadow: 0 0 0 0 rgba(var(--accent-rgb),0); }
  55% { opacity:1; transform: scale(.93) rotate(1deg); box-shadow: 0 0 110px 34px rgba(var(--accent-rgb),.9); }
  75% { transform: scale(1.06) rotate(-.5deg); }
  100% { opacity:1; transform: scale(1); box-shadow: 0 12px 32px rgba(var(--accent-deep-rgb),.55), inset 0 1px 0 rgba(255,255,255,.35); } }
@keyframes rl-pop { from { opacity:0; transform: scale(2.1) rotate(-5deg); } 65% { opacity:1; transform: scale(.94) rotate(0deg); } to { opacity:1; transform: scale(1); } }
/* beat-pulse wrapper (price pill / stamp): swells 1.04→1.00 on EVERY beat of the grid */
.bp { display:inline-block; }

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

/* ---- seeded particle field: global, continuous, in FRONT of scenes (v2: ~2.5× faster) ---- */
.pfield { position:absolute; inset:0; z-index:30; pointer-events:none; }
.pw { position:absolute; animation-name: rl-drift; animation-timing-function:linear; animation-iteration-count:infinite; }
.pfield .pw > span { animation-name: rl-psway; animation-timing-function:ease-in-out; animation-iteration-count:infinite; animation-direction:alternate; }
.pfield .p-holo { --rot: 45deg; }
@keyframes rl-drift { from { transform: translateY(0); } to { transform: translateY(-2250px); } }
@keyframes rl-psway { from { transform: translateX(calc(var(--amp,12px) * -1)) rotate(var(--rot,0deg)); }
  to { transform: translateX(var(--amp,12px)) rotate(var(--rot,0deg)); } }

/* ---- the stamp slot: identical position/size in every arm and theme ---- */
.stamp-slot { position:absolute; left:50%; top:46%; width:430px; height:430px; margin:-215px 0 0 -215px; z-index:24; }
.s-wrap, .s-pulse, .s-pop, .s-chroma { position:relative; width:100%; height:100%; }
.stamp span { display:block; padding:0 34px; }
.stamp-slot .stamp-ring { animation: stamp-ring 700ms ease-out var(--t-in,0ms) both; }
@keyframes rl-chroma { from { filter: drop-shadow(7px 0 0 rgba(255,45,85,.85)) drop-shadow(-7px 0 0 rgba(0,229,255,.8)); }
  to { filter:none; } }
/* v2: stamp-landing spark burst — seeded spans radiating out and fading over ~10 frames */
.simp { position:absolute; inset:0; z-index:5; pointer-events:none; }
.simp span { position:absolute; left:50%; top:50%; border-radius:50%; opacity:0;
  background: radial-gradient(circle, var(--spark-core) 0%, var(--spark-mid) 55%, rgba(var(--spark-glow-rgb),0) 100%);
  animation: rl-spark 333ms cubic-bezier(.15,.7,.3,1) both; }
@keyframes rl-spark { 0% { opacity:0; transform: translate(-50%,-50%) scale(1); }
  10% { opacity:1; } 100% { opacity:0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(.25); } }

/* ---- v2 CUT IMPACT KIT: accent flash + radial streak burst on EVERY cut ---- */
.cutflash { position:absolute; inset:0; z-index:58; opacity:0; pointer-events:none; mix-blend-mode:screen;
  background: radial-gradient(130% 130% at 50% 44%, #fff 0%, #fff 36%, rgba(var(--accent-rgb),.8) 62%, rgba(var(--accent-rgb),.08) 82%);
  animation: rl-cutflash 67ms linear both; }
@keyframes rl-cutflash { 0% { opacity:0; } 25% { opacity:.92; } 100% { opacity:0; } }
.burst { position:absolute; left:50%; top:44%; width:0; height:0; z-index:46; pointer-events:none; }
.burst span { position:absolute; left:0; top:0; transform-origin: 0 50%; border-radius:999px; opacity:0; mix-blend-mode:screen;
  background: linear-gradient(90deg, rgba(255,255,255,0) 0%, #fff 30%, var(--accent) 62%, rgba(var(--accent-rgb),0) 100%);
  box-shadow: 0 0 14px rgba(var(--accent-rgb),.6);
  animation: rl-streak 267ms cubic-bezier(.12,.9,.25,1) both; }
@keyframes rl-streak { 0% { opacity:0; transform: rotate(var(--a)) translateX(56px) scaleX(.25); }
  10% { opacity:1; } 60% { opacity:.85; } 100% { opacity:0; transform: rotate(var(--a)) translateX(var(--d)) scaleX(1.5); } }

/* ---- v2 HOOK (frames 0-36): darkened open + giant cheapest-price interrupt ---- */
.hookdark { position:absolute; inset:0; z-index:55; background:#000; opacity:0; pointer-events:none;
  animation: rl-hookdark 500ms linear 0ms both; }
@keyframes rl-hookdark { 0% { opacity:.6; } 92% { opacity:.6; } 100% { opacity:0; } }
.hookwrap { position:absolute; inset:0; z-index:57; display:flex; align-items:center; justify-content:center;
  text-align:center; pointer-events:none; }
.hookp-out { animation: rl-hookout 133ms cubic-bezier(.55,0,.8,.4) both; }
@keyframes rl-hookout { 0% { opacity:1; transform: scale(1); } 100% { opacity:0; transform: scale(1.7); } }
.hookp { font-size:330px; line-height:.85; letter-spacing:2px; -webkit-text-stroke:10px var(--stroke);
  animation: rl-hookslam 150ms cubic-bezier(.2,1.9,.3,1) 67ms both; }
.hookp.long { font-size:200px; }
@keyframes rl-hookslam { 0% { opacity:0; transform: scale(3) rotate(7deg); }
  60% { opacity:1; transform: scale(.92) rotate(-2deg); } 100% { opacity:1; transform: scale(1) rotate(-3deg); } }

/* ---- v2 URGENCY FURNITURE ---- */
.pbar { position:absolute; left:0; top:0; right:0; height:10px; z-index:62; background: rgba(255,255,255,.14); }
.pbar i { display:block; height:100%; width:0; background: linear-gradient(90deg, var(--accent) 0%, var(--hot) 100%);
  box-shadow: 0 0 18px rgba(var(--accent-rgb),.8); }
@keyframes rl-pbar { from { width:0; } to { width:100%; } }
.urgechip { position:absolute; left:50%; top:64px; z-index:12; transform: translateX(-50%) rotate(-2deg);
  padding:12px 28px; border-radius:12px; font-family: var(--font-display),'Anton',sans-serif; font-size:31px;
  letter-spacing:2px; color:#fff; text-transform:uppercase; white-space:nowrap;
  background: linear-gradient(135deg, #E8232A 0%, #B00E14 100%); border: 2px solid rgba(255,255,255,.5);
  box-shadow: 0 10px 30px rgba(0,0,0,.5), 0 0 44px rgba(232,35,42,.55); text-shadow: 0 2px 4px rgba(0,0,0,.5);
  animation-name: rl-chipflash; animation-timing-function: linear; animation-fill-mode: both; }
@keyframes rl-chipflash {
  0% { opacity:0; transform: translateX(-50%) rotate(-2deg) scale(.6); filter: brightness(1); }
  4% { opacity:1; transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); }
  14% { transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); }
  17% { transform: translateX(-50%) rotate(-2deg) scale(1.16); filter: brightness(1.7); }
  20% { transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); }
  50% { transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); }
  53% { transform: translateX(-50%) rotate(-2deg) scale(1.16); filter: brightness(1.7); }
  56% { transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); }
  100% { opacity:1; transform: translateX(-50%) rotate(-2deg) scale(1); filter: brightness(1); } }

/* ---- hard flash: ≤1-2 frames, fires ON the hook beat (delay set per-timeline) ---- */
.flash { position:absolute; inset:0; z-index:70; background:#fff; opacity:0; pointer-events:none;
  animation: rl-flash 67ms linear var(--flash-t,150ms) both; }
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
// v2: each word carries a seeded resting tilt (±1.6°, entered at 4×) via --tilt.
const wordSpans = (text, t0, { stagger = 85, cls = "" } = {}) => {
  const rnd = mulberry32(Math.round(t0) * 31 + String(text).length * 7);
  return nbh(esc(String(text))).split(/\s+/).map((w, i) => {
    const tilt = (rnd() * 3.2 - 1.6).toFixed(2);
    return `<span class="wd${cls ? " " + cls : ""}" style="--tilt:${tilt}deg;animation-delay:${t0 + i * stagger}ms">${w}</span>`;
  }).join(" ");
};

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

// scene wrapper punch-in on its cut: the incoming COMPOSITE scales 1.06→1 over ~5
// frames (overshoot bezier dips just under 1 then settles) — the photo itself never
// carries a scale animation; this is a cut impact on the wrapper, not a Ken-Burns dwell.
const sceneAnim = (idx, a, dur) =>
  `animation: scene-${idx} ${dur}ms linear both, rl-punchin 167ms cubic-bezier(.18,1.6,.4,1) ${a}ms both`;

const stampText = (slide, sel) =>
  slide?.price ? `JUST ${String(slide.price).toUpperCase()} A TICKET` : `LIVE ${String(sel.name || "UK DRAWS").toUpperCase()}`;

// beat-pulse wrapper: swells 1.04→1 on every beat while its content is visible.
const beatPulse = (t0, step, inner) =>
  `<span class="bp" style="animation: rl-beatpulse ${Math.max(1, Math.round(step))}ms linear ${t0}ms infinite both">${inner}</span>`;

// THE PRICE STAMP at a moment on the timeline. stamp-in/ring/chroma on wrappers so
// stampHtml stays verbatim; optional stamp-out (loop outro) on its own wrapper —
// its 0% state is identity, so it can't mask the entrance. v2 adds: a beat-pulse
// wrapper (.s-pulse) and a seeded spark burst (.simp) firing as the stamp LANDS
// (~55% of the 560ms stamp-in = +310ms — the slam frame).
function stampBlock(text, inMs, outMs = null, step = 500) {
  const rnd = mulberry32(Math.round(inMs) + text.length * 131);
  let sparks = "";
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + rnd() * 0.6;
    const d = Math.round(240 + rnd() * 190);
    const size = Math.round(9 + rnd() * 8);
    sparks += `<span style="--dx:${Math.round(Math.cos(ang) * d)}px;--dy:${Math.round(Math.sin(ang) * d)}px;width:${size}px;height:${size}px;animation-delay:${Math.round(inMs + 310)}ms"></span>`;
  }
  const out = outMs != null ? ` style="animation: stamp-out 400ms cubic-bezier(.55,0,.85,.36) ${outMs}ms both"` : "";
  return `<div class="stamp-slot" style="--t-in:${inMs}ms"><div class="simp">${sparks}</div><div class="s-wrap"${out}>
    <div class="s-pulse" style="animation: rl-beatpulse ${Math.max(1, Math.round(step))}ms linear ${inMs}ms infinite both">
    <div class="s-pop" style="animation: stamp-in 560ms cubic-bezier(.2,2,.3,1) ${inMs}ms both">
      <div class="s-chroma" style="animation: rl-chroma 67ms linear ${inMs}ms both">${stampHtml(esc(text))}</div>
    </div></div></div></div>`;
}

// urgency chip: only when the REAL closes label says tonight/tomorrow — flash-pulses
// twice per scene (double-peak keyframes over the scene's own duration).
function urgeChip(slide, a, len) {
  if (!/^CLOSES (TONIGHT|TOMORROW)/.test(String(slide?.closes || ""))) return "";
  return `<div class="urgechip" style="animation-duration:${len}ms;animation-delay:${a}ms">⚠ ${esc(slide.closes)}</div>`;
}

// seeded, continuously-drifting particle field (positions/speeds from mulberry32)
// v2: drift ~2.5× faster (9-20s → 3.6-8s per screen-height) — the air is ALIVE.
function particleField(profile, seed) {
  const { type = "embers", count = 46 } = profile || {};
  if (type === "none" || count <= 0) return "";
  const rnd = mulberry32(seed);
  let s = "";
  for (let i = 0; i < count; i++) {
    const left = (rnd() * 100).toFixed(2), top = (rnd() * 112 - 6).toFixed(2);
    const size = (3 + rnd() * 9).toFixed(1), op = (0.2 + rnd() * 0.5).toFixed(2);
    const dDur = Math.round(3600 + rnd() * 4400);            // 1.0× parallax layer, v2 speed
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

// blur-fill zoom-drift (backdrop only — the sharp photo never scales)
const bgZoom = (a, len) => `animation: rl-bgzoom ${len}ms ease-in-out ${a}ms both`;
const cbgZoom = (a, len) => `animation: rl-cbgzoom ${len}ms ease-in-out ${a}ms both`;

// ---------------------------------------------------------------- v2 impact kit
// ONE body-shake keyframe track for the whole timeline: several comma-listed shake
// animations on the same element silently override each other (a later animation's
// fill phase pins transform to its 0% row), so all impacts are merged into a single
// rl-shakes animation — 3 frames of seeded translate + a 1.02 scale so edges never show.
function shakeTrack(impacts, dur, seed) {
  const rnd = mulberry32(seed);
  const p = (t) => +((Math.min(Math.max(t, 0), dur) / dur) * 100).toFixed(4);
  const rows = ["0%{transform:none}"];
  const ts = [...new Set(impacts.map((t) => Math.round(t)))].sort((x, y) => x - y)
    .filter((t) => t >= 100 && t <= dur - 160);
  let last = -1e9;
  for (const t of ts) {
    if (t - last < 150) continue;
    last = t;
    const a = 11 + rnd() * 8, sx = rnd() < 0.5 ? -1 : 1, sy = rnd() < 0.5 ? -1 : 1;
    rows.push(`${p(t - 1)}%{transform:none}`);
    rows.push(`${p(t)}%{transform:translate(${(sx * a).toFixed(1)}px,${(-sy * a * 0.7).toFixed(1)}px) scale(1.025)}`);
    rows.push(`${p(t + 33)}%{transform:translate(${(-sx * a * 0.75).toFixed(1)}px,${(sy * a * 0.55).toFixed(1)}px) scale(1.018)}`);
    rows.push(`${p(t + 67)}%{transform:translate(${(sx * a * 0.4).toFixed(1)}px,${(-sy * a * 0.3).toFixed(1)}px) scale(1.01)}`);
    rows.push(`${p(t + 100)}%{transform:none}`);
  }
  rows.push("100%{transform:none}");
  return `@keyframes rl-shakes { ${rows.join(" ")} }`;
}

// per-cut overlay: 1-2 frame accent flash + a seeded radial streak burst (~8 frames)
function cutFxHtml(times, dur, seed) {
  const rnd = mulberry32(seed);
  let s = "";
  for (const t of times) {
    if (t <= 0 || t >= dur - 120) continue;
    let spans = "";
    for (let i = 0; i < 12; i++) {
      const ang = Math.round(i * 30 + rnd() * 18 - 9);
      const d = Math.round(400 + rnd() * 360);
      const len = Math.round(200 + rnd() * 200);
      const th = (4 + rnd() * 4).toFixed(1);
      const dl = Math.round(rnd() * 33);
      spans += `<span style="--a:${ang}deg;--d:${d}px;width:${len}px;height:${th}px;animation-delay:${t + dl}ms"></span>`;
    }
    s += `<div class="cutflash" style="animation-delay:${t}ms"></div><div class="burst">${spans}</div>`;
  }
  return s;
}

// hook interrupt: cheapest REAL ticket price across the selection, "5P?!"-style.
const priceVal = (p) => {
  const m = /^(\d+(?:\.\d+)?)p$/i.exec(String(p || ""));
  if (m) return +m[1] / 100;
  const m2 = /^£\s?(\d+(?:\.\d+)?)/.exec(String(p || ""));
  return m2 ? +m2[1] : Infinity;
};
function hookHtml(slides, flashT) {
  const cheap = slides.reduce((best, s) => (priceVal(s.price) < priceVal(best?.price) ? s : best), null);
  const txt = cheap?.price != null && priceVal(cheap.price) < Infinity
    ? `${String(cheap.price).toUpperCase()}?!` : "WIN?!";
  const long = txt.length > 5;
  return `<div class="hookdark" style="animation-duration:${flashT}ms"></div>
<div class="hookwrap"><div class="hookp-out" style="animation-delay:${flashT}ms"><div class="hookp${long ? " long" : ""}">${esc(txt)}</div></div></div>`;
}

// ---------------------------------------------------------------- scene builders
// Cold open / reprise: full-bleed hero (or typographic hero when no photo).
function heroScene({ idx, a, b, dur, slide, hero, stampT, kickT, lower3T = null, outT = null, sel, step = 500 }) {
  const len = b - a;
  const long = (slide.title || "").length > 22;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg" style="${bgZoom(a, len)}"><img src="${hero}"></div></div></div>
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
  return `<section class="scene" style="${sceneAnim(idx, a, dur)}">${media}
    <div class="scrim-b"></div>${urgeChip(slide, a, len)}${kicker}${lower3}${stampT != null ? stampBlock(stampText(slide, sel), stampT, outT, step) : ""}</section>`;
}

// Prize scene (arm A): framed floating card + kinetic title + price pill (+£ count-up).
function prizeScene({ idx, a, b, dur, slide, hero, i, n, qz, step = 500 }) {
  const len = b - a;
  const long = (slide.title || "").length > 24;
  const pillT = qz(a + 700);
  const counterStart = qz(a + 700), counterEnd = Math.min(counterStart + 900, b - 200);
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg" style="${bgZoom(a, len)}"><img src="${hero}"></div></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-in" style="animation: rl-cardin 520ms cubic-bezier(.2,1.6,.3,1) ${a}ms both"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="pcard"><div class="cbg" style="${cbgZoom(a, len)}"><img src="${hero}"></div><div class="photo contain"><img src="${hero}"></div>
           ${sweepAt(a + Math.round(len * 0.34))}<div class="pgrad"></div><div class="win-tab">WIN THIS</div></div>
       </div></div></div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card">${sweepAt(a + Math.round(len * 0.34), 1000)}</div>`;
  const tCenter = hero ? "" : " center";
  return `<section class="scene" style="${sceneAnim(idx, a, dur)}">${media}
    <div class="scrim-b"></div>${urgeChip(slide, a, len)}
    <div class="layer-text"><div class="t-drift" style="animation: rl-textdrift ${len}ms ease-in-out ${a}ms both">
      <div class="tblock${tCenter}">
        <div class="scenekick" style="animation-delay:${a}ms">PRIZE ${i} OF ${n} · ${esc(slide.closes || "")}</div>
        <h2 class="rl-title${long ? " long" : ""}">${wordSpans(slide.title, a + 60)}</h2>
        ${cashLine(slide.cashAlt, counterStart, counterEnd)}
        ${slide.odds ? `<div class="rl-closes" style="animation-delay:${a + 240}ms">ODDS <b>${esc(slide.odds)}</b></div>` : ""}
        ${slide.price ? beatPulse(pillT, step, `<div class="rl-pill" style="animation-delay:${pillT}ms">JUST ${esc(String(slide.price).toUpperCase())} A TICKET</div>`) : ""}
      </div>
    </div></div></section>`;
}

// Arm B hook scene: cold open events + giant price + question line.
// stampOutT: the cold-open stamp winds OUT before the giant odds/price slams in — the
// two share the centre of the frame; without the out the badge sits on top of the giant
// text and hides its first line (found in Task 6 keyframe QA).
function questionScene({ idx, a, b, dur, slide, hero, stampT, stampOutT, kickT, giantT, qT, sel, step = 500 }) {
  const len = b - a;
  const giant = slide.odds ? esc(slide.odds) : esc(String(slide.price || "").toUpperCase());
  const qLine = slide.odds ? `COULD BE YOU. WORTH A GO?` : `FOR A ${slide.title.toUpperCase()}?`;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg" style="${bgZoom(a, len)}"><img src="${hero}"></div></div></div>
       <div class="layer-card"><div class="hd-drift" style="animation: rl-colddrift ${len}ms ease-in-out ${a}ms both"><div class="photo contain hf-main"><img src="${hero}"></div></div>
         ${sweepAt(a + Math.round(len * 0.5), 1000)}</div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card">${sweepAt(a + Math.round(len * 0.5), 1000)}</div>`;
  return `<section class="scene" style="${sceneAnim(idx, a, dur)}">${media}
    <div class="scrim-b"></div>${urgeChip(slide, a, len)}
    <div class="q-wrap"><div class="gslam" style="animation-delay:${giantT}ms"><div class="giantq">${giant}</div></div>
      <div class="q-line rl-title">${wordSpans(qLine, qT, { stagger: 80 })}</div></div>
    <div class="kickline" style="animation-delay:${kickT}ms">${esc(slide.title)} · <b>${esc(slide.closes || "")}</b></div>
    ${stampBlock(stampText(slide, sel), stampT, stampOutT, step)}</section>`;
}

// Arm C countdown scene: flip-clock ticking to the earliest close.
function countdownScene({ idx, a, b, dur, slide, hero, clockT, pillT, closeIso, nowIso, step = 500 }) {
  const len = b - a;
  const long = (slide.title || "").length > 22;
  const media = hero
    ? `<div class="layer-bg"><div class="b-pan" style="animation: rl-bgpan ${len}ms ease-in-out ${a}ms both"><div class="hf-bg" style="${bgZoom(a, len)}"><img src="${hero}"></div></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-in" style="animation: rl-cardin 520ms cubic-bezier(.2,1.6,.3,1) ${a}ms both"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="pcard cd-card"><div class="cbg" style="${cbgZoom(a, len)}"><img src="${hero}"></div><div class="photo contain"><img src="${hero}"></div>
           ${sweepAt(a + Math.round(len * 0.3))}<div class="pgrad"></div></div>
       </div></div></div>`
    : `<div class="layer-bg"><div class="rl-bloom"></div><div class="rl-rays"></div><div class="rl-glow"></div></div>
       <div class="layer-card"><div class="c-float" style="animation: rl-float ${len}ms ease-in-out ${a}ms both">
         <div class="cd-typo"><div class="rl-giant${long ? " long" : ""}">${wordSpans(slide.title, a + 60)}</div></div>
       </div>${sweepAt(a + Math.round(len * 0.3), 1000)}</div>`;
  return `<section class="scene" style="${sceneAnim(idx, a, dur)}">${media}
    <div class="scrim-b"></div>${urgeChip(slide, a, len)}
    <div class="cd-kick"><span class="scenekick" style="animation-delay:${a}ms;font-size:33px">⏳ <b>${esc(slide.closes || "CLOSES SOON")}</b> · ${esc(slide.title)}</span></div>
    <div class="cd-clock" style="animation-delay:${clockT}ms">${countdownHtml(closeIso, nowIso)}</div>
    ${slide.price ? `<div class="cd-pill">${beatPulse(pillT, step, `<span class="rl-pill" style="animation-delay:${pillT}ms">JUST ${esc(String(slide.price).toUpperCase())} A TICKET</span>`)}</div>` : ""}
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
  // v2 pacing: cold open capped at 3s, arm-A prize holds target ~2.6s (max 3s per cut)
  const coldEndRaw = Math.min(Math.max(audioMeta?.dropMs ?? 2000, 2000), 3000); // scene 1 lands on the drop when it's early enough
  const durationMs =
    arm === "A" ? Math.min(18000, Math.max(14000, coldEndRaw + N * 2600 + 2400)) :
    arm === "B" ? 7500 : 10000;
  const grid = audioMeta?.bpm > 0 ? beatGrid(audioMeta, durationMs) : [];
  const qz = (t) => Math.round(quantize(t, grid));
  const step = grid.length > 1 ? grid[1] - grid[0] : 500;

  const scenes = [], dynKf = [], cutTimesMs = [], stampTimesMs = [], fxTimesMs = [];
  const stamp1 = qz(500);              // cold-open stamp — scale 3→1 + chroma + body shake ON the first beat
  const kick1 = qz(900);               // TRUE-fact kicker by ~900ms (next beat)
  const outT = durationMs - 400;       // loop outro: stamp winds back out
  let sceneIdx = 0;
  const addScene = (html, a, b) => { dynKf.push(sceneKeyframes(`scene-${sceneIdx}`, a, b, durationMs)); scenes.push(html); sceneIdx++; };

  if (arm === "A") {
    // multi-prize: cold open → prize scenes (≤3s holds, slides repeat cyclically to
    // fill the 14-18s contract, every cut on a beat) → top-prize reprise
    const coldEnd = qz(coldEndRaw);
    const repriseStart = qz(durationMs - 2400);
    const M = repriseStart - coldEnd;
    const nScenes = Math.max(N, Math.ceil(M / 3000));
    const bounds = [coldEnd];
    for (let i = 1; i < nScenes; i++) bounds.push(qz(coldEnd + Math.round((M * i) / nScenes)));
    bounds.push(repriseStart);
    for (let i = 1; i < bounds.length; i++) if (bounds[i] <= bounds[i - 1]) bounds[i] = bounds[i - 1] + step; // beat-spaced safety
    cutTimesMs.push(...bounds);
    stampTimesMs.push(stamp1, qz(repriseStart + 800));

    addScene(heroScene({ idx: 0, a: 0, b: bounds[0], dur: durationMs, slide: top, hero: heroOf(top), stampT: stamp1, kickT: kick1, sel, step }), 0, bounds[0]);
    for (let i = 0; i < nScenes; i++) {
      const a = bounds[i], b = bounds[i + 1];
      const s = slides[i % N];
      addScene(prizeScene({ idx: sceneIdx, a, b, dur: durationMs, slide: s, hero: heroOf(s), i: (i % N) + 1, n: N, qz, step }), a, b);
    }
    addScene(heroScene({ idx: sceneIdx, a: repriseStart, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(repriseStart + 400), sel, step }), repriseStart, durationMs);
  } else if (arm === "B") {
    // single-prize hook, v2-dense: dark hook + price interrupt (global) → stamp on beat 1
    // → giant odds slam (its own flash+shake) → question line → earlier hard cut to CTA
    const ctaCut = qz(5000);
    const giantT = qz(2000);
    cutTimesMs.push(ctaCut);
    stampTimesMs.push(stamp1, qz(5500));
    fxTimesMs.push(giantT); // the odds slam hits like a cut: accent flash + streaks + shake
    addScene(questionScene({ idx: 0, a: 0, b: ctaCut, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stamp1, stampOutT: Math.max(giantT - 400, stamp1 + 620), kickT: kick1, giantT, qT: qz(2400), sel, step }), 0, ctaCut);
    addScene(heroScene({ idx: 1, a: ctaCut, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(ctaCut + 400), sel, step }), ctaCut, durationMs);
  } else {
    // arm C: closing-tonight countdown (earliest close = slides[0] upstream)
    const cIso = closeIso ?? new Date(Date.parse(nowIso) + DEFAULT_LEFT_MS).toISOString();
    const coldEnd = qz(2000), finStart = qz(7500);
    cutTimesMs.push(coldEnd, finStart);
    stampTimesMs.push(stamp1, qz(finStart + 800));
    addScene(heroScene({ idx: 0, a: 0, b: coldEnd, dur: durationMs, slide: top, hero: heroOf(top), stampT: stamp1, kickT: kick1, sel, step }), 0, coldEnd);
    addScene(countdownScene({ idx: 1, a: coldEnd, b: finStart, dur: durationMs, slide: top, hero: heroOf(top),
      clockT: qz(coldEnd + 500), pillT: qz(coldEnd + 1000), closeIso: cIso, nowIso, step }), coldEnd, finStart);
    addScene(heroScene({ idx: 2, a: finStart, b: durationMs, dur: durationMs, slide: top, hero: heroOf(top),
      stampT: stampTimesMs[1], outT, lower3T: qz(finStart + 400), sel, step }), finStart, durationMs);
  }

  // ---- v2 impact kit: every cut + every stamp (onset AND ~+310ms landing slam) +
  // arm-specific extra hits shake the CAMERA via one merged keyframe track; every cut
  // (and extra hit) also fires an accent flash + streak burst overlay.
  const hitTimes = [...cutTimesMs, ...fxTimesMs];
  const impacts = [...hitTimes, ...stampTimesMs, ...stampTimesMs.map((t) => t + 310), 200 /* hook price landing */];
  dynKf.push(shakeTrack(impacts, durationMs, seed * 17 + 3));
  const pulsePeak = Math.min(70, Math.max(8, Math.round((133 / step) * 100)));
  dynKf.push(`@keyframes rl-beatpulse { 0%{transform:scale(1.04)} ${pulsePeak}%{transform:scale(1)} 100%{transform:scale(1)} }`);
  const fxHtml = cutFxHtml(hitTimes, durationMs, seed * 131 + 7);

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>${TOKEN_CSS}</style>
<style>${stampCss()}</style>
<style>${flipClockCss()}</style>
<style>${REEL_CSS}</style>
<style>${dynKf.join("\n")}</style>
</head><body data-theme="${theme}" data-arm="${arm}">
<!-- reel arm=${arm} dur=${durationMs} cuts=[${cutTimesMs.join(",")}] stamps=[${stampTimesMs.join(",")}] fps=${FPS} -->
<div class="reel" style="animation: rl-shakes ${durationMs}ms linear 0ms both">
${scenes.join("\n")}
${fxHtml}
${particleField(cfg.particles, seed)}
<div class="lsweep"></div>
<div class="vign"></div>
${hookHtml(slides, stamp1)}
<div class="flash" style="--flash-t:${stamp1}ms"></div>
<div class="pbar"><i style="animation: rl-pbar ${durationMs}ms linear 0ms both"></i></div>
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
