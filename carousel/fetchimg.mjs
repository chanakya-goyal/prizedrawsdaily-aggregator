// Pull clean prize photos straight from each draw's operator page (entry_url).
// The operator product page almost always has a gallery of clean product shots — far
// better than the marketing-collage thumbnail in image_url. This is the daily-driver:
// it removes the manual photo step. Claude then visually QAs the candidates.
//
// Multi-platform (Shopify / WooCommerce / custom) + hardened for unattended daily use:
//  • hard per-draw timeout (never hangs — see the @imgly lesson)
//  • triggers lazy-loaded galleries (scroll), reads currentSrc/srcset/data-src
//  • upgrades each URL to highest resolution (Shopify width=, Woo -WxH→original)
//  • filters junk (logos/badges/payment/social/share), dedups by image, keeps top-N
//  • hotlink-bypass download (Referer + weserv proxy fallback)
//
// CLI (default mode): bun carousel/fetchimg.mjs
//   → reads ~/Desktop/pdd-today/selection.json (draws + backups)
//   → writes ~/Desktop/pdd-today/.fetched/{slug}/cand-1..N.<ext> + pick.txt + candidates.json
//   pick.txt holds the chosen candidate filename (default = best guess); Claude edits it after a visual QA.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { workDir } from "./config.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// drop obvious non-product chrome (theme assets, icons, badges, social, UI graphics)
const JUNK = /logo|icons?[-_.]|\bicon\b|sprite|avatar|badge|payment|paypal|visa|mastercard|amex|klarna|clearpay|trustpilot|rating|review-stars|\bflag\b|loader|placeholder|spinner|favicon|cookie|social|whatsapp|tiktok|youtube|app-?store|google-?play|pixel|1x1|blank|spacer|\/theme\/|\/assets\/(?:img\/)?(?:ui|icons?|theme)|\/svg\//i;
const IMG_RE = /\.(jpe?g|png|webp)(\?|$)/i;

// keyword tokens from a prize title (real product photos are usually named after the prize)
const STOP = new Set("win this that the a an or and of for with from your you to in on at is are was new tax free cash worth instant dream draw draws prize prizes giveaway giveaways competition comp comps ticket tickets only just plus get win".split(" "));
const keywords = (title = "") =>
  [...new Set(String(title).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
const proxied = (url, w = 1400) =>
  `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}&w=${w}&output=jpg&q=92&we`;

// upgrade a URL to the highest resolution the platform offers
function maxRes(u) {
  try {
    const url = new URL(u);
    if (/cdn\/shop\/|cdn\.shopify\.com/.test(url.href)) {        // Shopify
      url.searchParams.set("width", "1600");
      url.searchParams.delete("height"); url.searchParams.delete("crop");
      return url.href;
    }
    // WooCommerce/WordPress: strip the -WIDTHxHEIGHT size suffix → original full-res
    return url.href.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))/i, "$1");
  } catch { return u; }
}
// dedup key: same image regardless of size suffix / query
function baseKey(u) {
  try {
    return new URL(u).pathname.toLowerCase()
      .replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, "").replace(/\.(jpe?g|png|webp)$/, "");
  } catch { return u; }
}

// Returns ranked candidate image URLs for a draw page (never throws/hangs; [] on failure).
// Pass opts.browser to reuse one browser across many draws (recommended — see CLI).
export async function fetchCandidates(entryUrl, { max = 6, timeout = 25000, title = "", browser: extBrowser } = {}) {
  const kws = keywords(title);
  let browser = extBrowser, owned = false, ctx;
  try {
    if (!browser) { browser = await chromium.launch(); owned = true; }
    ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 1000 } });
    const page = await ctx.newPage();
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => {});
    await page.evaluate(async () => {                              // trigger lazy galleries
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(500); window.scrollTo(0, document.body.scrollHeight * 0.6);
      await sleep(500); window.scrollTo(0, 0); await sleep(300);
    }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const raw = await page.evaluate(() => {
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      const out = [];
      const push = (u, w = 0, h = 0, hint = "") => { const a = u && abs(u); if (a) out.push({ url: a, w, h, hint }); };
      const bestSrcset = (ss) => {
        if (!ss) return null;
        return ss.split(",").map((x) => x.trim().split(/\s+/)).map(([u, w]) => ({ u, w: parseInt(w) || 0 }))
          .sort((a, b) => b.w - a.w)[0];
      };
      document.querySelectorAll('meta[property="og:image"],meta[property="og:image:secure_url"],meta[name="twitter:image"]')
        .forEach((m) => push(m.content, 0, 0, "og"));
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try { const imgs = []; (function dig(o) { if (!o || typeof o === "string") return;
          if (Array.isArray(o)) return o.forEach(dig);
          if (o.image) { const im = o.image; if (typeof im === "string") imgs.push(im);
            else if (Array.isArray(im)) im.forEach((x) => imgs.push(typeof x === "string" ? x : x?.url));
            else if (im.url) imgs.push(im.url); }
          Object.values(o).forEach(dig); })(JSON.parse(s.textContent));
          imgs.forEach((u) => push(u, 0, 0, "jsonld")); } catch {}
      });
      document.querySelectorAll("img").forEach((im) => {
        const cs = im.currentSrc || im.src; if (cs) push(cs, im.naturalWidth || 0, im.naturalHeight || 0, "img");
        const b = bestSrcset(im.getAttribute("srcset") || im.getAttribute("data-srcset")); if (b) push(b.u, b.w, 0, "srcset");
        ["data-src", "data-original", "data-large_image", "data-zoom-image", "data-image"].forEach((a) => {
          const v = im.getAttribute(a); if (v) push(v, 0, 0, a);
        });
      });
      document.querySelectorAll("source[srcset]").forEach((s) => { const b = bestSrcset(s.getAttribute("srcset")); if (b) push(b.u, b.w, 0, "source"); });
      document.querySelectorAll('a[href]').forEach((a) => { if (/\.(jpe?g|png|webp)(\?|$)/i.test(a.getAttribute("href") || "")) push(a.href, 0, 0, "link"); });
      return out;
    }).catch(() => []);
    await ctx.close().catch(() => {}); ctx = null;

    const seen = new Map();
    for (const c of raw) {
      if (!c.url || JUNK.test(c.url)) continue;
      // keep only things that look like real images (or known image CDNs)
      if (!IMG_RE.test(c.url) && !/cdn\/shop|cdn\.shopify|wp-content\/uploads|\/media\/|cloudfront|imgix|cloudinary/i.test(c.url)) continue;
      const up = maxRes(c.url);
      const key = baseKey(up);
      const area = (c.w || 0) * (c.h || 0);
      // raw gallery shots preferred over branded share images; zoom/lightbox links boosted
      let score = area || 450000;                       // unsized (og/jsonld/data-src) → mid base
      if (/og|share|preview|site-?image/i.test(c.hint) || /og-|share|preview|website-image/i.test(c.url)) score -= 250000;
      if (["link", "data-large_image", "data-zoom-image"].includes(c.hint)) score += 300000;
      // STRONG boost when the filename matches the prize name → product photos beat theme/icon assets
      let path = ""; try { path = decodeURIComponent(new URL(up).pathname.toLowerCase()); } catch {}
      if (kws.length && kws.some((k) => path.includes(k))) score += 5_000_000;
      const prev = seen.get(key);
      if (!prev || score > prev.score) seen.set(key, { url: up, w: c.w, h: c.h, hint: c.hint, score });
    }
    return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max);
  } catch {
    return [];
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
    try { if (owned && browser) await browser.close(); } catch {}   // only close a browser we launched
  }
}

const EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
// fetch with a hard timeout so a slow image host can't stall the routine
const fetchT = (url, opts = {}, ms = 15000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
};
// Download an image (Referer to defeat hotlink protection; weserv proxy fallback). → {buf,ext}|null
export async function downloadImage(url) {
  let origin; try { origin = new URL(url).origin + "/"; } catch {}
  const tries = [
    () => fetchT(url, { headers: { "User-Agent": UA, Referer: origin, Accept: "image/avif,image/webp,image/*,*/*" } }),
    () => fetchT(proxied(url)),
  ];
  for (const t of tries) {
    try {
      const r = await t();
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const ext = EXT[ct] || (ct.startsWith("image/") ? "jpg" : null);
      if (!ext) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 3000) return { buf, ext };
    } catch {}
  }
  return null;
}

const problems = [];

// ---- CLI ----
if (import.meta.main) {
  const DIR = workDir();
  const arg = process.argv[2];
  let outDir, items, perDraw = 5;
  if (arg) { ({ outDir, items, perDraw = 5 } = JSON.parse(await Bun.file(arg).text())); }
  else {
    const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());
    outDir = `${DIR}/.fetched`;
    items = [...sel.draws, ...(sel.backups || [])].filter((d) => d.entry_url).map((d) => ({ slug: d.slug, entryUrl: d.entry_url, title: d.title }));
  }
  const result = {};
  const browser = await chromium.launch();   // ONE browser, reused for every draw (clean, fast, no orphans)
  try {
    for (const { slug, entryUrl, title } of items) {
      const dir = `${outDir}/${slug}`;
      await mkdir(dir, { recursive: true }).catch(() => {});
      let saved = [];
      try {
        const cands = await fetchCandidates(entryUrl, { title, browser });  // per-draw bounded by goto/networkidle timeouts
        for (const c of cands) {
          if (saved.length >= perDraw) break;
          const dl = await downloadImage(c.url);
          if (dl) { const f = `cand-${saved.length + 1}.${dl.ext}`; await Bun.write(`${dir}/${f}`, dl.buf); saved.push({ file: f, url: c.url, w: c.w, h: c.h, hint: c.hint }); }
        }
        if (!saved.length) problems.push({ slug, reason: "no candidates" });
      } catch (e) { problems.push({ slug, reason: e?.message || "no candidates" }); /* one bad draw never stops the rest */ }
      if (saved.length) await Bun.write(`${dir}/pick.txt`, saved[0].file); // default best guess (Claude QAs/edits)
      await Bun.write(`${dir}/candidates.json`, JSON.stringify({ slug, entryUrl, candidates: saved }, null, 2));
      result[slug] = saved.length;
      console.log(`  ${slug.slice(0, 46).padEnd(48)} ${saved.length} candidate(s)`);
    }
  } finally { await browser.close().catch(() => {}); }
  await Bun.write(`${outDir}/report.json`, JSON.stringify({ date: new Date().toISOString(), problems }, null, 2));
  if (problems.length) console.log(`⚠ ${problems.length} draw(s) had photo problems (see .fetched/report.json):`, problems.map((p) => p.slug).join(", "));
  console.log("RESULT " + JSON.stringify(result));
}
