// Shrink images before they land in Supabase Storage.
//
// WHY: `rehost.mjs` used to copy the operator's ORIGINAL bytes into the `draw-images`
// bucket verbatim — average 964KB, worst case a 12MB PNG. That blew the Supabase free-tier
// 1GB storage quota (2.43GB / 243%, 19 Aug 2026) for nothing, because the SITE never serves
// those bytes: prizedrawsdaily's `src/lib/img.ts` routes every dynamic image through
// images.weserv.nl at `w<=960&output=webp&q=60`, so the stored original is only ever
// weserv's INPUT. Measured on real bucket files, re-encoding at w=1280/webp/q=75 shrinks
// them ~30x (9630KB -> 174KB) with no visible change at display size.
//
// HOW: weserv itself does the work. It's already a trusted dependency on both sides of this
// stack (rehost's Cloudflare fallback, and the site's display pipeline), so this needs no
// npm package and no native binary (sharp) — same behaviour locally and in CI.
const PROXY = "https://images.weserv.nl/";

// 1280 leaves 2x headroom over the site's widest srcset entry (960) for the draw-detail
// hero; q=75 sits above the site's display q=60 so the re-encode at render time is a
// no-op visually.
export const WEBP_W = 1280;
export const WEBP_Q = 75;

const stripScheme = (u) => u.replace(/^https?:\/\//i, ""); // weserv wants host+path, no scheme

// Build the weserv URL that returns `url` as resized webp. Pure — the unit tests cover it.
// Returns null for anything weserv can't fetch (empty, data:, non-http), so callers can
// treat "no proxy URL" and "proxy failed" the same way.
export function weservUrl(url, { w = WEBP_W, q = WEBP_Q } = {}) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  // encodeURIComponent on the whole target means a source path containing & or ?w= can
  // never inject a parameter into our query string.
  return `${PROXY}?url=${encodeURIComponent(stripScheme(url))}&w=${w}&output=webp&q=${q}&we`;
}

// Fetch `url` through weserv and return the webp bytes, or null. Never throws — a proxy
// miss must degrade to the caller's fallback, never break an ingest run (same contract as
// `tryFetch` in rehost.mjs).
export async function fetchWebp(url, { w = WEBP_W, q = WEBP_Q, timeoutMs = 30000, minBytes = 1024 } = {}) {
  const proxied = weservUrl(url, { w, q });
  if (!proxied) return null;
  try {
    const r = await fetch(proxied, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    // Sub-1KB means an error/challenge page slipped through with an image content-type,
    // not a real picture (same guard rehost.mjs uses).
    if (buf.byteLength < minBytes) return null;
    return buf;
  } catch {
    return null;
  }
}

// Idempotency guard for the backfill: true = leave this object alone. Skipping anything
// already webp (or already small enough that re-encoding wins nothing) means the backfill
// can be interrupted and re-run freely. Folder entries from the storage list API have
// `id === null` and no metadata.
export function shouldSkip(obj, { minBytes = 250_000 } = {}) {
  if (!obj || obj.id === null || obj.id === undefined) return true;
  const meta = obj.metadata;
  if (!meta || typeof meta.size !== "number") return true;
  if ((meta.mimetype || "").toLowerCase() === "image/webp") return true;
  return meta.size < minBytes;
}
