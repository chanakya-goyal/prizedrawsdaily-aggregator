// Copy every public draw photo and operator logo onto the Cloudflare Pages site, then point
// the rows at the copies. Why Pages: lib/pages.mjs. Runbook: PAGES.md.
//
// One run:
//   1. read the deployed manifest (`manifest.json` on the site: key → sha256, bytes);
//   2. read every draw and operator row, and plan (lib/pages.mjs): what the next deployment
//      holds, and which rows move;
//   3. stage the files in PAGES_DIR/public, reusing what is already there (the Actions cache)
//      when its hash matches the manifest, otherwise downloading from the Pages site (free),
//      the local backup (SEED_DIR, first run only), or Cloudinary (metered, capped);
//   4. refuse to deploy if any photo a row already points at would be missing;
//   5. deploy with wrangler, wait until the site serves the new manifest, spot-check photos;
//   6. only then repoint rows, each guarded by `url=eq.<what we read>`, so a row the scrape
//      rewrote in the meantime is left alone.
// A failure at any step before 6 leaves every row exactly where it was, still loading.
//
//   DRY_RUN=true            plan and stage only: no deploy, no row written
//   SEED_DIR=<dir>          a byte-exact local backup with manifest.jsonl (first run)
//   PAGES_DIR=.pages-images where the site is staged (cached between CI runs)
//   MAX_CLOUDINARY=600      cap on downloads from Cloudinary per run (they cost credits)
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloudinaryConfig } from "./lib/storage.mjs";
import {
  planMirror, pagesBase, pagesSite, pagesProject, pagesUrl, manifestOf,
  HEADERS_FILE, NOT_FOUND_FILE, PAGES_MAX_FILES, PAGES_WARN_FILES, PAGES_MAX_BYTES,
} from "./lib/pages.mjs";

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DRY = process.env.DRY_RUN === "true";
const SEED = process.env.SEED_DIR || "";
const DIR = process.env.PAGES_DIR || ".pages-images";
const PUB = join(DIR, "public"); // the deployed folder; photos under PUB/i, config at its root
const IMG = join(PUB, "i");
const MAX_CLD = Number(process.env.MAX_CLOUDINARY || 600);
const PROJECT = pagesProject();
const SITE = pagesSite();
const BASE = pagesBase();
const UA = "prizedrawsdaily-images-publisher/1 (+https://prizedrawsdaily.co.uk)";

if (!SB || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if ((!CF_TOKEN || !CF_ACCOUNT) && !DRY) {
  // Not an error until the owner adds the secrets: the photos simply stay on Cloudinary.
  console.log("publish-images: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — nothing to do.");
  process.exit(0);
}

const sha256 = (buf) => new Bun.CryptoHasher("sha256").update(buf).digest("hex");
const SBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CFH = { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" };

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

async function readAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SB}/rest/v1/${table}?select=${select}&order=id&limit=1000&offset=${offset}`, { headers: SBH });
    if (!r.ok) throw new Error(`${table} read ${r.status} ${(await r.text()).slice(0, 120)}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// GET a file as bytes, or null. A non-image content-type is an error page, not a photo.
async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      const type = (r.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/")) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      return buf.byteLength ? buf : null;
    } catch { await Bun.sleep(1000 * (attempt + 1)); }
  }
  return null;
}

async function localSha(path) {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  return sha256(new Uint8Array(await f.arrayBuffer()));
}

async function listFiles(root, prefix = "") {
  const out = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

// ── 1. the project and what it serves now ────────────────────────────────────────────
const projUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects`;
// A dry run without credentials skips the project check and plans against an empty site.
let proj = CF_TOKEN && CF_ACCOUNT ? await fetch(`${projUrl}/${PROJECT}`, { headers: CFH }).then((r) => r.json()) : { success: false };
if (!proj.success) {
  if (DRY) { console.log(`DRY RUN: project ${PROJECT} does not exist yet; it would be created.`); proj = { result: { subdomain: new URL(SITE).host } }; }
  else {
    console.log(`creating Pages project ${PROJECT}…`);
    proj = await fetch(projUrl, { method: "POST", headers: CFH, body: JSON.stringify({ name: PROJECT, production_branch: "main" }) }).then((r) => r.json());
    if (!proj.success) { console.error(`✗ could not create the project: ${JSON.stringify(proj.errors).slice(0, 300)}`); process.exit(1); }
  }
}
// Every row we write embeds BASE, so the site must be the project's real address (a taken
// name gets a suffix from Cloudflare).
if (`https://${proj.result.subdomain}/` !== SITE) {
  console.error(`✗ project ${PROJECT} is served at https://${proj.result.subdomain}/ but PAGES_SITE is ${SITE}. Set PAGES_SITE to match before any row is written.`);
  process.exit(1);
}

const deployedRes = await fetch(`${SITE}manifest.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) }).catch(() => null);
const deployed = deployedRes?.ok ? (await deployedRes.json()).files || {} : {};
console.log(`site ${SITE} · ${Object.keys(deployed).length} file(s) deployed now`);

// ── 2. plan ───────────────────────────────────────────────────────────────────────────
const cloud = cloudinaryConfig();
const draws = await readAll("draws", "id,status,image_url");
const operators = await readAll("operators", "id,logo_url");
const { want, repoint, drafts, unsafe } = planMirror({ draws, operators, base: BASE, cloud });
const onPagesRows = draws.filter((d) => d.image_url?.startsWith(BASE)).length + operators.filter((o) => o.logo_url?.startsWith(BASE)).length;
console.log(`plan: ${want.size} file(s) · ${repoint.length} row(s) to move · ${onPagesRows} row(s) already on Pages · ${drafts} draft(s) left on Cloudinary · ${unsafe.length} unsafe key(s) skipped`);
for (const u of unsafe.slice(0, 5)) console.log(`  ! unsafe key, row left alone: ${u.slice(0, 120)}`);

// ── 3. stage ──────────────────────────────────────────────────────────────────────────
const seed = new Map(); // key → sha256, from the byte-exact backup (first run only)
if (SEED) {
  const text = await Bun.file(join(SEED, "manifest.jsonl")).text();
  for (const line of text.split("\n")) { if (!line.trim()) continue; const m = JSON.parse(line); seed.set(m.key, m.sha256); }
  console.log(`seed: ${seed.size} file(s) in ${SEED}`);
}

await mkdir(IMG, { recursive: true });
const staged = new Map(); // key → { sha256, bytes }
const dropped = new Set(); // keys we could not stage — their rows are not moved
const missingLive = []; // keys a row ALREADY points at that we could not stage
const tally = { cache: 0, pages: 0, seed: 0, cloudinary: 0, capped: 0 };
let cldBudget = MAX_CLD;

async function put(key, buf, via) {
  if (buf.byteLength > PAGES_MAX_BYTES) return false;
  const path = join(IMG, key);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, buf);
  staged.set(key, { sha256: sha256(buf), bytes: buf.byteLength });
  tally[via]++;
  return true;
}

await pool([...want], 12, async ([key, w]) => {
  const path = join(IMG, key);
  if (w.from === "pages") {
    // Already deployed. Reuse the cached copy only when it is byte-identical to what the
    // site serves; otherwise fetch it from the site itself (no meter on Pages).
    const expected = deployed[key]?.sha256;
    if (expected && (await localSha(path)) === expected) {
      staged.set(key, { sha256: expected, bytes: deployed[key].bytes }); tally.cache++; return;
    }
    const buf = await download(pagesUrl(BASE, key));
    if (buf && (!expected || sha256(buf) === expected) && (await put(key, buf, "pages"))) return;
    missingLive.push(key); dropped.add(key); return;
  }
  // From Cloudinary. A migrated (image-form) photo is byte-identical to the backup.
  if (w.form === "image" && seed.has(key)) {
    const buf = await Bun.file(join(SEED, key)).arrayBuffer().then((b) => new Uint8Array(b)).catch(() => null);
    if (buf && sha256(buf) === seed.get(key) && (await put(key, buf, "seed"))) return;
  }
  if (cldBudget <= 0) { tally.capped++; dropped.add(key); return; }
  cldBudget--;
  const buf = await download(w.url);
  if (buf && (await put(key, buf, "cloudinary"))) return;
  dropped.add(key);
});

// Nothing outside the plan survives into the deployment: a photo whose rows were all
// retired by image-retention.mjs drops off the site here.
let pruned = 0;
for (const rel of await listFiles(IMG)) {
  if (!staged.has(rel)) { await rm(join(IMG, rel)); pruned++; }
}
// Tell CI whether the staged folder differs from what its cache held, so it saves a new one.
const gh = process.env.GITHUB_OUTPUT;
if (gh && (tally.pages + tally.seed + tally.cloudinary + pruned) > 0) await writeFile(gh, "save_cache=true\n", { flag: "a" });
console.log(`staged ${staged.size}: cache ${tally.cache} · pages ${tally.pages} · seed ${tally.seed} · cloudinary ${tally.cloudinary}` +
  ` · capped ${tally.capped} · failed ${dropped.size - tally.capped - missingLive.length} · pruned ${pruned}`);

// ── 4. gates ──────────────────────────────────────────────────────────────────────────
if (missingLive.length) {
  // A row points at a Pages photo we could not reproduce. Deploying without it would not
  // make that row worse (it is already missing or unreadable), but it is never normal.
  console.log(`⚠️ ${missingLive.length} photo(s) rows already use could not be staged: ${missingLive.slice(0, 5).join(", ")}`);
}
const deployedKeys = Object.keys(deployed);
const lost = deployedKeys.filter((k) => !staged.has(k) && want.get(k)?.from === "pages");
if (lost.length) {
  console.error(`✗ refusing to deploy: ${lost.length} photo(s) that rows point at would be removed (${lost.slice(0, 5).join(", ")}).`);
  process.exit(1);
}
if (staged.size > PAGES_WARN_FILES) {
  console.log(`⚠️ NEAR THE LIMIT: ${staged.size} photos; Pages free plan stops at 20,000 per site. Lower RETENTION_DAYS or add a second Pages project (PAGES.md).`);
  if (gh) await writeFile(gh, "near_limit=true\n", { flag: "a" });
}
if (staged.size + 3 > PAGES_MAX_FILES) {
  console.error(`✗ refusing to deploy: ${staged.size} files is past the ${PAGES_MAX_FILES} guard (Pages free plan stops at 20,000). Lower RETENTION_DAYS.`);
  process.exit(1);
}

const moves = repoint.filter((p) => staged.has(p.key));
const manifest = manifestOf(staged);
const unchanged = JSON.stringify(manifest.files) === JSON.stringify(manifestOf(Object.entries(deployed)).files);
if (DRY) {
  console.log(`DRY RUN: would deploy ${staged.size} file(s) (${unchanged ? "unchanged" : "changed"}) and move ${moves.length} row(s).`);
  process.exit(0);
}

// ── 5. deploy and confirm ─────────────────────────────────────────────────────────────
if (!unchanged) {
  await writeFile(join(PUB, "_headers"), HEADERS_FILE);
  await writeFile(join(PUB, "404.html"), NOT_FOUND_FILE);
  await writeFile(join(PUB, "manifest.json"), JSON.stringify(manifest));
  // cwd = DIR: wrangler would bundle a `functions/` folder found in its working directory.
  const p = Bun.spawn(["bunx", "wrangler@4.148.0", "pages", "deploy", "public", `--project-name=${PROJECT}`, "--branch=main", "--commit-dirty=true"], {
    cwd: DIR, env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT }, stdout: "inherit", stderr: "inherit",
  });
  if ((await p.exited) !== 0) { console.error("✗ wrangler deploy failed — no row was changed."); process.exit(1); }

  const want_ = JSON.stringify(manifest.files);
  let live = false;
  for (let i = 0; i < 24 && !live; i++) {
    const r = await fetch(`${SITE}manifest.json?check=${Date.now()}`, { headers: { "User-Agent": UA } }).catch(() => null);
    if (r?.ok) live = JSON.stringify((await r.json()).files) === want_;
    if (!live) await Bun.sleep(5000);
  }
  if (!live) { console.error("✗ the site never served the new manifest — no row was changed."); process.exit(1); }
  console.log("✓ deployed and live");
} else console.log("site already holds exactly this set — no deploy");

// Spot-check the photos the rows are about to use: right status, right size.
const sample = [...new Set(moves.map((m) => m.key))].sort(() => Math.random() - 0.5).slice(0, 25);
let bad = 0;
await pool(sample, 8, async (key) => {
  const r = await fetch(pagesUrl(BASE, key), { headers: { "User-Agent": UA } }).catch(() => null);
  const len = r?.ok ? (await r.arrayBuffer()).byteLength : -1;
  if (len !== staged.get(key).bytes) { bad++; console.log(`  ✗ ${key}: ${r?.status ?? "no response"}, ${len} bytes`); }
});
if (bad) { console.error(`✗ ${bad}/${sample.length} spot-checked photo(s) wrong on the site — no row was changed.`); process.exit(1); }

// ── 6. repoint ────────────────────────────────────────────────────────────────────────
let moved = 0, raced = 0, failed = 0;
await pool(moves, 8, async (m) => {
  const q = `id=eq.${encodeURIComponent(m.id)}&${m.column}=eq.${encodeURIComponent(m.old)}`;
  const r = await fetch(`${SB}/rest/v1/${m.table}?${q}`, {
    method: "PATCH", headers: { ...SBH, Prefer: "return=representation" },
    body: JSON.stringify({ [m.column]: pagesUrl(BASE, m.key) }),
  }).catch(() => null);
  if (!r?.ok) { failed++; return; }
  const rows = await r.json().catch(() => []);
  if (rows.length) moved++; else raced++;
});
console.log(`rows: moved ${moved} · changed since read ${raced} · failed ${failed} · waiting for next run ${repoint.length - moves.length}`);
// A failed PATCH leaves that row on Cloudinary, still loading: worth a red run, not a panic.
if (failed) process.exit(1);
