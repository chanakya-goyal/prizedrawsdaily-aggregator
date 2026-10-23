// Repair operator logos so every operator in the directory shows its own mark, served from
// OUR storage. What counts as needing work:
//   - missing, unreachable, or not image bytes (always)
//   - hotlinked from a host we do not own: Google image thumbnails, app-store icons,
//     LinkedIn, Trustpilot... (with REHOST_ALL=true). These break the day the host blocks us.
//
// For each one we gather candidates (owner pick → the operator's own site: apple-touch-icon,
// <img> logo, icon links, og:image → icon services → the current hotlink), measure each, and
// rank them (lib/logos.mjs): sharp square marks first, nothing under 96px, no banners. The winner
// is stored as a 256px transparent square, padded and never cropped, because the site draws
// logos in a square tile with object-cover. publish-images.mjs then mirrors it to Pages.
//
//   DRY_RUN defaults TRUE (nothing is written; works with the anon key).
//     bun fix-operator-logos.mjs                         # broken/missing only
//     REHOST_ALL=true bun fix-operator-logos.mjs --sheet out/logos.html   # + every hotlink, contact sheet
//   ONLY=slug1,slug2           limit the run
//   LOGO_URL=<url> ONLY=<slug> hand-picked mark for one operator
//   logos.json {slug: url}     hand-picked marks, used before discovery (repo root, optional)
//   PICKS=<file>               owner-approved picks from a dry run's out/logo-picks-<date>.json
//   Write (OWNER RUN):  IMAGE_PROVIDER=cloudinary DRY_RUN=false PICKS=out/logo-picks-<date>.json bun fix-operator-logos.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  sniff, imageDims, discoverFromHtml, rankCandidates, judge, needsWork, squareLogoUrl,
  writeRefusal, parsePicks, contactSheet, dataUri,
} from "./lib/logos.mjs";

// Refuse an unsafe write BEFORE any network call or storage import side effects.
const refusal = writeRefusal(process.env);
if (refusal) { console.error(`✗ refusing to write: ${refusal}`); process.exit(1); }

const { UA } = await import("./lib/parse.mjs");
const { putObject, publicBases, deleteObjects, sameObject, IMAGE_PROVIDER } = await import("./lib/storage.mjs");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const readKey = serviceKey || process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !readKey) { console.error("✗ SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required"); process.exit(1); }
const DRY = process.env.DRY_RUN !== "false";
const REHOST_ALL = process.env.REHOST_ALL === "true";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const argSheet = (() => { const i = process.argv.indexOf("--sheet"); return i > 0 ? process.argv[i + 1] : null; })();
const today = new Date().toISOString().slice(0, 10);
const H = { apikey: readKey, Authorization: `Bearer ${readKey}` };

// Hand-picked marks: LOGO_URL (one slug) > PICKS file > logos.json.
const overrides = {};
const loadPicks = (file) => {
  const { picks, bad } = parsePicks(readFileSync(file, "utf8"));
  if (bad.length) console.log(`! ${file}: ignored entries without an http(s) URL: ${bad.join(", ")}`);
  Object.assign(overrides, picks);
};
if (existsSync("logos.json")) loadPicks("logos.json");
if (process.env.PICKS) loadPicks(process.env.PICKS);
if (process.env.LOGO_URL) {
  if (!ONLY || ONLY.size !== 1) { console.error("✗ LOGO_URL needs exactly one ONLY=<slug>"); process.exit(1); }
  overrides[[...ONLY][0]] = process.env.LOGO_URL;
}

async function probe(url, source) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { url, source, ok: false, why: `HTTP ${r.status}` };
    const buf = new Uint8Array(await r.arrayBuffer());
    const dims = sniff(buf) ? imageDims(buf) : null;
    return { url, source, ok: !!dims, why: dims ? undefined : "not an image", bytes: buf.byteLength, dims, buf };
  } catch (e) { return { url, source, ok: false, why: e.name === "TimeoutError" ? "timeout" : String(e.message || e).slice(0, 40) }; }
}

async function candidatesFor(o) {
  const list = [];
  if (overrides[o.slug]) list.push({ url: overrides[o.slug], source: "override" });
  else {
    // The stored logo goes first so the 12-probe cap can never drop it from the comparison.
    if (o.logo_url) list.push({ url: o.logo_url, source: "current" });
    let html = "", site = o.website_url;
    if (site) {
      try {
        const r = await fetch(site, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
        html = await r.text(); site = r.url || site;
      } catch { /* bot-walled or down: well-known paths and icon services below still work */ }
      list.push(...discoverFromHtml(html, site));
    }
  }
  const seen = new Set();
  const probes = [];
  for (const c of list) {
    if (seen.has(c.url) || probes.length >= 12) continue;
    seen.add(c.url);
    probes.push(await probe(c.url, c.source));
  }
  return probes;
}

// The stored form of a candidate: weserv squares, pads and re-encodes it. Null when weserv
// cannot reach the origin (some operator hosts block it).
async function viaWeserv(src) {
  const u = squareLogoUrl(src);
  if (!u) return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return sniff(buf) === "webp" && buf.byteLength >= 100 ? buf : null;
  } catch { return null; }
}

// Store the pick as a dated 256px square webp. Dated key: Pages serves /i/* as immutable for
// 30 days, so overwriting one key would leave browsers on the old logo.
async function store(o, pick) {
  const key = `operator-logos/${o.slug}-${today.replace(/-/g, "")}.webp`;
  const creds = { supabaseUrl, serviceKey };
  let bytes = await viaWeserv(pick.url);
  if (!bytes) {
    // weserv could not reach the origin: upload the raw bytes, square them from OUR copy.
    const ext = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp", svg: "svg", ico: "ico", avif: "avif" }[pick.dims?.kind] || "img";
    const interim = `operator-logos/${o.slug}-src-${today.replace(/-/g, "")}.${ext}`;
    const type = { svg: "image/svg+xml", ico: "image/x-icon" }[pick.dims?.kind] || `image/${pick.dims?.kind || "png"}`;
    const interimUrl = await putObject({ path: interim, bytes: pick.buf, contentType: type, ...creds, bucket: "draw-images" });
    bytes = await viaWeserv(interimUrl);
    if (!sameObject(interim, key)) { try { await deleteObjects([interim]); } catch { /* orphan is waste, not breakage */ } }
    if (!bytes) throw new Error("could not square the image (weserv failed on our own copy too)");
  }
  const url = await putObject({ path: key, bytes, contentType: "image/webp", ...creds, bucket: "draw-images" });
  const p = await fetch(`${supabaseUrl}/rest/v1/operators?id=eq.${o.id}`, {
    method: "PATCH", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ logo_url: url }),
  });
  if (!p.ok) throw new Error(`PATCH ${p.status}`);
  return url;
}

const res = await fetch(`${supabaseUrl}/rest/v1/operators?select=id,slug,name,logo_url,website_url&order=slug`, { headers: H });
if (!res.ok) { console.error(`✗ reading operators: HTTP ${res.status}`); process.exit(1); }
const ops = await res.json();
const bases = publicBases({ supabaseUrl, bucket: "draw-images" });
console.log(`${ops.length} operators · DRY_RUN=${DRY} · REHOST_ALL=${REHOST_ALL} · provider=${IMAGE_PROVIDER}${ONLY ? ` · ONLY=${[...ONLY].join(",")}` : ""}${process.env.PICKS ? ` · PICKS=${Object.keys(overrides).length}` : ""}\n`);

// Six operators at a time: polite to operator sites, and the monthly job fits in CI.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const scope = ops.filter((o) => (!ONLY || ONLY.has(o.slug)) && (!process.env.PICKS || overrides[o.slug])); // a picks run touches only approved slugs
const todo = (await pool(scope, 6, async (o) => {
  let check = null;
  if (o.logo_url) {
    const p = await probe(o.logo_url, "current");
    const v = judge(p);
    check = p.ok ? { ok: true } : { ok: false, why: p.why };
    if (p.ok && !v.keep) check = { ok: true, weak: v.why };
  }
  const why = overrides[o.slug] && (ONLY || process.env.PICKS) ? "owner pick" : needsWork(o, bases, check, { rehostAll: REHOST_ALL });
  return why ? { ...o, why } : null;
})).filter(Boolean);
console.log(`${todo.length} operator(s) need a logo:\n${todo.map((t) => `  • ${t.slug} — ${t.why}`).join("\n")}\n`);

const rows = [], picksOut = { _note: `dry run ${today}: delete any line you reject, then run the write with PICKS=<this file>` };
let fixed = 0; const failed = [];
// Discovery in parallel; reporting and writes stay in slug order, one at a time.
const found = await pool(todo, 6, (o) => candidatesFor(o));
for (const [i, o] of todo.entries()) {
  const probes = found[i];
  const ranked = rankCandidates(probes);
  const pick = ranked[0] || null;
  if (DRY && pick) {
    // Preview the exact stored bytes when weserv can make them; else the raw candidate.
    const sq = await viaWeserv(pick.url);
    pick.squared = !!sq;
    pick.src = sq ? dataUri(sq, "webp") : dataUri(pick.buf, pick.dims?.kind);
    for (const a of ranked.slice(1, 4)) a.src = dataUri(a.buf, a.dims?.kind);
  }
  const rejected = probes.filter((p) => !judge(p).keep).map((p) => `${p.source}: ${judge(p).why}`).slice(0, 4).join("; ");
  const cur = probes.find((p) => p.source === "current" && p.ok);
  rows.push({ slug: o.slug, name: o.name, why: o.why, current: (cur && dataUri(cur.buf, cur.dims?.kind)) || o.logo_url, pick, alternates: ranked.slice(1), rejected });
  if (!pick) { failed.push(o.slug); console.log(`  ❌ ${o.slug} — no usable logo (${probes.length} candidates; ${rejected || "none fetched"})`); continue; }
  picksOut[o.slug] = pick.url;
  const label = `${pick.source} ${pick.dims?.w ?? "?"}x${pick.dims?.h ?? "?"}${pick.verdict.square ? "" : " wide→padded"}`;
  if (DRY) { fixed++; console.log(`  ✅ ${o.slug} ← ${label} ${pick.url.slice(0, 90)}`); continue; }
  try { const url = await store(o, pick); fixed++; console.log(`  ✅ ${o.slug} ← ${label} → ${url}`); }
  catch (e) { failed.push(o.slug); console.log(`  ❌ ${o.slug} — ${String(e.message || e).slice(0, 90)}`); }
}

if (DRY && todo.length) {
  // A partial run (ONLY) must never overwrite the full sheet's picks file.
  const file = `out/logo-picks-${today}${ONLY ? "-partial" : ""}.json`;
  mkdirSync("out", { recursive: true });
  writeFileSync(file, JSON.stringify(picksOut, null, 2) + "\n");
  console.log(`\npicks → ${file}`);
}
if (argSheet) {
  mkdirSync(dirname(argSheet), { recursive: true });
  writeFileSync(argSheet, contactSheet(rows, { date: today }));
  console.log(`contact sheet → ${argSheet}`);
}
console.log(`\n${DRY ? "would fix" : "fixed"}=${fixed}  failed=${failed.length}${failed.length ? " → " + failed.join(", ") : ""}`);
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `need=${todo.length}\nfailed=${failed.length}\n`);
}
