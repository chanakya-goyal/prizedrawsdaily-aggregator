// Rebuild draw images that point at the DEAD old Supabase project.
//
// Context: the 2026-08-20 org migration moved the database to a new project,
// but Storage bytes could not come with it (the old org is 402'd until its
// quota refills on 15 Sep 2026). Every migrated row therefore still points
// its image_url at the old project. Live rows never self-heal — the ingest's
// correctionDecision() deliberately never patches image_url — so this is a
// one-shot repair.
//
// It does NOT copy from the old bucket (unreachable). It re-derives each
// image from the operator's own page via entry_url, then re-hosts through
// the SAME 3-stage lib/rehost.mjs the daily ingest uses, so the result is
// compressed webp at the house params and weserv-blocked origins still work.
//
//   DRY_RUN=false               actually write (default is a dry run)
//   STATUS=active,draft         which rows to repair (default active,draft)
//   LIMIT=50                    stop after N rows
//   CONCURRENCY=6               parallel workers (default 6)
//
// Ended draws are excluded by default: their operator pages are usually gone,
// so they are better recovered from the old bucket after 15 Sep.

import { rehostImage } from "./lib/rehost.mjs";
import { apiOperator, wooOperator } from "./extractor.mjs";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== "false";
const STATUS = (process.env.STATUS || "active,draft").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const DEAD_REF = process.env.DEAD_REF || "kkuuwksgyypicnblwubs";
const WAYBACK = process.env.WAYBACK !== "false"; // archive fallback for dead product pages

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── find the rows still pointing at the dead project ──────────────────
async function listBroken() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const url = `${SB}/rest/v1/draws?select=id,slug,title,entry_url,image_url,status,operators(slug)`
      + `&image_url=like.*${DEAD_REF}*`
      + `&status=in.(${STATUS.join(",")})`
      + `&entry_url=not.is.null&order=draw_date.desc`;
    const r = await fetch(url, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } });
    if (!r.ok) throw new Error(`list failed: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

// ── pull the origin image off the operator's own product page ─────────
function absolutise(src, base) {
  try { return new URL(src.replace(/&amp;/g, "&"), base).href; } catch { return null; }
}

// A bare user-agent trips header-sniffing WAFs that a full browser header set
// sails through — a meaningful share of the "page 403" failures are that, not
// a real block.
const BROWSER_HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

// og:image is what the operator itself advertises as the product image and is
// by far the most consistent field across these very varied platforms.
const IMG_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  /"image"\s*:\s*"([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i,           // JSON-LD
];

function imageFromHtml(html, base) {
  for (const p of IMG_PATTERNS) {
    const m = html.match(p);
    if (m) {
      const abs = absolutise(m[1], base);
      if (abs && /^https?:/i.test(abs)) return abs;
    }
  }
  return null;
}

async function originImage(entryUrl) {
  let html;
  try {
    const r = await fetch(entryUrl, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { img: null, why: `page ${r.status}` };
    html = await r.text();
  } catch (e) { return { img: null, why: `fetch ${e.name || "error"}` }; }

  const img = imageFromHtml(html, entryUrl);
  return img ? { img, why: null } : { img: null, why: "no og:image" };
}

// Last resort for ended draws: the operator has taken the product page down (or
// walls it), but the Internet Archive may hold a snapshot from when the draw was
// live. We read og:image out of the snapshot and then re-host from whatever URL
// it names — usually the operator's CDN, which long outlives the product page.
async function waybackImage(entryUrl) {
  try {
    const a = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(entryUrl)}`,
      { signal: AbortSignal.timeout(25000) });
    if (!a.ok) return null;
    const j = await a.json();
    const snap = j?.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;

    // id_ returns the ORIGINAL bytes without the Archive's rewriting/toolbar.
    const rawUrl = snap.url.replace(/\/(\d{14})\//, "/$1id_/");
    const r = await fetch(rawUrl, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return imageFromHtml(await r.text(), entryUrl);
  } catch { return null; }
}

// ── API operators need their adapter, not og:image ────────────────────
// ukcc and seven-days-perf run an Angular SPA where every HTML path returns
// the same shell — there is no server-rendered og:image to scrape, which is
// why they dominated the first pass's failures (65 of 125 remaining active
// draws). Their images live in the API's thumbnail.url. One adapter call per
// operator builds an entry_url → image_url index for all of their rows.
const normUrl = (u) => (u || "").trim().replace(/\/+$/, "").toLowerCase();

// Woo operators are the other big group: their product pages often carry no
// og:image, but the Store API feed the scraper already uses returns the image
// per product. knownUrls is threaded in so wooOperator returns OUR products
// rather than only the newest N — maxLive caps ingestion, not the re-read.
async function buildAdapterImageIndex(rowsByOp) {
  const index = new Map();
  let ops = [];
  try { ops = await Bun.file("operators.json").json(); } catch { return index; }

  // Deliberately ignores `enabled` — a disabled operator (red-hot-raffles was
  // switched off for 8MB pages stalling the daily run) is still a perfectly good
  // source for the image of a draw we ALREADY have. We are reading one known
  // product, not ingesting new inventory, so the reason it was disabled doesn't
  // apply here.
  const wanted = ops.filter((o) => rowsByOp.has(o.slug)
                                && (o.method === "api" || o.method === "woo"));
  for (const op of wanted) {
    const knownUrls = new Set(rowsByOp.get(op.slug) || []);
    try {
      const rows = op.method === "api"
        ? await apiOperator(op, 500)
        : await wooOperator(op, Math.max(Number(op.maxLive || 0), knownUrls.size, 100), { knownUrls });
      let n = 0;
      for (const r of rows) {
        if (r?.entry_url && r?.image_url) { index.set(normUrl(r.entry_url), r.image_url); n++; }
      }
      console.log(`  ${op.method} ${op.slug}: ${n} image(s) indexed`);
    } catch (e) {
      console.log(`  ${op.method} ${op.slug}: failed (${String(e.message || e).slice(0, 60)})`);
    }
  }
  return index;
}

let API_IMAGES = new Map();

// ── repair one row ────────────────────────────────────────────────────
async function repair(d) {
  const opSlug = d.operators?.slug || "misc";

  // adapter first where we have one — it is authoritative and costs no extra request
  let img = API_IMAGES.get(normUrl(d.entry_url)) || null;
  let why = null;
  if (!img) ({ img, why } = await originImage(d.entry_url));
  // then the archive, for pages the operator has removed or walls off
  if (!img && WAYBACK) {
    const w = await waybackImage(d.entry_url);
    if (w) { img = w; why = null; }
  }
  if (!img) return { ok: false, reason: why };

  if (DRY_RUN) return { ok: true, dry: true, img };

  const res = await rehostImage(img, opSlug, d.slug, { supabaseUrl: SB, serviceKey: KEY });
  if (!res.changed) return { ok: false, reason: `rehost ${res.via}` };

  const p = await fetch(`${SB}/rest/v1/draws?id=eq.${d.id}`, {
    method: "PATCH",
    headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ image_url: res.url }),
  });
  if (!p.ok) return { ok: false, reason: `patch ${p.status}` };

  // measure what we actually stored, to keep the storage budget honest
  let bytes = 0;
  try {
    const h = await fetch(res.url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    bytes = Number(h.headers.get("content-length") || 0);
  } catch { /* size is reporting only */ }
  return { ok: true, via: res.via, url: res.url, bytes };
}

// ── run ───────────────────────────────────────────────────────────────
const rows = await listBroken();
console.log(`${DRY_RUN ? "DRY RUN" : "LIVE"} | status=${STATUS.join("+")} | ${rows.length} broken row(s) | concurrency=${CONCURRENCY}\n`);

const rowsByOp = new Map();
for (const r of rows) {
  const s = r.operators?.slug;
  if (!s) continue;
  if (!rowsByOp.has(s)) rowsByOp.set(s, []);
  rowsByOp.get(s).push(r.entry_url);
}
API_IMAGES = await buildAdapterImageIndex(rowsByOp);
if (API_IMAGES.size) console.log(`  ${API_IMAGES.size} image(s) available from adapters\n`);

let done = 0, fixed = 0, failed = 0, bytes = 0;
const reasons = {}, vias = {};

async function worker(queue) {
  for (;;) {
    const d = queue.shift();
    if (!d) return;
    // rehost's upload() throws on a non-2xx. Left uncaught it kills the worker
    // and, with every worker gone, the whole run — which is exactly how the
    // first ended-draws pass died at row ~1355 of 2106 on a single bad key.
    let r;
    try {
      r = await repair(d);
    } catch (e) {
      r = { ok: false, reason: `threw: ${String(e.message || e).slice(0, 40)}` };
      console.log(`  ✗ ${d.slug.slice(0, 60)} — ${String(e.message || e).slice(0, 80)}`);
    }
    done++;
    if (r.ok) {
      fixed++;
      if (r.via) vias[r.via] = (vias[r.via] || 0) + 1;
      bytes += r.bytes || 0;
    } else {
      failed++;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    if (done % 25 === 0 || done === rows.length) {
      const avg = fixed && bytes ? ` | avg ${(bytes / fixed / 1024).toFixed(0)}KB` : "";
      console.log(`  ${String(done).padStart(4)}/${rows.length}  fixed=${fixed} failed=${failed}${avg}`);
    }
  }
}

const queue = [...rows];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)));

console.log(`\n${"═".repeat(56)}`);
console.log(`  repaired : ${fixed}`);
console.log(`  failed   : ${failed}`);
if (Object.keys(vias).length) console.log(`  via      : ${Object.entries(vias).map(([k, v]) => `${k}=${v}`).join("  ")}`);
if (bytes) {
  console.log(`  stored   : ${(bytes / 1024 / 1024).toFixed(1)} MB  (avg ${(bytes / fixed / 1024).toFixed(0)} KB/image)`);
  console.log(`  projected: ${((bytes / fixed) * 3114 / 1024 / 1024 / 1024).toFixed(2)} GB if all 3,114 draws were stored at this rate`);
}
if (failed) {
  console.log(`  reasons  :`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`);
}
console.log("═".repeat(56));
if (DRY_RUN) console.log("\n  DRY RUN — nothing written. Re-run with DRY_RUN=false to apply.");
