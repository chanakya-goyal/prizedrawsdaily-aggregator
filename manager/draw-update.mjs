// Cowork/Claude helper: update one draw by id.
// Usage: bun manager/draw-update.mjs <id> '<json>'
//   <json> = columns to set, e.g. '{"prize_description":"...","status":"active"}'
//   To change category, pass {"category_id":"<uuid>"} (ids come from drafts-fetch output).
//   When YOU judged that category rather than a rule deriving it, stamp the provenance too:
//   {"category_id":"<uuid>","category_source":"claude"} — that is what stops the next scrape
//   overwriting your judgment with a keyword guess (see run.mjs's category write paths).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required — write).
import { rehostImage } from "../lib/rehost.mjs";

const SB = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const [, , id, json] = process.argv;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!id || !json) { console.error("usage: bun manager/draw-update.mjs <id> '<json>'"); process.exit(1); }

let body;
try { body = JSON.parse(json); } catch (e) { console.error("invalid JSON:", e.message); process.exit(1); }

const ALLOWED = new Set(["prize_description", "status", "category_id", "category_source", "title", "grand_prize", "image_url", "draw_date", "ticket_price", "total_entries", "total_prize_value", "featured"]);
const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
if (bad.length) { console.error("disallowed fields:", bad.join(", ")); process.exit(1); }

// category_source is provenance, not data, and the value decides whether the daily scrape may
// ever change this category again: 'rule' = machine-derived and re-checkable, 'claude' = judged
// from the page, 'manual' = human — the last two are immune to rule verdicts in run.mjs. A typo
// would therefore either strand a judgment as re-litigable or freeze a machine guess against
// correction, and the DB CHECK constraint would reject it as an opaque 400. Validate it here.
const CATEGORY_SOURCES = ["rule", "claude", "manual"];
if ("category_source" in body && !CATEGORY_SOURCES.includes(body.category_source)) {
  console.error(`category_source must be one of ${CATEGORY_SOURCES.join(", ")} — got ${JSON.stringify(body.category_source)}`);
  process.exit(1);
}

// If a fresh image_url is being set, re-host it onto our own Storage first (same reason as
// draw-insert: the live site proxies every image through weserv, which some hosts block).
if (body.image_url && /^https?:\/\//i.test(body.image_url) && !body.image_url.startsWith(SB)) {
  try {
    const [row] = await (await fetch(`${SB}/rest/v1/draws?id=eq.${id}&select=slug,operators(slug)`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
    if (row?.slug) {
      const res = await rehostImage(body.image_url, row.operators?.slug || "misc", row.slug, { supabaseUrl: SB, serviceKey: KEY });
      if (res.changed) { console.log(`🖼  re-hosted image [${res.via}]`); body.image_url = res.url; }
    }
  } catch (e) { console.log(`! re-host failed: ${(e.message || "").slice(0, 60)}`); }
}

const r = await fetch(`${SB}/rest/v1/draws?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify(body),
});
if (!r.ok) { console.error(`PATCH → ${r.status} ${await r.text()}`); process.exit(1); }
const [row] = await r.json();
console.log(`✅ updated ${id} → ${Object.keys(body).join(", ")}${row ? ` (status=${row.status})` : ""}`);
