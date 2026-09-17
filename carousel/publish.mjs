// PUBLISH step: take the rendered slides in ~/Desktop/pdd-today/out/, make them
// Instagram-ready (JPEG, 1080×1350, public URLs), upload to a public Supabase bucket,
// and emit a publish.json the Composio step consumes (IG carousel + FB album).
//
//   bun run carousel/publish.mjs
//
// Needs SUPABASE_SERVICE_ROLE_KEY (add to ~/pdd-aggregator/.env — Bun auto-loads it;
// Supabase dashboard → Project Settings → API → service_role secret).
import { chromium } from "playwright";
import { readdir } from "node:fs/promises";
import { buildFbCaption } from "./caption.mjs";
import { toDrawSlide } from "./format.mjs";
import { GLOBAL, workDir } from "./config.mjs";
import { withRetry } from "./util.mjs";
import { upsertPost, todayLondon, getPost } from "./state.mjs";
import { uploadHeaders } from "../lib/storage.mjs";

const DIR = workDir();
const OUT = `${DIR}/out`;
const SUPABASE_URL = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = GLOBAL.bucket;
const IG_USER_ID = GLOBAL.igUserId;

if (!KEY) {
  console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing. Add it to ~/pdd-aggregator/.env:");
  console.error("  SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Supabase dashboard → Settings → API>");
  process.exit(1);
}

// date folder (Europe/London) for tidy storage paths
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
const sel = JSON.parse(await Bun.file(`${DIR}/selection.json`).text());

// idempotency preflight — refuse to re-publish a carousel that's already live
const existing = await getPost(todayLondon(), "carousel").catch((e) => { console.error("⚠ preflight skipped (state unreachable): " + e.message); return null; });
if (existing?.status === "published") {
  console.error(`✗ Today's carousel is already PUBLISHED (ig_media_id=${existing.ig_media_id}). Refusing to re-publish. Use state-mark.mjs if this is wrong.`);
  process.exit(2);
}
// reel/story get a narrower preflight than the carousel: a published reel/story only
// skips RE-HOSTING that one asset (log + continue) instead of exiting the whole run —
// a carousel-only re-run or a late story on a reel day must still be able to proceed.

const caption = (await Bun.file(`${OUT}/CAPTION.txt`).text().catch(() => "")).trim()
  || (await Bun.file(`${OUT}/CAPTION_FALLBACK.txt`).text().catch(() => "")).trim();
if (!caption) { console.error("✗ no caption (CAPTION.txt or CAPTION_FALLBACK.txt)"); process.exit(1); }

// ordered slide PNGs (01-…, 02-…, …)
const pngs = (await readdir(OUT)).filter((f) => /^\d\d-.*\.png$/.test(f)).sort();
if (pngs.length < 2) { console.error("✗ Need ≥2 slides in", OUT); process.exit(1); }
console.log(`Slides: ${pngs.length}  | caption ${caption.length} chars`);

// 1) convert each PNG → Instagram-ready JPEG (1080×1350) via a headless canvas
const browser = await chromium.launch();
const page = await browser.newPage();
async function toJpeg(pngPath) {
  const buf = Buffer.from(await Bun.file(pngPath).arrayBuffer());
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const jpegDataUrl = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = src; });
    const c = document.createElement("canvas"); c.width = 1080; c.height = 1350;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#07060a"; ctx.fillRect(0, 0, 1080, 1350);
    ctx.drawImage(img, 0, 0, 1080, 1350);
    return c.toDataURL("image/jpeg", 0.92);
  }, dataUrl);
  return Buffer.from(jpegDataUrl.split(",")[1], "base64");
}

// 2) ensure the public bucket exists (idempotent)
async function ensureBucket() {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (r.ok) { console.log(`Bucket '${BUCKET}' created (public).`); return; }
  const t = await r.text();
  if (r.status === 409 || /exists/i.test(t)) { console.log(`Bucket '${BUCKET}' already exists.`); return; }
  throw new Error(`bucket create failed ${r.status}: ${t.slice(0, 200)}`);
}

// 3) upload a buffer → public URL. Defaults to image/jpeg (slide path, unchanged
// call sites below); pass "video/mp4" for reel.mp4/story.mp4.
async function upload(path, buf, contentType = "image/jpeg") {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: uploadHeaders({ serviceKey: KEY, contentType }),
    body: buf,
  });
  if (!r.ok) throw new Error(`upload ${path} failed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

await withRetry(() => ensureBucket(), { label: "ensureBucket" });
const urls = [];
for (let i = 0; i < pngs.length; i++) {
  const jpeg = await toJpeg(`${OUT}/${pngs[i]}`);
  const path = `${today}/${sel.slug}/${String(i + 1).padStart(2, "0")}.jpg`;
  const url = await withRetry(() => upload(path, jpeg), { label: "upload" });
  urls.push(url);
  console.log(`  ✓ ${pngs[i]} → ${(jpeg.length / 1024).toFixed(0)}KB → ${url}`);
}
await browser.close();

// 4) reel + story hosting (Tasks 6-7's outputs) — optional; a carousel-only day has
// neither file and both blocks skip silently. Each has its own narrow idempotency
// check (see comment above the carousel preflight): if today's row for that FORMAT
// is already published, skip re-hosting (and skip the write-ahead row below, so we
// never clobber a published row's real asset_urls with a no-op re-run) but keep going.
let reelUrl = null, coverUrl = null, storyUrl = null, reelMeta = null;
// uploadedThisRun gates the write-ahead upserts below: a skip-branch resolves the
// URL (so publish.json stays complete for FB/DAILY consumption on re-runs) WITHOUT
// having uploaded anything, so URL truthiness alone can't be the upsert gate — that
// would re-upsert (and clobber) an already-published row's real asset_urls/status
// on every idempotent re-run.
let reelUploadedThisRun = false, storyUploadedThisRun = false;

try {
  if (await Bun.file(`${OUT}/reel.mp4`).exists()) {
    reelMeta = await Bun.file(`${OUT}/reel-meta.json`).json().catch(() => null);
    const existingReel = await getPost(todayLondon(), "reel").catch((e) => { console.error("⚠ reel preflight skipped (state unreachable): " + e.message); return null; });
    if (existingReel?.status === "published") {
      console.error(`⚠ today's REEL is already PUBLISHED (ig_media_id=${existingReel.ig_media_id}). Skipping re-hosting reel+cover.`);
      // resolve to the canonical public URLs the upload path would have produced —
      // publish.json must stay complete (FB video post + DAILY.md both read reelUrl)
      // even on a retry run that skips re-hosting.
      reelUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${today}/${sel.slug}/reel.mp4`;
      coverUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${today}/${sel.slug}/cover.jpg`;
    } else {
      const reelBuf = Buffer.from(await Bun.file(`${OUT}/reel.mp4`).arrayBuffer());
      reelUrl = await withRetry(() => upload(`${today}/${sel.slug}/reel.mp4`, reelBuf, "video/mp4"), { label: "upload reel" });
      console.log(`  ✓ reel.mp4 → ${(reelBuf.length / 1024 / 1024).toFixed(1)}MB → ${reelUrl}`);
      reelUploadedThisRun = true;
      if (await Bun.file(`${OUT}/cover.jpg`).exists()) {
        const coverBuf = Buffer.from(await Bun.file(`${OUT}/cover.jpg`).arrayBuffer());
        coverUrl = await withRetry(() => upload(`${today}/${sel.slug}/cover.jpg`, coverBuf, "image/jpeg"), { label: "upload cover" });
        console.log(`  ✓ cover.jpg → ${(coverBuf.length / 1024).toFixed(0)}KB → ${coverUrl}`);
      }
    }
  }
} catch (e) {
  console.error("⚠ reel hosting failed (carousel continues): " + e.message);
}

try {
  if (await Bun.file(`${OUT}/story.mp4`).exists()) {
    const existingStory = await getPost(todayLondon(), "story").catch((e) => { console.error("⚠ story preflight skipped (state unreachable): " + e.message); return null; });
    if (existingStory?.status === "published") {
      console.error(`⚠ today's STORY is already PUBLISHED (ig_media_id=${existingStory.ig_media_id}). Skipping re-hosting story.`);
      storyUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${today}/${sel.slug}/story.mp4`;
    } else {
      const storyBuf = Buffer.from(await Bun.file(`${OUT}/story.mp4`).arrayBuffer());
      storyUrl = await withRetry(() => upload(`${today}/${sel.slug}/story.mp4`, storyBuf, "video/mp4"), { label: "upload story" });
      console.log(`  ✓ story.mp4 → ${(storyBuf.length / 1024 / 1024).toFixed(1)}MB → ${storyUrl}`);
      storyUploadedThisRun = true;
    }
  }
} catch (e) {
  console.error("⚠ story hosting failed (carousel continues): " + e.message);
}

// Facebook: ONE multi-photo feed post carrying the whole deck, not one photo and not a pile of
// caption-less ones. The 4:5 slides already rendered ARE Meta's own recommended feed ratio, so
// nothing is re-cut.
//
// What this deliberately does NOT build is a child_attachments carousel. Every card in one
// requires a link, which makes the whole thing a LINK post — the worst-performing organic
// format measured (0.05% engagement, roughly 200 views against 1,125 for a photo, Socialinsider
// across 25M posts). A multi-photo post keeps the photo treatment and still carries one real
// clickable link in the body, which is the thing Instagram cannot do at all.
const fbItems = await Bun.file(`${OUT}/facts.json`).json().catch(() => sel.draws.map((d) => {
  // Fallback only. Prefer build.mjs's facts: recomputing titles here with a second cleaner is
  // how Instagram and Facebook ended up calling the same prize two different things.
  const s = toDrawSlide(d); return { title: s.title, price: s.price };
}));
const fbCaption = (await Bun.file(`${OUT}/FB_CAPTION.txt`).text().catch(() => "")).trim()
  || buildFbCaption(sel.name, sel.slug, fbItems);
const heroUrl = urls[0];              // still the album's lead image and the fb_video thumbnail
// Meta caps a feed post's photo array; the carousel is ten slides, which is inside every
// published limit, so the album is the deck.
const fbUrls = urls;

const altTexts = await Bun.file(`${OUT}/alt.json`).json().catch(() => []);
const publish = {
  date: today, category: sel.slug, seoKeyword: sel.seoKeyword || null, archetype: sel.archetype || null,
  igUserId: IG_USER_ID, caption, fbCaption, heroUrl, urls, altTexts, reelUrl, coverUrl, storyUrl, reelMeta,
  // The Facebook album and, explicitly, the tools that must not be used for it. Naming the
  // forbidden ones in the manifest is the point: the single-photo call is still the obvious
  // thing to reach for, and a link-card carousel is the tempting one.
  fbUrls,
  fbForbiddenTools: ["FACEBOOK_CREATE_PHOTO_POST (single photo — posts the cover and drops nine slides)",
                     "child_attachments / link-card carousel (every card needs a link, which makes it a LINK post)"],
};
await Bun.write(`${OUT}/publish.json`, JSON.stringify(publish, null, 2));
// write-ahead row (spec §4.2): marks today's carousel "assets_uploaded" before Composio posts,
// so a crash/retry mid-post can't silently double-publish. Tables are pending a one-time SQL
// paste (state-schema.sql) — don't let that block today's publish; log + carry on.
try {
  await upsertPost({
    date: todayLondon(), format: "carousel", status: "assets_uploaded",
    category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
    hook_archetype: sel.archetype || null, seo_keyword: sel.seoKeyword || null,
    caption, asset_urls: urls,
  });
  await upsertPost({
    date: todayLondon(), format: "fb_album", status: "assets_uploaded",
    category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
    caption: fbCaption, asset_urls: fbUrls,
  });
  // reel/story rows only get written when we actually uploaded something THIS run —
  // gated on uploadedThisRun (not URL truthiness), since the skip branches above now
  // populate reelUrl/storyUrl from the canonical public URL even when nothing was
  // re-hosted. Re-upserting on a skip-run would clobber that row's real (published)
  // status + asset_urls with a stale assets_uploaded write.
  if (reelUploadedThisRun) {
    await upsertPost({
      date: todayLondon(), format: "reel", status: "assets_uploaded",
      category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
      hook_archetype: reelMeta?.arm ? `arm-${reelMeta.arm}` : null,
      asset_urls: [reelUrl, coverUrl],
    });
  }
  if (storyUploadedThisRun) {
    await upsertPost({
      date: todayLondon(), format: "story", status: "assets_uploaded",
      category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
      asset_urls: [storyUrl],
    });
  }
  // fb_video write-ahead row: FB video post is now the primary FB action (DAILY.md
  // §9.4), but publish.mjs never wrote a row for it — cleanup.mjs then waited
  // forever on a row that would never appear. Written whenever the reel asset is
  // resolved this run (uploaded OR skip-branch canonical URL) since either way FB
  // can post FACEBOOK_CREATE_VIDEO_POST from reelUrl. Preflighted like reel/story
  // so a retry run never clobbers an already-published fb_video row.
  if (reelUrl) {
    const existingFbVideo = await getPost(todayLondon(), "fb_video").catch((e) => { console.error("⚠ fb_video preflight skipped (state unreachable): " + e.message); return null; });
    if (existingFbVideo?.status === "published") {
      console.log(`⚠ today's FB_VIDEO is already PUBLISHED (fb_post_id=${existingFbVideo.fb_post_id}). Skipping write-ahead row.`);
    } else {
      await upsertPost({
        date: todayLondon(), format: "fb_video", status: "assets_uploaded",
        category: sel.slug, draw_slugs: sel.draws.map((d) => d.slug),
        caption: fbCaption, asset_urls: [reelUrl],
      });
    }
  }
  console.log(`✓ write-ahead rows: carousel + fb_album${reelUploadedThisRun ? " + reel" : ""}${storyUploadedThisRun ? " + story" : ""}${reelUrl ? " + fb_video" : ""} assets_uploaded (idempotent re-runs will not double-post)`);
} catch (e) {
  console.log(`⚠ state write failed (tables pending?): ${e?.message || e}`);
}
console.log(`\n✓ ${urls.length} public JPEGs hosted. Wrote ${OUT}/publish.json`);
console.log("\n--- FB CAPTION (single detailed post) ---\n" + fbCaption);
console.log(`\nNext: IG → carousel (${urls.length} urls + caption).`);
console.log(`      FB → ONE multi-photo feed post (all ${fbUrls.length} urls, message=fbCaption).`);
console.log("      FB → do NOT use the single-photo call (posts the cover, drops the rest) and do NOT build a link-card carousel (it becomes a link post).");
