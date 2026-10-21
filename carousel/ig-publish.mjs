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
// Keys: a project key (ak_…) calls the REST API with `x-api-key`. A consumer key (ck_…, the project behind
// Composio's hosted MCP, where the owner's Instagram and Facebook are connected) is REFUSED by the REST API
// (401 "Missing dashboard JWT", 21 Oct 2026), so it goes through the hosted MCP endpoint instead, calling the
// same tools via COMPOSIO_MULTI_EXECUTE_TOOL.
import { GLOBAL, workDir, fbExtraTags } from "./config.mjs";
import { markStatus, todayLondon, getPost, patchPost } from "./state.mjs";
import { dueItem, done, release } from "./autopilot/queue.mjs";

export const BASE = "https://backend.composio.dev/api/v3.1";
const IG_USER = GLOBAL.igUserId;
const FB_PAGE = GLOBAL.fbPageId;

// Facebook takes a link in the post itself, so "link in bio" (an Instagram-only phrase) goes; the site
// address already in the caption is what a reader taps. Facebook does not cap hashtags at five, so the
// category's extra Facebook tags (config.json global.fbHashtags) join the tag line. Everything else,
// operator credit included, stays.
export function fbCaption(s, category = null) {
  let t = String(s || "").replace(/,?[ \t]*\n?[ \t]*link in bio\b/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  const extra = category ? fbExtraTags(category) : [];
  if (!extra.length) return t;
  const lines = t.split("\n"), i = lines.findLastIndex((l) => /^#\w/.test(l.trim()));
  const have = i >= 0 ? lines[i].trim().split(/\s+/) : [];
  const tags = [...new Set([...have, ...extra])].join(" ");
  if (i >= 0) lines[i] = tags; else lines.push("", tags);
  return lines.join("\n");
}

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

export const MCP_URL = "https://connect.composio.dev/mcp";
let mcpReady = null, rpcId = 0;
async function mcpRpc(method, params, notify = false) {
  const r = await fetch(MCP_URL, { method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-consumer-api-key": process.env.COMPOSIO_API_KEY },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const t = await r.text();
  if (notify) return null;
  if (!r.ok) throw new Error(`MCP ${method} HTTP ${r.status}: ${t.slice(0, 200)}`);
  // streamable HTTP answers as plain JSON or as one SSE event
  const line = t.trim().startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
  return JSON.parse(line || "{}");
}
// One tool's result out of COMPOSIO_MULTI_EXECUTE_TOOL's envelope, shaped like the REST answer.
export function parseMcpResult(rpc, slug) {
  if (rpc?.error) throw new Error(`${slug} failed (MCP): ${JSON.stringify(rpc.error).slice(0, 300)}`);
  const text = (rpc?.result?.content || []).map((c) => c.text || "").join("");
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${slug} failed (MCP): ${text.slice(0, 300)}`); }
  const r0 = j?.data?.results?.[0];
  if (j?.successful === false || !r0 || r0.response?.successful === false || r0.error) {
    throw new Error(`${slug} failed (MCP): ${JSON.stringify(r0?.response?.error ?? r0?.error ?? j?.error ?? r0?.response ?? j).slice(0, 400)}`);
  }
  return { successful: true, data: r0.response?.data ?? r0.response };
}
async function mcpExecute(slug, args) {
  mcpReady ??= (async () => {
    await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pdd-autopilot", version: "1" } });
    await mcpRpc("notifications/initialized", {}, true);
  })();
  await mcpReady;
  return parseMcpResult(await mcpRpc("tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {
    tools: [{ tool_slug: slug, arguments: args }], sync_response_to_workbench: false, current_step: slug, thought: "PrizeDrawsDaily autopilot" } }), slug);
}

export async function execute(slug, args, { dry = false } = {}) {
  if (dry) { console.log(`  [dry] ${slug} ${JSON.stringify(args).slice(0, 220)}`); return { successful: true, data: { id: `dry-${slug}` } }; }
  if ((process.env.COMPOSIO_API_KEY || "").startsWith("ck_")) return mcpExecute(slug, args);
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
  const category = (await Bun.file(`${workDir()}/selection.json`).json().catch(() => ({}))).slug || null;
  const res = await execute("FACEBOOK_CREATE_MULTI_PHOTO_POST", { page_id: FB_PAGE, photo_urls: p.urls, message: fbCaption(p.caption, category) }, { dry });
  const id = fbIdOf(res);
  if (!id) throw new Error(`facebook multi-photo post returned no id: ${JSON.stringify(res).slice(0, 300)}`);
  if (!dry) await markStatus(todayLondon(), "fb_album", "published", { fb_post_id: String(id) });
  console.log(`FB PUBLISHED ${id}`);
  return id;
}

export async function fbReel(item, { dry = false } = {}) {
  const res = await execute("FACEBOOK_CREATE_VIDEO_POST", { page_id: FB_PAGE, file_url: item.videoUrl, description: fbCaption(item.caption, item.category), published: true }, { dry });
  const id = fbIdOf(res);
  if (!id) throw new Error(`facebook video post returned no id: ${JSON.stringify(res).slice(0, 300)}`);
  return String(id);
}

export const sameCaption = (a, b) => norm(a) === norm(b);
async function alreadyPosted(ig, item) {
  const res = await execute("INSTAGRAM_GET_IG_USER_MEDIA", { ig_user_id: ig, limit: 5, fields: "id,caption,media_product_type,timestamp" });
  const list = res?.data?.data ?? res?.data?.response_data?.data ?? res?.data ?? [];
  const hit = (Array.isArray(list) ? list : []).find((m) => sameCaption(m.caption, item.caption) && new Date(m.timestamp) >= new Date(item.from) - 3600e3);
  return hit ? String(hit.id) : null;
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
  for (let attempt = 1; attempt <= 3 && !media; attempt++) {   // a fresh container on a retry, as PUBLISH_SLOT.md did
    // A publish whose answer was lost (a timeout after Instagram accepted it) must not post twice: before every
    // attempt, look for this exact caption among the newest posts and take that id if it is there.
    if (!dry) { media = await alreadyPosted(ig, item).catch(() => null); if (media) { console.log(`  already on Instagram: ${media}`); break; } }
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
    else if (cmd === "fb-caption") console.log(fbCaption((await pub()).caption, (await Bun.file(`${workDir()}/selection.json`).json().catch(() => ({}))).slug));
    else if (cmd === "reel") process.exit(await reel(Bun.argv[3] && !Bun.argv[3].startsWith("--") ? Bun.argv[3] : "auto", { dry }));
    else { console.error("usage: ig-publish.mjs accounts | carousel | story | verify | fb-carousel | fb-caption | reel [auto|reel|reel-2] [--dry-run]"); process.exit(64); }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
