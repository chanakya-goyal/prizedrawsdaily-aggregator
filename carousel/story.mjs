// carousel/story.mjs — the daily countdown STORY (spec §4.5): a single 12s scene,
// no cuts — just a card "breathing" (1.00→1.02 scale loop, CARD layer only, the raw
// photo is never scale-animated) behind a real flip-clock ticking to the soonest-
// closing draw. API-posted stories carry NO tappable link (Instagram/Graph API
// stories can't attach one) — the payoff here is reach/warmth ("link in bio ·
// @prizedrawsdaily"), not a click.
//
// Composes the SAME primitives as the Reel timeline (carousel/reel-template.mjs) —
// SEEK_RUNTIME, stampCss/stampHtml, flipClockCss/countdownHtml — so capture.mjs and
// encode.mjs need zero story-specific code. Determinism: no Date.now()/Math.random();
// nowIso is build-time, closeIso is the real draw_date.
//
// Run: [PDD_DIR=…] bun carousel/story.mjs   (after plan.mjs + fetchimg.mjs; needs
// selection.json). PROCESS ARCHITECTURE mirrors reel.mjs's documented gotcha (ONE
// chromium.launch() per Bun process): main is orchestration-only; frame capture runs
// in a self-exec subprocess (`bun story.mjs --capture <job.json>`).
import { readdir, mkdir } from "node:fs/promises";
import { workDir, catCfg, themeOf } from "./config.mjs";
import { fontFaceCss } from "./fonts.mjs";
import { stampCss, stampHtml, SEEK_RUNTIME, flipClockCss, countdownHtml } from "./reel-template.mjs";
import { beatGrid, quantize } from "./beat.mjs";
import { toDrawSlide } from "./format.mjs";

const FPS = 30;
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FONT_CSS = await fontFaceCss();
const STYLES_TEXT = await Bun.file(new URL("./styles.css", import.meta.url)).text();
// same token-lift trick as reel-template.mjs / reel.mjs's buildCoverHtml — pull only
// the :root + [data-theme] blocks so var(--accent) etc. resolve per category.
const TOKEN_CSS = [...STYLES_TEXT.matchAll(/(?:^|\n)\s*(?::root|\[data-theme="[^"]+"\])\s*\{[^}]*\}/g)]
  .map((m) => m[0].trim()).join("\n");

// deterministic default "now" for callers that don't pass a real time (tests).
const DEFAULT_NOW = "2026-01-01T18:00:00.000Z";

// ---------------------------------------------------------------- story-scoped CSS
const STORY_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1080px; height:1920px; overflow:hidden; }
body { background: var(--bg-solid); color:#fff; font-family:'Oswald', ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing:antialiased; text-rendering:geometricPrecision; }
.story { position:absolute; inset:0; overflow:hidden;
  background:
    radial-gradient(120% 70% at 50% 10%, rgba(var(--glow-rgb),.24) 0%, rgba(var(--accent-rgb),0) 48%),
    radial-gradient(130% 90% at 50% 96%, rgba(var(--accent-deep-rgb),.18) 0%, rgba(0,0,0,0) 52%),
    radial-gradient(130% 92% at 50% 44%, var(--bg-1) 0%, var(--bg-2) 56%, var(--bg-3) 100%); }
.st-glow { position:absolute; left:50%; top:34%; width:1150px; height:1150px; transform:translate(-50%,-50%); z-index:1;
  background: radial-gradient(circle, var(--glow) 0%, rgba(var(--accent-rgb),.42) 28%, rgba(0,0,0,0) 64%);
  opacity:.7; filter: blur(20px); mix-blend-mode:screen; pointer-events:none; }
.vign { position:absolute; inset:0; z-index:50; pointer-events:none; box-shadow: inset 0 0 240px rgba(0,0,0,.5); }

.st-kick { position:absolute; left:56px; right:56px; top:120px; z-index:6; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:700; font-size:34px; letter-spacing:4px; text-transform:uppercase;
  color:#fff; text-shadow: 0 2px 12px rgba(0,0,0,.85);
  animation: st-in 460ms cubic-bezier(.2,1.6,.3,1) both; }
.st-kick b { color: var(--hot); }

.st-name { position:absolute; left:64px; right:64px; top:190px; z-index:6; text-align:center;
  font-family: var(--font-display),'Anton',sans-serif; font-size:58px; line-height:1.02; text-transform:uppercase;
  background: linear-gradient(180deg, #ffffff 0%, #ffffff 46%, var(--ink-end) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  -webkit-text-stroke: 3px var(--stroke); paint-order: stroke fill;
  animation: st-in 460ms cubic-bezier(.2,1.6,.3,1) 90ms both; }

/* ---- the CARD layer breathes (1.00→1.02, exactly 3 loops over the 12s clip);
   the raw <img> inside is NEVER animated — only this wrapper's transform moves. ---- */
.st-breathe { position:absolute; left:64px; right:64px; top:310px; height:820px;
  animation: st-breathe 4000ms ease-in-out infinite; transform-origin:50% 50%; }
@keyframes st-breathe { 0%,100% { transform: scale(1.00); } 50% { transform: scale(1.02); } }

.st-card { position:absolute; inset:0; border-radius:40px; overflow:hidden;
  background: radial-gradient(circle at 50% 36%, rgba(var(--accent-rgb),.30) 0%, rgba(var(--card-rgb),.97) 60%);
  border: 3px solid rgba(var(--ray-rgb),.65);
  box-shadow: 0 30px 70px rgba(0,0,0,.62), 0 0 90px rgba(var(--accent-rgb),.38),
              inset 0 0 0 1px rgba(var(--gold-rgb),.5), inset 0 1px 0 rgba(255,255,255,.16);
  opacity:0; animation: st-in 560ms cubic-bezier(.2,1.6,.3,1) 220ms both; }
.st-card .cbg { position:absolute; inset:0; }
.st-card .cbg img { width:100%; height:100%; object-fit:cover; transform:scale(1.5); /* static fill, not animated */
  filter: blur(40px) saturate(1.6) brightness(1.1); opacity:.55; }
.st-card .photo { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:46px; }
.st-card .photo img { max-width:100%; max-height:100%; object-fit:contain; filter: drop-shadow(0 22px 34px rgba(0,0,0,.55)); }
.st-card .pgrad { position:absolute; inset:0; box-shadow: inset 0 0 90px rgba(0,0,0,.42), inset 0 0 0 1px rgba(var(--ray-rgb),.15);
  background: linear-gradient(180deg, rgba(0,0,0,0) 58%, rgba(0,0,0,.42) 100%); }
.st-typo { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:70px; }
.st-typo .st-title { font-family: var(--font-display),'Anton',sans-serif; font-size:100px; line-height:.94; text-transform:uppercase;
  background: linear-gradient(180deg, #ffffff 0%, #ffffff 46%, var(--ink-end) 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
  -webkit-text-stroke: 6px var(--stroke); paint-order: stroke fill; }

.st-clock { position:absolute; left:0; right:0; top:1170px; z-index:8; display:flex; justify-content:center;
  animation: st-in 540ms cubic-bezier(.2,1.8,.3,1) 700ms both; }

/* API stories carry NO tappable link — reach/warmth line only, never a clickable anchor. */
.st-link { position:absolute; left:0; right:0; top:1560px; z-index:8; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:600; font-size:32px; letter-spacing:2px; text-transform:uppercase;
  color: rgba(255,255,255,.92); text-shadow: 0 2px 10px rgba(0,0,0,.85);
  animation: st-in 460ms cubic-bezier(.2,1.6,.3,1) 900ms both; }
.st-link b { color: var(--hot); }

/* THE PRICE STAMP lands over the card at ~10s (stampCss/stampHtml, imported verbatim) */
.st-stamp { position:absolute; left:50%; top:46%; width:430px; height:430px; margin:-215px 0 0 -215px; z-index:40; }
.st-stamp .stamp span { display:block; padding:0 34px; }
.st-stamp .stamp-ring { animation: stamp-ring 700ms ease-out var(--t-in,0ms) both; }
@keyframes st-chroma { from { filter: drop-shadow(7px 0 0 rgba(255,45,85,.85)) drop-shadow(-7px 0 0 rgba(0,229,255,.8)); } to { filter:none; } }

.rfoot { position:absolute; left:0; right:0; bottom:36px; z-index:60; text-align:center;
  font-family:'Oswald',sans-serif; font-weight:600; font-size:24px; letter-spacing:3px;
  color: rgba(255,255,255,.78); text-shadow: 0 2px 10px rgba(0,0,0,.85); }

@keyframes st-in { from { opacity:0; transform: translateY(46px); } to { opacity:1; transform:none; } }
`;

function stampBlock(text, tMs) {
  return `<div class="st-stamp" style="--t-in:${tMs}ms">
    <div class="s-pop" style="animation: stamp-in 560ms cubic-bezier(.2,2,.3,1) ${tMs}ms both">
      <div class="s-chroma" style="animation: st-chroma 67ms linear ${tMs}ms both">${stampHtml(esc(text))}</div>
    </div></div>`;
}

// ---------------------------------------------------------------- the timeline
export function buildStoryTimeline({ draw, hero, theme, audioMeta, nowIso = DEFAULT_NOW }) {
  if (!draw) throw new Error("buildStoryTimeline: need a draw");
  const slide = toDrawSlide(draw, 1);
  const closeIso = draw.draw_date || nowIso;
  const durationMs = 12000; // fixed 12s story — no cuts, one continuous scene

  // the stamp is the only quantized moment (mirrors reel-template's beat-snap rule);
  // everything else is a simple entrance cascade, not a "cut/slam".
  const grid = audioMeta?.bpm > 0 ? beatGrid(audioMeta, durationMs) : [];
  const stampT = grid.length ? Math.round(quantize(10000, grid)) : 10000;
  const stampText = slide.price ? `JUST ${String(slide.price).toUpperCase()} A TICKET` : "CLOSING SOON";

  const media = hero
    ? `<div class="cbg"><img src="${hero}"></div><div class="photo"><img src="${hero}"></div><div class="pgrad"></div>`
    : `<div class="st-typo"><div class="st-title">${esc(slide.title)}</div></div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${FONT_CSS}</style>
<style>${TOKEN_CSS}</style>
<style>${stampCss()}</style>
<style>${flipClockCss()}</style>
<style>${STORY_CSS}</style>
</head><body data-theme="${theme}">
<!-- story dur=${durationMs} stamp=${stampT} closes=${closeIso} fps=${FPS} -->
<div class="story" style="animation: stamp-shake 100ms linear ${stampT}ms both">
  <div class="st-glow"></div>
  <div class="st-kick">⏳ <b>${esc(slide.closes || "CLOSES SOON")}</b></div>
  <div class="st-name">${esc(slide.title)}</div>
  <div class="st-breathe"><div class="st-card">${media}</div></div>
  <div class="st-clock">${countdownHtml(closeIso, nowIso)}</div>
  <div class="st-link">LINK IN BIO · <b>@prizedrawsdaily</b></div>
  ${stampBlock(stampText, stampT)}
  <div class="vign"></div>
  <footer class="rfoot">18+ · UK ONLY · PLAY RESPONSIBLY</footer>
</div>
<script>${SEEK_RUNTIME}</script>
</body></html>`;

  return { html, durationMs, stampTimesMs: [stampT] };
}

// ---------------------------------------------------------------- child: --capture
// Frame loop in its own process — captureFrames() performs its own single launch.
async function captureChild(jobPath) {
  const { captureFrames } = await import("./capture.mjs");
  const job = await Bun.file(jobPath).json();
  const html = await Bun.file(job.htmlPath).text();
  const { frames } = await captureFrames(html, { fps: job.fps, durationMs: job.durationMs, outDir: job.outDir });
  console.log(`  captured ${frames} frames → ${job.outDir}`);
}

// ---------------------------------------------------------------- orchestration
async function main() {
  const { minDimOk } = await import("./imgcheck.mjs");
  const { pickAudio } = await import("./beat.mjs");
  const { encodeVideo, assertVideoContract } = await import("./encode.mjs");

  const t0 = Date.now();
  const stage = async (name, fn) => {
    const s = Date.now();
    const r = await fn();
    console.log(`■ ${name} — ${((Date.now() - s) / 1000).toFixed(1)}s`);
    return r;
  };

  const DIR = workDir();
  const OUT = `${DIR}/out`;
  const WORK = `${DIR}/.storywork`;
  await mkdir(OUT, { recursive: true });
  await mkdir(WORK, { recursive: true });
  const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
  if (!sel.draws?.length) throw new Error("story: selection.json has no draws");

  // ---- pick the draw closing SOONEST (min draw_date; ties keep the first/original order)
  let draw = sel.draws[0];
  for (const d of sel.draws) {
    if (!d.draw_date) continue;
    if (!draw.draw_date || Date.parse(d.draw_date) < Date.parse(draw.draw_date)) draw = d;
  }

  // ---- hero photo: DUPLICATED priority logic from reel.mjs (per the task brief — do
  // not refactor). (1) your dropped photo named by slug/rank, (2) auto-fetched
  // .fetched/{slug}/pick.txt gated by minDimOk ≥500px, (3) none → typographic.
  const files = await readdir(DIR);
  const IMG_EXT = /\.(jpe?g|png|webp)$/i;
  const baseOf = (f) => f.trim().replace(IMG_EXT, "").replace(IMG_EXT, "").trim().toLowerCase();
  const rank = sel.draws.indexOf(draw) + 1;
  const findClean = (slug, r) => {
    const f = files.find((f) => {
      if (f.startsWith("REF-") || !IMG_EXT.test(f.trim())) return false;
      const b = baseOf(f);
      return b === slug.toLowerCase() || b === String(r);
    });
    return f ? `${DIR}/${f}` : null;
  };
  const toDataUrl = async (path) => {
    const buf = Buffer.from(await Bun.file(path).arrayBuffer());
    const ext = path.split(".").pop().toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  };
  const fetchedPath = async (slug) => {
    const pick = Bun.file(`${DIR}/.fetched/${slug}/pick.txt`);
    if (!(await pick.exists())) return null;
    const name = (await pick.text()).trim();
    const p = `${DIR}/.fetched/${slug}/${name}`;
    return name && (await Bun.file(p).exists()) ? p : null;
  };

  let hero = null, srcKind = "typographic";
  const mine = findClean(draw.slug, rank);
  if (mine) { hero = await toDataUrl(mine); srcKind = "your photo"; }
  else {
    const auto = await fetchedPath(draw.slug);
    if (auto && (await minDimOk(auto, 500))) { hero = await toDataUrl(auto); srcKind = "auto-fetched"; }
    else if (auto) console.log(`  ⚠ ${draw.slug}: auto-fetched pick is under 500px — rejected (typographic scene)`);
  }
  console.log(`Story draw: ${draw.slug} · closes ${draw.draw_date} · photo: ${srcKind}`);

  // ---- audio + timeline. trimToOnsetMs MUST be the manifest firstBeatOffsetMs
  // (loudnorm amplifies silent intros deep into tracks); nowIso is real build time;
  // closeIso (inside buildStoryTimeline) is the REAL draw_date — never synthetic.
  const theme = themeOf(sel.slug);
  const audioMeta = await pickAudio(catCfg(sel.slug).audioMood);
  const nowIso = new Date().toISOString();
  const tl = buildStoryTimeline({ draw, hero, theme, audioMeta, nowIso });
  console.log(`Story · theme ${theme} · ${tl.durationMs}ms · stamp [${tl.stampTimesMs}] · audio ${audioMeta.file} (${audioMeta.mood})`);

  const timelinePath = `${WORK}/story.html`;
  await Bun.write(timelinePath, tl.html);

  // ---- capture (browser subprocess — ONE chromium.launch() per process)
  const framesDir = `${WORK}/frames`;
  await stage("capture", async () => {
    const jobPath = `${WORK}/capture.job.json`;
    await Bun.write(jobPath, JSON.stringify({ htmlPath: timelinePath, fps: FPS, durationMs: tl.durationMs, outDir: framesDir }));
    const p = Bun.spawn(["bun", import.meta.path, "--capture", jobPath], { stdout: "inherit", stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error("story: capture subprocess failed (see output above)");
  });

  // ---- encode + IG contract (ffmpeg only — no browser, safe in main)
  await stage("encode", async () => {
    await encodeVideo({
      framesDir, fps: FPS, out: `${OUT}/story.mp4`,
      audio: {
        file: audioMeta.file,
        trimToOnsetMs: audioMeta.firstBeatOffsetMs || 0,
        stingFile: "stamp-sting.wav",
        stingTimesMs: tl.stampTimesMs,
      },
    });
    const c = await assertVideoContract(`${OUT}/story.mp4`, { minDurS: 10, maxDurS: 15 });
    console.log(`  contract OK: ${c.durS.toFixed(2)}s ${c.w}x${c.h} ${c.vcodec}/${c.acodec} moovFront=${c.moovFront}`);
  });

  await Bun.write(`${OUT}/story-meta.json`, JSON.stringify({
    slug: draw.slug, durationMs: tl.durationMs, stampTimesMs: tl.stampTimesMs,
    audio: { file: audioMeta.file, mood: audioMeta.mood },
  }, null, 2));
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${OUT}/story.mp4 + story-meta.json`);
}

// ---------------------------------------------------------------- entry
if (import.meta.main) {
  const [flag, jobPath] = process.argv.slice(2);
  if (flag === "--capture") await captureChild(jobPath);
  else if (flag) { console.error(`story: unknown flag ${flag} (expected --capture)`); process.exit(2); }
  else await main();
}
