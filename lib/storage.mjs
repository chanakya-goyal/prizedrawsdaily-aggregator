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
  const prefix = PUBLIC_PREFIX(creds);
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
