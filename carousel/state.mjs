// carousel/state.mjs — durable post/metric state in Supabase (spec §4.2).
// Writes need SUPABASE_SERVICE_ROLE_KEY; reads fall back to the publishable key.
import { GLOBAL } from "./config.mjs";
import { withRetry } from "./util.mjs";

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
  const rows = await rest(`carousel_posts?date=eq.${date}&format=eq.${format}`, {
    method: "PATCH", headers: hdrs({ Prefer: "return=representation" }), body: JSON.stringify(body),
  }, "markStatus");
  if (!rows || rows.length === 0) console.error(`⚠ markStatus matched NO row for ${date}/${format} — nothing recorded`);
  return rows;
}

export async function getPost(date, format) {
  const rows = await rest(`carousel_posts?date=eq.${date}&format=eq.${format}&limit=1`, { headers: hdrs() }, "getPost");
  return rows?.[0] || null;
}

export async function recentPosts(days) {
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  return (await rest(`carousel_posts?date=gte.${since}&order=date.desc`, { headers: hdrs() }, "recentPosts")) || [];
}

export async function recentMetrics(days) {
  const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  return (await rest(`carousel_metrics?day=gte.${since}&order=day.desc`, { headers: hdrs() }, "recentMetrics")) || [];
}

export async function recentDrawSlugs(days = 7) {
  const rows = await recentPosts(days);
  return [...new Set(rows.flatMap((r) => r.draw_slugs || []))];
}

export async function lastCategory() {
  const rows = await recentPosts(3);
  return rows.find((r) => r.category)?.category || null;
}

// ⚠ THE UPSERT KEY IS HALF OF A TWO-PLACE CHANGE. The other half is the primary key in
// migrations/0003-instrumentation.sql. `window` is in the key because reach and views keep
// accruing for days: without it the last capture silently overwrites the first, and a post's 12
// views at 6 hours are indistinguishable from 12 views at 6 days. Changing the DDL without this
// line, or this line without the DDL, reverts to last-write-wins — which is the defect, not a
// degraded version of the fix. So a key mismatch fails LOUDLY and names the remedy rather than
// falling back to the old key, because a silent fallback would look exactly like success.
const METRICS_KEY = "day,media_id,metric,window";

export async function insertMetrics(rows) {
  if (!rows?.length) return null;
  // Every row carries the three provenance columns. A row without them is a row that cannot be
  // read back later, so they are defaulted here rather than left to each caller.
  const stamped = rows.map((r) => ({ source: "api", window: "legacy", age_hours: null, ...r }));
  try {
    return await rest(`carousel_metrics?on_conflict=${encodeURIComponent(METRICS_KEY)}`, {
      method: "POST",
      headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(stamped),
    }, "insertMetrics");
  } catch (e) {
    const m = String(e?.message || e);
    if (/window|on_conflict|42703|PGRST/i.test(m)) {
      throw new Error(
        `insertMetrics refused on the upsert key "${METRICS_KEY}".\n` +
        `  This is almost certainly migrations/0003-instrumentation.sql not yet applied.\n` +
        `  Paste it into Supabase \u2192 SQL editor, then re-run. Nothing was written.\n  Underlying: ${m}`);
    }
    throw e;
  }
}

// The retention curve, hand-transcribed from Instagram's own professional insights (Channel B).
// No Graph API field returns it, so the spec must not pretend otherwise: source is always 'app'
// and every row carries an archived screenshot in evidence_url.
export async function insertCurve({ day, media_id, kind = "reel_retention", points, evidence_url = null }) {
  if (!Array.isArray(points) || !points.length) throw new Error("insertCurve: points must be a non-empty array");
  // The 3-second reading is mandatory, not conventional: "watch under 3 seconds" is a named input
  // to the abandonment prediction head, so a curve without it cannot answer the question it is for.
  if (!points.some((pt) => Number(pt?.t_ms) === 3000)) {
    throw new Error("insertCurve: points must include an explicit reading at t_ms = 3000");
  }
  return rest(`carousel_curves?on_conflict=${encodeURIComponent("day,media_id,kind")}`, {
    method: "POST",
    headers: hdrs({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ day, media_id, kind, points, source: "app", evidence_url }]),
  }, "insertCurve");
}
