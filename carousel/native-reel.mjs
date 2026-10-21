// carousel/native-reel.mjs — the native Reel (2026-10-21): ONE prize, the price in the first
// half-second, in the same Instagram-sticker look as the native deck.
//
//   bun carousel/native-reel.mjs            (after build.mjs: reads selection.json + out/images.json)
//   → out/reel-1/{reel.mp4, cover.jpg, reel-keyframes.png, reel-meta.json, REEL_CAPTION.txt}
//   → out/reel-2/… the same five files for the second hero (the morning slot)
//
// Why it looks like this (21 Oct audit, live Graph API): the six old Reels were the only posts
// Instagram showed to non-followers, but 80–92% of viewers left within 2–3 s. They opened on a
// list. This opens on one price said as a claim, with the photograph already moving at frame 0,
// the closing day and the operator on screen by 2.4 s, and an end card pointing at the site.
//
// PROCESS ARCHITECTURE (repo gotcha: ONE chromium.launch() per Bun process): the main process
// never opens a browser. `bun native-reel.mjs --capture job.json` is a child that launches once,
// runs the layout gate at two moments, then screenshots every frame.
import { mkdir, rm, readdir } from "node:fs/promises";
import { workDir, GLOBAL, catCfg } from "./config.mjs";
import { FONT_CSS, NATIVE_CSS, esc, wm, stickerSize, leadSize } from "./native.mjs";
import { hashOf, SITE } from "./native-copy.mjs";
import { pickHeroes, reelModel, reelStrings, reelCaption } from "./native-reel-copy.mjs";
import { encodeVideo, assertVideoContract } from "./encode.mjs";
import { pickAudio } from "./beat.mjs";
import * as compliance from "./compliance.mjs";
import { airTime } from "./autopilot/queue.mjs";

export const W = 1080, H = 1920, FPS = 30;
export const DURATION_MS = 9600;
// Text keep-out for an organic Reel: under Instagram's top bar, above the caption block, and clear
// of the like/comment/share column once below the Story-safe line. Photographs may run anywhere.
export const REEL_SAFE = { x: 65, y: 269, right: 1015, bottom: 1420, buttonsY: 1152, buttonsX: 880 };
// When each beat lands (ms). The price slam carries the audio sting.
export const T = { hook: 0, price: 250, lead: 1100, closes: 1900, operator: 2100, cash: 2900, out: 6500, end: 6800 };
const STING_MS = T.price;

const tilt = (key, max = 2.5) => ((hashOf(key) % 1000) / 1000 * 2 - 1) * max;
const lines = (arr) => arr.filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join("<br>");
const K = (frames) => `data-k='${JSON.stringify(frames)}'`;

// Pop in: from scale `from` and transparent to rest, over `ms`, holding the element's tilt.
const pop = (t, r, { from = 0.6, ms = 280, dy = 0 } = {}) => K([[0, { o: 0, s: from, r, y: dy }], [t, { o: 0, s: from, r, y: dy }], [t + ms, { o: 1, s: 1, r, y: 0 }]]);
// The price sticker lands like a stamp: big, tilted further, then settles.
const slam = (t, r) => K([[0, { o: 0, s: 2.3, r: r - 9 }], [t, { o: 0, s: 2.3, r: r - 9 }], [t + 90, { o: 1, s: 1.2, r: r - 2 }], [t + 300, { o: 1, s: 1, r }]]);

export function reelHtml(m) {
  const c = m.copy;
  const parts = m.closes;
  const hookSize = c.hook.text.length <= 16 ? 84 : c.hook.text.length <= 24 ? 70 : 58;
  const r = (k, max) => tilt(`${m.slug}-${k}`, max);
  const body = `
  <div class="bg" style="background-image:url('${m.photo}')"></div>${wm()}
  <div id="main" ${K([[0, { o: 1, y: 0 }], [T.out, { o: 1, y: 0 }], [T.out + 300, { o: 0, y: -80 }]])} style="position:absolute;inset:0">
    <div class="photo" style="left:40px;top:560px;width:1000px;height:1000px;border-radius:28px;position:absolute">
      <img src="${m.photo}" alt="" ${K([[0, { s: 1.16 }], [T.out, { s: 1.0 }]])}>
    </div>
    <div class="mark" data-t="mark" style="position:absolute;left:72px;right:auto;top:584px;bottom:auto">© ${SITE}</div>
    <div class="bub" data-t="hook" style="position:absolute;left:85px;width:910px;top:290px;font-size:${hookSize}px" ${K([[0, { o: 1, s: 1.12, r: r("hk", 1.4) }], [240, { o: 1, s: 1, r: r("hk", 1.4) }]])}>${lines([c.hook.text])}</div>
    <div style="position:absolute;left:65px;width:950px;top:410px;display:flex;justify-content:center;align-items:center;gap:30px">
      <div class="strong ${m.tone === "pink" ? "pink" : ""}" data-t="price" style="font-size:${Math.min(190, stickerSize(c.price.text) + 40)}px" ${slam(T.price, r("st", 5))}>${esc(c.price.text)}</div>
    </div>
    <div style="position:absolute;left:80px;width:780px;top:1140px;display:flex;flex-direction:column;align-items:flex-start;gap:18px">
      <div class="bub left" data-t="lead" style="max-width:780px;font-size:${Math.min(50, leadSize(c.lead.text))}px" ${pop(T.lead, r("ld", 1.6), { from: 0.85, dy: 40 })}>${lines([c.lead.text])}</div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;max-width:780px">
        <div class="cd" data-t="closes" style="padding:8px 22px 10px;flex:none" ${pop(T.closes, r("cd", 2.2))}><div class="t" style="font-size:22px">${esc(c.closesLabel.text)}</div><div class="v" style="font-size:44px">${parts.map((p) => `<b>${esc(p)}</b>`).join("")}</div></div>
        <div class="loc sm" data-t="operator" style="max-width:780px" ${pop(T.operator, r("op", 1.4), { from: 0.9 })}><i>📍</i><span>${esc(c.operator.text)}</span></div>
      </div>
    </div>
    ${c.cash ? `<div class="bub green" data-t="cash" style="position:absolute;right:84px;top:1010px;font-size:40px" ${pop(T.cash, r("ca", 2))}>${lines([c.cash.text])}</div>` : ""}
  </div>
  <div id="end" ${K([[0, { o: 0, s: 0.92 }], [T.end, { o: 0, s: 0.92 }], [T.end + 380, { o: 1, s: 1 }]])} style="position:absolute;inset:0">
    <div class="pol" style="left:240px;top:300px;transform:rotate(${r("pl", 4).toFixed(2)}deg)"><img src="${m.photo}" alt="" style="width:600px;height:420px"></div>
    <div style="position:absolute;left:85px;width:910px;top:800px;display:flex;flex-direction:column;align-items:center;gap:30px">
      <div class="bub" data-t="more" style="font-size:66px;transform:rotate(${r("mo", 2).toFixed(2)}deg)">${lines([c.more.text])}</div>
      <div class="link" data-t="site" style="transform:rotate(${r("si", 1.6).toFixed(2)}deg)"><i>🔗</i><span>${esc(c.site.text)}</span></div>
    </div>
    <div data-t="fine print" style="position:absolute;left:100px;width:770px;top:1200px;text-align:center;color:rgba(255,255,255,.92);font:600 28px/1.4 Inter;text-shadow:0 1px 6px rgba(0,0,0,.5)">${esc(c.fine.text)}</div>
  </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}
:root{--h:${H}px}
${NATIVE_CSS}
html,body{width:${W}px;height:${H}px}
[data-k]{will-change:transform,opacity}
#main .photo img{transform-origin:50% 55%}
</style></head><body>${body}<script>${RUNTIME}</script></body></html>`;
}

// Deterministic timeline: every animated element carries keyframes [[ms, {o,s,r,x,y}], …];
// __seek(t) sets each one from its segment with an ease-out curve. No CSS animation, no clock.
const RUNTIME = `
(() => {
  const ease = (p) => 1 - Math.pow(1 - p, 3);
  const els = [...document.querySelectorAll('[data-k]')].map((e) => [e, JSON.parse(e.dataset.k)]);
  const at = (k, t) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) if (t <= k[i][0]) {
      const [t0, a] = k[i - 1], [t1, b] = k[i], p = t1 === t0 ? 1 : ease((t - t0) / (t1 - t0)), v = {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) v[key] = (a[key] ?? b[key]) + ((b[key] ?? a[key]) - (a[key] ?? b[key])) * p;
      return v;
    }
    return k[k.length - 1][1];
  };
  window.__seek = (t) => {
    for (const [e, k] of els) {
      const v = at(k, t);
      if (v.o != null) e.style.opacity = v.o;
      e.style.transform = 'translate(' + (v.x || 0) + 'px,' + (v.y || 0) + 'px) rotate(' + (v.r || 0) + 'deg) scale(' + (v.s ?? 1) + ')';
    }
  };
  window.__visible = (e) => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o > 0.5; };
  window.__layout = (safe) => {
    const out = [];
    const els = [...document.querySelectorAll('[data-t]')].filter(window.__visible).map((e) => [e, e.getBoundingClientRect()]);
    for (const [e, r] of els) {
      if (r.left < safe.x || r.top < safe.y || r.right > safe.right || r.bottom > safe.bottom) out.push(e.dataset.t + ' leaves the Reel safe zone (' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ')');
      if (r.bottom > safe.buttonsY && r.right > safe.buttonsX) out.push(e.dataset.t + ' runs under the like/comment/share column');
      for (const c of [e, ...e.querySelectorAll('span')]) if (c.scrollWidth > c.clientWidth + 2 && getComputedStyle(c).whiteSpace === 'nowrap') out.push(e.dataset.t + ' overflows its box');
    }
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const [a, ra] = els[i], [b, rb] = els[j];
      const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      const small = Math.min(ra.width * ra.height, rb.width * rb.height) || 1;
      if (x * y / small > 0.12) out.push(a.dataset.t + ' lands on ' + b.dataset.t);
    }
    return out;
  };
  (async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    const img = document.querySelector('.photo img'), b = img.parentElement.getBoundingClientRect();
    if (img.naturalWidth && b.height) {
      const ir = img.naturalWidth / img.naturalHeight, br = b.width / b.height;
      img.style.objectFit = (1 - Math.min(ir / br, br / ir)) <= 0.30 ? 'cover' : 'contain';
    }
    window.__seek(0);
    window.__ready = true;
  })();
})();`;

// ---------------------------------------------------------------- child: --capture
async function captureChild(jobPath) {
  const { chromium } = await import("playwright");
  const job = await Bun.file(jobPath).json();
  await rm(job.outDir, { recursive: true, force: true });
  await mkdir(job.outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(await Bun.file(job.htmlPath).text(), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction("window.__ready === true", { timeout: 30000 }).catch(() => { throw new Error("native reel: page never became ready (fonts/images)"); });
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
    if (broken) throw new Error(`native reel: ${broken} image(s) failed to decode — refusing a degraded Reel`);
    // The layout gate at the two moments everything is on screen: the full prize beat and the end card.
    const problems = [];
    for (const t of [T.out - 100, DURATION_MS - 200]) {
      await page.evaluate((x) => window.__seek(x), t);
      problems.push(...(await page.evaluate((s) => window.__layout(s), REEL_SAFE)).map((p) => `@${t}ms ${p}`));
    }
    if (problems.length) throw new Error(`native reel layout refused:\n  ${problems.join("\n  ")}`);
    const frames = Math.round(job.durationMs / (1000 / FPS));
    for (let i = 0; i < frames; i++) {
      await page.evaluate((x) => window.__seek(x), Math.round(i * 1000 / FPS));
      await page.screenshot({ path: `${job.outDir}/f${String(i + 1).padStart(5, "0")}.png`, timeout: 15000 });
    }
    console.log(`  captured ${frames} frames`);
  } finally {
    await browser.close();
  }
}

const FF = "/opt/homebrew/bin/ffmpeg";
async function ff(args) {
  const p = Bun.spawn([FF, "-y", "-loglevel", "error", ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`ffmpeg: ${(await new Response(p.stderr).text()).slice(-300)}`);
}
const frameAt = (dir, ms) => `${dir}/f${String(Math.min(Math.round(DURATION_MS / (1000 / FPS)), Math.round(ms / (1000 / FPS)) + 1)).padStart(5, "0")}.png`;

// ---------------------------------------------------------------- main
async function main() {
  const DIR = workDir();
  const sel = await Bun.file(`${DIR}/selection.json`).json();
  const sheet = await Bun.file(`${DIR}/out/images.json`).json().catch(() => []);
  const risk = Object.fromEntries(sheet.map((r) => [r.slug, ({ low: 0, medium: 1, high: 2 })[r.poster] ?? 1]));
  const photoOf = async (d) => {
    const pick = Bun.file(`${DIR}/.fetched/${d.slug}/pick.txt`);
    if (await pick.exists()) {
      const f = Bun.file(`${DIR}/.fetched/${d.slug}/${(await pick.text()).trim()}`);
      if (await f.exists()) return `data:image/jpeg;base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`;
    }
    return d.image_url || null;
  };
  const now = process.env.REEL_NOW ? new Date(process.env.REEL_NOW) : new Date();
  // the hero that closes sooner takes the evening slot; the other still has a night of runway
  const heroes = pickHeroes(sel.draws, { riskOf: (d) => risk[d.slug] ?? 1, count: Number(process.env.REEL_COUNT || 2) })
    .sort((a, b) => +new Date(a.draw_date) - +new Date(b.draw_date));
  if (!heroes.length) { console.error("✗ native reel: no eligible hero in the deck"); process.exit(1); }
  const audio = await pickAudio(catCfg(sel.slug).audioMood);

  for (const [i, d] of heroes.entries()) {
    // out/reel-N/, never out/reel.mp4: that legacy path makes publish.mjs host it as the old daily
    // Reel and write an fb_video row nothing completes. These go through autopilot/queue.mjs.
    const outDir = `${DIR}/out/reel-${i + 1}`;
    const work = `${DIR}/.reelwork/native-${i + 1}`;
    await mkdir(outDir, { recursive: true });
    await mkdir(work, { recursive: true });
    const at = airTime(i, now); // every date word below is worded for when this Reel airs
    const photo = await photoOf(d);
    if (!photo) { console.error(`✗ native reel ${i + 1}: ${d.slug} has no photograph`); process.exit(1); }

    // the wording gate — the same predicates as the deck, with this Reel's own facts
    const facts = compliance.factsTable({
      drawsRendered: 1, prices: [String(d.ticket_price)], caps: [Number(d.total_entries)].filter(Boolean),
      daysToClose: [Math.max(1, Math.ceil((+new Date(d.draw_date) - at.getTime()) / 86400000))],
    });
    const op = [String(d.operators?.name || "").trim()].filter(Boolean);
    const gate = (text, surface = "asset") => [
      ...compliance.checkUnit(text, { facts, surface, bannedPhrases: GLOBAL.bannedPhrases, operatorNames: op }),
      ...(surface === "title" ? [] : compliance.checkQuestionUnit(text, facts)),
    ];
    const m = reelModel({ d, sel, photo, now: at, gate: (line) => gate(line).filter((h) => h.class === compliance.CLASS.A) });
    const hits = reelStrings(m).flatMap(([field, text, surface]) => gate(text, surface).map((h) => ({ ...h, field })));
    const classA = hits.filter((h) => h.class === compliance.CLASS.A);
    if (classA.length) { console.error(`✗ native reel ${i + 1}: class A wording — ${classA.map((h) => `${h.field}: ${h.predicate}`).join(", ")}`); process.exit(1); }
    const caption = reelCaption({ sel, m, d, now: at });
    const capA = compliance.checkUnit(caption, { facts, surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames: op }).filter((h) => h.class === compliance.CLASS.A);
    if (capA.length) { console.error(`✗ native reel ${i + 1}: class A in the caption — ${capA.map((h) => h.predicate).join(", ")}`); process.exit(1); }

    const htmlPath = `${work}/reel.html`;
    await Bun.write(htmlPath, reelHtml(m));
    const job = { htmlPath, outDir: `${work}/frames`, durationMs: DURATION_MS };
    await Bun.write(`${work}/job.json`, JSON.stringify(job));
    const child = Bun.spawn(["bun", import.meta.path, "--capture", `${work}/job.json`], { stdout: "inherit", stderr: "inherit", env: process.env });
    if ((await child.exited) !== 0) { console.error(`✗ native reel ${i + 1}: capture refused (see above)`); process.exit(1); }

    const mp4 = `${outDir}/reel.mp4`;
    await encodeVideo({ framesDir: job.outDir, fps: FPS, out: mp4, audio: { file: audio.file, trimToOnsetMs: audio.firstBeatOffsetMs || 0, stingFile: "stamp-sting.wav", stingTimesMs: [STING_MS] } });
    const contract = await assertVideoContract(mp4);
    // cover = the full prize beat (hook + price + photo + closing day + operator)
    await ff(["-i", frameAt(job.outDir, T.out - 200), "-q:v", "3", `${outDir}/cover.jpg`]);
    const strip = [0, 400, 1300, 2600, T.out - 200, DURATION_MS - 300].map((ms) => frameAt(job.outDir, ms));
    await ff([...strip.flatMap((f) => ["-i", f]), "-filter_complex",
      `${strip.map((_, k) => `[${k}:v]scale=360:640[v${k}]`).join(";")};${strip.map((_, k) => `[v${k}]`).join("")}hstack=inputs=${strip.length}`,
      `${outDir}/reel-keyframes.png`]);
    await Bun.write(`${outDir}/REEL_CAPTION.txt`, caption);
    await Bun.write(`${outDir}/reel-meta.json`, JSON.stringify({
      arm: "native", armSource: "native-reel", durationMs: Math.round(contract.durS * 1000), isLoop: false,
      hero: d.slug, operator: op[0], hookKey: m.hookKey, hook: m.copy.hook.text, audio: { file: audio.file, mood: audio.mood },
      slot: i === 0 ? "reel" : `reel-${i + 1}`,
    }, null, 2));
    console.log(`✓ reel ${i + 1} (${m.hookKey}: "${m.copy.hook.text}") → ${mp4}  ${contract.durS.toFixed(1)}s  ${d.slug.slice(0, 50)}`);
  }
  await rm(`${DIR}/.reelwork`, { recursive: true, force: true });
}

if (import.meta.main) {
  const i = Bun.argv.indexOf("--capture");
  if (i > -1) await captureChild(Bun.argv[i + 1]);
  else await main();
}
