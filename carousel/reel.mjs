// carousel/reel.mjs — REEL orchestrator (spec §4.4): selection → arm A/B/C timeline →
// deterministic frames → contract-gated reel.mp4 + cover.jpg + QA keyframe strip + meta.
// Run: [REEL_ARM=A|B|C] [PDD_DIR=…] bun carousel/reel.mjs   (after plan.mjs + fetchimg.mjs)
//
// PROCESS ARCHITECTURE (repo gotcha: ONE chromium.launch() per Bun process — a second
// launch's devtools pipe dies instantly under Bun+Playwright; see preview-sheet.mjs):
// the MAIN process is ORCHESTRATION ONLY and never launches a browser. All browser work
// runs in self-exec subprocesses (`bun reel.mjs --<mode> <job.json>`, import.meta.main-guarded),
// each performing exactly one chromium.launch():
//   1) --shot    cover.html → out/cover.jpg                (browser, own process)
//   2) --capture timeline.html → .reelwork/frames/f*.png   (captureFrames owns its launch)
//   3) main:     encodeVideo + assertVideoContract          (ffmpeg only, no browser)
//   4) --shot    keyframes composite → out/reel-keyframes.png (browser, own process)
// Intermediates live in ${PDD_DIR}/.reelwork/; deliverables in ${PDD_DIR}/out/.
import { workDir, catCfg, themeOf } from "./config.mjs";
import { readdir, mkdir } from "node:fs/promises";

const FPS = 30, FRAME_MS = 1000 / FPS;
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// shared "ready" gate for static pages (mirrors SEEK_RUNTIME's font+image wait)
const READY_SNIPPET = `<script>(async () => {
  try { await document.fonts.ready; } catch {}
  const wait = (im) => (!im || im.complete) ? null : new Promise((r) => { im.onload = r; im.onerror = r; });
  await Promise.all([...document.images].map(wait).filter(Boolean));
  window.__ready = true;
})();</script>`;

// ---------------------------------------------------------------- child: --shot
// Render one static HTML file → one screenshot. Exactly one chromium.launch().
async function shotChild(jobPath) {
  const { chromium } = await import("playwright");
  const job = await Bun.file(jobPath).json();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    await page.setContent(await Bun.file(job.htmlPath).text(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 30000 }).catch(() => {
      throw new Error(`shot: ${job.htmlPath} never became ready (fonts/images failed)`);
    });
    const opts = { path: job.out, type: job.type || "png", fullPage: !!job.fullPage, timeout: 30000 };
    if (opts.type === "jpeg") opts.quality = job.quality ?? 90;
    await page.screenshot(opts);
    console.log(`  shot → ${job.out}`);
  } finally {
    await browser.close();
  }
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

// ---------------------------------------------------------------- cover card
// Minimal static 1080×1920 card: theme tokens + hero + THE PRICE STAMP carrying the
// ≤4-word coverText ("{PRIZE NOUN} · {price}") — screenshotted as JPEG q90.
async function buildCoverHtml({ theme, coverText, hero }) {
  const { fontFaceCss } = await import("./fonts.mjs");
  const { stampCss, stampHtml } = await import("./reel-template.mjs");
  const fontCss = await fontFaceCss();
  // lift the :root/[data-theme] token blocks from styles.css (same trick as reel-template)
  const stylesText = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const tokenCss = [...stylesText.matchAll(/(?:^|\n)\s*(?::root|\[data-theme="[^"]+"\])\s*\{[^}]*\}/g)]
    .map((m) => m[0].trim()).join("\n");
  const media = hero
    ? `<div class="hf-bg"><img src="${hero}"></div><div class="hf-main"><img src="${hero}"></div>`
    : `<div class="glow"></div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${fontCss}</style>
<style>${tokenCss}</style>
<style>${stampCss()}</style>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1080px; height:1920px; overflow:hidden; }
body { background: var(--bg-solid); font-family:'Oswald', ui-sans-serif, sans-serif; -webkit-font-smoothing:antialiased; }
.cover { position:absolute; inset:0; overflow:hidden;
  background:
    radial-gradient(120% 70% at 50% 12%, rgba(var(--glow-rgb),.22) 0%, rgba(var(--accent-rgb),0) 48%),
    radial-gradient(130% 90% at 50% 96%, rgba(var(--accent-deep-rgb),.18) 0%, rgba(0,0,0,0) 52%),
    radial-gradient(130% 92% at 50% 44%, var(--bg-1) 0%, var(--bg-2) 56%, var(--bg-3) 100%); }
.hf-bg { position:absolute; inset:-48px; }
.hf-bg img { width:100%; height:100%; object-fit:cover; filter: blur(42px) saturate(1.55) brightness(.92); opacity:.62; }
.hf-main { position:absolute; inset:110px 50px 880px; display:flex; align-items:center; justify-content:center; }
.hf-main img { max-width:100%; max-height:100%; object-fit:contain; filter: drop-shadow(0 28px 46px rgba(0,0,0,.6)); }
.glow { position:absolute; left:50%; top:40%; width:1200px; height:1200px; transform:translate(-50%,-50%);
  background: radial-gradient(circle, var(--glow) 0%, rgba(var(--accent-rgb),.42) 28%, rgba(0,0,0,0) 64%);
  opacity:.75; filter: blur(20px); }
.scrim { position:absolute; inset:0; z-index:2;
  background: linear-gradient(180deg, rgba(var(--scrim-rgb),.30) 0%, rgba(var(--scrim-rgb),0) 25%, rgba(var(--scrim-rgb),0) 48%, rgba(var(--scrim-rgb),.80) 78%, rgba(var(--scrim-rgb),.97) 100%); }
.slot { position:absolute; left:50%; top:1250px; width:430px; height:430px; margin:-215px 0 0 -215px; z-index:5; transform:scale(1.5); }
.stamp span { display:block; padding:0 34px; }
.vign { position:absolute; inset:0; z-index:8; box-shadow: inset 0 0 240px rgba(0,0,0,.5); pointer-events:none; }
.rfoot { position:absolute; left:0; right:0; bottom:36px; z-index:9; text-align:center; font-weight:600; font-size:24px;
  letter-spacing:3px; color:rgba(255,255,255,.78); text-shadow:0 2px 10px rgba(0,0,0,.85); }
</style></head><body data-theme="${theme}">
<div class="cover">${media}<div class="scrim"></div>
<div class="slot">${stampHtml(esc(coverText))}</div>
<div class="vign"></div>
<footer class="rfoot">18+ · UK ONLY · PLAY RESPONSIBLY</footer>
</div>${READY_SNIPPET}</body></html>`;
}

// ---------------------------------------------------------------- QA keyframes
// §7.5 legibility gate: frames 1/16/37, each stamp onset AND its landed pose
// (+467ms = 14 frames, past the 560ms stamp-in overshoot), each SCENE's midpoint
// (so the arm's hook scene — giant price / countdown / prize cards — is always
// sampled), and the final loop frame.
function pickKeyframes(durationMs, stampTimesMs, cutTimesMs = []) {
  const total = Math.round(durationMs / FRAME_MS);
  const at = (t) => Math.max(1, Math.min(total, Math.round(t / FRAME_MS) + 1));
  const bounds = [0, ...cutTimesMs, durationMs];
  const mids = bounds.slice(0, -1).map((a, i) => Math.round((a + bounds[i + 1]) / 2));
  const want = [
    [1, "f1 · 0ms · hook"],
    [16, "f16 · 500ms"],
    [37, "f37 · 1200ms"],
    ...mids.map((t, i) => [at(t), `scene ${i + 1} mid @${t}ms`]),
    ...stampTimesMs.flatMap((t) => [[at(t), `stamp @${t}ms`], [at(t + 467), `stamp landed @${t}+467ms`]]),
    [total, `f${total} · final (loop)`],
  ];
  const byN = new Map();
  for (const [n, label] of want) byN.set(n, byN.has(n) ? `${byN.get(n)} + ${label}` : label);
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, label]) => ({ n, label }));
}

async function buildKeyframesHtml(framesDir, tiles) {
  let cells = "";
  for (const t of tiles) {
    const p = `${framesDir}/f${String(t.n).padStart(5, "0")}.png`;
    const b64 = Buffer.from(await Bun.file(p).arrayBuffer()).toString("base64");
    cells += `<div class="c"><img src="data:image/png;base64,${b64}"><span>${esc(t.label)}</span></div>`;
  }
  return `<!doctype html><meta charset="utf-8"><style>
* { box-sizing:border-box; margin:0; }
body { background:#111; color:#eee; font:600 15px system-ui; padding:14px; display:flex; gap:12px; }
.c { width:340px; text-align:center; flex:none; }
.c img { width:340px; display:block; border-radius:6px; margin-bottom:6px; }
.c span { color:#9cf; }
</style>${cells}${READY_SNIPPET}`;
}

// ---------------------------------------------------------------- orchestration
async function main() {
  const { toDrawSlide } = await import("./format.mjs");
  const { minDimOk } = await import("./imgcheck.mjs");
  const { buildReelTimeline } = await import("./reel-template.mjs");
  const { pickAudio } = await import("./beat.mjs");
  const { encodeVideo, assertVideoContract } = await import("./encode.mjs");

  const t0 = Date.now();
  const stage = async (name, fn) => {
    const s = Date.now();
    const r = await fn();
    console.log(`■ ${name} — ${((Date.now() - s) / 1000).toFixed(1)}s`);
    return r;
  };
  const runChild = async (flag, name, job) => {
    const jobPath = `${WORK}/${name}.job.json`;
    await Bun.write(jobPath, JSON.stringify(job));
    const p = Bun.spawn(["bun", import.meta.path, flag, jobPath], { stdout: "inherit", stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error(`reel: ${name} subprocess failed (see output above)`);
  };

  const DIR = workDir();
  const OUT = `${DIR}/out`;
  const WORK = `${DIR}/.reelwork`;
  await mkdir(OUT, { recursive: true });
  await mkdir(WORK, { recursive: true });
  const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());

  // ---- arm: env REEL_ARM ∈ A|B|C, else rotate by day of year
  const envArm = (process.env.REEL_ARM || "").toUpperCase();
  if (process.env.REEL_ARM && !["A", "B", "C"].includes(envArm))
    throw new Error(`REEL_ARM must be A|B|C (got "${process.env.REEL_ARM}")`);
  const dayOfYear = Math.floor((Date.now() - Date.parse(new Date().getFullYear() + "-01-01")) / 86400000);
  const arm = envArm || ["A", "B", "C"][dayOfYear % 3];

  // ---- hero photos: DUPLICATED from build.mjs (per the task brief — do not refactor).
  // Priority per draw: (1) photo you dropped in the work dir named 1–5 or by slug,
  // (2) auto-fetched .fetched/{slug}/pick.txt gated by minDimOk ≥500px, (3) none → typographic.
  const files = await readdir(DIR);
  const IMG_EXT = /\.(jpe?g|png|webp)$/i;
  const baseOf = (f) => f.trim().replace(IMG_EXT, "").replace(IMG_EXT, "").trim().toLowerCase();
  const findClean = (slug, rank) => {
    const f = files.find((f) => {
      if (f.startsWith("REF-") || !IMG_EXT.test(f.trim())) return false;
      const b = baseOf(f);
      return b === slug.toLowerCase() || b === String(rank);
    });
    return f ? `${DIR}/${f}` : null;
  };
  const toDataUrl = async (path) => {
    const buf = Buffer.from(await Bun.file(path).arrayBuffer());
    const ext = path.split(".").pop().toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  };
  const FETCHED = `${DIR}/.fetched`;
  const fetchedPath = async (slug) => {
    const pick = Bun.file(`${FETCHED}/${slug}/pick.txt`);
    if (!(await pick.exists())) return null;
    const name = (await pick.text()).trim();
    const p = `${FETCHED}/${slug}/${name}`;
    return name && (await Bun.file(p).exists()) ? p : null;
  };
  const heroes = {}, srcKind = {};
  for (let i = 0; i < sel.draws.length; i++) {
    const d = sel.draws[i];
    const mine = findClean(d.slug, i + 1);
    if (mine) { heroes[d.slug] = await toDataUrl(mine); srcKind[d.slug] = "your photo"; continue; }
    const auto = await fetchedPath(d.slug);
    if (!auto) continue;
    if (await minDimOk(auto, 500)) { heroes[d.slug] = await toDataUrl(auto); srcKind[d.slug] = "auto-fetched"; }
    else console.log(`  ⚠ ${d.slug}: auto-fetched pick is under 500px — rejected (typographic scene)`);
  }
  console.log(`Photos: ${Object.keys(heroes).length}/${sel.draws.length}`);
  sel.draws.forEach((d, i) => console.log(`  ${i + 1}. ${d.slug.slice(0, 44).padEnd(46)} ${srcKind[d.slug] || "— typographic"}`));

  // ---- audio + timeline. trimToOnsetMs MUST be the manifest firstBeatOffsetMs (loudnorm
  // amplifies silent intros deep into tracks); nowIso is passed for ALL arms (determinism),
  // closeIso = earliest draw_date so arm C's countdown is REAL, never synthetic.
  const audioMeta = await pickAudio(catCfg(sel.slug).audioMood);
  const nowIso = new Date().toISOString();
  const closeIso = sel.draws.map((d) => d.draw_date).filter(Boolean).sort()[0] ?? null;
  const slides = sel.draws.map((d, i) => toDrawSlide(d, i + 1));
  const tl = buildReelTimeline({ sel, slides, heroes, arm, audioMeta, nowIso, closeIso });
  const theme = themeOf(sel.slug);
  console.log(`Arm ${arm} · theme ${theme} · ${tl.durationMs}ms · cuts [${tl.cutTimesMs}] · stamps [${tl.stampTimesMs}] · audio ${audioMeta.file} (${audioMeta.mood}) · cover "${tl.coverText}"`);
  const timelinePath = `${WORK}/timeline.html`;
  await Bun.write(timelinePath, tl.html);

  // ---- 1) cover.jpg (browser subprocess #1)
  await stage("cover", async () => {
    const coverPath = `${WORK}/cover.html`;
    await Bun.write(coverPath, await buildCoverHtml({ theme, coverText: tl.coverText, hero: heroes[sel.draws[0]?.slug] ?? null }));
    await runChild("--shot", "cover", { htmlPath: coverPath, out: `${OUT}/cover.jpg`, width: 1080, height: 1920, type: "jpeg", quality: 90 });
  });

  // ---- 2) frames (browser subprocess #2)
  const framesDir = `${WORK}/frames`;
  await stage("capture", () =>
    runChild("--capture", "capture", { htmlPath: timelinePath, fps: FPS, durationMs: tl.durationMs, outDir: framesDir }));

  // ---- 3) encode + IG contract (ffmpeg — no browser, safe in main)
  await stage("encode", async () => {
    await encodeVideo({
      framesDir, fps: FPS, out: `${OUT}/reel.mp4`,
      audio: {
        file: audioMeta.file,
        trimToOnsetMs: audioMeta.firstBeatOffsetMs || 0,
        stingFile: "stamp-sting.wav",
        stingTimesMs: tl.stampTimesMs,
      },
    });
    const c = await assertVideoContract(`${OUT}/reel.mp4`, { minDurS: 3, maxDurS: 20 });
    console.log(`  contract OK: ${c.durS.toFixed(2)}s ${c.w}x${c.h} ${c.vcodec}/${c.acodec} moovFront=${c.moovFront}`);
  });

  // ---- 4) QA keyframe strip (browser subprocess #3)
  const tiles = pickKeyframes(tl.durationMs, tl.stampTimesMs, tl.cutTimesMs);
  await stage("keyframes", async () => {
    const kfPath = `${WORK}/keyframes.html`;
    await Bun.write(kfPath, await buildKeyframesHtml(framesDir, tiles));
    await runChild("--shot", "keyframes", {
      htmlPath: kfPath, out: `${OUT}/reel-keyframes.png`,
      width: tiles.length * 352 + 28, height: 700, type: "png", fullPage: true,
    });
  });

  // ---- meta
  await Bun.write(`${OUT}/reel-meta.json`, JSON.stringify({
    arm, durationMs: tl.durationMs, stampTimesMs: tl.stampTimesMs,
    audio: { file: audioMeta.file, mood: audioMeta.mood }, coverText: tl.coverText,
  }, null, 2));
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${OUT}/reel.mp4 + cover.jpg + reel-keyframes.png + reel-meta.json`);
}

// ---------------------------------------------------------------- entry
if (import.meta.main) {
  const [flag, jobPath] = process.argv.slice(2);
  if (flag === "--shot") await shotChild(jobPath);
  else if (flag === "--capture") await captureChild(jobPath);
  else if (flag) { console.error(`reel: unknown flag ${flag} (expected --shot|--capture)`); process.exit(2); }
  else await main();
}
