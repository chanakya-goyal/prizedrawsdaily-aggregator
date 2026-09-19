// Move the `draw-images` bytes from Supabase Storage to Cloudflare R2, then point
// the database at the new home.
//
// WHY: the Supabase Free plan meters a 1 GB storage ceiling AND a 5 GB/month egress
// allowance, and this bucket breached the second in the 20 Aug–20 Sep 2026 cycle
// (7.67 GB) while heading for the first around 9 Oct (708 MB, +16 MB/day, measured
// 2026-09-19). Compression cannot buy the headroom: the draw hero is served at
// w=1280 (`draws.$slug.tsx`), so the stored 1280/q75 is already the right size and
// anything smaller upscales it. R2 includes 10 GB and charges nothing for egress at
// any volume. The DATABASE STAYS ON SUPABASE — only the bytes move.
//
// THREE PHASES, deliberately separate. Never fold them together: the whole point is
// that the bytes are proven to exist at the new address BEFORE any row is repointed,
// and that the Supabase copy is still there to roll back to afterwards.
//
//   bun migrate-to-r2.mjs --phase=copy      # Supabase → R2. Idempotent, resumable.
//   bun migrate-to-r2.mjs --phase=verify    # every referenced object present + cacheable on R2
//   bun migrate-to-r2.mjs --phase=rewrite   # PATCH draws.image_url / operators.logo_url
//
// DRY_RUN=true is the default for every phase. `copy` and `verify` are read-only
// against the database in all cases; only `rewrite` ever writes a row.
//
// THIS SCRIPT NEVER DELETES ANYTHING. The Supabase objects are the rollback copy —
// reclaiming that 708 MB is a separate, later, deliberate decision, and `--phase=rewrite`
// prints the rollback command before it touches anything.
//
// Rows still pointing at the DEAD project (kkuuwksgyypicnblwubs) are counted and skipped,
// never copied: those bytes are already 402 and belong to repair-images.mjs.
import { listAllObjects, referencedPaths, publicBases, r2Client, r2PublicBase, UPLOAD_CACHE_CONTROL, objectPathFromUrl, PUBLIC_PREFIX } from "./lib/storage.mjs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.BUCKET || "draw-images";
const DRY = process.env.DRY_RUN !== "false";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || d;
const PHASE = arg("phase", "");
const LIMIT = Number(arg("limit", 0)) || Infinity;

if (!URL_ || !KEY) { console.error("✗ needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!["copy", "verify", "rewrite"].includes(PHASE)) {
  console.error("✗ --phase=copy | verify | rewrite"); process.exit(1);
}
const BASE = r2PublicBase();
if (!BASE) { console.error("✗ needs R2_PUBLIC_BASE (e.g. https://img.prizedrawsdaily.co.uk/)"); process.exit(1); }

const creds = { supabaseUrl: URL_, serviceKey: KEY, bucket: BUCKET };
const SB_PREFIX = PUBLIC_PREFIX(creds);
const MB = (b) => (b / 1048576).toFixed(1) + " MB";
const r2 = r2Client();
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const r2Url = (path) => BASE + enc(path);

async function pool(items, worker, n = CONCURRENCY) {
  let i = 0;
  const run = async () => { for (;;) { const k = i++; if (k >= items.length) return; await worker(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// ─── copy ────────────────────────────────────────────────────────────────────
if (PHASE === "copy") {
  console.log(`${DRY ? "DRY RUN" : "LIVE"} — copying ${BUCKET} → R2 bucket ${process.env.R2_BUCKET}`);
  const files = (await listAllObjects(creds)).slice(0, LIMIT);
  const total = files.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  console.log(`  ${files.length} objects, ${MB(total)}\n`);

  let copied = 0, skipped = 0, failed = 0, bytes = 0;
  const errors = [];
  await pool(files, async (f) => {
    const size = f.metadata?.size || 0;
    try {
      // Resumable: an object already at the right size is left alone, so an
      // interrupted run costs only the objects it had not reached.
      const existing = await r2.file(f.path).stat().catch(() => null);
      if (existing && existing.size === size) { skipped++; return; }
      if (DRY) { copied++; bytes += size; return; }

      const src = await fetch(SB_PREFIX + encodeURI(f.path), { signal: AbortSignal.timeout(60_000) });
      if (!src.ok) throw new Error(`source ${src.status}`);
      const type = src.headers.get("content-type") || f.metadata?.mimetype || "image/webp";
      const buf = new Uint8Array(await src.arrayBuffer());
      // Guard: a truncated download must never overwrite/land as a good object.
      if (size && buf.byteLength !== size) throw new Error(`size ${buf.byteLength} != ${size}`);

      await r2.write(f.path, buf, { type, cacheControl: UPLOAD_CACHE_CONTROL });
      copied++; bytes += buf.byteLength;
      if (copied % 250 === 0) console.log(`  … ${copied} copied, ${skipped} already there, ${MB(bytes)}`);
    } catch (e) {
      failed++; if (errors.length < 15) errors.push(`${f.path}: ${(e.message || e).toString().slice(0, 80)}`);
    }
  });
  console.log(`\n${DRY ? "would copy" : "copied"} ${copied} · already present ${skipped} · failed ${failed} · ${MB(bytes)}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (DRY) console.log("\nRe-run with DRY_RUN=false to apply.");
  else if (failed) { console.error("\n✗ some objects failed — re-run copy before verify."); process.exit(1); }
}

// ─── verify ──────────────────────────────────────────────────────────────────
if (PHASE === "verify") {
  console.log(`verifying every referenced image exists on R2 and is cacheable…`);
  const { paths } = await referencedPaths(creds);
  const files = await listAllObjects(creds);
  const sizeOf = new Map(files.map((f) => [f.path, f.metadata?.size || 0]));
  const wanted = [...paths].slice(0, LIMIT);
  console.log(`  ${wanted.length} referenced object(s)\n`);

  let ok = 0, missing = 0, mismatched = 0, uncacheable = 0;
  const bad = [];
  await pool(wanted, async (path) => {
    const stat = await r2.file(path).stat().catch(() => null);
    if (!stat) { missing++; if (bad.length < 15) bad.push(`MISSING  ${path}`); return; }
    const want = sizeOf.get(path);
    if (want && stat.size !== want) { mismatched++; if (bad.length < 15) bad.push(`SIZE     ${path} ${stat.size} != ${want}`); return; }
    ok++;
  });
  // Cache-control is checked over the PUBLIC url with GET, because that is what
  // weserv and browsers actually see — and because HEAD lied on Supabase Storage.
  const sample = wanted.filter((_, i) => i % Math.max(1, Math.floor(wanted.length / 12)) === 0).slice(0, 12);
  for (const path of sample) {
    const r = await fetch(r2Url(path), { method: "GET" });
    const cc = r.headers.get("cache-control") || "";
    r.body?.cancel();
    if (!/max-age=\d{5,}/.test(cc) || /no-cache|no-store/.test(cc)) { uncacheable++; bad.push(`CACHE    ${path} → ${cc || "(none)"} [${r.status}]`); }
  }
  console.log(`present+correct ${ok} · missing ${missing} · size mismatch ${mismatched}`);
  console.log(`public cache-control sample: ${sample.length - uncacheable}/${sample.length} cacheable`);
  for (const b of bad) console.log(`  ! ${b}`);
  if (missing || mismatched || uncacheable) { console.error("\n✗ NOT safe to rewrite yet."); process.exit(1); }
  console.log("\n✓ every referenced image is on R2, correct size, and cacheable. Safe to --phase=rewrite.");
}

// ─── rewrite ─────────────────────────────────────────────────────────────────
if (PHASE === "rewrite") {
  console.log(`${DRY ? "DRY RUN" : "LIVE"} — repointing database URLs to ${BASE}`);
  console.log(`ROLLBACK: the Supabase objects are untouched. To undo, PATCH the same rows back to`);
  console.log(`          ${SB_PREFIX}<path>  (or re-run with R2_PUBLIC_BASE unset and the old URLs restored from a dump).\n`);

  const bases = publicBases(creds);
  const rest = `${URL_}/rest/v1`;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const TARGETS = [
    { table: "draws", column: "image_url" },
    { table: "operators", column: "logo_url" },
  ];

  for (const { table, column } of TARGETS) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${rest}/${table}?select=id,${column}&limit=1000&offset=${offset}`, { headers: H });
      if (!r.ok) { console.error(`✗ ${table} read ${r.status}`); process.exit(1); }
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) break;
    }

    let todo = 0, already = 0, dead = 0, foreign = 0;
    const work = [];
    for (const row of rows) {
      const url = row[column];
      if (!url) continue;
      if (url.startsWith(BASE)) { already++; continue; }
      // Dead-project rows are a different problem (repair-images.mjs) — never touched here.
      if (/kkuuwksgyypicnblwubs|hnmutpztdkzmtdopdjuo/.test(url)) { dead++; continue; }
      const path = objectPathFromUrl(url, bases);
      if (!path) { foreign++; continue; }
      work.push({ id: row.id, path }); todo++;
    }
    console.log(`${table}.${column}: ${rows.length} rows — ${todo} to repoint · ${already} already R2 · ${dead} dead-project (skipped) · ${foreign} not ours (left alone)`);

    if (!DRY && work.length) {
      let done = 0, failed = 0;
      await pool(work.slice(0, LIMIT), async ({ id, path }) => {
        // Only repoint a row whose bytes are demonstrably at the new address.
        const stat = await r2.file(path).stat().catch(() => null);
        if (!stat) { failed++; return; }
        const r = await fetch(`${rest}/${table}?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
          body: JSON.stringify({ [column]: r2Url(path) }),
        });
        if (!r.ok) { failed++; return; }
        done++;
        if (done % 500 === 0) console.log(`  … ${done}/${work.length}`);
      });
      console.log(`  ✓ repointed ${done} · skipped-not-on-r2 ${failed}`);
      if (failed) console.log(`  (rows whose object is not on R2 were LEFT on Supabase — run copy+verify, then rewrite again)`);
    }
  }
  if (DRY) console.log("\nRe-run with DRY_RUN=false to apply.");
}
