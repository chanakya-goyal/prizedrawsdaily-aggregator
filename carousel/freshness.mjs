// carousel/freshness.mjs — dead-man's-switch check (spec §4.10). Anon-readable.
// Run anywhere: bun carousel/freshness.mjs   (exit 0 = fresh, 1 = stale)
import { GLOBAL } from "./config.mjs";
const KEY = GLOBAL.supabasePublishableKey;
try {
  const r = await fetch(`${GLOBAL.supabaseUrl}/rest/v1/carousel_posts?status=eq.published&order=posted_at.desc&limit=1`,
    { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  const [last] = r.ok ? await r.json() : [];
  if (!last?.posted_at) { console.log("STALE — no published posts recorded yet"); process.exit(1); }
  const hours = (Date.now() - new Date(last.posted_at).getTime()) / 3600000;
  if (hours > 36) { console.log(`STALE ${hours.toFixed(0)}h since last post (${last.date}) — streak at risk, say "publish today"`); process.exit(1); }
  console.log(`OK last post ${last.date} (${hours.toFixed(1)}h ago)`);
} catch (e) {
  console.log(`STALE — freshness check failed: ${e?.message || e}`);
  process.exit(1);
}
