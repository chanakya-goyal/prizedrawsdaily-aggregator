// Draw photos are SERVED from Cloudflare Pages; Cloudinary only receives them (PAGES.md).
//
// WHY: Cloudinary's free plan meters delivered bytes. weserv downloads the whole stored
// photo on every cache miss (once per width × crop × data centre), and crawlers fetch
// og:image straight from the host. On 2026-10-09, the first day on Cloudinary, that ran at
// ~0.7 GB/day: 25 credits gone in about a week. A Cloudflare Pages site serves static files
// with no bandwidth meter and needs no card. So the scraper keeps uploading to Cloudinary
// as before, and publish-images.mjs copies every PUBLIC photo onto Pages and points the
// row at the copy.
//
// Pure functions only. publish-images.mjs does the I/O; test/pages.test.mjs pins the rules.
import { objectPathFromUrl, cloudinaryAssetOf } from "./storage.mjs";

export const PAGES_PROJECT_DEFAULT = "prizedrawsdaily-images";

// Free plan: 20,000 files per deployment. Stop short of it so the alarm fires while there
// is still room to act (lower RETENTION_DAYS).
export const PAGES_MAX_FILES = 19_500;
// Early warning, with room left to act: split the photos across a second Pages project.
// With RETENTION_DAYS=0 this fires only at ~1,900 new public draws a day (PAGES.md).
export const PAGES_WARN_FILES = 15_000;
// Cloudflare refuses any single asset over 25 MiB.
export const PAGES_MAX_BYTES = 25 * 1024 * 1024;

export const pagesProject = (env = process.env) => env.PAGES_PROJECT || PAGES_PROJECT_DEFAULT;

/** The site root: the project's own subdomain, unless PAGES_SITE overrides it. */
export function pagesSite(env = process.env) {
  const b = (env.PAGES_SITE || `https://${pagesProject(env)}.pages.dev/`).trim();
  return b.endsWith("/") ? b : `${b}/`;
}

/**
 * Where the photos are served: `<site>/i/`. Keeping every photo under one folder lets a
 * single `_headers` rule give them the long cache, while `manifest.json` at the root keeps
 * Pages' default (revalidate every time) and so always reads true.
 */
export const pagesBase = (env = process.env) => `${pagesSite(env)}i/`;

/** The public URL of a key: each path segment encoded, the same way cloudinaryRawUrl does. */
export const pagesUrl = (base, key) => base + key.split("/").map(encodeURIComponent).join("/");

/** The key a URL on our Pages site names, or null. Understands a weserv wrapper. */
export const pagesKeyOf = (url, base) => objectPathFromUrl(url, base);

// A key becomes a file path inside the deployed `i/` folder, so it must stay inside it: no
// `..`, no dot-segments, no backslashes. Every real key is `<folder>/<name>.<image ext>`.
const SAFE_KEY = /^[^/\\]+(\/[^/\\]+)+$/;
const IMAGE_EXT = /\.(webp|avif|jpe?g|png|gif|svg)$/i;
export function isSafeKey(key) {
  if (typeof key !== "string" || !SAFE_KEY.test(key) || !IMAGE_EXT.test(key)) return false;
  return !key.split("/").some((s) => s === "." || s === ".." || s.startsWith("."));
}

/**
 * Decide what the Pages site must hold and which rows move onto it.
 *
 *   want     Map(key → { from: "pages" | "cloudinary", url })   the full next deployment
 *   repoint  [{ table, column, id, old, key }]                   rows to point at Pages
 *
 * Rules, each pinned by a test:
 *  - A row already on Pages keeps its file: the next deployment REPLACES the last one, so
 *    a key left out is a photo deleted.
 *  - A row on Cloudinary is copied over and repointed, unless it is a DRAFT. Drafts are not
 *    public, and the scraper re-uploads a draft's photo on every run, which would set it back
 *    to Cloudinary each time. It moves once published.
 *  - A Cloudinary row beats a Pages row for the same key: the scraper only writes a
 *    Cloudinary URL when it has just uploaded new bytes (a relisted draw's new photo).
 *  - Between two Cloudinary forms for one key, raw wins: raw is every upload since
 *    2026-10-09, the image form is the older migrated copy.
 *  - Operator logos follow the same rules; operators have no draft state.
 *  - A key that is unsafe as a file path is never written; the row stays where it is.
 */
export function planMirror({ draws = [], operators = [], base, cloud }) {
  const want = new Map();
  const repoint = [];
  const unsafe = [];
  let drafts = 0;

  const consider = (table, column, id, url, isDraft) => {
    if (typeof url !== "string" || !url) return;
    const onPages = pagesKeyOf(url, base);
    if (onPages) {
      if (!isSafeKey(onPages)) { unsafe.push(url); return; }
      if (!want.has(onPages)) want.set(onPages, { from: "pages", url });
      return;
    }
    const asset = cloud ? cloudinaryAssetOf(url, cloud) : null;
    if (!asset) return; // not ours: an operator's own URL the scrape could not re-host
    if (isDraft) { drafts++; return; }
    if (!isSafeKey(asset.path)) { unsafe.push(url); return; }
    const had = want.get(asset.path);
    const beats = !had || had.from === "pages" || (asset.resourceType === "raw" && had.form !== "raw");
    if (beats) want.set(asset.path, { from: "cloudinary", url, form: asset.resourceType });
    repoint.push({ table, column, id, old: url, key: asset.path });
  };

  for (const d of draws) consider("draws", "image_url", d.id, d.image_url, d.status === "draft");
  for (const o of operators) consider("operators", "logo_url", o.id, o.logo_url, false);
  return { want, repoint, drafts, unsafe };
}

/**
 * Configuration files deployed at the site root, next to `i/`.
 *  - `_headers`: photos get the same cache policy Cloudinary served (30 days, immutable),
 *    so weserv and browsers behave exactly as before. CORS open, like Cloudinary.
 *  - `404.html`: without one, Pages treats the site as a single-page app and answers 200
 *    with the index for ANY missing path. A missing photo must be a real 404, or the site's
 *    image fallback never fires and the checks below could not see it.
 */
export const HEADERS_FILE = `/i/*
  Cache-Control: public, max-age=2592000, immutable
  Access-Control-Allow-Origin: *
`;
export const NOT_FOUND_FILE = "<!doctype html><title>Not found</title>";

/** Rows of the manifest the deployment carries, sorted so equal sets compare equal. */
export function manifestOf(entries) {
  const files = {};
  for (const [key, v] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) files[key] = v;
  return { files };
}
