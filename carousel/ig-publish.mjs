// carousel/ig-publish.mjs — publish today's post to Instagram through Composio's REST API.
//
//   bun carousel/ig-publish.mjs accounts      list the Instagram accounts this key can reach
//   bun carousel/ig-publish.mjs carousel      children (alt text) → carousel container → publish → state row
//   bun carousel/ig-publish.mjs story         the Story still → publish → state row
//   bun carousel/ig-publish.mjs verify        newest post's caption == publish.json's caption
//   bun carousel/ig-publish.mjs reel [auto|reel|reel-2]
//                                             the queued Reel due at this UK hour (autopilot/queue.mjs) →
//                                             REELS container → publish → mark done → read it back
//   bun carousel/ig-publish.mjs fb-carousel   today's slides as ONE Facebook Page multi-photo post → fb_album row
//   bun carousel/ig-publish.mjs fb-caption    print the Facebook version of today's caption
//   A posted Reel is also posted to the Facebook Page (video post) right after Instagram.
//   add --dry-run to print the calls without making them
//
// WHY A SCRIPT. The daily run used to publish by calling Composio's MCP tools from inside a Claude session.
// That MCP login lives in the Mac's keychain, so publishing could only happen on the Mac. This script needs
// only COMPOSIO_API_KEY, so the same step runs on the Mac or on GitHub Actions, and the exact calls are code
// rather than something a model re-derives every morning.
//
// Keys: a project key (ak_…) goes in `x-api-key`; a consumer key (ck_…, the project behind Composio's hosted
// MCP) goes in `x-consumer-api-key`. Accounts connected through the MCP live in the consumer project.
import { GLOBAL, workDir } from "./config.mjs";
import { markStatus, todayLondon, getPost, patchPost } from "./state.mjs";
import { dueItem, done, release } from "./autopilot/queue.mjs";

export const BASE = "https://backend.composio.dev/api/v3.1";
const IG_USER = GLOBAL.igUserId;
const FB_PAGE = GLOBAL.fbPageId;

// Facebook takes a link in the post itself, so "link in bio" (an Instagram-only phrase) goes; the site
// address already in the caption is what a reader taps. Everything else, operator credit included, stays.
export const fbCaption = (s) => String(s || "").replace(/,?[ \t]*\n?[ \t]*link in bio\b/gi, "").replace(/\n{3,}/g, "\n\n").trim();

export function authHeaders(key = process.env.COMPOSIO_API_KEY || "") {
  if (!key) throw new Error("COMPOSIO_API_KEY is not set");
  return { [key.startsWith("ck_") ? "x-consumer-api-key" : "x-api-key"]: key, "Content-Type": "application/json" };
}

// Composio wraps tool output differently per toolkit; the Graph API id can sit at any of these depths.
export function idOf(res) {
  const d = res?.data ?? res;
  return d?.id ?? d?.data?.id ?? d?.response_data?.id ?? d?.creation_id ?? null;
}

export async function listAccounts() {
  const r = await fetch(`${BASE}/connected_accounts?toolkit_slugs=instagram&statuses=ACTIVE&limit=20`, { headers: authHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`connected_accounts HTTP ${r.status}: ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  return (j.items || []).map((a) => ({ id: a.id, status: a.status, user_id: a.user_id ?? null, toolkit: a.toolkit?.slug }));
}

let accountCache = null;
async function account() {
  if (process.env.COMPOSIO_IG_ACCOUNT) return process.env.COMPOSIO_IG_ACCOUNT;
  if (accountCache) return accountCache;
  const list = await listAccounts();
  if (!list.length) throw new Error("this Composio key reaches no ACTIVE Instagram account — connect Instagram under the key's project, or use the consumer (ck_) key");
  accountCache = list[0];
  return accountCache;
}

export async function execute(slug, args, { dry = false } = {}) {
  if (dry) { console.log(`  [dry] ${slug} ${JSON.stringify(args).slice(0, 220)}`); return { successful: true, data: { id: `dry-${slug}` } }; }
  const acct = await account();
  const body = { arguments: args, version: "latest" };
  if (typeof acct === "string") body.connected_account_id = acct;
  else { body.connected_account_id = acct.id; if (acct.user_id) body.user_id = acct.user_id; }
  const r = await fetch(`${BASE}/tools/execute/${slug}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  // A 200 can still be a failed tool run: `successful` is the verdict, not the HTTP status.
  if (!r.ok || j.successful === false) {
    throw new Error(`${slug} failed (HTTP ${r.status}): ${JSON.stringify(j.error ?? j.data ?? j).slice(0, 400)}`);
  }
  return j;
}

const pub = async () => {
  const p = await Bun.file(`${workDir()}/out/publish.json`).json().catch(() => null);
  if (!p) throw new Error("out/publish.json missing — run bun carousel/publish.mjs first");
  return p;
};

async function publishContainer(creationId, dry) {
  const res = await execute("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", { ig_user_id: IG_USER, creation_id: creationId, max_wait_seconds: 300 }, { dry });
  const id = idOf(res);
  if (!id) throw new Error(`publish returned no media id: ${JSON.stringify(res).slice(0, 300)}`);
  return id;
}

export async function carousel({ dry = false } = {}) {
  const p = await pub();
  const urls = p.urls || [];
  if (urls.length < 2) throw new Error(`publish.json has ${urls.length} slide url(s); a carousel needs 2-10`);
  if (urls.length > 10) throw new Error(`publish.json has ${urls.length} slide urls; Instagram allows 10`);
  let parent;
  try {
    // Preferred: one child per slide so each keeps its alt text.
    const children = [];
    for (const [i, url] of urls.entries()) {
      const c = await execute("INSTAGRAM_POST_IG_USER_MEDIA",
        { ig_user_id: IG_USER, image_url: url, is_carousel_item: true, alt_text: p.altTexts?.[i] || undefined }, { dry });
      const id = idOf(c);
      if (!id) throw new Error(`child ${i + 1} returned no container id`);
      children.push(id);
    }
    parent = idOf(await execute("INSTAGRAM_CREATE_CAROUSEL_CONTAINER", { ig_user_id: IG_USER, children, caption: p.caption }, { dry }));
  } catch (e) {
    // Known fallback: the one-call route, which drops alt text (Instagram limitation via this tool).
    console.error(`  per-child route failed (${e.message.slice(0, 160)}) — falling back to child_image_urls`);
    parent = idOf(await execute("INSTAGRAM_CREATE_CAROUSEL_CONTAINER", { ig_user_id: IG_USER, child_image_urls: urls, caption: p.caption }, { dry }));
  }
  if (!parent) throw new Error("carousel container returned no id");
  const media = await publishContainer(parent, dry);
  if (!dry) await markStatus(todayLondon(), "carousel", "published", { ig_media_id: media, ig_container_id: parent });
  console.log(`PUBLISHED ${media}`);
  return media;
}

export async function story({ dry = false } = {}) {
  const p = await pub();
  if (!p.storyUrl) throw new Error("publish.json has no storyUrl — no Story today");
  const container = idOf(await execute("INSTAGRAM_POST_IG_USER_MEDIA", { ig_user_id: IG_USER, media_type: "STORIES", image_url: p.storyUrl }, { dry }));
  if (!container) throw new Error("story container returned no id");
  const media = await publishContainer(container, dry);
  if (!dry) await markStatus(todayLondon(), "story", "published", { ig_media_id: media, ig_container_id: container });
  console.log(`PUBLISHED STORY ${media}`);
  return media;
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

const fbIdOf = (res) => { const d = res?.data ?? res; return d?.post_id ?? d?.id ?? d?.data?.post_id ?? d?.data?.id ?? null; };

// The carousel's slides as one Facebook multi-photo post. Facebook is a second home: a failure here is
// reported, never a reason to hold Instagram back.
export async function fbCarousel({ dry = false } = {}) {
  const p = await pub();
  const row = dry ? null : await getPost(todayLondon(), "fb_album").catch(() => null);
  if (row?.status === "published") { console.log(`FB ALREADY ${row.fb_post_id}`); return row.fb_post_id; }
  const res = await execute("FACEBOOK_CREATE_MULTI_PHOTO_POST", { page_id: FB_PAGE, photo_urls: p.urls, message: fbCaption(p.caption) }, { dry });
  const id = fbIdOf(res);
  if (!id) throw new Error(`facebook multi-photo post returned no id: ${JSON.stringify(res).slice(0, 300)}`);
  if (!dry) await markStatus(todayLondon(), "fb_album", "published", { fb_post_id: String(id) });
  console.log(`FB PUBLISHED ${id}`);
  return id;
}

export async function fbReel(item, { dry = false } = {}) {
  const res = await execute("FACEBOOK_CREATE_VIDEO_POST", { page_id: FB_PAGE, file_url: item.videoUrl, description: fbCaption(item.caption), published: true }, { dry });
  const id = fbIdOf(res);
  if (!id) throw new Error(`facebook video post returned no id: ${JSON.stringify(res).slice(0, 300)}`);
  return String(id);
}

// One queued Reel. queue.mjs decides whether it is due (slot window, posted already, draw still open), so
// this posts exactly what the lunchtime run built and checked: its video, cover and caption byte for byte.
// Exit codes for the workflow: 0 posted, 3 nothing due (not an error), 1 failed.
export async function reel(which = "auto", { dry = false } = {}) {
  const r = await dueItem(which, { dry });
  if (!r.ok) { console.log(`NOTHING DUE · ${r.why}`); return 3; }
  const { slot, item } = r;
  const ig = item.igUserId || IG_USER;
  let media = null, lastErr = null;
  for (let attempt = 1; attempt <= 2 && !media; attempt++) {   // a fresh container once, as PUBLISH_SLOT.md did
    try {
      const container = idOf(await execute("INSTAGRAM_POST_IG_USER_MEDIA", { ig_user_id: ig, media_type: "REELS",
        video_url: item.videoUrl, cover_url: item.coverUrl, caption: item.caption, share_to_feed: true }, { dry }));
      if (!container) throw new Error("the REELS container returned no id");
      media = await publishContainer(container, dry);
    } catch (e) { lastErr = e; console.error(`  attempt ${attempt}: ${e.message.slice(0, 300)}`); }
  }
  if (!media) {
    if (!dry) await release(slot).catch(() => {});   // hand it back: the Mac or a later start may still make it
    throw new Error(`${slot} not published: ${lastErr?.message?.slice(0, 300)}`);
  }
  if (dry) { await fbReel(item, { dry }); console.log(`[dry] would publish ${slot} (${item.hero}) to Instagram and Facebook`); return 0; }
  await done(slot, media);
  // Facebook after Instagram, once: the claim means only this runner reaches here for this Reel.
  try { const fb = await fbReel(item); await patchPost(item.date, slot, { fb_post_id: fb }); console.log(`FB PUBLISHED ${slot} ${fb}`); }
  catch (e) { console.error(`FB FAILED ${slot}: ${e.message.slice(0, 300)}`); }
  const res = await execute("INSTAGRAM_GET_IG_USER_MEDIA", { ig_user_id: ig, limit: 3, fields: "id,media_product_type,permalink,timestamp" });
  const items = res?.data?.data ?? res?.data?.response_data?.data ?? res?.data ?? [];
  const mine = (Array.isArray(items) ? items : []).find((m) => String(m.id) === String(media));
  console.log(`PUBLISHED ${slot} ${media} ${mine?.permalink || ""} ${mine ? mine.media_product_type : "(not yet listed)"}`);
  return 0;
}
export async function verify({ dry = false } = {}) {
  const p = await pub();
  const res = await execute("INSTAGRAM_GET_IG_USER_MEDIA", { ig_user_id: IG_USER, limit: 3, fields: "id,caption,permalink,timestamp" }, { dry });
  if (dry) return true;
  const items = res?.data?.data ?? res?.data?.response_data?.data ?? res?.data ?? [];
  const newest = Array.isArray(items) ? items[0] : null;
  if (newest && norm(newest.caption) === norm(p.caption)) { console.log(`VERIFIED ${newest.id} ${newest.permalink || ""}`); return true; }
  console.error(`NOT VERIFIED — newest caption starts "${norm(newest?.caption).slice(0, 80)}"`);
  return false;
}

if (import.meta.main) {
  const [cmd] = Bun.argv.slice(2);
  const dry = Bun.argv.includes("--dry-run");
  try {
    if (cmd === "accounts") console.log(JSON.stringify(await listAccounts(), null, 2));
    else if (cmd === "carousel") await carousel({ dry });
    else if (cmd === "story") await story({ dry });
    else if (cmd === "verify") process.exit((await verify({ dry })) ? 0 : 1);
    else if (cmd === "fb-carousel") await fbCarousel({ dry });
    else if (cmd === "fb-caption") console.log(fbCaption((await pub()).caption));
    else if (cmd === "reel") process.exit(await reel(Bun.argv[3] && !Bun.argv[3].startsWith("--") ? Bun.argv[3] : "auto", { dry }));
    else { console.error("usage: ig-publish.mjs accounts | carousel | story | verify | fb-carousel | fb-caption | reel [auto|reel|reel-2] [--dry-run]"); process.exit(64); }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
