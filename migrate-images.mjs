// Move EVERY draw photo and logo off Supabase Storage to the active provider (Cloudinary or
// R2), keep a local backup of every object from the same download, and point the database at
// the new home.
//
// WHY: the Supabase Free bucket reached 1,004 MB of 1,024 MB on 2026-10-09 — the second time
// in two months — because every draw photo was kept forever. The owner's call is to leave the
// Supabase project holding ONLY its database: a fresh storage counter, not a bucket frozen at
// 97% of its quota and one stray write from a 402 on every API. See CLOUDINARY.md.
//
// PHASES, deliberately separate — bytes are proven at the new address AND on local disk
// before any row is repointed, and nothing here ever deletes an object.
//
//   bun migrate-images.mjs --phase=copy         # Supabase → provider + local backup. Resumable.
//   bun migrate-images.mjs --phase=verify       # every referenced object present + right size + cacheable
//   bun migrate-images.mjs --phase=rewrite      # PATCH draws.image_url / operators.logo_url
//   bun migrate-images.mjs --phase=empty-check  # READ-ONLY: would the bucket be safe to empty?
//
// `empty-check` evaluates lib/migration.mjs emptyGate against real evidence (byte-exact local
// backup, every row on the provider, every provider copy GET-verified) and prints exactly what
// could be deleted. It deletes NOTHING. Emptying the bucket is a separate step that needs the
// owner's explicit go-ahead (CLOUDINARY.md).
//
// DRY_RUN=true is the default; --limit=N rehearses on a handful (copy/verify/rewrite).
// BACKUP_DIR defaults to the newest ~/pdd-backups/draw-images-<date>/ (or today's): reusing it
// is what lets a resumed copy read from disk instead of downloading again.
//
// Only the `draw-images` bucket is ever read — never carousel-slides or badges.
import { homedir } from "node:os";
import { mkdir, readdir, appendFile } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { listBucketDeep, PUBLIC_PREFIX, IMAGE_PROVIDER, cloudinaryConfig, cloudinaryPublicBase, cloudinaryUpload, cloudinaryInventory, publicIdOf, r2Client, r2PublicBase, UPLOAD_CACHE_CONTROL, objectPathFromUrl } from "./lib/storage.mjs";
import { selectToMove, emptyGate, onceAsync } from "./lib/migration.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.BUCKET || "draw-images";
const DRY = process.env.DRY_RUN !== "false";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || d;
const PHASE = arg("phase", "");
const LIMIT = Number(arg("limit", 0)) || Infinity;
// Which provider to move TO. Defaults to IMAGE_PROVIDER; name it explicitly to run the copy
// before or after the scrape is switched (--to=cloudinary).
const TO = arg("to", IMAGE_PROVIDER === "supabase" ? "" : IMAGE_PROVIDER);

if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!["copy", "verify", "rewrite", "empty-check"].includes(PHASE)) { console.error("✗ --phase=copy | verify | rewrite | empty-check"); process.exit(1); }
if (!["cloudinary", "r2"].includes(TO)) { console.error("✗ set IMAGE_PROVIDER=cloudinary|r2, or pass --to=cloudinary|r2"); process.exit(1); }
if (BUCKET !== "draw-images") { console.error(`✗ this script only ever reads draw-images (BUCKET=${BUCKET} refused)`); process.exit(1); }

const creds = { supabaseUrl: URL_, serviceKey: KEY, bucket: BUCKET };
const SB_PREFIX = PUBLIC_PREFIX(creds);
const MB = (b) => (b / 1048576).toFixed(1) + " MB";
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const sha256 = (bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function pool(items, worker, n = CONCURRENCY) {
  let i = 0;
  const run = async () => { for (;;) { const k = i++; if (k >= items.length) return; await worker(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function readAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=${select}&order=id&limit=1000&offset=${offset}`, { headers: H });
    if (!r.ok) throw new Error(`${table} read ${r.status} ${(await r.text()).slice(0, 120)}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// ─── the local backup ─────────────────────────────────────────────────────────
async function backupDir() {
  if (process.env.BACKUP_DIR) return resolve(process.env.BACKUP_DIR);
  const root = join(homedir(), "pdd-backups");
  // Reuse the newest existing backup: a resume on a later day must find what it already has,
  // or it downloads the whole bucket again (Supabase egress is metered too).
  const existing = await readdir(root).then((n) => n.filter((x) => /^draw-images-\d{4}-\d{2}-\d{2}$/.test(x)).sort()).catch(() => []);
  return join(root, existing.at(-1) || `draw-images-${new Date().toISOString().slice(0, 10)}`);
}
const BACKUP = await backupDir();
const MANIFEST = join(BACKUP, "manifest.jsonl");
/** Disk path for a bucket key — refusing anything that would escape the backup folder. */
const diskPath = (key) => {
  const p = resolve(BACKUP, key);
  if (!p.startsWith(BACKUP + sep)) throw new Error(`refusing key outside the backup folder: ${key}`);
  return p;
};
const diskSize = async (key) => { const f = Bun.file(diskPath(key)); return (await f.exists()) ? f.size : -1; };
async function loadManifest() {
  const m = new Map();
  const f = Bun.file(MANIFEST);
  if (!(await f.exists())) return m;
  for (const line of (await f.text()).split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); m.set(e.key, e); } catch { /* a torn last line from an interrupted run */ }
  }
  return m; // last entry per key wins
}

// ─── the destination, behind one small interface ─────────────────────────────
// lookup(path) → { bytes, url } | null   put(path, bytes, type) → { bytes, url }
const PREVIEW_ONLY = { name: "(destination not configured — preview only)", base: null, lookup: async () => null };
function destination() {
  const canPreview = DRY && PHASE === "copy";
  if (TO === "cloudinary") {
    const cfg = cloudinaryConfig();
    if (!cfg) {
      if (canPreview) return PREVIEW_ONLY;
      console.error("✗ Cloudinary not configured — set CLOUDINARY_URL (see CLOUDINARY.md)"); process.exit(1);
    }
    // The migration's world is the IMAGE assets it created on 2026-10-09: selectToMove,
    // verify, rewrite and empty-check all reason about `/image/upload/` URLs and
    // extension-less public_ids. New uploads elsewhere are raw (cloudinaryUpload explains
    // why); this script stays image so its bookkeeping stays true if it is ever re-run.
    const base = cloudinaryPublicBase(cfg, "image");
    // Shared, one-shot index load: concurrent lookups must all wait for the SAME finished
    // inventory, never see a half-built Map (see onceAsync in lib/migration.mjs).
    const index = onceAsync(async () => {
      const byId = new Map();
      for (const v of (await cloudinaryInventory({ resourceTypes: ["image"] })).values()) byId.set(v.publicId, v);
      return byId;
    });
    return {
      name: `Cloudinary (${cfg.cloudName})`,
      base,
      // One Admin API call per 500 assets — never one per image (500 calls/hour on Free).
      async lookup(path) {
        const hit = (await index()).get(publicIdOf(path));
        return hit ? { bytes: hit.bytes, url: base + enc(`${hit.publicId}.${hit.format}`) } : null;
      },
      async put(path, bytes, type) {
        const res = await cloudinaryUpload({ path, bytes, contentType: type, resourceType: "image" });
        (await index()).set(res.public_id, { publicId: res.public_id, format: res.format, bytes: res.bytes });
        return { bytes: res.bytes, url: base + enc(`${res.public_id}.${res.format}`) };
      },
    };
  }
  const base = r2PublicBase();
  if (!base) {
    if (canPreview) return PREVIEW_ONLY;
    console.error("✗ needs R2_PUBLIC_BASE"); process.exit(1);
  }
  const r2 = r2Client();
  return {
    name: `R2 (${process.env.R2_BUCKET})`,
    base,
    async lookup(path) {
      const s = await r2.file(path).stat().catch(() => null);
      return s ? { bytes: s.size, url: base + enc(path) } : null;
    },
    async put(path, bytes, type) {
      await r2.write(path, bytes, { type, cacheControl: UPLOAD_CACHE_CONTROL });
      return { bytes: bytes.byteLength, url: base + enc(path) };
    },
  };
}

// ─── what is where ────────────────────────────────────────────────────────────
const dest = destination();
const draws = await readAll("draws", "id,status,image_url");
const operators = await readAll("operators", "id,logo_url");
const { move, onCloud, skipped } = selectToMove({ draws, operators, sbPrefix: SB_PREFIX, cloudBase: dest.base });
const bucket = (await listBucketDeep(creds)).map((f) => ({ path: f.path, size: f.metadata?.size || 0 }));
const sizeOf = new Map(bucket.map((o) => [o.path, o.size]));
const rowsOf = (path) => [...(move.get(path) || []), ...(onCloud.get(publicIdOf(path)) || [])];
const missingAtSource = [...move.keys()].filter((p) => !sizeOf.has(p));
const referenced = bucket.filter((o) => move.has(o.path) || onCloud.has(publicIdOf(o.path)));
const orphans = bucket.filter((o) => !move.has(o.path) && !onCloud.has(publicIdOf(o.path)));
const sum = (xs) => xs.reduce((a, o) => a + o.size, 0);
const nRows = [...move.values()].reduce((a, r) => a + r.length, 0);

console.log(`${DRY ? "DRY RUN" : "LIVE"} · phase=${PHASE} · Supabase ${BUCKET} → ${dest.name}`);
console.log(`  bucket: ${bucket.length} object(s), ${MB(sum(bucket))} — ${referenced.length} referenced (${MB(sum(referenced))}), ${orphans.length} unreferenced (${MB(sum(orphans))})`);
console.log(`  rows still on Supabase: ${nRows} across ${move.size} key(s) · already on the provider: ${skipped.alreadyMoved} · not ours: ${skipped.dead} dead-project, ${skipped.foreign} hotlinked · ${skipped.empty} empty`);
if (missingAtSource.length) console.log(`  ! ${missingAtSource.length} key(s) referenced by rows but absent from the bucket, e.g. ${missingAtSource.slice(0, 3).join(", ")}`);
console.log(`  backup: ${BACKUP}\n`);

/**
 * GET one public URL with `Range: bytes=0-0` — a real GET (so the headers are the truth) that
 * costs one byte of bandwidth. Returns true, or a reason string. `expectBytes` checks the size
 * from Content-Range (or the body, if the server ignored the range).
 */
async function checkServed(url, expectBytes) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
    const cc = r.headers.get("cache-control") || "";
    const type = r.headers.get("content-type") || "";
    let total = Number((r.headers.get("content-range") || "").split("/")[1]);
    if (r.status === 200) total = (await r.arrayBuffer()).byteLength; else await r.arrayBuffer().catch(() => {});
    if (r.status !== 200 && r.status !== 206) return `HTTP ${r.status}`;
    if (!type.startsWith("image/")) return `content-type ${type || "(none)"}`;
    const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] || 0);
    if (maxAge < 86400 || /no-cache|no-store/.test(cc)) return `not cacheable: "${cc || "(none)"}"`;
    if (expectBytes != null && total !== expectBytes) return `size ${total} != ${expectBytes}`;
    return true;
  } catch (e) { return (e.message || String(e)).slice(0, 80); }
}

// ─── copy (+ backup) ──────────────────────────────────────────────────────────
if (PHASE === "copy") {
  // Referenced objects first, so a --limit rehearsal exercises the upload path. Unreferenced
  // objects go to disk only — nothing on the site would load them from the provider.
  const work = [...referenced, ...orphans].slice(0, LIMIT);
  const manifest = await loadManifest();
  if (!DRY) await mkdir(BACKUP, { recursive: true });
  const t = { downloaded: 0, fromDisk: 0, uploaded: 0, alreadyThere: 0, failed: 0, dlBytes: 0, upBytes: 0 };
  const errors = [];
  await pool(work, async ({ path, size }) => {
    try {
      const toProvider = move.has(path);
      let bytes = null;
      let type = path.endsWith(".png") ? "image/png" : /\.jpe?g$/.test(path) ? "image/jpeg" : "image/webp";
      // 1. Local backup — from the SAME download that feeds the upload, so the backup costs no
      //    extra Supabase egress. Already on disk at the right size → read it from there.
      if ((await diskSize(path)) === size) t.fromDisk++;
      else if (DRY) { t.downloaded++; t.dlBytes += size; }
      else {
        const src = await fetch(SB_PREFIX + encodeURI(path), { signal: AbortSignal.timeout(60_000) });
        if (!src.ok) throw new Error(`source ${src.status}`);
        type = (src.headers.get("content-type") || type).split(";")[0];
        bytes = new Uint8Array(await src.arrayBuffer());
        // A truncated download must never land as a "good" object, on disk or upstream.
        if (size && bytes.byteLength !== size) throw new Error(`size ${bytes.byteLength} != ${size}`);
        await mkdir(dirname(diskPath(path)), { recursive: true });
        await Bun.write(diskPath(path), bytes);
        t.downloaded++; t.dlBytes += size;
      }
      // 2. Upload, unless the provider already has it at the right size (resumable).
      if (toProvider) {
        const have = await dest.lookup(path);
        if (have && have.bytes === size) t.alreadyThere++;
        else if (DRY) { t.uploaded++; t.upBytes += size; }
        else {
          bytes ??= new Uint8Array(await Bun.file(diskPath(path)).arrayBuffer());
          await dest.put(path, bytes, type);
          t.uploaded++; t.upBytes += size;
        }
      }
      // 3. Manifest: what the backup holds, its hash, and which rows used it.
      const m = manifest.get(path);
      if (!DRY && !(m && m.bytes === size)) {
        bytes ??= new Uint8Array(await Bun.file(diskPath(path)).arrayBuffer());
        await appendFile(MANIFEST, JSON.stringify({ key: path, bytes: size, sha256: sha256(bytes), rows: rowsOf(path) }) + "\n");
      }
      const done = t.downloaded + t.fromDisk;
      if (!DRY && done % 250 === 0) console.log(`  … ${done}/${work.length} on disk, ${t.uploaded} uploaded`);
    } catch (e) {
      t.failed++; if (errors.length < 15) errors.push(`${path}: ${(e.message || e).toString().slice(0, 90)}`);
    }
  });
  console.log(`${DRY ? "would download" : "downloaded"} ${t.downloaded} (${MB(t.dlBytes)} of Supabase egress) · already on disk ${t.fromDisk}`);
  console.log(`${DRY ? "would upload" : "uploaded"} ${t.uploaded} (${MB(t.upBytes)}) · already at the provider ${t.alreadyThere} · failed ${t.failed}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (DRY) console.log("\nRe-run with DRY_RUN=false to apply.");
  else if (t.failed) { console.error("\n✗ some objects failed — re-run copy (it resumes) before verify."); process.exit(1); }
}

// ─── verify ───────────────────────────────────────────────────────────────────
if (PHASE === "verify") {
  const wanted = referenced.slice(0, LIMIT);
  let ok = 0, missing = 0, mismatched = 0, bad = 0;
  const notes = [];
  const urls = [];
  await pool(wanted, async ({ path, size }) => {
    const have = await dest.lookup(path);
    if (!have) { missing++; if (notes.length < 15) notes.push(`MISSING  ${path}`); return; }
    if (have.bytes !== size) { mismatched++; if (notes.length < 15) notes.push(`SIZE     ${path} ${have.bytes} != ${size}`); return; }
    ok++; urls.push(have.url);
  });
  // Over the PUBLIC url with GET: that is what weserv and browsers see, and HEAD lied on
  // Supabase Storage. "Cacheable" = max-age ≥ a day and no no-cache/no-store — the header whose
  // absence turned a 596 MB bucket into 6.37 GB of egress in Sep 2026.
  const step = Math.max(1, Math.floor(urls.length / 12));
  const sample = urls.filter((_, i) => i % step === 0).slice(0, 12);
  for (const u of sample) {
    const v = await checkServed(u);
    if (v !== true) { bad++; notes.push(`SERVE    ${u} → ${v}`); }
  }
  console.log(`present+correct ${ok} · missing ${missing} · size mismatch ${mismatched}`);
  console.log(`public GET sample: ${sample.length - bad}/${sample.length} served as cacheable images`);
  for (const n of notes) console.log(`  ! ${n}`);
  if (missing || mismatched || bad) { console.error("\n✗ NOT safe to go on yet."); process.exit(1); }
  console.log("\n✓ every referenced image is at the new address, the right size, and cacheable.");
}

// ─── rewrite ──────────────────────────────────────────────────────────────────
if (PHASE === "rewrite") {
  console.log(`ROLLBACK: nothing is deleted by this phase. To undo, PATCH the same rows back to ${SB_PREFIX}<key>.\n`);
  const urlOf = new Map([...draws.map((d) => [`draws.${d.id}`, d.image_url]), ...operators.map((o) => [`operators.${o.id}`, o.logo_url])]);
  const jobs = [];
  for (const [path, refs] of move) {
    if (!sizeOf.has(path)) continue;
    for (const ref of refs) jobs.push({ ref, path });
  }
  const todo = jobs.slice(0, LIMIT);
  let done = 0, notThere = 0, raced = 0, failed = 0;
  await pool(DRY ? [] : todo, async ({ ref, path }) => {
    // Only repoint a row whose bytes are demonstrably at the new address.
    const have = await dest.lookup(path);
    if (!have || have.bytes !== sizeOf.get(path)) { notThere++; return; }
    const [table, id] = ref.split(/\.(.+)/);
    const column = table === "draws" ? "image_url" : "logo_url";
    // `<column>=eq.<old>`: if the scrape rewrote this row since we read it, leave it alone
    // rather than overwrite a newer image with an older one.
    const r = await fetch(`${URL_}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&${column}=eq.${encodeURIComponent(urlOf.get(ref))}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ [column]: have.url }),
    });
    if (!r.ok) { failed++; return; }
    const rows = await r.json().catch(() => []);
    if (!rows.length) { raced++; return; }
    done++;
    if (done % 500 === 0) console.log(`  … ${done}/${todo.length}`);
  });
  if (DRY) console.log(`would repoint ${todo.length} row(s). Re-run with DRY_RUN=false to apply.`);
  else {
    console.log(`repointed ${done} · not at destination ${notThere} · changed since read ${raced} · failed ${failed}`);
    if (notThere || raced) console.log("  (rows not repointed stay on Supabase — re-run copy, verify, then rewrite again)");
    if (failed) process.exit(1);
  }
}

// ─── empty-check (read-only) ──────────────────────────────────────────────────
if (PHASE === "empty-check") {
  // Evidence for the gate (lib/migration.mjs emptyGate decides; it is the pinned part).
  const manifest = await loadManifest();
  const backup = new Map();
  await pool(bucket, async ({ path }) => {
    const m = manifest.get(path);
    const f = Bun.file(diskPath(path));
    if (!(await f.exists())) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    backup.set(path, { manifestBytes: m?.bytes, sha256: m?.sha256, diskBytes: bytes.byteLength, diskSha256: sha256(bytes) });
  });
  // Every row URL on the provider, per asset: each must GET as a whole, cacheable image of the
  // size the Supabase original had.
  const urlsById = new Map();
  for (const u of [...draws.map((d) => d.image_url), ...operators.map((o) => o.logo_url)]) {
    const k = u && dest.base ? objectPathFromUrl(u, dest.base) : null;
    if (!k) continue;
    const id = publicIdOf(k);
    if (!urlsById.has(id)) urlsById.set(id, new Set());
    urlsById.get(id).add(u);
  }
  const cloudOk = new Map();
  await pool(referenced.filter((o) => onCloud.has(publicIdOf(o.path))), async ({ path, size }) => {
    const id = publicIdOf(path);
    for (const u of urlsById.get(id) || []) {
      const v = await checkServed(u, size);
      if (v !== true) { cloudOk.set(id, `${u.slice(-60)} → ${v}`); return; }
    }
    if (!cloudOk.has(id)) cloudOk.set(id, true);
  });
  const stillOnSupabase = [...move.values()].flat();
  const gate = emptyGate({ bucket, backup, stillOnSupabase, onCloud, cloudOk });

  if (gate.refuse) {
    console.error(`✗ NOT safe to empty — ${gate.reasons.length} problem(s):`);
    for (const r of gate.reasons.slice(0, 25)) console.error(`  ! ${r}`);
    process.exit(1);
  }
  console.log(`✓ safe to empty: ${gate.deletable.length} object(s), ${MB(gate.bytes)} would be freed · ${gate.kept.length} kept`);
  for (const k of gate.kept.slice(0, 10)) console.log(`  kept ${k.path}: ${k.why}`);
  console.log("\nThis phase deletes nothing. Emptying the bucket is a separate step that needs the owner's explicit go-ahead (CLOUDINARY.md).");
}
