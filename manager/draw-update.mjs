// Cowork/Claude helper: update one draw by id.
// Usage: bun manager/draw-update.mjs <id> '<json>'
//   <json> = columns to set, e.g. '{"prize_description":"...","status":"active"}'
//   To change category, pass {"category_id":"<uuid>"} (ids come from drafts-fetch output).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required — write).
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const [, , id, json] = process.argv;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!id || !json) { console.error("usage: bun manager/draw-update.mjs <id> '<json>'"); process.exit(1); }

let body;
try { body = JSON.parse(json); } catch (e) { console.error("invalid JSON:", e.message); process.exit(1); }

const ALLOWED = new Set(["prize_description", "status", "category_id", "title", "grand_prize", "image_url", "draw_date", "ticket_price", "total_entries", "total_prize_value", "featured"]);
const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
if (bad.length) { console.error("disallowed fields:", bad.join(", ")); process.exit(1); }

const r = await fetch(`${SB}/rest/v1/draws?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify(body),
});
if (!r.ok) { console.error(`PATCH → ${r.status} ${await r.text()}`); process.exit(1); }
const [row] = await r.json();
console.log(`✅ updated ${id} → ${Object.keys(body).join(", ")}${row ? ` (status=${row.status})` : ""}`);
