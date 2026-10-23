// Pure helpers for fix-operator-logos.mjs. Kept free of network and env so the rules that
// decide WHICH logo an operator gets are unit-tested (test/logos.test.mjs).
//
// Why the rules look like this:
//   - The site draws every logo inside a small SQUARE tile with object-cover (64px on the
//     operator page, 48px on cards). A wide wordmark is cropped to its middle letters, so a
//     square mark wins over a wide one, and a wide one is padded to a square before upload.
//   - Below 112px a mark is upscaled on the 128/256px srcset and looks soft. 16-48px favicons
//     are rejected outright.
//   - Hotlinks (Google image thumbnails, app-store icons, LinkedIn, Trustpilot) break the day
//     the host blocks us and are not the operator's own mark, so they count as needing work.

export const MIN_SIDE = 112;      // px, a square at or above this is "sharp" on the 2x tile
export const SOFT_SIDE = 96;      // px, a square from SOFT_SIDE to MIN_SIDE is kept, ranked after sharp ones
export const WIDE_LONG = 224;     // px, a wide wordmark needs this long side (it is padded to 256)
export const WIDE_SHORT = 48;     // px, and this short side
export const MAX_ASPECT = 4;      // wider than 4:1 is a banner, not a logo
export const SQUARE_ASPECT = 1.3; // up to this counts as a square mark
export const MIN_BYTES = 512;
export const LOGO_PX = 256;       // stored size: square, padded, transparent

// Magic-byte sniff. Content-type alone is not enough: Trustpilot serves real JPEG/AVIF as
// octet-stream, while a hotlink-blocked host serves an HTML error page with a 200.
export function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const b = (i) => buf[i];
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpeg";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "png";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return "gif";
  if (b(0) === 0x00 && b(1) === 0x00 && b(2) === 0x01 && b(3) === 0x00) return "ico";
  const ascii = (s, e) => String.fromCharCode(...buf.slice(s, e));
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (buf.length >= 12 && ascii(4, 12) === "ftypavif") return "avif";
  const head = new TextDecoder().decode(buf.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

// Width and height from the file header, or null when the format hides them (AVIF) or the
// bytes are truncated. SVG returns {svg:true} with the viewBox size when it has one.
export function imageDims(buf) {
  const kind = sniff(buf);
  try {
    if (kind === "png") return { kind, w: u32be(buf, 16), h: u32be(buf, 20) };
    if (kind === "gif") return { kind, w: u16le(buf, 6), h: u16le(buf, 8) };
    if (kind === "jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return { kind, w: u16be(buf, i + 7), h: u16be(buf, i + 5) };
        i += 2 + u16be(buf, i + 2);
      }
      return { kind, w: null, h: null };
    }
    if (kind === "webp") {
      const chunk = String.fromCharCode(...buf.slice(12, 16));
      if (chunk === "VP8X") return { kind, w: 1 + u24le(buf, 24), h: 1 + u24le(buf, 27) };
      if (chunk === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return { kind, w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === "VP8 ") return { kind, w: u16le(buf, 26) & 0x3fff, h: u16le(buf, 28) & 0x3fff };
    }
    if (kind === "ico") {
      // Largest entry wins; a 0 byte means 256.
      let best = { w: 0, h: 0 };
      const n = u16le(buf, 4);
      for (let k = 0; k < n && 6 + k * 16 + 1 < buf.length; k++) {
        const w = buf[6 + k * 16] || 256, h = buf[7 + k * 16] || 256;
        if (w * h > best.w * best.h) best = { w, h };
      }
      return { kind, ...best };
    }
    if (kind === "svg") {
      const t = new TextDecoder().decode(buf.slice(0, 2048));
      const vb = t.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      return { kind, svg: true, w: vb ? Number(vb[1]) : null, h: vb ? Number(vb[2]) : null };
    }
  } catch { /* truncated header */ }
  return kind ? { kind, w: null, h: null } : null;
}

// Images that contain "logo" but are NOT the operator's brand mark. Picking one is worse than
// picking nothing: croc-comps' first match was the Visa/Mastercard payment strip.
export const JUNK = /payment|visa|mastercard|paypal|klarna|stripe|amex|trustpilot|trustbox|partner|sponsor|affiliat|age-?(?:verif|18)|18plus|gamble|gamstop|bacta|cookie|placeholder|spinner|loading|blank|banner|hero|slider|facebook|fb-|instagram|twitter|x-logo|tiktok|youtube|linkedin|pinterest|whatsapp|snapchat|social|citizens|advice|apple-pay|google-pay|app-?store|google-?play|ssl|secure/i;

const abs = (href, base) => { try { return new URL(href.replace(/&amp;/g, "&"), base).href; } catch { return null; } };

// Candidate logo URLs from an operator's homepage HTML, each tagged with where it came from.
// Order here is discovery order only; rankCandidates() decides.
export function discoverFromHtml(html, site) {
  const out = [];
  const seen = new Set();
  const push = (u, source) => {
    const a = abs(u, site);
    if (!a || seen.has(a) || !/^https?:/i.test(a) || JUNK.test(a)) return;
    seen.add(a); out.push({ url: a, source });
  };
  const rules = [
    ["apple-touch-icon", /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/gi],
    ["apple-touch-icon", /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*apple-touch-icon[^"']*["']/gi],
    ["img-logo", /<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi],
    ["img-logo", /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["']/gi],
    ["img-logo", /<img[^>]+src=["']([^"']*logo[^"']*)["']/gi],
    ["icon", /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/gi],
    ["icon", /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/gi],
    ["og-image", /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi],
  ];
  for (const [source, re] of rules) { let m; while ((m = re.exec(html || ""))) push(m[1], source); }
  for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) push(p, "well-known");
  try {
    const host = new URL(site).hostname;
    push(`https://www.google.com/s2/favicons?domain=${host}&sz=256`, "icon-service");
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`, "icon-service");
  } catch { /* bad site url */ }
  return out;
}

// Lower is better. A probe is {url, source, ok, bytes, dims}.
// Measured on the 2026-10-23 dry run: purpose-built icons are the operator's own square mark;
// the stored logo (often the operator's Trustpilot business logo) is usually right; on-page
// <img> "logo" matches were the noisiest source (a Citizens Advice badge, a Facebook icon).
const SOURCE_RANK = { override: 0, "apple-touch-icon": 1, icon: 2, "well-known": 3, "icon-service": 4, current: 5, "img-logo": 6, "og-image": 7 };

export function judge(p) {
  if (!p.ok) return { keep: false, why: p.why || "fetch failed" };
  if (p.bytes < MIN_BYTES) return { keep: false, why: `only ${p.bytes}B` };
  const d = p.dims;
  if (!d) return { keep: false, why: "not an image" };
  if (d.svg) {
    const aspect = d.w && d.h ? Math.max(d.w, d.h) / Math.min(d.w, d.h) : 1;
    if (aspect > MAX_ASPECT) return { keep: false, why: `banner ${aspect.toFixed(1)}:1` };
    // A tiny viewBox (under 64) is a UI glyph (a badge, an arrow), not a brand mark: soft.
    const tiny = d.w && d.h && Math.max(d.w, d.h) < 64;
    return { keep: true, square: aspect <= SQUARE_ASPECT, sharp: !tiny, minSide: LOGO_PX, aspect };
  }
  // AVIF and some WebP hide their size in the header. Real image bytes are kept, ranked with
  // the wide tier, so a measured square mark still wins and a banner never beats it.
  if (!d.w || !d.h) return { keep: true, square: false, sharp: false, minSide: 0, aspect: 1, unknown: true };
  const minSide = Math.min(d.w, d.h), maxSide = Math.max(d.w, d.h), aspect = maxSide / minSide;
  const square = aspect <= SQUARE_ASPECT;
  if (p.source === "override") return { keep: true, square, sharp: true, minSide, aspect };
  if (aspect > MAX_ASPECT) return { keep: false, why: `banner ${d.w}x${d.h}` };
  if (square && minSide < SOFT_SIDE) return { keep: false, why: `too small ${d.w}x${d.h}` };
  if (!square && (maxSide < WIDE_LONG || minSide < WIDE_SHORT)) return { keep: false, why: `too small ${d.w}x${d.h}` };
  return { keep: true, square, sharp: !square || minSide >= MIN_SIDE, minSide, aspect };
}

// Best first. Override always wins; then square before wide; then source; then size.
export function rankCandidates(probes) {
  return probes
    .map((p) => ({ ...p, verdict: judge(p) }))
    .filter((p) => p.verdict.keep)
    .sort((a, b) => {
      const ov = (a.source === "override" ? 0 : 1) - (b.source === "override" ? 0 : 1);
      if (ov) return ov;
      // Tier: sharp square (0) > soft square (1) > wide wordmark (2).
      const tier = (v) => (v.square ? (v.sharp ? 0 : 1) : 2);
      const sq = tier(a.verdict) - tier(b.verdict);
      if (sq) return sq;
      const sr = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
      if (sr) return sr;
      return Math.min(b.verdict.minSide, 512) - Math.min(a.verdict.minSide, 512);
    });
}

// Does this operator's stored logo need work? `bases` = every public base we own
// (storage.publicBases). `check` = result of fetching the stored URL.
export function needsWork(row, bases, check, { rehostAll = false } = {}) {
  if (!row.logo_url) return "missing";
  if (check && !check.ok) return check.why || "broken";
  if (rehostAll && check?.weak) return `weak ${check.weak}`;
  if (rehostAll && !bases.some((b) => row.logo_url.startsWith(b))) {
    try { return `hotlink ${new URL(row.logo_url).hostname}`; } catch { return "hotlink"; }
  }
  return null;
}

// The weserv URL that turns any candidate into the stored form: a 256px transparent square,
// the mark padded (never cropped), webp. Also used by the contact sheet as the exact preview.
export function squareLogoUrl(url, px = LOGO_PX) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const target = encodeURIComponent(url.replace(/^https?:\/\//i, ""));
  return `https://images.weserv.nl/?url=${target}&w=${px}&h=${px}&fit=contain&cbg=transparent&output=webp&q=90`;
}

// Writing is refused unless every safety condition holds. Returns null when allowed, else the
// reason. Checked BEFORE any network call.
export function writeRefusal(env) {
  if (env.DRY_RUN !== "false") return null; // dry run: nothing is written
  const provider = (env.IMAGE_PROVIDER || "").toLowerCase();
  if (provider !== "cloudinary" && provider !== "r2")
    return `IMAGE_PROVIDER must be cloudinary or r2 for a write (got "${env.IMAGE_PROVIDER || ""}"); the default writes to the frozen Supabase bucket`;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return "SUPABASE_SERVICE_ROLE_KEY is required for a write";
  if (!env.ONLY && !env.PICKS) return "a write needs ONLY=<slug> or PICKS=<approved picks json>; a blind bulk write is not allowed";
  if (env.LOGO_URL && (!env.ONLY || env.ONLY.includes(","))) return "LOGO_URL needs exactly one ONLY=<slug>";
  return null;
}

// Owner-approved picks: {slug: url}. Bad entries are reported, not silently dropped.
export function parsePicks(text) {
  const raw = JSON.parse(text);
  const picks = {}, bad = [];
  for (const [slug, url] of Object.entries(raw)) {
    if (slug.startsWith("_")) continue; // comment keys
    if (typeof url === "string" && /^https?:\/\//i.test(url)) picks[slug] = url; else bad.push(slug);
  }
  return { picks, bad };
}

const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif" };
// Inline an image into the contact sheet so it shows exactly these bytes, offline, with no
// hotlink or proxy involved. Big originals are left as URLs to keep the sheet light.
export function dataUri(buf, kind, maxBytes = 160_000) {
  if (!buf || !MIME[kind] || buf.byteLength > maxBytes) return null;
  return `data:${MIME[kind]};base64,${Buffer.from(buf).toString("base64")}`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One-page contact sheet for the owner: current logo, the pick as it will be stored (on a
// light and a dark tile, the two backgrounds the site uses), and the runners-up.
export function contactSheet(rows, { date }) {
  // object-fit:contain on raw images mimics the padding the stored square will have.
  const tile = (src, bg) => src
    ? `<div class="t" style="background:${bg}"><img src="${esc(src)}" alt=""></div>`
    : `<div class="t none" style="background:${bg}">none</div>`;
  const body = rows.map((r) => {
    const pick = r.pick;
    const alts = (r.alternates || []).slice(0, 3).map((a) =>
      `<figure>${tile(a.src || a.url, "#fff")}<figcaption>${esc(a.source)} ${a.dims?.w ?? "?"}x${a.dims?.h ?? "?"}</figcaption></figure>`).join("");
    return `<tr><td><b>${esc(r.name)}</b><br><code>${esc(r.slug)}</code><br><small>${esc(r.why)}</small></td>
<td>${tile(r.current, "#fff")}</td>
<td>${pick ? `${tile(pick.src || pick.url, "#fff")}${tile(pick.src || pick.url, "#1d1d1f")}<br><small>${esc(pick.source)} · ${pick.dims?.w ?? "?"}x${pick.dims?.h ?? "?"}${pick.verdict?.square ? "" : " · wide, padded"}${pick.squared === false ? " · proxy blocked, squared from our copy at write" : ""}</small><br><small class="u">${esc(pick.url)}</small>` : `<b class="miss">no usable logo found</b><br><small>${esc(r.rejected || "")}</small>`}</td>
<td class="alts">${alts}</td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Operator logos ${esc(date)}</title><style>
body{font:14px/1.4 -apple-system,system-ui,sans-serif;margin:16px;color:#111;background:#fafafa}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:8px;vertical-align:top}
.t{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:12px;overflow:hidden;margin:2px;outline:1px solid #0001}
.t img{width:100%;height:100%;object-fit:contain}.none{color:#999;font-size:11px}.miss{color:#b00}
.u{color:#666;word-break:break-all}figure{display:inline-block;margin:0 6px 0 0;text-align:center}figcaption{font-size:11px;color:#666}
</style></head><body><h1>Operator logos, ${esc(date)}</h1>
<p>${rows.length} operators need a logo. "Pick" is shown as it will be stored (256px square, padded, transparent) on the white card and the dark header. Every image is embedded in this file. Delete any line you reject from the picks file, then run the write.</p>
<table><tr><th>Operator</th><th>Now</th><th>Pick</th><th>Runners-up</th></tr>
${body}</table></body></html>`;
}
