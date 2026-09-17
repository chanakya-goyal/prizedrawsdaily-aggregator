// The 9:16 Reel — a broadcast insert over a full-bleed photograph.
//
// WHAT THIS REPLACED, AND WHY
// The old template was a dark, orange, particle-and-glow montage with a price stamp, a flip
// clock, camera shake and a confetti layer. Every element of it sat OUTSIDE Meta's safe box —
// verified, including `.pcard`, which breached all four edges — so the price, the deadline, the
// CTA and the handle were all in territory Instagram's own UI can cover. It also built its CSS
// by regex-scraping styles.css, which meant per-category structure could never reach it.
//
// THE GRAMMAR NOW: one photograph per draw, full bleed, with persistent chrome over it that
// EXPANDS to state the numbers, HOLDS, then COLLAPSES to give the photograph back. The rail and
// the conditions band never move; only the insert card does. That is the shape the research
// calls a broadcast insert, and it is the only one that keeps a dominant photograph — which
// matters because Instagram makes reels "less visible" when they are "majority text" or carry
// borders, and a dominant photograph is the defence.
//
// THE LOOP IS CLOSED BY CONSTRUCTION, not by luck. Frame 0 and the final frame must be the same
// picture, because a seamless loop is measured as replays rather than as a new viewer: Views
// count "starts to play or replay" and Watch time includes replays, so a loop inflates both
// without reaching one extra person. Two things make it close: the reel RETURNS to the first
// photograph with the card collapsed, and the total duration is a whole multiple of the
// category scene's own loop, so the scene is also back at phase 0.
import { fontFaceCss } from "./fonts.mjs";
import { tokenCss } from "./tokens.mjs";
import { sceneFor, sceneBack, sceneMotion } from "./scene.mjs";
import * as oddsCopy from "./odds-copy.mjs";
import { cleanTitle, closesLabel, priceLabel } from "./format.mjs";
import { beatGrid, quantize } from "./beat.mjs";

const FONT_CSS = await fontFaceCss();
const FPS = 30, FRAME = 1000 / FPS;
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nbh = (s = "") => String(s).replace(/(\w)-(\w)/g, "$1‑$2");

// Meta's Derived Safe Box A, edge-detected from their own 9:16 diagram, and the L-notch.
export const SAFE = { x: 65, y: 269, w: 950, h: 883 };
export const L_NOTCH = { x: 853, y: 1152, w: 227, h: 768 };

// The chrome rects. This is the sole normative source: the scene lanes ARE these rects, and
// nothing else in the system types them.
export const CHROME = {
  rail:  { y: 269,  h: 116 },                 // static, always, carries the mark and the stamp
  card:  { y: 661,  h: 346 },                 // expands from a fixed floor at y 1007
  band:  { y: 1007, h: 145 },                 // the conditions band, static, always
};
// Collapsed chrome is the rail plus the band: 116 + 145 = 261px. Expanded adds the card:
// 116 + 346 + 145 = 607px. The photograph keeps the rest, which is the whole point.
export const CHROME_COLLAPSED = CHROME.rail.h + CHROME.band.h;
export const CHROME_EXPANDED = CHROME_COLLAPSED + CHROME.card.h;

// The seek runtime, unchanged. It pauses every animation and sets currentTime, which is what
// makes a CSS timeline frame-addressable and therefore deterministic.
export const SEEK_RUNTIME = `
window.__vt = 0;
window.__seek = (tMs) => {
  window.__vt = tMs;
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = tMs; }
};
(async () => {
  try { await document.fonts.ready; } catch {}
  const wait = (im) => (!im || im.complete) ? null : new Promise((r) => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  try { await document.fonts.ready; } catch {}
  for (const a of document.getAnimations()) a.pause();
  window.__ready = true;
})();`;

// ---------------------------------------------------------------- timing

const RETURN_MS = 600;      // the tail that brings the first photograph back, so the loop closes
const EXPAND_MS = 380;      // the insert rising from its floor
const COLLAPSE_MS = 300;    // and dropping back
const OPEN_SHARE = 0.20;    // share of a segment spent on the open window before the insert rises

// Duration is chosen so the CATEGORY SCENE is back at phase 0 at the end. A scene that animates
// has a loop of 1800-6000ms; a reel that is not a whole multiple of it ends mid-drift, the final
// frame differs from frame 0, and the loop assertion fails — correctly, because the loop really
// would visibly jump.
export function pickDuration({ loopMs = 0, targetMs = 15000 } = {}) {
  if (!loopMs) return targetMs;
  const loops = Math.max(2, Math.round(targetMs / loopMs));
  return loops * loopMs;
}

// How many draws fit. Each needs enough room to open, state its numbers and close; below that
// the insert is a flicker rather than a beat.
const MIN_SEGMENT_MS = 3200;
export function planSegments({ durationMs, drawCount, grid = [] }) {
  const usable = durationMs - RETURN_MS;
  const n = Math.max(1, Math.min(drawCount, Math.floor(usable / MIN_SEGMENT_MS)));
  const seg = usable / n;
  const q = (t) => (grid.length ? Math.round(quantize(t, grid)) : Math.round(t));
  return Array.from({ length: n }, (_, i) => {
    // The FIRST segment starts at exactly 0, never on the nearest beat. Quantising it pushed
    // the opening cut to the first downbeat — 202ms on a 112 BPM bed — which left the first six
    // frames with no photograph at all, black. That also breaks the loop: frame 0 would be empty
    // while the final frame carries the returned photograph.
    const a = i === 0 ? 0 : q(i * seg);
    const b = i === n - 1 ? usable : q((i + 1) * seg);
    const openFor = Math.round((b - a) * OPEN_SHARE);
    const expandAt = q(a + openFor);
    const collapseAt = Math.max(expandAt + EXPAND_MS + 400, b - COLLAPSE_MS);
    return { i, a, b, expandAt, collapseAt };
  });
}

// ---------------------------------------------------------------- css

const REEL_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden}
body{background:var(--ink);color:var(--ink);font-family:var(--font-text),system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.reel{position:relative;width:1080px;height:1920px;overflow:hidden}

/* The photograph is FULL BLEED and sits under everything. It is the thing that pays. */
.shot{position:absolute;inset:0;opacity:0}
.shot img{width:100%;height:100%;object-fit:cover;display:block}

/* Scene lanes. #scene-back is ABOVE the photograph here and clipped to its lanes, so it is
   chrome texture rather than a backdrop. */
.scene-host{position:absolute;inset:0;pointer-events:none}

/* Persistent chrome. Neither of these ever moves; a moving brand mark reads as an error. */
.rail{position:absolute;left:0;width:1080px;background:var(--rail);display:flex;
  align-items:center;justify-content:space-between;padding:0 65px}
.wordmark{font-family:var(--font-display);font-weight:800;font-size:var(--fs-label);
  letter-spacing:1.5px;color:var(--rail-ink);text-transform:uppercase;line-height:1}
.stamp{font-family:var(--font-figure);font-weight:700;font-size:var(--fs-label);
  color:var(--rail-accent);line-height:1;white-space:nowrap}

/* The insert card grows UPWARD from a fixed floor under overflow:hidden, so the rows are
   revealed rather than flown in. Anchoring it by its bottom edge is what makes that true. */
.card{position:absolute;left:0;width:1080px;background:var(--ground);overflow:hidden;height:0}
.card-inner{position:absolute;left:0;bottom:0;width:1080px;height:346px;padding:0 65px}
.rowB{height:90px;display:flex;align-items:center}
.prize{font-family:var(--font-display);font-weight:700;font-size:var(--fs-lead);
  line-height:60px;color:var(--ink);text-transform:uppercase;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;width:950px}
.rowC{height:256px;padding:8px 0}
.eyebrow{font-weight:600;font-size:var(--fs-label);line-height:var(--lh-label);height:50px;
  letter-spacing:var(--tr-label);text-transform:uppercase;color:var(--ink-meta)}
.figure{font-family:var(--font-figure);font-weight:700;font-size:var(--fs-figure);
  line-height:var(--lh-figure);height:120px;color:var(--ink);font-variant-numeric:tabular-nums}
.cond{font-weight:600;font-size:var(--fs-label);line-height:var(--lh-label);height:50px;color:var(--ink)}

/* The conditions band. Opaque, static, and the reason the whole frame is compliant: the ASA
   does not treat a social post as space-limited, so every significant condition ships on it. */
.band{position:absolute;left:0;width:1080px;background:var(--rail);padding:16px 65px;
  display:flex;flex-direction:column;justify-content:center}
.band .set{position:absolute;left:65px;right:65px;opacity:0}
.band .l{font-size:var(--fs-legal);line-height:var(--lh-legal);white-space:nowrap}
.band .l1{font-weight:600;color:var(--rail-ink);text-transform:uppercase}
.band .l1.soon{color:var(--closing)}
.band .l2,.band .l3{font-weight:400;color:var(--rail-meta)}

/* Per-element keyframes are emitted per reel — see trackCss(). There are deliberately NO
   shared open/close pairs here any more.

   WHY: the first version put TWO animations on one property, card-open delayed to the expand
   time and card-shut delayed to the collapse time, both with fill-mode 'both'. The backwards
   fill of the LAST animation wins, so before its delay card-shut held its own FROM value —
   346px — and every insert card was already open at t=0. Every band line was visible at once
   for the same reason. One animation per element, spanning the whole timeline, cannot have that
   bug, and it makes periodicity structural: 0% and 100% are written to be the same frame. */
`;

// One animation per element, spanning the WHOLE reel, with the timings baked in as percentages.
// A cut is a hard switch rather than a dissolve — a dissolve between two operators' photographs
// reads as a slideshow, and the beat is what makes it read as an edit — so the visibility steps
// take one frame.
function trackCss(segs, durationMs) {
  const pct = (t) => Math.max(0, Math.min(100, (t / durationMs) * 100));
  const step = (FRAME / durationMs) * 100;                 // one frame, as a percentage
  const f = (v) => v.toFixed(4);
  const out = [];
  const last = segs.length - 1;

  segs.forEach((s, i) => {
    // VISIBILITY. Segment 0 owns both ends of the timeline: it is visible from 0, hands over at
    // its own cut, and comes BACK for the return tail. That is what closes the loop, and doing
    // it with one element rather than a duplicated "home" shot is what makes 0% and 100%
    // provably the same frame instead of two frames that happen to look alike.
    const homeAt = pct(durationMs - RETURN_MS);
    out.push(i === 0
      ? `@keyframes shot-0{0%,${f(pct(s.b))}%{opacity:1}${f(pct(s.b) + step)}%,${f(homeAt)}%{opacity:0}${f(homeAt + step)}%,100%{opacity:1}}`
      : `@keyframes shot-${i}{0%,${f(pct(s.a))}%{opacity:0}${f(pct(s.a) + step)}%,${f(pct(s.b))}%{opacity:1}${f(pct(s.b) + step)}%,100%{opacity:0}}`);
    out.push(i === 0
      ? `@keyframes band-0{0%,${f(pct(s.b))}%{opacity:1}${f(pct(s.b) + step)}%,${f(homeAt)}%{opacity:0}${f(homeAt + step)}%,100%{opacity:1}}`
      : `@keyframes band-${i}{0%,${f(pct(s.a))}%{opacity:0}${f(pct(s.a) + step)}%,${f(pct(s.b))}%{opacity:1}${f(pct(s.b) + step)}%,100%{opacity:0}}`);

    // THE INSERT. Closed from 0% to the expand, open across the hold, closed again to 100%, so
    // the card is collapsed at both ends of the timeline whatever else happens in between.
    const e0 = pct(s.expandAt), e1 = pct(s.expandAt + EXPAND_MS);
    const c0 = pct(s.collapseAt), c1 = pct(s.collapseAt + COLLAPSE_MS);
    out.push(`@keyframes card-${i}{0%,${f(e0)}%{height:0}${f(e1)}%,${f(c0)}%{height:346px}${f(c1)}%,100%{height:0}}`);
  });
  return out.join("\n");
}

// ---------------------------------------------------------------- build

export function buildReelTimeline({ sel, slides, heroes = {}, arm = "A", audioMeta = null, nowIso = null, closeIso = null }) {
  const draws = (sel?.draws || []).filter((d) => Number(d.total_entries) > 0 && (heroes[d.slug] || d.image_url));
  if (!draws.length) throw new Error("buildReelTimeline: no draw carries both a ticket cap and a photograph — refusing to render a reel with nothing to state");

  const scene = sceneFor(sel.slug);
  const durationMs = pickDuration({ loopMs: scene.loopMs, targetMs: 15000 });
  const grid = audioMeta?.bpm > 0 ? beatGrid(audioMeta, durationMs) : [];
  const segs = planSegments({ durationMs, drawCount: draws.length, grid });
  const used = draws.slice(0, segs.length);
  const last = segs.length - 1;

  const checked = (sel.draws || []).map((d) => d.figures_checked_at).filter(Boolean).sort();
  const stampText = checked.length
    ? oddsCopy.stampShort(new Date(checked[0]).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }))
    : "";

  const shots = [];
  const cards = [];
  const bands = [];
  const tracks = trackCss(segs, durationMs);
  used.forEach((d, i) => {
    const s = segs[i];
    const hero = heroes[d.slug] || d.image_url;
    const cap = Number(d.total_entries);
    const title = cleanTitle(d.grand_prize || d.title);
    const soon = (new Date(d.draw_date) - Date.now()) < 48 * 3600e3;
    const host = (() => { try { return new URL(d.entry_url).hostname.replace(/^www\./, ""); } catch { return "the operator's own site"; } })();
    const lines = oddsCopy.bandLines({
      role: "reel-card", closesText: closesLabel(d.draw_date),
      price: priceLabel(d.ticket_price) || "n/a", host, freeEntryRoute: d.free_entry_route || "unknown",
    });

    const anim = (name, ease = "linear") => `${name}-${i} ${durationMs}ms ${ease} 0ms both`;
    shots.push(`<div class="shot" style="animation:${anim("shot")}"><img src="${hero}"></div>`);
    cards.push(`<div class="card" style="top:${CHROME.card.y}px;animation:${anim("card", "cubic-bezier(.2,.8,.2,1)")}">
      <div class="card-inner">
        <div class="rowB"><div class="prize" data-pdd-claim="prize-name">${esc(nbh(title))}</div></div>
        <div class="rowC">
          <div class="eyebrow">${oddsCopy.eyebrow()}</div>
          <div style="height:10px"></div>
          <div class="figure">${oddsCopy.capFigure(cap)}</div>
          <div style="height:10px"></div>
          <div class="cond">${esc(oddsCopy.conditional(cap))}</div>
        </div>
      </div></div>`);
    bands.push(`<div class="set" style="animation:${anim("band")}">
      <div class="l l1${soon ? " soon" : ""}">${esc(lines[0])}</div>
      <div class="l l2">${esc(lines[1])}</div>
      <div class="l l3">${esc(lines[2])}</div>
    </div>`);
  });

  // No separate "return tail" element: segment 0's own track brings it back (see trackCss).
  // The first version duplicated the opening shot and the opening band, and sliced the band's
  // markup out of a string to do it — two elements that had to render identically rather than
  // one element that cannot differ from itself.

  const cutTimesMs = segs.map((s) => s.a).filter((t) => t > 0);
  const stampTimesMs = segs.map((s) => s.expandAt);
  const coverText = oddsCopy.capFigure(Number(used[0].total_entries));

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style><style>${tokenCss()}</style><style>${REEL_CSS}</style>
<style>${sceneMotion(scene, "reel-9x16")}</style>
<style>${tracks}</style>
</head><body data-pdd-role="reel-card">
<!-- reel dur=${durationMs} scene=${scene.id} loop=${scene.loopMs} cuts=[${cutTimesMs}] fps=${FPS} arm=${arm} -->
<div class="reel">
  ${shots.join("\n  ")}
  <div class="scene-host">${sceneBack(scene, "reel-9x16", { draw: used[0], animate: true })}</div>
  <div class="rail" style="top:${CHROME.rail.y}px;height:${CHROME.rail.h}px">
    <span class="wordmark">PRIZEDRAWSDAILY</span>${stampText ? `<span class="stamp">${esc(stampText)}</span>` : ""}
  </div>
  ${cards.join("\n  ")}
  <div class="band" style="top:${CHROME.band.y}px;height:${CHROME.band.h}px">${bands.join("\n    ")}</div>
</div>
<script>${SEEK_RUNTIME}</script></body></html>`;

  // stampText travels out so the cover can render the SAME read-at stamp as the video. Two
  // surfaces deriving it separately is how they end up disagreeing about when we looked.
  return { html, durationMs, cutTimesMs, stampTimesMs, coverText, stampText, sceneId: scene.id, drawsUsed: used.length };
}

// The frame budget the build asserts against. Exported so a test can check the arithmetic
// without rendering 450 frames.
export function loopClosureFrames(durationMs) {
  const frames = Math.round(durationMs / FRAME);
  return { frames, first: 0, last: frames - 1, lastMs: Math.round((frames - 1) * FRAME) };
}
