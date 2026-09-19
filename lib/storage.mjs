// Supabase Storage helpers shared by compress-images.mjs and prune-orphans.mjs.
//
// The interesting part is `referencedPaths`: it works out which database columns point into
// the bucket by ASKING PostgREST for the schema, rather than trusting a hardcoded list of
// tables. That matters because this data drives deletions — a column we forget to scan is a
// set of live images we would classify as orphans and destroy. Discovery fails safe; a
// hardcoded list fails destructively.

const LIST_PAGE = 1000;
const ROW_PAGE = 1000;

export const PUBLIC_PREFIX = ({ supabaseUrl, bucket }) =>
  `${supabaseUrl}/storage/v1/object/public/${bucket}/`;

/**
 * Every object we upload MUST carry this. An upload that sends no `cache-control`
 * header is stored by Supabase with `cacheControl: "no-cache"`, and that single
 * default is what blew the free-tier egress quota in the 2026-09 billing cycle:
 * 596 MB of stored images produced 6.37 GB of egress (12.7x the whole bucket).
 *
 * The mechanism, measured 2026-09-12 against the live bucket:
 *   - the site renders every image through images.weserv.nl (`src/lib/img.ts`)
 *   - weserv honours the origin's cache-control. Against a `no-cache` origin it
 *     answers `x-cache-status: BYPASS` — it stores nothing, so it re-downloads the
 *     FULL-SIZE original from Supabase on EVERY SINGLE impression, then throws it
 *     away. A 205 KB original is re-fetched to serve a 76 KB thumbnail, every view.
 *   - against a cacheable origin it answers MISS (storable) and fetches once.
 * Browsers and every downstream CDN behave the same way, so nothing cached anywhere.
 *
 * Verified end-to-end before shipping: a probe object uploaded WITH this header
 * served `public, max-age=31536000` on GET and flipped weserv from BYPASS to MISS.
 *
 * Beware: `curl -I` (HEAD) against Supabase Storage reports `no-cache` even for a
 * correctly-cached object. Only a GET shows the true header. Verify with GET.
 *
 * No `immutable`: these paths are upserted in place (`compress-images.mjs` rewrites
 * the same key, and re-ingest can replace a draw's photo), so a client that chooses
 * to revalidate must still be able to pick up replaced bytes. `immutable` forbids
 * even that, and would strand a stale image in caches for a year.
 */
export const UPLOAD_CACHE_CONTROL = "public, max-age=31536000";

/**
 * Headers for a Supabase Storage upload. Centralised so a new upload site cannot
 * silently omit the cache-control that `UPLOAD_CACHE_CONTROL` explains.
 */
export function uploadHeaders({ serviceKey, contentType }) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": contentType,
    "cache-control": UPLOAD_CACHE_CONTROL,
    "x-upsert": "true",
  };
}

/**
 * WHERE IMAGES LIVE.
 *
 * `supabase` (default) keeps the historical behaviour. `r2` sends new uploads to
 * Cloudflare R2 instead. The switch exists because the Supabase Free plan meters
 * BOTH a 1 GB storage ceiling and a 5 GB/month egress allowance, and this bucket
 * was on course to breach the first around 9 Oct 2026 (708 MB and +16 MB/day,
 * measured 2026-09-19) having already breached the second. R2 charges nothing for
 * egress at any volume and includes 10 GB of storage.
 *
 * The database stays on Supabase. Only the bytes move.
 */
export const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "supabase").toLowerCase();

const withSlash = (u) => (u.endsWith("/") ? u : u + "/");

/** Public base for R2-served objects, e.g. https://img.prizedrawsdaily.co.uk/ */
export function r2PublicBase() {
  const b = process.env.R2_PUBLIC_BASE;
  return b ? withSlash(b) : null;
}

/**
 * EVERY public URL base we have ever served images from — Supabase first, then R2
 * if configured.
 *
 * This list is the safety-critical part of a provider move. `draws.image_url` and
 * `operators.logo_url` hold absolute URLs, so mid-migration the database holds a
 * MIX of Supabase and R2 URLs. Anything that maps a stored URL back to an object
 * key must understand all of them.
 *
 * Get this wrong and `referencedPaths` returns an empty set, every object in the
 * bucket classifies as an orphan, and `prune-orphans.mjs` deletes the lot — which
 * is also the rollback copy. `prune-orphans.mjs` carries an independent
 * circuit-breaker for exactly this reason; do not remove it.
 */
export function publicBases({ supabaseUrl, bucket }) {
  const bases = [PUBLIC_PREFIX({ supabaseUrl, bucket })];
  const r2 = r2PublicBase();
  if (r2) bases.push(r2);
  return bases;
}

/** Lazily-built Bun S3 client pointed at R2. Bun ships S3 natively — no dependency. */
let _r2;
export function r2Client() {
  if (_r2) return _r2;
  const need = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`R2 not configured — missing ${missing.join(", ")}`);
  _r2 = new Bun.S3Client({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });
  return _r2;
}

/**
 * Write one object and return its public URL. The ONLY write path — both providers
 * set the same long-lived cache-control, because serving `no-cache` is the exact
 * bug that turned a 596 MB bucket into 6.37 GB of egress (see UPLOAD_CACHE_CONTROL).
 */
export async function putObject({ path, bytes, contentType, supabaseUrl, serviceKey, bucket = "draw-images" }) {
  if (IMAGE_PROVIDER === "r2") {
    const base = r2PublicBase();
    if (!base) throw new Error("IMAGE_PROVIDER=r2 but R2_PUBLIC_BASE is unset");
    await r2Client().write(path, bytes, {
      type: contentType,
      // Same header, same reason. R2 stores it as S3 system metadata and serves
      // it back on every public GET.
      cacheControl: UPLOAD_CACHE_CONTROL,
    });
    return base + path.split("/").map(encodeURIComponent).join("/");
  }
  const r = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: "POST",
    headers: uploadHeaders({ serviceKey, contentType }),
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`storage ${r.status} ${(await r.text()).slice(0, 120)}`);
  return PUBLIC_PREFIX({ supabaseUrl, bucket }) + encodeURI(path);
}

// Supabase drops the occasional connection mid-sweep (ECONNRESET on a plain list call). A
// transient socket error must not abort a 2000-object walk.
async function withRetry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < tries - 1) await Bun.sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${label}: ${(last?.message || last || "").toString().slice(0, 160)}`);
}

/**
 * Extract a bucket object path from a stored URL, or null if the URL doesn't point at our
 * bucket. Pure — this is the function that decides whether an image is "in use", so it is
 * unit-tested against every URL shape we actually store.
 *
 * Handles:
 *   - the plain public URL
 *   - a trailing ?query / #hash (cache-busting params)
 *   - percent-encoding (uploads go through encodeURI, so `a b.jpg` is stored as `a%20b.jpg`)
 *   - a Supabase URL nested inside an images.weserv.nl wrapper (?url=…), because the site
 *     renders every image through weserv and some rows have the wrapped form stored
 */
export function objectPathFromUrl(url, prefix) {
  if (typeof url !== "string" || !url) return null;

  // `prefix` may be a single base or a list of them (see publicBases). Mid-move the
  // database holds both Supabase and R2 URLs, and a stored URL that matches NONE of
  // our bases must return null — never be silently treated as unreferenced.
  if (Array.isArray(prefix)) {
    for (const p of prefix) {
      const hit = objectPathFromUrl(url, p);
      if (hit) return hit;
    }
    return null;
  }

  // weserv wrapper: pull the inner origin URL out of ?url= before matching.
  if (url.includes("weserv.nl")) {
    const m = url.match(/[?&]url=([^&]+)/);
    if (m) {
      let inner = decodeURIComponent(m[1]);
      // weserv accepts a scheme-less origin ("ssl:host/path") as well as a full URL.
      if (/^ssl:/i.test(inner)) inner = "https://" + inner.slice(4);
      else if (!/^https?:\/\//i.test(inner)) inner = "https://" + inner;
      return objectPathFromUrl(inner, prefix);
    }
  }

  if (!url.startsWith(prefix)) return null;
  const raw = url.slice(prefix.length).replace(/[?#].*$/, "");
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Split bucket objects into keep/delete. Pure, so the safety rules are testable. */
export function classifyOrphans(files, referenced, { cutoffMs, now = Date.now() } = {}) {
  const orphans = [];
  let youngSkipped = 0;
  for (const f of files) {
    if (referenced.has(f.path)) continue;
    const created = Date.parse(f.created_at || f.updated_at || "") || 0;
    if (cutoffMs != null && created > now - cutoffMs) { youngSkipped++; continue; }
    orphans.push(f);
  }
  return { orphans, youngSkipped };
}

// The storage list API is per-prefix and paginated; folder entries come back with id === null.
async function listPrefix(prefix, { supabaseUrl, serviceKey, bucket }) {
  const H = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const out = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await withRetry(async () => {
      const r = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
        method: "POST",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(`returned ${JSON.stringify(j).slice(0, 160)}`);
      return j;
    }, `list ${prefix || "/"}`);
    out.push(...page);
    if (page.length < LIST_PAGE) return out;
  }
}

/** Walk the whole bucket. Layout is one level deep: <operator-slug>/<draw-slug>.<ext> */
export async function listAllObjects(creds) {
  const files = [];
  for (const top of await listPrefix("", creds)) {
    if (top.id !== null) { files.push({ ...top, path: top.name }); continue; }
    for (const f of await listPrefix(`${top.name}/`, creds)) {
      if (f.id !== null) files.push({ ...f, path: `${top.name}/${f.name}` });
    }
  }
  return files;
}

async function sbJson(url, serviceKey, label) {
  const r = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`${label} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/**
 * Every bucket object path the database still references.
 *
 * Two passes on purpose. First a small sample per table reveals WHICH columns actually hold
 * bucket URLs; only those columns are then paged in full. Scanning every string column of
 * every table would work but costs far more reads for the same answer.
 *
 * Any table or page that errors THROWS rather than returning a partial set — a partial set
 * silently becomes "these images are orphans", which is the one outcome we cannot risk.
 */
export async function referencedPaths(creds) {
  const { supabaseUrl, serviceKey } = creds;
  // ALL our bases, not just Supabase — mid-move the DB holds a mix, and a base we
  // fail to recognise turns live images into "orphans". See publicBases().
  const prefix = publicBases(creds);
  const rest = `${supabaseUrl}/rest/v1`;

  const spec = await sbJson(`${rest}/`, serviceKey, "openapi");
  const tables = Object.keys(spec?.definitions || {});
  if (!tables.length) throw new Error("openapi returned no table definitions — cannot scan safely");

  // Pass 1 — which (table, column) pairs contain bucket URLs?
  const columns = [];
  for (const table of tables) {
    const props = spec.definitions[table]?.properties || {};
    const textCols = Object.keys(props).filter((c) => (props[c]?.type ?? "string") === "string");
    if (!textCols.length) continue;
    const sample = await sbJson(
      `${rest}/${table}?select=${textCols.join(",")}&limit=200`,
      serviceKey,
      `sample ${table}`
    );
    if (!Array.isArray(sample)) continue;
    for (const col of textCols) {
      if (sample.some((row) => objectPathFromUrl(row?.[col], prefix))) columns.push({ table, column: col });
    }
  }

  // Pass 2 — page those columns exhaustively.
  const paths = new Set();
  for (const { table, column } of columns) {
    for (let offset = 0; ; offset += ROW_PAGE) {
      const rows = await sbJson(
        `${rest}/${table}?select=${column}&limit=${ROW_PAGE}&offset=${offset}`,
        serviceKey,
        `${table}.${column}`
      );
      if (!Array.isArray(rows)) throw new Error(`${table}.${column} returned a non-array`);
      for (const row of rows) {
        const p = objectPathFromUrl(row?.[column], prefix);
        if (p) paths.add(p);
      }
      if (rows.length < ROW_PAGE) break;
    }
  }

  return { paths, scanned: tables, columns };
}
