// Fetch live draws closing within N days and pick the strongest category.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";

export const CATEGORIES = ["car-draws", "cash-prizes", "house-draws", "tech-giveaways", "luxury", "collectibles"];

// minDays = a runway floor: never feature a draw closing sooner than this (so a post
// stays relevant and followers have time to enter). days = the upper bound.
export async function fetchEndingSoon(days = 7, minDays = 0) {
  const from = new Date(Date.now() + minDays * 86400000).toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();
  const u = new URL(SUPABASE_URL + "/rest/v1/draws");
  u.searchParams.set("select",
    "slug,title,grand_prize,prize_description,image_url,ticket_price,total_prize_value,total_entries,draw_date,entry_url,categories(slug,name),operators(name)");
  u.searchParams.set("status", "eq.active");
  u.searchParams.append("draw_date", "gte." + from);
  u.searchParams.append("draw_date", "lte." + end);
  u.searchParams.set("image_url", "not.is.null");
  u.searchParams.set("order", "draw_date.asc");
  u.searchParams.set("limit", "300");
  const r = await fetch(u, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  if (!r.ok) throw new Error("Supabase fetch failed: " + r.status + " " + (await r.text()).slice(0, 200));
  return await r.json();
}

// Visual suitability for a clean-product carousel (cash is abstract → deprioritised).
const VISUAL_WEIGHT = {
  "luxury": 1.0, "car-draws": 1.0, "tech-giveaways": 0.92,
  "collectibles": 0.85, "house-draws": 0.8, "cash-prizes": 0.4, "other": 0.6,
};

// Score each category: needs enough draws to fill the carousel, weighted by visual fit,
// tiebroken by total prize value. Requires >=3 draws unless nothing else qualifies.
export function pickBestCategory(draws, n = 5, onlySlug = null) {
  const by = {};
  for (const d of draws) {
    const s = d.categories?.slug || "other";
    if (onlySlug && s !== onlySlug) continue;
    (by[s] ||= []).push(d);
  }
  let best = null;
  for (const [slug, list] of Object.entries(by)) {
    const w = VISUAL_WEIGHT[slug] ?? 0.6;
    const value = list.reduce((a, d) => a + (Number(d.total_prize_value) || 0), 0);
    const enough = list.length >= Math.min(3, n) ? 1 : 0;
    const score = enough * 1e12 + w * Math.min(list.length, n) * 1e9 + value;
    if (!best || score > best.score) best = { slug, score, list };
  }
  if (!best) return null;
  return {
    slug: best.slug, name: best.list[0].categories?.name || best.slug, count: best.list.length,
    draws: best.list.slice(0, n),
    pool: best.list, // full ordered category list (for backups / swaps)
  };
}
