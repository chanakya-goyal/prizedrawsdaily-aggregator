// carousel/freshness.mjs — dead-man's-switch check (spec §4.10).
// Run anywhere: bun carousel/freshness.mjs   (exit 0 = fresh, 1 = stale or unreadable)
//
// It read GLOBAL.supabasePublishableKey, which has been "" since the Aug-2026 Supabase move, so every
// request 401'd and the check printed "no published posts recorded yet" whatever the truth — it said
// STALE sixty seconds after a verified live post. It now takes the key the rest of the state code
// uses, and an unreadable state says so instead of posing as an empty one.
import { GLOBAL } from "./config.mjs";
import { supabaseUrl } from "../lib/sb.mjs";

export const STALE_HOURS = 36;

export const keyFrom = (env = process.env, global = GLOBAL) =>
  env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || global.supabasePublishableKey || "";

export function verdict(last, now = Date.now(), staleHours = STALE_HOURS) {
  if (!last?.posted_at) return { ok: false, line: "STALE — no published post recorded" };
  const hours = (now - new Date(last.posted_at).getTime()) / 3600000;
  if (hours > staleHours) return { ok: false, line: `STALE ${hours.toFixed(0)}h since last post (${last.date})` };
  return { ok: true, line: `OK last post ${last.date} (${hours.toFixed(1)}h ago)` };
}

if (import.meta.main) {
  const KEY = keyFrom();
  try {
    if (!KEY) throw new Error("no Supabase key in the environment (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY)");
    const r = await fetch(`${supabaseUrl()}/rest/v1/carousel_posts?format=eq.carousel&status=eq.published&order=posted_at.desc&limit=1`,
      { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
    if (!r.ok) throw new Error(`state unreadable (HTTP ${r.status})`);
    const [last] = await r.json();
    const v = verdict(last, Date.now(), Number(process.env.STALE_HOURS) || STALE_HOURS);
    console.log(v.line);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.log(`UNKNOWN — freshness check failed: ${e?.message || e}`);
    process.exit(1);
  }
}
