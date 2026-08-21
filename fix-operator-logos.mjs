// Repair operator logos. Two faults this fixes:
//   1. 17 logos still point at the DEAD Supabase project (kkuuwksgyypicnblwubs) and return
//      HTTP 402 since the Aug-2026 org migration — the migration re-hosted DRAW images but
//      never operator logos.
//   2. A handful are missing outright, 404/403 at source, or serve HTML instead of an image.
//
// For each broken operator we discover a logo on their own live site (apple-touch-icon →
// og:image → <img> with "logo" in it → favicon), then re-host it onto OUR storage via the
// same lib/rehost.mjs path the draw-image pipeline uses, so the site never hotlinks again.
//
//   DRY_RUN defaults TRUE.  bun fix-operator-logos.mjs            # report only
//                           DRY_RUN=false bun fix-operator-logos.mjs
//   ONLY=slug1,slug2 limits the run.
import { rehostImage } from "./lib/rehost.mjs";
import { UA } from "./lib/parse.mjs";

const { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey } = process.env;
if (!supabaseUrl || !serviceKey) { console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
const DRY = process.env.DRY_RUN !== "false";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const H = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

// A stored logo is BROKEN when it is absent, unreachable, or not actually image bytes.
// Content-type alone is not enough: Trustpilot serves real JPEG/AVIF as octet-stream, while a
// hotlink-blocked host serves an HTML error page with a 200. Sniff the magic bytes.
const MAGIC = [[0xff,0xd8,0xff],[0x89,0x50,0x4e,0x47],[0x47,0x49,0x46],[0x52,0x49,0x46,0x46]]; // jpg png gif webp/riff
function looksLikeImage(buf, type) {
  if (type === "image/svg+xml" || /^\s*<svg/i.test(new TextDecoder().decode(buf.slice(0, 64)))) return true;
  const head = [...buf.slice(0, 4)];
  if (MAGIC.some((m) => m.every((b, i) => head[i] === b))) return true;
  return buf.length > 12 && new TextDecoder().decode(buf.slice(4, 12)) === "ftypavif";
}
async function checkLogo(url) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, why: "missing" };
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < 512) return { ok: false, why: `only ${buf.byteLength}B` };
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    return looksLikeImage(buf, type) ? { ok: true } : { ok: false, why: `not an image (${type || "?"})` };
  } catch (e) { return { ok: false, why: e.name === "TimeoutError" ? "timeout" : (e.message || "error").slice(0, 40) }; }
}

const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

// Images that contain "logo" but are NOT the operator's brand mark. Picking one of these is
// worse than picking nothing: croc-comps' first match was the Visa/Mastercard payment strip.
const JUNK = /payment|visa|mastercard|paypal|klarna|stripe|amex|trustpilot|trustbox|partner|sponsor|affiliat|age-?(?:verif|18)|18plus|gamble|gamstop|bacta|cookie|placeholder|spinner|loading|blank/i;

// Discover logo candidates on the operator's own site, best first. apple-touch-icon leads:
// it is purpose-built square artwork, unlike og:image (often a promo banner) or a 16px favicon.
async function discoverLogos(site) {
  const out = [];
  const push = (u) => { const a = abs(u, site); if (a && !out.includes(a)) out.push(a); };
  let html = "";
  try {
    const r = await fetch(site, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    html = await r.text();
    site = r.url || site; // follow redirects before resolving relative hrefs
  } catch { /* site unreachable — fall through to well-known paths + icon services below */ }
  for (const re of [
    /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi,
    /<img[^>]+(?:class|id|alt|src)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']*logo[^"']*)["']/gi,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/gi,
  ]) { let m; while ((m = re.exec(html))) push(m[1]); }
  // Well-known paths: many sites serve these even when their HTML is bot-walled.
  for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.ico"]) push(p);
  // Last resort — public icon services fetch the site server-side, so they still work when the
  // origin 403s us. We re-host the bytes, so this is never a live hotlink.
  try {
    const host = new URL(site).hostname;
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    push(`https://www.google.com/s2/favicons?domain=${host}&sz=256`);
  } catch {}
  return out
    .filter((u) => !JUNK.test(u))
    .filter((u) => !/\.svg($|\?)/i.test(u) || out.length === 1); // weserv can't rasterise every svg
}

const ops = await (await fetch(
  `${supabaseUrl}/rest/v1/operators?select=id,slug,name,logo_url,website_url&order=slug`, { headers: H }
)).json();

console.log(`${ops.length} operators · DRY_RUN=${DRY}${ONLY ? ` · ONLY=${[...ONLY].join(",")}` : ""}\n`);
const broken = [];
for (const o of ops) {
  if (ONLY && !ONLY.has(o.slug)) continue;
  const v = await checkLogo(o.logo_url);
  if (!v.ok) broken.push({ ...o, why: v.why });
}
console.log(`${broken.length} operator(s) need a logo:\n${broken.map((b) => `  • ${b.slug} — ${b.why}`).join("\n")}\n`);

let fixed = 0, failed = [];
for (const o of broken) {
  const site = o.website_url || `https://${o.slug.replace(/-/g, "")}.co.uk`;
  const cands = await discoverLogos(site);
  let done = null;
  for (const c of cands.slice(0, 10)) {
    const probe = await checkLogo(c);
    if (!probe.ok) continue;
    if (DRY) { done = { url: c, via: "dry" }; break; }
    try {
      const res = await rehostImage(c, "operator-logos", o.slug, { supabaseUrl, serviceKey });
      if (!res.changed) continue;
      const p = await fetch(`${supabaseUrl}/rest/v1/operators?id=eq.${o.id}`, {
        method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ logo_url: res.url }),
      });
      if (!p.ok) throw new Error(`PATCH ${p.status}`);
      done = res; break;
    } catch (e) { console.log(`    ! ${o.slug}: ${(e.message || e).toString().slice(0, 70)}`); }
  }
  if (done) { fixed++; console.log(`  ✅ ${o.slug} ← ${done.url.slice(0, 96)}`); }
  else { failed.push(o.slug); console.log(`  ❌ ${o.slug} — no usable logo found on ${site} (${cands.length} candidates)`); }
}
console.log(`\n${DRY ? "would fix" : "fixed"}=${fixed}  failed=${failed.length}${failed.length ? " → " + failed.join(", ") : ""}`);
