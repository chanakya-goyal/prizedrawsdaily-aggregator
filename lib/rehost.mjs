// Re-host a draw image onto our OWN Supabase Storage so the live site never hotlinks a
// third-party operator host. Hotlinked images break the moment the source host blocks
// cross-origin/bot requests — e.g. Cloudflare "Just a moment" returns HTTP 403 to an
// <img> embedded on prizedrawsdaily.co.uk. That is the root cause of operator images
// silently breaking on the site (Borders Competitions was the first confirmed case:
// borderscompetitions.co.uk is behind Cloudflare bot protection). Copying the bytes into
// the `draw-images` bucket at ingest means the browser only ever loads from our own domain.
//
// Fetch strategy — first that yields real image bytes wins:
//   1. direct  — fetch() with the shared browser UA (works for most operators)
//   2. weserv  — images.weserv.nl, a free image proxy that fetches + re-encodes server-side
//                and gets past the Cloudflare hotlink wall that 403s our direct fetch
// If BOTH fail we return the ORIGINAL url unchanged — graceful: identical to today's
// behaviour (still-broken for that one image) so a fetch miss never blocks the insert.
import { UA } from "./parse.mjs";

const BUCKET = "draw-images";
const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" };
const MIN_BYTES = 1024; // anything smaller is a CF challenge page / 1px error placeholder, not a real image

const isImageType = (t) => typeof t === "string" && t.startsWith("image/");
const stripScheme = (u) => u.replace(/^https?:\/\//i, ""); // weserv wants host+path, no scheme

async function tryFetch(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!r.ok || !isImageType(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength < MIN_BYTES) return null;
    return { buf, type };
  } catch { return null; }
}

// Download the real bytes via the first strategy that works.
async function download(imageUrl) {
  let got = await tryFetch(imageUrl);
  if (got) return { ...got, via: "direct" };
  got = await tryFetch(`https://images.weserv.nl/?url=${encodeURIComponent(stripScheme(imageUrl))}`);
  if (got) return { ...got, via: "weserv" };
  return null;
}

// Upload bytes to draw-images/<opSlug>/<drawSlug>.<ext>; returns the public URL.
async function upload({ buf, type }, path, { supabaseUrl, serviceKey }) {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": type, "x-upsert": "true" },
    body: buf,
  });
  if (!r.ok) throw new Error(`storage ${r.status} ${(await r.text()).slice(0, 120)}`);
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
}

// Public entry point. Returns { url, via, changed }:
//   already-ours / empty / non-http  → { changed:false, via:"own"|"skip" }, url unchanged
//   re-hosted                        → { changed:true,  via:"direct"|"weserv" }, url = new Supabase URL
//   both fetch strategies failed     → { changed:false, via:"miss" }, original url unchanged
export async function rehostImage(imageUrl, opSlug, drawSlug, { supabaseUrl, serviceKey }) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return { url: imageUrl, via: "skip", changed: false };
  if (imageUrl.startsWith(supabaseUrl)) return { url: imageUrl, via: "own", changed: false }; // already on our storage
  const got = await download(imageUrl);
  if (!got) return { url: imageUrl, via: "miss", changed: false };
  const ext = EXT_BY_TYPE[got.type] || "jpg";
  const url = await upload(got, `${opSlug}/${drawSlug}.${ext}`, { supabaseUrl, serviceKey });
  return { url, via: got.via, changed: true };
}
