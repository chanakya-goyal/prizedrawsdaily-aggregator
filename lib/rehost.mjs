// Re-host a draw image onto our OWN Supabase Storage so the live site never hotlinks a
// third-party operator host. Hotlinked images break the moment the source host blocks
// cross-origin/bot requests — e.g. Cloudflare "Just a moment" returns HTTP 403 to an
// <img> embedded on prizedrawsdaily.co.uk. That is the root cause of operator images
// silently breaking on the site (Borders Competitions was the first confirmed case:
// borderscompetitions.co.uk is behind Cloudflare bot protection). Copying the bytes into
// the `draw-images` bucket at ingest means the browser only ever loads from our own domain.
//
// Images are stored RESIZED (w<=1280) AND RE-ENCODED to webp — never at their original
// resolution. Storing originals put the bucket at 2.43GB against the Supabase free-tier
// 1GB quota (243%, Aug 2026) purely as dead weight, since the site serves every dynamic
// image through images.weserv.nl at w<=960/webp/q=60 and never touches the stored original
// directly. See lib/compress.mjs for the measurements.
//
// Fetch strategy — first that yields real image bytes wins:
//   1. weserv+resize — images.weserv.nl fetches the origin SERVER-side and hands back
//                      resized webp in one hop. This both compresses AND gets past the
//                      Cloudflare hotlink wall that 403s our direct fetch, so it's the
//                      primary path.
//   2. direct        — fetch() with the shared browser UA, then compress by round-tripping
//                      our own public URL back through weserv. Needed because weserv
//                      policy-blocks a few operator domains outright (phatlads.com,
//                      easylivingcompetitions.co.uk) while a plain fetch still succeeds.
//                      Our own bucket URL is always weserv-reachable, so the compress leg
//                      works even when the origin is blocked.
// If BOTH fail we return the ORIGINAL url unchanged — graceful: identical to the original
// behaviour (still-broken for that one image) so a fetch miss never blocks the insert.
import { UA } from "./parse.mjs";
import { fetchWebp } from "./compress.mjs";

const BUCKET = "draw-images";
const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" };
const MIN_BYTES = 1024; // anything smaller is a CF challenge page / 1px error placeholder, not a real image

const isImageType = (t) => typeof t === "string" && t.startsWith("image/");

async function tryFetch(url) {
  try {
    // Hard timeout: a broken origin that ACCEPTS the connection but never responds
    // (Red Hot Raffles, 2026-08-14) stalled a whole Action run for 2h06m without it.
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!r.ok || !isImageType(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < MIN_BYTES) return null;
    return { buf, type };
  } catch { return null; }
}

// Upload bytes to draw-images/<path>; returns the public URL.
async function upload({ buf, type }, path, { supabaseUrl, serviceKey }) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": type, "x-upsert": "true" },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`storage ${r.status} ${(await r.text()).slice(0, 120)}`);
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function remove(path, { supabaseUrl, serviceKey }) {
  try {
    await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch { /* an orphaned interim object is wasteful, not broken — never fail the ingest over it */ }
}

// Public entry point. Returns { url, via, changed }:
//   already-ours / empty / non-http  → { changed:false, via:"own"|"skip" }, url unchanged
//   re-hosted                        → { changed:true,  via:"weserv"|"direct+webp"|"direct" }, url = new Supabase URL
//   both fetch strategies failed     → { changed:false, via:"miss" }, original url unchanged
export async function rehostImage(imageUrl, opSlug, drawSlug, { supabaseUrl, serviceKey }) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return { url: imageUrl, via: "skip", changed: false };
  if (imageUrl.startsWith(supabaseUrl)) return { url: imageUrl, via: "own", changed: false }; // already on our storage
  const creds = { supabaseUrl, serviceKey };

  // 1. weserv fetches + resizes + re-encodes server-side: compressed webp in one hop.
  const webp = await fetchWebp(imageUrl, { minBytes: MIN_BYTES });
  if (webp) {
    const url = await upload({ buf: webp, type: "image/webp" }, `${opSlug}/${drawSlug}.webp`, creds);
    return { url, via: "weserv", changed: true };
  }

  // 2. weserv couldn't reach it (or policy-blocks the domain) — pull the bytes ourselves.
  const got = await tryFetch(imageUrl);
  if (!got) return { url: imageUrl, via: "miss", changed: false };
  const ext = EXT_BY_TYPE[got.type] || "jpg";
  const interimPath = `${opSlug}/${drawSlug}.${ext}`;
  const interimUrl = await upload(got, interimPath, creds);

  // …then compress by sending OUR public URL through weserv, which can always reach it.
  const shrunk = got.type === "image/webp" ? null : await fetchWebp(interimUrl, { minBytes: MIN_BYTES });
  if (!shrunk || shrunk.byteLength >= got.buf.byteLength) {
    // Nothing to gain (already webp, or the re-encode came back bigger) — keep what we have.
    return { url: interimUrl, via: "direct", changed: true };
  }
  const url = await upload({ buf: shrunk, type: "image/webp" }, `${opSlug}/${drawSlug}.webp`, creds);
  if (interimPath !== `${opSlug}/${drawSlug}.webp`) await remove(interimPath, creds);
  return { url, via: "direct+webp", changed: true };
}
