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
import { workDir, catCfg } from "./config.mjs";
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
// THE COVER IS THE REEL'S OPENING FRAME, not a poster of its own.
//
// It is the Reel's thumbnail, and a cover that looks like a different piece of work makes the
// thumbnail disagree with the video it fronts — which is why the scene system treats it as its
// own surface rather than an afterthought. So it carries the same photograph, the same rail,
// the same conditions band and the same cap, with the insert card COLLAPSED: exactly what a
// viewer sees in the first frame.
//
// Lane R only. buildCoverHtml renders no insert card, so there is no Lane C on it and never
// was; declaring one is what made the old loop assertion read as vacuous rather than as passing.
async function buildCoverHtml({ coverText, hero, sel, stampText }) {
  const { fontFaceCss } = await import("./fonts.mjs");
  const { tokenCss } = await import("./tokens.mjs");
  const { sceneFor, sceneBack } = await import("./scene.mjs");
  const { CHROME } = await import("./reel-template.mjs");
  const oddsCopy = await import("./odds-copy.mjs");
  const { closesLabel, priceLabel, cleanTitle } = await import("./format.mjs");
  const fontCss = await fontFaceCss();
  const scene = sceneFor(sel.slug);
  const d = sel.draws[0];
  const host = (() => { try { return new URL(d.entry_url).hostname.replace(/^www\./, ""); } catch { return "the operator's own site"; } })();
  const lines = oddsCopy.bandLines({
    role: "reel-open", drawsRendered: sel.draws.length,
    fromPrice: priceLabel(Math.min(...sel.draws.map((x) => Number(x.ticket_price)).filter((n) => n > 0))) || "n/a",
    closesText: closesLabel(d.draw_date), price: priceLabel(d.ticket_price) || "n/a", host,
    freeEntryRoute: d.free_entry_route || "unknown",
  });
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${fontCss}</style><style>${tokenCss()}</style>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden}
body{background:var(--ink);font-family:var(--font-text),system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.cover{position:absolute;inset:0;overflow:hidden}
.shot{position:absolute;inset:0}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
.scene-host{position:absolute;inset:0;pointer-events:none}
.rail{position:absolute;left:0;width:1080px;background:var(--rail);display:flex;align-items:center;
  justify-content:space-between;padding:0 65px}
.wordmark{font-family:var(--font-display);font-weight:800;font-size:var(--fs-label);letter-spacing:1.5px;
  color:var(--rail-ink);text-transform:uppercase;line-height:1}
.stamp{font-family:var(--font-figure);font-weight:700;font-size:var(--fs-label);color:var(--rail-accent);line-height:1}
/* The cap, large, on OPAQUE chrome contiguous with the rail above it.
   The first version set it in white directly over the photograph with a text-shadow, and on a
   white-and-blue motorbike it was almost unreadable — white on white. A drop shadow is the old
   dark-template trick for exactly this, and it fails the moment the photograph is light, which
   on this inventory is most of the time. The chrome in this system is opaque everywhere else
   for the same reason, so the cover has no business being the exception. */
.hero{position:absolute;left:0;width:1080px;background:var(--rail);padding:24px 65px 30px}
.hero .eyebrow{font-weight:600;font-size:var(--fs-label);letter-spacing:var(--tr-label);text-transform:uppercase;
  color:var(--rail-accent)}
.hero .fig{font-family:var(--font-figure);font-weight:700;font-size:200px;line-height:200px;color:var(--rail-ink);
  font-variant-numeric:tabular-nums}
.hero .sub{margin-top:6px;font-weight:600;font-size:var(--fs-lead);line-height:60px;color:var(--rail-meta);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.band{position:absolute;left:0;width:1080px;background:var(--rail);padding:16px 65px;display:flex;
  flex-direction:column;justify-content:center}
.band .l{font-size:var(--fs-legal);line-height:var(--lh-legal);white-space:nowrap}
.band .l1{font-weight:600;color:var(--rail-ink);text-transform:uppercase}
.band .l2,.band .l3{font-weight:400;color:var(--rail-meta)}
</style></head><body data-pdd-role="reel-open">
<div class="cover">
  ${hero ? `<div class="shot"><img src="${hero}"></div>` : ""}
  <div class="scene-host">${sceneBack(scene, "reel-cover-9x16", { draw: d })}</div>
  <div class="rail" style="top:${CHROME.rail.y}px;height:${CHROME.rail.h}px">
    <span class="wordmark">PRIZEDRAWSDAILY</span>${stampText ? `<span class="stamp">${esc(stampText)}</span>` : ""}
  </div>
  <div class="hero" style="top:${CHROME.rail.y + CHROME.rail.h}px">
    <div class="eyebrow">${oddsCopy.eyebrow()}</div>
    <div class="fig">${esc(coverText)}</div>
    <div class="sub">${esc(cleanTitle(d.grand_prize || d.title))}</div>
  </div>
  <div class="band" style="top:${CHROME.band.y}px;height:${CHROME.band.h}px">
    <div class="l l1">${esc(lines[0])}</div>
    <div class="l l2">${esc(lines[1])}</div>
    <div class="l l3">${esc(lines[2])}</div>
  </div>
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
  // closeIso must match whichever draw arm C actually DISPLAYS (reel-template.mjs's arm-C
  // countdownScene always renders `top` = slides[0] = sel.draws[0]) — so it's keyed off
  // sel.draws[0] first, not an independent min() across the whole selection, which could
  // silently disagree with the displayed draw after a manual backup swap during QA. Falls
  // back to the old earliest-across-selection computation only if draws[0] lacks a date.
  const audioMeta = await pickAudio(catCfg(sel.slug).audioMood);
  const nowIso = new Date().toISOString();
  const closeIso = sel.draws[0]?.draw_date ?? sel.draws.map((d) => d.draw_date).filter(Boolean).sort()[0] ?? null;
  // No slides array: buildReelTimeline reads sel.draws directly, so mapping them through the
  // old draw-slide shape first was doing work nothing consumed.
  const tl = buildReelTimeline({ sel, heroes, arm, audioMeta, nowIso, closeIso });
  // No theme. Per-category identity is STRUCTURE now and comes from the scene module, so what
  // is worth logging is which scene resolved and whether its loop divides the reel.
  console.log(`Arm ${arm} · scene ${tl.sceneId} · ${tl.durationMs}ms · ${tl.drawsUsed} draws · cuts [${tl.cutTimesMs}] · inserts [${tl.stampTimesMs}] · audio ${audioMeta.file} (${audioMeta.mood}) · cover "${tl.coverText}"`);
  const timelinePath = `${WORK}/timeline.html`;
  await Bun.write(timelinePath, tl.html);

  // ---- 1) cover.jpg (browser subprocess #1)
  await stage("cover", async () => {
    const coverPath = `${WORK}/cover.html`;
    await Bun.write(coverPath, await buildCoverHtml({
      coverText: tl.coverText, hero: heroes[sel.draws[0]?.slug] ?? sel.draws[0]?.image_url ?? null,
      sel, stampText: tl.stampText || "",
    }));
    await runChild("--shot", "cover", { htmlPath: coverPath, out: `${OUT}/cover.jpg`, width: 1080, height: 1920, type: "jpeg", quality: 90 });
  });

  // ---- 2) frames (browser subprocess #2)
  const framesDir = `${WORK}/frames`;
  // THE LOOP ASSERTION, and it runs BEFORE the 95-second capture so a broken loop costs seconds
  // rather than two minutes.
  //
  // A seamless loop is worth asserting because of how Instagram counts: Views are "starts to
  // play or replay" and Watch time INCLUDES replays, so a loop inflates views, watch time and
  // average watch time without reaching one extra person. That makes reach and skip rate the
  // only honest reads on this surface — and it makes a loop that visibly jumps a wasted
  // opportunity rather than a cosmetic flaw.
  //
  // The comparison is t=0 against t=durationMs — the WRAP point, not the last captured frame.
  // The last frame sits one frame short of the duration, so on a moving scene it differs from
  // frame 0 by exactly one frame of drift; comparing against it would demand the animation stand
  // still, which is the opposite of what is wanted. I had this the wrong way round at first and
  // the assertion failed on a loop that was in fact closed.
  await stage("loop", async () => {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    try {
      const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
      await p.setContent(tl.html, { waitUntil: "domcontentloaded", timeout: 60000 });
      await p.waitForFunction("window.__ready === true", { timeout: 30000 });
      const at = async (t) => { await p.evaluate((x) => window.__seek(x), t); return p.screenshot({ type: "png", animations: "allow", timeout: 20000 }); };
      const first = await at(0), wrap = await at(tl.durationMs);
      if (Buffer.compare(first, wrap) !== 0) {
        throw new Error(`reel loop does not close: the frame at t=0 differs from the frame at t=${tl.durationMs}ms.\n`
          + `  scene "${tl.sceneId}" loops every ${(await import("./scene.mjs")).sceneFor(sel.slug).loopMs}ms and the reel runs ${tl.durationMs}ms `
          + `(${tl.durationMs % ((await import("./scene.mjs")).sceneFor(sel.slug).loopMs || 1)}ms out of phase).\n`
          + `  refusing to ship a reel whose loop visibly jumps`);
      }
      console.log(`  loop closes: t=0 and t=${tl.durationMs}ms are byte-identical`);
    } finally { await b.close(); }
  });

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
    // §11.2: REEL_ARM=A|B|C lets a human force an arm and nothing recorded that it was forced.
    // An arm picked by hand and scored as a rotation draw is a corrupted experiment, so the
    // PROVENANCE of the choice is stored beside the choice.
    armSource: envArm ? "env_override" : "rotation",
    // True by construction, not by assumption: the loop closure was asserted byte-identical at
    // the wrap point above, and a run where it did not close never reaches this write. It is
    // recorded so the watch figures always carry the inflation caveat — a seamless loop inflates
    // views, watch time and average watch time without reaching one extra person.
    isLoop: true,
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
