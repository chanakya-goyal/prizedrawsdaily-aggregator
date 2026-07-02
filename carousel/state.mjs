// carousel/state.mjs — durable post/metric state in Supabase (spec §4.2).
// Writes need SUPABASE_SERVICE_ROLE_KEY; reads fall back to the publishable key.
import { GLOBAL } from "./config.mjs";
import { withRetry, fetchOk } from "./util.mjs";

const URL_ = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || GLOBAL.supabasePublishableKey;

let _fetch = fetch;
export const _setFetch = (f) => { _fetch = f; };

const hdrs = (extra = {}) => ({ apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...extra });

async function rest(path, init = {}, label = "state") {
  return withRetry(async () => {
    const r = await _fetch(`${URL_}/rest/v1/${path}`, init);
    if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }, { label });
}

export const todayLondon = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

export async function upsertPost(row) {
  return rest(`carousel_posts?on_conflict=${encodeURIComponent("date,format")}`, {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  }, "upsertPost");
}

export async function markStatus(date, format, status, patch = {}) {
  const body = { status, updated_at: new Date().toISOString(), ...patch };
  if (status === "published" && !body.posted_at) body.posted_at = new Date().toISOString();
  return rest(`carousel_posts?date=eq.${date}&format=eq.${format}`, {
    method: "PATCH", headers: hdrs({ Prefer: "return=minimal" }), body: JSON.stringify(body),
  }, "markStatus");
}

export async function getPost(date, format) {
  const rows = await rest(`carousel_posts?date=eq.${date}&format=eq.${format}&limit=1`, { headers: hdrs() }, "getPost");
  return rows?.[0] || null;
}

export async function recentPosts(days) {
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  return (await rest(`carousel_posts?date=gte.${since}&order=date.desc`, { headers: hdrs() }, "recentPosts")) || [];
}

export async function recentDrawSlugs(days = 7) {
  const rows = await recentPosts(days);
  return [...new Set(rows.flatMap((r) => r.draw_slugs || []))];
}

export async function lastCategory() {
  const rows = await recentPosts(3);
  return rows.find((r) => r.category)?.category || null;
}

export async function insertMetrics(rows) {
  if (!rows?.length) return null;
  return rest(`carousel_metrics?on_conflict=${encodeURIComponent("day,media_id,metric")}`, {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  }, "insertMetrics");
}
