// Read-only. Lists DRAFTS held on their category: a rule-set category the prize text contradicts,
// or a car/house category whose pool is under £5k. These rows already have a category_id, so the
// null-category pass (PROMPT step 2b) never sees them, and nothing else ever releases them —
// measured 2026-10-19 at ~120 drafts. A Claude/manual judgment is checked as stored by the
// publish gate (lib/verify.mjs), so stamping the RIGHT category is what lets them publish.
// Usage: bun manager/category-held.mjs            # JSON for the routine
//        LIMIT=40 bun manager/category-held.mjs   # oldest first
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Never writes.
import { sbGetAll, supabaseUrl } from "../lib/sb.mjs";
import { categoryHoldReasons } from "../lib/manager.mjs";

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const LIMIT = Number(process.env.LIMIT || 60);
const base = supabaseUrl();
const nowIso = new Date().toISOString();

const cats = await sbGetAll("categories?select=id,slug&order=slug", { key: KEY, base });
const slugById = Object.fromEntries(cats.map((c) => [c.id, c.slug]));
// Judged rows (claude/manual) are excluded: never re-litigate a judgment (PROMPT step 2b rule).
const drafts = await sbGetAll(
  `draws?status=eq.draft&category_id=not.is.null&or=(category_source.is.null,category_source.eq.rule)&draw_date=gte.${nowIso}&order=created_at.asc` +
  "&select=id,title,grand_prize,entry_url,image_url,ticket_price,total_entries,prize_description,category_id,category_source,created_at,operator:operators(slug)",
  { key: KEY, base },
);
const held = [];
for (const d of drafts) {
  const reasons = categoryHoldReasons(d, slugById[d.category_id]);
  if (reasons.length) held.push({ id: d.id, operator: d.operator?.slug, title: d.title, grand_prize: d.grand_prize, entry_url: d.entry_url, image_url: d.image_url, ticket_price: d.ticket_price, total_entries: d.total_entries, stored_category: slugById[d.category_id], reasons });
}
const categories = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
console.log(JSON.stringify({ categories, total: held.length, count: Math.min(held.length, LIMIT), draws: held.slice(0, LIMIT) }, null, 2));
