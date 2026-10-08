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
 * Cloudflare R2, `cloudinary` to Cloudinary. The switch exists because the Supabase
 * Free plan meters BOTH a 1 GB storage ceiling and a 5 GB/month egress allowance, and
 * this bucket breached the second in Sep 2026 and reached 994 MB of the first on
 * 2026-10-09 (+16 MB/day).
 *
 * Why two alternatives: R2 is the better product (10 GB, egress $0 at any volume) but
 * Cloudflare will not enable it without a payment method on file, and the owner has
 * declined to add one. Cloudinary's Free plan needs no card (25 credits/month shared
 * across storage, bandwidth and transformations — we use a few). If a card is ever
 * added, the R2 path is built and tested: see DECISIONS.md.
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
 * Cloudinary credentials, or null when Cloudinary is not configured at all.
 *
 * Accepts the single `CLOUDINARY_URL` the dashboard hands out
 * (`cloudinary://<api_key>:<api_secret>@<cloud_name>`) or the three separate
 * variables. A HALF-configured environment throws rather than returning null: null
 * means "use Supabase", and silently writing to the full Supabase bucket because one
 * variable was mistyped is exactly the failure this provider exists to end.
 *
 * Read from the environment at CALL time, not module load, so tests and scripts that
 * set the variables after import see them.
 */
export function cloudinaryConfig(env = process.env) {
  if (env.CLOUDINARY_URL) {
    const m = env.CLOUDINARY_URL.trim().match(/^cloudinary:\/\/([^:@/]+):([^@/]+)@([^/?#\s]+)\/?$/);
    if (!m) throw new Error("CLOUDINARY_URL is malformed — expected cloudinary://<api_key>:<api_secret>@<cloud_name>");
    return { cloudName: m[3], apiKey: decodeURIComponent(m[1]), apiSecret: decodeURIComponent(m[2]) };
  }
  const parts = { CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY: env.CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET };
  const set = Object.entries(parts).filter(([, v]) => v);
  if (!set.length) return null;
  const missing = Object.keys(parts).filter((k) => !parts[k]);
  if (missing.length) throw new Error(`Cloudinary half-configured — missing ${missing.join(", ")}`);
  return { cloudName: parts.CLOUDINARY_CLOUD_NAME, apiKey: parts.CLOUDINARY_API_KEY, apiSecret: parts.CLOUDINARY_API_SECRET };
}

/**
 * Public base for Cloudinary-served originals.
 *
 * The `/v1/` is the placeholder Cloudinary's own SDKs insert for public_ids that
 * contain folders: without a version segment the first folder can be parsed as a
 * transformation. It also makes everything after the base IDENTICAL to the bucket
 * key (`<operator>/<draw>.webp`), so `objectPathFromUrl` maps a Cloudinary URL and
 * the Supabase URL it was copied from to the same key — which is what keeps
 * `referencedPaths` honest and lets retention find the Supabase copy to fall back to.
 * Replaced bytes are pushed through the CDN with `invalidate=true` on upload.
 */
export function cloudinaryPublicBase({ cloudName }) {
  return `https://res.cloudinary.com/${cloudName}/image/upload/v1/`;
}

/**
 * Cloudinary upload signature: SHA-1 over the signed params sorted by key and joined
 * as `k=v&k=v`, with the API secret appended. `file`, `cloud_name`, `resource_type`
 * and `api_key` are never signed; empty values are left out.
 * https://cloudinary.com/documentation/authentication_signatures
 */
const UNSIGNED = new Set(["file", "cloud_name", "resource_type", "api_key"]);
export function cloudinarySignature(params, apiSecret) {
  const str = Object.keys(params)
    .filter((k) => !UNSIGNED.has(k) && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return new Bun.CryptoHasher("sha1").update(str + apiSecret).digest("hex");
}

/** A bucket key without the extension of its LAST segment: Cloudinary's public_id. */
export function publicIdOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(0, dot) : path;
}

/**
 * Do two keys name the same stored object on `provider`? On Cloudinary the extension
 * is the delivery format, not part of the identity, so `op/d.jpg` and `op/d.webp` are
 * ONE asset. rehost's "upload interim .jpg → upload .webp → delete the interim" would
 * otherwise delete the webp it had just written.
 */
export function sameObject(a, b, provider = IMAGE_PROVIDER) {
  if (provider === "cloudinary") return publicIdOf(a) === publicIdOf(b);
  return a === b;
}

/**
 * EVERY public URL base we have ever served images from — Supabase first, then each
 * other provider that is configured (R2, Cloudinary).
 *
 * This list is the safety-critical part of a provider move. `draws.image_url` and
 * `operators.logo_url` hold absolute URLs, so mid-migration the database holds a
 * MIX of Supabase and new-provider URLs — and permanently so for old ended draws,
 * which are deliberately left on Supabase. Anything that maps a stored URL back to
 * an object key must understand all of them.
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
  const cld = cloudinaryConfig();
  if (cld) bases.push(cloudinaryPublicBase(cld));
  return bases;
}

/** The public base new uploads land on, for whichever provider is active. */
export function activePublicBase({ supabaseUrl, bucket }) {
  if (IMAGE_PROVIDER === "r2") return r2PublicBase();
  if (IMAGE_PROVIDER === "cloudinary") {
    const cfg = cloudinaryConfig();
    return cfg ? cloudinaryPublicBase(cfg) : null;
  }
  return PUBLIC_PREFIX({ supabaseUrl, bucket });
}

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const cloudinaryAuth = ({ apiKey, apiSecret }) => "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

function requireCloudinary() {
  const cfg = cloudinaryConfig();
  if (!cfg) throw new Error("IMAGE_PROVIDER=cloudinary but no CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME/_API_KEY/_API_SECRET) is set");
  return cfg;
}

/**
 * Signed upload to Cloudinary over plain REST — no SDK dependency. Returns the
 * Cloudinary API response (public_id, format, bytes, …).
 *
 * `overwrite` + `invalidate`: the same key is re-uploaded when a draw's photo changes
 * (re-ingest, compress, the rehost interim → webp step), and the CDN must drop the
 * old copy rather than serve it for the life of its cache.
 */
export async function cloudinaryUpload({ path, bytes, contentType }) {
  const cfg = requireCloudinary();
  const params = { public_id: publicIdOf(path), overwrite: "true", invalidate: "true", timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }));
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append("api_key", cfg.apiKey);
  form.append("signature", cloudinarySignature(params, cfg.apiSecret));
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`cloudinary upload ${r.status} ${(j?.error?.message || "").slice(0, 120)}`);
  return j;
}

/**
 * Delete objects (by bucket key) from the ACTIVE non-Supabase provider. Cloudinary's
 * Admin API takes ≤100 public_ids per call and is rate-limited (500 calls/hour on the
 * Free plan), so batching is not optional. Returns per-key outcomes; never throws for
 * a single bad batch, so one failure cannot abort a retention run half-way.
 */
export async function deleteObjects(paths) {
  const out = { deleted: 0, notFound: 0, failed: [] };
  if (IMAGE_PROVIDER === "r2") {
    for (const p of paths) {
      try { await r2Client().delete(p); out.deleted++; } catch (e) { out.failed.push(`${p}: ${e.message || e}`); }
    }
    return out;
  }
  if (IMAGE_PROVIDER !== "cloudinary") throw new Error("deleteObjects only deletes from R2 or Cloudinary — Supabase is the archive and is never pruned here");
  const cfg = requireCloudinary();
  const ids = [...new Set(paths.map(publicIdOf))];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const qs = batch.map((id) => `public_ids[]=${encodeURIComponent(id)}`).join("&") + "&invalidate=true";
    try {
      const r = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/resources/image/upload?${qs}`, {
        method: "DELETE",
        headers: { Authorization: cloudinaryAuth(cfg) },
        signal: AbortSignal.timeout(60_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { out.failed.push(`batch ${i / 100}: ${r.status} ${(j?.error?.message || "").slice(0, 80)}`); continue; }
      for (const id of batch) {
        const v = j.deleted?.[id];
        if (v === "deleted") out.deleted++;
        else if (v === "not_found") out.notFound++;
        else out.failed.push(`${id}: ${v ?? "no answer"}`);
      }
    } catch (e) { out.failed.push(`batch ${i / 100}: ${(e.message || e).toString().slice(0, 80)}`); }
  }
  return out;
}

/**
 * Every image on the Cloudinary account as Map(key → { bytes, format }), where key is
 * `<public_id>.<format>` — the same shape as a bucket key. One Admin API call per 500
 * assets, which is what makes the migration resumable without one call per image
 * (the Free plan allows 500 Admin calls an hour; 6,000 single lookups would take 12).
 */
export async function cloudinaryInventory() {
  const cfg = requireCloudinary();
  const out = new Map();
  let cursor = "";
  for (;;) {
    const url = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/resources/image/upload?max_results=500${cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const j = await withRetry(async () => {
      const r = await fetch(url, { headers: { Authorization: cloudinaryAuth(cfg) }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
      return r.json();
    }, "cloudinary list");
    for (const res of j.resources || []) out.set(`${res.public_id}.${res.format}`, { bytes: res.bytes, format: res.format, publicId: res.public_id });
    if (!j.next_cursor) return out;
    cursor = j.next_cursor;
  }
}

/** Cloudinary account usage (credits, storage, bandwidth) from the Admin API. */
export async function cloudinaryUsage() {
  const cfg = requireCloudinary();
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/usage`, {
    headers: { Authorization: cloudinaryAuth(cfg) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`cloudinary usage ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
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
 * Write one object and return its public URL. The ONLY write path. Supabase and R2
 * set the same long-lived cache-control, because serving `no-cache` is the exact
 * bug that turned a 596 MB bucket into 6.37 GB of egress (see UPLOAD_CACHE_CONTROL);
 * Cloudinary's CDN sets its own and `migrate-images.mjs --phase=verify` proves it is
 * cacheable before any row is pointed at it.
 */
export async function putObject({ path, bytes, contentType, supabaseUrl, serviceKey, bucket = "draw-images" }) {
  if (IMAGE_PROVIDER === "cloudinary") {
    const cfg = requireCloudinary();
    const res = await cloudinaryUpload({ path, bytes, contentType });
    // Address the asset by the format Cloudinary actually stored. Asking for a
    // different extension than the stored one is a format CONVERSION — a billed
    // transformation on every cache miss — so a `.jpg` key holding PNG bytes is served
    // as `.png`. Normally the two agree and the URL is base + the bucket key verbatim.
    const key = `${publicIdOf(path)}.${res.format || path.split(".").pop()}`;
    // Cloudinary's CDN sets its own long-lived Cache-Control on originals; there is no
    // per-upload header to set. `verify` in migrate-images.mjs checks it over GET.
    return cloudinaryPublicBase(cfg) + encPath(key);
  }
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

/**
 * Walk a bucket to ANY depth. `listAllObjects` assumes draw-images' one-level
 * `<operator>/<draw>` layout; carousel-slides nests `<date>/<slug>/<file>`, and the
 * project's storage quota counts every bucket, so the storage alarm needs this.
 */
export async function listBucketDeep(creds, prefix = "") {
  const out = [];
  for (const e of await listPrefix(prefix, creds)) {
    const path = prefix + e.name;
    if (e.id === null) out.push(...(await listBucketDeep(creds, `${path}/`)));
    else out.push({ ...e, path });
  }
  return out;
}

/** Every bucket in the project, by name. */
export async function listBuckets({ supabaseUrl, serviceKey }) {
  return sbJson(`${supabaseUrl}/storage/v1/bucket`, serviceKey, "buckets");
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
