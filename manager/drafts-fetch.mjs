// Cowork/Claude helper: print draft draws (+ category slug→id map) as JSON.
// Usage: bun manager/drafts-fetch.mjs            # all current drafts
//        LIMIT=50 bun manager/drafts-fetch.mjs   # cap
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_PUBLISHABLE_KEY for read).
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
const LIMIT = Number(process.env.LIMIT || 200);
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY"); process.exit(1); }

const get = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { console.error(`GET ${path} → ${r.status} ${await r.text()}`); process.exit(1); }
  return r.json();
};

const cats = await get("categories?select=id,slug");
const categories = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
const draws = await get(
  "draws?status=eq.draft&order=created_at.desc&limit=" + LIMIT +
  "&select=id,slug,title,grand_prize,prize_description,image_url,ticket_price,total_entries,total_prize_value,draw_date,entry_url,category_id,operator:operators(slug,name),category:categories(slug)"
);

console.log(JSON.stringify({ categories, count: draws.length, draws }, null, 2));
