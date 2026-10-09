// One paginated PostgREST reader, because this repo had five and two of them were wrong.
//
// WHY THIS EXISTS
// PostgREST caps every response at 1000 rows and says so only in the `content-range` header —
// the body is a perfectly well-formed array of exactly 1000 rows. Nothing errors. A caller
// that trusts `.length` as a total therefore reports the cap as if it were the answer.
// Measured 2026-08-30, `ended-sweep.mjs` printed:
//
//     LIVE — checking 1000 active+draft draws for ended comps
//
// against an inventory of 759 active + drafts. That "1000" is the cap describing itself.
// Every draw past row 1000 had never been swept — never expired, never even reported — for
// as long as the table has exceeded 1000 rows.
//
// WHY `order=` IS LOAD-BEARING, NOT COSMETIC
// Offset paging over an unordered result set is undefined behaviour: Postgres may return rows
// in a different physical order between the two requests, so a row can be skipped or returned
// twice. Two of the pre-existing copies of this loop (run.mjs, manager/coverage-report.mjs)
// omitted the ORDER BY, which means their paging was silently lossy on exactly the large
// tables that made paging necessary. `sbGetAll` appends `order=id` unless the caller already
// specified one, so the ordering cannot be forgotten.
//
// WHY A NON-ARRAY RESPONSE THROWS
// PostgREST answers a failed read with an OBJECT, not an array. Degrading to `[]` turns a
// permissions error or a bad column name into "there is no data" — a silent no-op on the
// daily cron, which is the failure mode this fleet exists to prevent. Loud failure, always.

// WHY THERE IS NO DEFAULT PROJECT
// This file, ended-sweep.mjs and ~20 scripts used to fall back to one hard-coded project URL
// when SUPABASE_URL was unset (some had no env read at all). In Oct 2026 the database moved to a
// new project because the old organisation ran past its free quota; every fallback would have
// kept reading and writing the OLD project after the cutover, with no error anywhere. The URL
// now comes from the environment only, and its absence is a loud failure.

/**
 * The Supabase project URL — from SUPABASE_URL, never a built-in default. Throws when unset.
 * Trailing slashes are dropped so `${supabaseUrl()}/rest/v1/...` is always well-formed.
 */
export function supabaseUrl(env = process.env) {
  const u = (env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!u) {
    throw new Error(
      "SUPABASE_URL is not set — there is no default project. Set it in .env (local), the " +
        "workflow secrets (Actions) or the cowork routine's environment."
    );
  }
  return u;
}
const PAGE = 1000;

const authHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });

/**
 * Read every row matching a PostgREST query, paging past the 1000-row cap.
 *
 * @param {string} path      e.g. `draws?select=id,title&status=eq.active`
 * @param {object} opts
 * @param {string} opts.key  Supabase key (service-role for writes-adjacent reads, publishable otherwise)
 * @param {string} [opts.base]
 * @param {function} [opts.fetchImpl] injected for tests
 * @param {number} [opts.pageSize]
 * @returns {Promise<object[]>}
 */
export async function sbGetAll(path, { key, base = supabaseUrl(), fetchImpl = fetch, pageSize = PAGE } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  // Only impose an order if the caller hasn't chosen one — a caller ordering by draw_date is
  // making a deliberate choice and must not have it silently overridden.
  const ordered = /(^|[?&])order=/.test(path) ? path : `${path}${sep}order=id`;
  const joiner = ordered.includes("?") ? "&" : "?";

  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = `${base}/rest/v1/${ordered}${joiner}limit=${pageSize}&offset=${offset}`;
    const r = await fetchImpl(url, { headers: authHeaders(key) });
    const page = await r.json();
    if (!Array.isArray(page)) {
      throw new Error(
        `PostgREST read failed — HTTP ${r.status}: ${page?.message || JSON.stringify(page).slice(0, 200)} (${path})`
      );
    }
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

/**
 * Exact row count via `Prefer: count=exact`, without transferring the rows.
 * Returns null when the count cannot be read — a count we can't read must not
 * masquerade as zero.
 */
export async function sbCount(path, { key, base = supabaseUrl(), fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${base}/rest/v1/${path}`, {
      headers: { ...authHeaders(key), Prefer: "count=exact", Range: "0-0" },
    });
    const n = Number((r.headers.get("content-range") || "/0").split("/")[1]);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}
