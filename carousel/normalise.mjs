// Asset normalisation at ingest (spec §9). Uncontrolled operator artwork in, one predictable
// master out — or a refusal with a reason.
//
// WHY THIS EXISTS
// Every decorative compensation the old deck carried existed because the input was not
// uniform: a blurred, scaled, saturated copy of the image used as its own background; a
// runtime contain/cover heuristic keyed off a per-draw flag; a card frame to stop a light
// photograph dissolving into its surround. Normalise the input and the compensation becomes
// unnecessary. It also matters beyond looks: Instagram's own ranking note (about.instagram.com,
// 31 May 2023) makes reels "less visible" when they are "majority text" or carry borders, and
// the defence is a dominant photograph. A deck of other operators' marketing collages is the
// opposite of that defence.
//
// THE ENGINE, AND WHY IT IS A BROWSER
// package.json has exactly two dependencies, cheerio and playwright. There is no sharp, no
// jimp, no canvas. So the image engine is Chromium's own canvas, driven through Playwright: it
// decodes every format the scraper meets, gives real pixel access, and resamples with a decent
// filter. ffmpeg is also on the machine but is the wrong shape for measurement.
//
// WHAT IS DETERMINISTIC AND WHAT IS NOT
// Tier 0 (admissibility) and Tier 1 (geometry, ground, tone) are byte-level and deterministic:
// same input, same output, unit-testable, safe to run unattended. The composite/poster signal
// is a HEURISTIC and is reported as advisory rather than used to refuse — telling a marketing
// collage from a photograph of a real scene is a semantic judgement, and a deterministic proxy
// that hard-rejected would throw away legitimate prizes. It surfaces on the image sheet for a
// human instead.

// ---------------------------------------------------------------- Tier 0: admissibility

// Sniff the magic bytes before trusting any content type. Precedent and reason are already in
// fix-operator-logos.mjs: operators serve JPEGs as text/html, PNGs as application/octet-stream,
// and denial pages as image/jpeg.
export function sniff(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 12) return null;
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "image/avif";   // ftyp at offset 4
  return null;
}

// A file that decodes to 1000px on the short edge and occupies under 8 KB is a flat colour, a
// gradient, or a denial graphic. Raised from the old 3000-byte floor, which let those through.
export const BYTE_FLOOR = 8192;

// 64x64, 5 bits per channel, measured on the TRIMMED region so a wide uniform border cannot
// inflate the count. Under 48 distinct colours is not a photograph of anything.
export const MIN_DISTINCT_COLOURS = 48;

// ---------------------------------------------------------------- the master
// The widest and tallest rect any surface takes, so one master serves them all. §5.7's photo
// well is 1015px CSS wide by 615px at a one-line prize name, rendered at deviceScaleFactor 2.
export const MASTER = { w: 2030, h: 1230 };
export const MASTER_AR = MASTER.w / MASTER.h;   // 1.650:1

// ---------------------------------------------------------------- Tier 1: decisions
// These are pure functions of the measurements so they can be unit-tested without a browser.
// The browser only produces numbers; every judgement lives here.

// Ring sigma below 6/255 with a light mean means a product photographed on a near-uniform light
// ground — a seamless white studio shot, which is most of this inventory. That can be keyed out
// by luminance alone: no cutout model, no API, no network.
//
// A high-sigma ring is a photograph of a real scene and is kept AS a photograph. That is also
// the distribution-safe choice: cutting a real scene out produces a floating object on paper,
// which reads as a graphic rather than a photograph.
export function classifyGround({ ringSigma, ringMeanL }) {
  if (ringSigma < 6 && ringMeanL > 88) return "product-on-light";
  if (ringSigma >= 6) return "photograph";
  return "product-on-dark";           // uniform but dark: keep as a plate, never key out
}

// One gain and one gamma, derived from the measured histogram. Deliberately conservative: the
// L* 62 target is applied to a CUTOUT subject, which will sit on paper and must not fight it,
// and NOT to a photograph — a genuinely dark prize, a black car at night, must not be lifted to
// a mid grey. That would be a different photograph.
export function tonePlan(m, { isCutout = false } = {}) {
  const plan = { gain: 1, gamma: 1, saturation: 1, notes: [] };
  if (isCutout && Math.abs(m.meanL - 62) > 4) {
    plan.gain = clamp(62 / Math.max(m.meanL, 1), 0.7, 1.45);
    plan.notes.push(`mean L* ${m.meanL.toFixed(1)} -> 62 (cutout target)`);
  }
  if (m.p5L < 8) { plan.notes.push(`shadow clip: p5 L* ${m.p5L.toFixed(1)} lifted`); plan.gamma *= 0.92; }
  // The highlight pull is gated on the ground being DARK, and that gate is the whole point.
  // Most of this inventory is a product on a white studio ground, where pure-white pixels are
  // the GROUND rather than a blown-out subject. Pulling them dulls the paper the product is
  // meant to sit on and fixes nothing. Without the gate this fired on essentially every asset.
  if (m.p95L > 94 && m.ringMeanL <= 80) { plan.notes.push(`highlight clip: p95 L* ${m.p95L.toFixed(1)} pulled`); plan.gamma *= 1.06; }
  // Contrast is stretched only when the image is genuinely flat, and never by more than 1.25x.
  const range = m.p95L - m.p5L;
  if (range < 55) { plan.contrast = Math.min(1.25, 55 / Math.max(range, 1)); plan.notes.push(`flat: 5-95 range ${range.toFixed(1)} stretched ${plan.contrast.toFixed(2)}x`); }
  // Desaturate only a genuinely oversaturated asset, and never below 0.8x. Operator artwork is
  // often pushed hard; a real product photograph is not.
  if (m.meanC > 46) { plan.saturation = Math.max(0.8, 38 / m.meanC); plan.notes.push(`chroma C* ${m.meanC.toFixed(1)} -> 38`); }
  return plan;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The edge guard is a TEST, not a transform. On a crop whose edge abuts the paper ground, a very
// light outer ring dissolves into the paper. The crop search prefers an anchor that passes; it
// never darkens pixels to force one, because a local darkening ramp is a vignette.
export const EDGE_GUARD_MAX_P95 = 94;
export function edgeGuard({ edgeP95L, padded }) {
  // The guard asks whether a CROP's edge dissolves into the paper it abuts. A PADDED master has
  // no such edge: its outer band is the pad, which is the photo well's own background colour, so
  // measuring it always returns pure white and always "fails". That is the guard testing its own
  // pad rather than the photograph — so it does not apply here.
  if (padded) return { pass: true, edgeP95L, skipped: "padded — the outer band is the well's own ground" };
  return { pass: edgeP95L <= EDGE_GUARD_MAX_P95, edgeP95L };
}

// Advisory only. A poster or collage carries a lot of small, high-contrast structure spread
// across the whole frame; a product photograph carries it around one subject. This distinguishes
// the extremes and is honest about the middle, which is why it never refuses on its own.
export function posterRisk({ edgeDensity, distinctColours }) {
  if (edgeDensity > 0.22 && distinctColours > 400) return "high";
  if (edgeDensity > 0.15) return "medium";
  return "low";
}

// ---------------------------------------------------------------- the browser side

const PAGE_FN = `
(async ({ src, master, opts }) => {
  const img = new Image();
  img.decoding = "sync";
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("decode failed")); img.src = src; });
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) throw new Error("decode failed");

  // sRGB -> L* (CIE lightness). Doing this properly matters: every threshold in the spec is in
  // L*, and approximating it with a luma average moves them all by several points.
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const Lstar = (r, g, b) => {
    const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
  };

  const grab = (w, h) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingQuality = "high";
    return [c, x];
  };

  // ---- measurement pass, on a 256px long-edge downsample
  const sw = W >= H ? 256 : Math.max(1, Math.round(256 * W / H));
  const sh = W >= H ? Math.max(1, Math.round(256 * H / W)) : 256;
  const [sc, sx] = grab(sw, sh);
  sx.drawImage(img, 0, 0, sw, sh);
  const px = sx.getImageData(0, 0, sw, sh).data;

  const Ls = [], Cs = [];
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    Ls.push(Lstar(r, g, b));
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    Cs.push((mx - mn) / 2.55);                       // a rough chroma proxy, 0..100
  }
  const sorted = [...Ls].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // ---- the border ring, scaled to the downsample
  const ringPx = Math.max(2, Math.round(8 * sw / W));
  const ring = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (x >= ringPx && x < sw - ringPx && y >= ringPx && y < sh - ringPx) continue;
    ring.push(Ls[y * sw + x]);
  }
  const ringMeanL = mean(ring);
  const ringSigma = Math.sqrt(mean(ring.map((v) => (v - ringMeanL) ** 2))) * 2.55;  // back to 0-255

  // ---- trim a near-uniform border, then count distinct colours inside it
  let top = 0, bot = sh - 1, left = 0, right = sw - 1;
  const near = (v) => Math.abs(v - ringMeanL) < 4;
  const rowUniform = (y) => { for (let x = 0; x < sw; x++) if (!near(Ls[y * sw + x])) return false; return true; };
  const colUniform = (x) => { for (let y = 0; y < sh; y++) if (!near(Ls[y * sw + x])) return false; return true; };
  while (top < bot && rowUniform(top)) top++;
  while (bot > top && rowUniform(bot)) bot--;
  while (left < right && colUniform(left)) left++;
  while (right > left && colUniform(right)) right--;

  const seen = new Set();
  let edges = 0, edgeCount = 0;
  for (let y = top; y <= bot; y++) for (let x = left; x <= right; x++) {
    const i = (y * sw + x) * 4;
    seen.add(((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3));
    if (x > left && y > top) {
      const l = Ls[y * sw + x];
      const d = Math.abs(l - Ls[y * sw + x - 1]) + Math.abs(l - Ls[(y - 1) * sw + x]);
      edgeCount++;
      if (d > 18) edges++;                            // a strong local step, i.e. an edge
    }
  }

  const m = {
    width: W, height: H, aspect: W / H,
    meanL: mean(Ls), p5L: pct(5), p95L: pct(95), meanC: mean(Cs),
    ringMeanL, ringSigma,
    distinctColours: seen.size,
    edgeDensity: edgeCount ? edges / edgeCount : 0,
    trimmed: { x: left / sw, y: top / sh, w: (right - left + 1) / sw, h: (bot - top + 1) / sh },
  };
  if (opts.measureOnly) return { m };

  // ---- render pass: cover-crop the TRIMMED region to the master aspect, centred on it
  const tx = m.trimmed.x * W, ty = m.trimmed.y * H;
  const tw = m.trimmed.w * W, th = m.trimmed.h * H;
  const targetAR = master.w / master.h;
  let cw = tw, ch = tw / targetAR;
  if (ch > th) { ch = th; cw = th * targetAR; }
  // Pad rather than crop when the trimmed subject is TALLER than the master allows. Cropping a
  // portrait product to 1.65:1 removes the product, which is the bug this whole module exists to
  // stop — a golf trolley cropped to a patch of white background. The pad is the photo well's
  // own ground, so on a white-ground product shot it is invisible.
  const padMode = (tw / th) < targetAR * 0.82;
  const [oc, ox] = grab(master.w, master.h);
  ox.fillStyle = opts.pad || "#FFFFFF";
  ox.fillRect(0, 0, master.w, master.h);
  ox.imageSmoothingQuality = "high";
  const filters = [];
  if (opts.gain !== 1) filters.push("brightness(" + opts.gain + ")");
  if (opts.contrast && opts.contrast !== 1) filters.push("contrast(" + opts.contrast + ")");
  if (opts.saturation !== 1) filters.push("saturate(" + opts.saturation + ")");
  ox.filter = filters.join(" ") || "none";
  if (padMode) {
    const s = Math.min(master.w / tw, master.h / th);
    const dw = tw * s, dh = th * s;
    ox.drawImage(img, tx, ty, tw, th, (master.w - dw) / 2, (master.h - dh) / 2, dw, dh);
  } else {
    ox.drawImage(img, tx + (tw - cw) / 2, ty + (th - ch) / 2, cw, ch, 0, 0, master.w, master.h);
  }

  // ---- edge guard, measured on the SHIPPED crop's outer 24px
  const [gc, gx] = grab(master.w, master.h);
  gx.drawImage(oc, 0, 0);
  const gp = gx.getImageData(0, 0, master.w, master.h).data;
  const edgeLs = [];
  const band = 24;
  for (let y = 0; y < master.h; y++) for (let x = 0; x < master.w; x++) {
    if (x >= band && x < master.w - band && y >= band && y < master.h - band) continue;
    const i = (y * master.w + x) * 4;
    edgeLs.push(Lstar(gp[i], gp[i + 1], gp[i + 2]));
  }
  edgeLs.sort((a, b) => a - b);
  m.edgeP95L = edgeLs[Math.floor(0.95 * edgeLs.length)];
  m.padded = padMode;
  return { m, dataUrl: oc.toDataURL("image/jpeg", 0.92) };
})
`;

// ONE BROWSER PER BUN PROCESS, and that is not an optimisation. Launching chromium a second
// time in the same Bun process hangs — the issue already documented at the top of
// preview-sheet.mjs. Normalising and then rendering in one build is exactly that pattern, so
// this accepts an ALREADY-LAUNCHED browser and the caller owns the single launch. Pass the
// chromium namespace instead and it will launch its own, which is fine for a standalone script.
export async function openEngine(chromiumOrBrowser) {
  const own = typeof chromiumOrBrowser.launch === "function";
  const browser = own ? await chromiumOrBrowser.launch() : chromiumOrBrowser;
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "domcontentloaded" });
  // The worker function is installed ONCE and every image is passed to it as an argument. The
  // first version interpolated the base64 image into the evaluate source, so Chromium parsed a
  // megabyte-and-a-half JS literal per call and eleven images took longer than eight minutes.
  await page.evaluate(`window.__norm = ${PAGE_FN}`);
  return {
    page,
    run: (arg) => page.evaluate((a) => window.__norm(a), arg),
    // Close only what we opened. A borrowed browser belongs to the caller.
    close: async () => { await page.close(); if (own) await browser.close(); },
  };
}

const HARD_TIMEOUT_MS = 20000;   // fetchimg's own rule: a hard per-image timeout, never a hang

export async function measure(engine, buf) {
  const mime = sniff(buf);
  if (!mime) return { ok: false, reason: "not-an-image", detail: "magic bytes match no known format" };
  if (buf.length < BYTE_FLOOR) return { ok: false, reason: "too-small", detail: `${buf.length}B under the ${BYTE_FLOOR}B floor` };
  const src = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  let out;
  try {
    out = await engine.run({ src, master: MASTER, opts: { measureOnly: true } });
  } catch (e) {
    return { ok: false, reason: "decode-failed", detail: String(e.message).slice(0, 120) };
  }
  const m = out.m;
  if (m.distinctColours < MIN_DISTINCT_COLOURS)
    return { ok: false, reason: "flat", detail: `${m.distinctColours} distinct colours under ${MIN_DISTINCT_COLOURS}`, m };
  return { ok: true, mime, m, ground: classifyGround(m), poster: posterRisk(m) };
}

export async function normalise(engine, buf) {
  const a = await measure(engine, buf);
  if (!a.ok) return a;
  const isCutout = a.ground === "product-on-light";
  const plan = tonePlan(a.m, { isCutout });
  const out = await Promise.race([
    engine.run({ src: `data:${a.mime};base64,${Buffer.from(buf).toString("base64")}`, master: MASTER, opts: { ...plan, pad: "#FFFFFF" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`normalise exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)),
  ]);
  const guard = edgeGuard({ ...out.m, padded: out.m.padded });
  const b64 = out.dataUrl.split(",")[1];
  return {
    ok: true, ground: a.ground, poster: a.poster, plan, guard,
    m: { ...a.m, ...out.m },
    buffer: Buffer.from(b64, "base64"),
  };
}
