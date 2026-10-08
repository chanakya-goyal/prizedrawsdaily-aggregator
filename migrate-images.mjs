// Move the images that MATTER from Supabase Storage to the active provider (Cloudinary or
// R2), then point the database at the new home.
//
// WHY: the Supabase Free bucket reached 994 MB of 1 GB on 2026-10-09 — the second time in two
// months — because every draw photo was kept forever. This moves only what the site still
// needs (see lib/retention.mjs selectNecessary): every live and draft draw, draws that ended
// within RETENTION_DAYS, and every operator logo. Long-ended draws keep pointing at Supabase,
// which becomes a frozen archive once every writer has switched (CLOUDINARY.md, step 1).
//
// Supersedes migrate-to-r2.mjs, which copies the WHOLE bucket and only knows R2. That script
// is kept, unchanged, for the day a card goes on file and everything moves to R2.
//
// THREE PHASES, deliberately separate — the bytes are proven to exist at the new address
// BEFORE any row is repointed, and the Supabase copy is still there to roll back to after.
//
//   bun migrate-images.mjs --phase=copy      # Supabase → provider. Idempotent, resumable.
//   bun migrate-images.mjs --phase=verify    # every selected object present, right size, cacheable
//   bun migrate-images.mjs --phase=rewrite   # PATCH draws.image_url / operators.logo_url
//
// DRY_RUN=true is the default for every phase; --limit=N rehearses on a handful.
// THIS SCRIPT NEVER DELETES ANYTHING, anywhere.
import { listAllObjects, PUBLIC_PREFIX, IMAGE_PROVIDER, cloudinaryConfig, cloudinaryPublicBase, cloudinaryUpload, cloudinaryInventory, publicIdOf, r2Client, r2PublicBase, UPLOAD_CACHE_CONTROL } from "./lib/storage.mjs";
import { selectNecessary } from "./lib/retention.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.BUCKET || "draw-images";
const DRY = process.env.DRY_RUN !== "false";
const DAYS = Number(process.env.RETENTION_DAYS || 30);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || d;
const PHASE = arg("phase", "");
const LIMIT = Number(arg("limit", 0)) || Infinity;
// Which provider to move TO. Defaults to IMAGE_PROVIDER, but can be named explicitly so the
// copy can run BEFORE the scrape is switched over (--to=cloudinary).
const TO = arg("to", IMAGE_PROVIDER === "supabase" ? "" : IMAGE_PROVIDER);

if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!["copy", "verify", "rewrite"].includes(PHASE)) { console.error("✗ --phase=copy | verify | rewrite"); process.exit(1); }
if (!["cloudinary", "r2"].includes(TO)) { console.error("✗ set IMAGE_PROVIDER=cloudinary|r2, or pass --to=cloudinary|r2"); process.exit(1); }

const creds = { supabaseUrl: URL_, serviceKey: KEY, bucket: BUCKET };
const SB_PREFIX = PUBLIC_PREFIX(creds);
const MB = (b) => (b / 1048576).toFixed(1) + " MB";
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

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

// ─── the destination, behind one small interface ─────────────────────────────
// inventory(): Map(bucket key → { bytes, url }) for what is already there.
// put(): upload, returning { bytes, url }.
// A DRY copy may run before any credentials exist: it then reports the selection and assumes
// nothing is at the destination yet. Every other phase needs the real thing.
const PREVIEW_ONLY = { name: "(destination not configured — preview of the selection only)", lookup: async () => null };
function destination() {
  const canPreview = DRY && PHASE === "copy";
  if (TO === "cloudinary") {
    const cfg = cloudinaryConfig();
    if (!cfg) {
      if (canPreview) return PREVIEW_ONLY;
      console.error("✗ Cloudinary not configured — set CLOUDINARY_URL (see CLOUDINARY.md)"); process.exit(1);
    }
    const base = cloudinaryPublicBase(cfg);
    let byId = null;
    return {
      name: `Cloudinary (${cfg.cloudName})`,
      // One Admin API call per 500 assets — never one per image (500 calls/hour on Free).
      async lookup(path) {
        if (!byId) {
          byId = new Map();
          for (const v of (await cloudinaryInventory()).values()) byId.set(v.publicId, v);
        }
        const hit = byId.get(publicIdOf(path));
        return hit ? { bytes: hit.bytes, url: base + enc(`${hit.publicId}.${hit.format}`) } : null;
      },
      async put(path, bytes, type) {
        const res = await cloudinaryUpload({ path, bytes, contentType: type });
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

// ─── what to move ─────────────────────────────────────────────────────────────
const draws = await readAll("draws", "id,status,draw_date,created_at,image_url");
const operators = await readAll("operators", "id,logo_url");
const { paths, skipped } = selectNecessary({ draws, operators, sbPrefix: SB_PREFIX, days: DAYS });
const sizeOf = new Map((await listAllObjects(creds)).map((f) => [f.path, f.metadata?.size || 0]));
const missingAtSource = [...paths.keys()].filter((p) => !sizeOf.has(p));
const wanted = [...paths.keys()].filter((p) => sizeOf.has(p)).slice(0, LIMIT);
const wantedBytes = wanted.reduce((a, p) => a + sizeOf.get(p), 0);
const nDraws = wanted.reduce((a, p) => a + paths.get(p).draws.length, 0);
const nLogos = wanted.reduce((a, p) => a + paths.get(p).logos.length, 0);

const dest = destination();
console.log(`${DRY ? "DRY RUN" : "LIVE"} · phase=${PHASE} · Supabase → ${dest.name} · keep window ${DAYS}d`);
console.log(`  selected ${wanted.length} image(s), ${MB(wantedBytes)} — used by ${nDraws} draw row(s) + ${nLogos} operator logo(s)`);
console.log(`  left on Supabase: ${skipped.expired} long-ended draws · not ours: ${skipped.dead} dead-project, ${skipped.foreign} hotlinked · ${skipped.alreadyMoved} already moved · ${skipped.empty} empty`);
if (missingAtSource.length) console.log(`  ! ${missingAtSource.length} selected key(s) referenced but absent from the bucket (left alone) e.g. ${missingAtSource.slice(0, 3).join(", ")}`);
console.log("");

// ─── copy ─────────────────────────────────────────────────────────────────────
if (PHASE === "copy") {
  let copied = 0, present = 0, failed = 0, bytes = 0;
  const errors = [];
  await pool(wanted, async (path) => {
    const size = sizeOf.get(path);
    try {
      // Resumable: an object already there at the right size is left alone.
      const have = await dest.lookup(path);
      if (have && have.bytes === size) { present++; return; }
      if (DRY) { copied++; bytes += size; return; }
      const src = await fetch(SB_PREFIX + encodeURI(path), { signal: AbortSignal.timeout(60_000) });
      if (!src.ok) throw new Error(`source ${src.status}`);
      const type = (src.headers.get("content-type") || "image/webp").split(";")[0];
      const buf = new Uint8Array(await src.arrayBuffer());
      // A truncated download must never land as a "good" object.
      if (size && buf.byteLength !== size) throw new Error(`size ${buf.byteLength} != ${size}`);
      await dest.put(path, buf, type);
      copied++; bytes += buf.byteLength;
      if (copied % 250 === 0) console.log(`  … ${copied} copied, ${present} already there, ${MB(bytes)}`);
    } catch (e) {
      failed++; if (errors.length < 15) errors.push(`${path}: ${(e.message || e).toString().slice(0, 90)}`);
    }
  });
  console.log(`${DRY ? "would copy" : "copied"} ${copied} · already present ${present} · failed ${failed} · ${MB(bytes)}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (DRY) console.log("\nRe-run with DRY_RUN=false to apply.");
  else if (failed) { console.error("\n✗ some objects failed — re-run copy before verify."); process.exit(1); }
}

// ─── verify ───────────────────────────────────────────────────────────────────
if (PHASE === "verify") {
  let ok = 0, missing = 0, mismatched = 0, bad = 0;
  const notes = [];
  const urls = [];
  await pool(wanted, async (path) => {
    const have = await dest.lookup(path);
    if (!have) { missing++; if (notes.length < 15) notes.push(`MISSING  ${path}`); return; }
    if (have.bytes !== sizeOf.get(path)) { mismatched++; if (notes.length < 15) notes.push(`SIZE     ${path} ${have.bytes} != ${sizeOf.get(path)}`); return; }
    ok++; urls.push(have.url);
  });
  // Over the PUBLIC url with GET: that is what weserv and browsers see, and HEAD lied on
  // Supabase Storage. "Cacheable" = a positive max-age and no no-cache/no-store — the exact
  // header whose absence turned a 596 MB bucket into 6.37 GB of egress in Sep 2026.
  const step = Math.max(1, Math.floor(urls.length / 12));
  const sample = urls.filter((_, i) => i % step === 0).slice(0, 12);
  for (const u of sample) {
    const r = await fetch(u);
    const cc = r.headers.get("cache-control") || "";
    const type = r.headers.get("content-type") || "";
    await r.arrayBuffer().catch(() => {});
    const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] || 0);
    if (!r.ok || !type.startsWith("image/") || maxAge < 86400 || /no-cache|no-store/.test(cc)) {
      bad++; notes.push(`SERVE    ${u} → ${r.status} ${type} cache-control="${cc || "(none)"}"`);
    }
  }
  console.log(`present+correct ${ok} · missing ${missing} · size mismatch ${mismatched}`);
  console.log(`public GET sample: ${sample.length - bad}/${sample.length} served as cacheable images`);
  for (const n of notes) console.log(`  ! ${n}`);
  if (missing || mismatched || bad) { console.error("\n✗ NOT safe to rewrite yet."); process.exit(1); }
  console.log("\n✓ every selected image is at the new address, the right size, and cacheable. Safe to --phase=rewrite.");
}

// ─── rewrite ──────────────────────────────────────────────────────────────────
if (PHASE === "rewrite") {
  console.log(`ROLLBACK: nothing is deleted. To undo, PATCH the same rows back to ${SB_PREFIX}<key>.\n`);
  const urlOf = new Map([...draws.map((d) => [`d:${d.id}`, d.image_url]), ...operators.map((o) => [`o:${o.id}`, o.logo_url])]);
  const jobs = [];
  for (const path of wanted) {
    const { draws: dIds, logos } = paths.get(path);
    for (const id of dIds) jobs.push({ table: "draws", column: "image_url", id, path });
    for (const id of logos) jobs.push({ table: "operators", column: "logo_url", id, path });
  }
  let done = 0, notThere = 0, raced = 0, failed = 0;
  await pool(DRY ? [] : jobs, async (j) => {
    // Only repoint a row whose bytes are demonstrably at the new address.
    const have = await dest.lookup(j.path);
    if (!have || have.bytes !== sizeOf.get(j.path)) { notThere++; return; }
    const old = urlOf.get(`${j.table === "draws" ? "d" : "o"}:${j.id}`);
    // `<column>=eq.<old>`: if the scrape rewrote this row since we read it, leave it alone
    // rather than overwrite a newer image with an older one.
    const r = await fetch(`${URL_}/rest/v1/${j.table}?id=eq.${encodeURIComponent(j.id)}&${j.column}=eq.${encodeURIComponent(old)}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ [j.column]: have.url }),
    });
    if (!r.ok) { failed++; return; }
    const rows = await r.json().catch(() => []);
    if (!rows.length) { raced++; return; }
    done++;
    if (done % 500 === 0) console.log(`  … ${done}/${jobs.length}`);
  });
  if (DRY) console.log(`would repoint ${jobs.length} row(s). Re-run with DRY_RUN=false to apply.`);
  else {
    console.log(`repointed ${done} · not at destination ${notThere} · changed since read ${raced} · failed ${failed}`);
    if (notThere) console.log("  (rows whose object is not at the destination were LEFT on Supabase — run copy+verify, then rewrite again)");
    if (failed) process.exit(1);
  }
}
