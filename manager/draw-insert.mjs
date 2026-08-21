// Cowork/Claude helper: insert ONE AI-extracted premium draw as a draft.
// Used for aiAssist operators (e.g. Dream Car) where Claude reads the page and supplies
// draw_date (and total_entries only if a max is published). Rules are relaxed vs the
// deterministic path: total_entries is OPTIONAL (these sites show only "% sold").
//
// Usage: bun manager/draw-insert.mjs '<json>'
//   json = { operator_slug, title, grand_prize, category, ticket_price, total_entries?,
//            draw_date (ISO), image_url, entry_url, prize_description?, category_source? }
//   `category` here is rule-derived (ai-fetch resolves it from the operator pin / keyword rules),
//   so `category_source` stays NULL unless you pass one — only state 'claude' when YOU judged the
//   category from the page. An explicit source is also the only thing that may overwrite the
//   category on a draft already stamped 'claude'/'manual'.
// Env: SUPABASE_SERVICE_ROLE_KEY (required).
import { schemaGate } from "../gate.mjs";
import { templateDescription } from "../lib/describe.mjs";
import { rehostImage } from "../lib/rehost.mjs";

const SB = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STATUS = process.env.PUBLISH_STATUS || "draft";
const WINDOW_DAYS = Number(process.env.AI_WINDOW_DAYS || 90); // premium draws have longer runways
const [, , json] = process.argv;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!json) { console.error("usage: bun manager/draw-insert.mjs '<json>'"); process.exit(1); }

let d;
try { d = JSON.parse(json); } catch (e) { console.error("invalid JSON:", e.message); process.exit(1); }

const isUrl = (u) => typeof u === "string" && /^https?:\/\/.+/i.test(u) && u.length <= 500;
const round2 = (n) => Math.round(n * 100) / 100;
const slugify = (s) => (s || "draw").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draw";

// Relaxed required-field check (NO total_entries).
const now = new Date();
const errs = [];
if (!d.title || !String(d.title).trim()) errs.push("title");
if (!(Number(d.ticket_price) > 0)) errs.push("ticket_price>0");
if (!isUrl(d.image_url)) errs.push("image_url");
if (!isUrl(d.entry_url)) errs.push("entry_url");
if (!d.draw_date || isNaN(new Date(d.draw_date).getTime())) errs.push("draw_date");
else {
  const dt = new Date(d.draw_date);
  if (dt < now) errs.push("draw_date in past");
  else if (dt > new Date(now.getTime() + WINDOW_DAYS * 864e5)) errs.push(`draw_date >${WINDOW_DAYS}d away`);
}
if (errs.length) { console.log(`⏭ skip (${(d.title || "?").slice(0, 40)}): ${errs.join(", ")}`); process.exit(0); }

const sbGet = async (p) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${p} ${r.status}`);
  return r.json();
};

// Map operator + category, dedup by entry_url.
const [op] = await sbGet(`operators?slug=eq.${encodeURIComponent(d.operator_slug)}&select=id`);
if (!op) { console.error(`unknown operator ${d.operator_slug}`); process.exit(1); }
const cats = await sbGet(`categories?select=id,slug`);
const category_id = cats.find((c) => c.slug === d.category)?.id || null;
// Provenance for that category — recorded ONLY when the caller states it. It is tempting to
// assume this tool's verdict is a judged one because Claude drives it, but the category field
// does not come from Claude: ai-fetch.mjs resolves it as `op.category || inferCategory(...)`
// (ai-fetch.mjs:117) — the operator pin and keyword rules, the same engine the scraper uses —
// before Claude reads the page at all. Stamping that 'claude' would certify a rule guess as
// judged and make it permanently immune to rule correction, so an unstated source stays null,
// which is what every other category writer in this repo does.
const CATEGORY_SOURCES = ["rule", "claude", "manual"];
if (d.category_source != null && !CATEGORY_SOURCES.includes(d.category_source)) {
  console.error(`category_source must be one of ${CATEGORY_SOURCES.join(", ")} — got ${JSON.stringify(d.category_source)}`);
  process.exit(1);
}
const category_source = category_id && d.category_source ? d.category_source : null;
const entries = Number.isFinite(Number(d.total_entries)) && Number(d.total_entries) > 0 ? Math.round(Number(d.total_entries)) : null;
const tpv = entries ? Math.min(round2(Number(d.ticket_price) * entries), 1_000_000_000) : null;

// Re-host the image onto our OWN Storage before writing, so the live site (which proxies
// every image through images.weserv.nl) never hotlinks a third-party host that blocks
// weserv's servers. Mirrors run.mjs; a fetch miss keeps the origin URL (never blocks).
const sb = { supabaseUrl: SB, serviceKey: KEY };
const imgPath = `${slugify(d.title).slice(0, 100)}-${d.operator_slug}`.slice(0, 120);
try {
  const res = await rehostImage(d.image_url, d.operator_slug, imgPath, sb);
  if (res.changed) { console.log(`🖼  re-hosted image [${res.via}]`); d.image_url = res.url; }
  else if (res.via === "miss") console.log(`⚠️ image unreachable, kept origin`);
} catch (e) { console.log(`! re-host failed: ${(e.message || "").slice(0, 60)}`); }

// If this entry_url already exists: refresh the data on a DRAFT row (self-heals earlier
// wrong/missing fields); never touch a published/ended row.
const dup = await sbGet(`draws?entry_url=eq.${encodeURIComponent(d.entry_url)}&select=id,status,category_id,category_source`);
if (dup.length) {
  const ex = dup[0];
  if (ex.status !== "draft") { console.log(`⏭ exists & ${ex.status}; left alone: ${d.title.slice(0, 40)}`); process.exit(0); }
  const patch = { total_entries: entries, total_prize_value: tpv, draw_date: d.draw_date, ticket_price: round2(Number(d.ticket_price)), image_url: d.image_url, grand_prize: d.grand_prize || d.title };
  // Same immunity run.mjs applies on its refresh path: a claude/manual category was judged, not
  // derived, so the rule-resolved verdict arriving here must never revert it — that would undo a
  // human decision AND silently re-certify the guess that replaced it. Only an EXPLICIT source in
  // the incoming JSON may supersede one.
  const judged = ["claude", "manual"].includes(ex.category_source);
  if (category_id && (!judged || d.category_source)) { patch.category_id = category_id; patch.category_source = category_source; }
  else if (category_id && judged) console.log(`↩︎ kept judged category (source=${ex.category_source}) — pass category_source explicitly to override`);
  if (d.prize_description) patch.prize_description = d.prize_description;
  const ur = await fetch(`${SB}/rest/v1/draws?id=eq.${ex.id}`, { method: "PATCH", headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  if (!ur.ok) { console.error(`UPDATE ${ur.status} ${await ur.text()}`); process.exit(1); }
  console.log(`♻️ refreshed draft: ${d.title.slice(0, 46)} | entries=${entries ?? "—"} | ${d.draw_date.slice(0, 10)}`);
  process.exit(0);
}

// Stable slug (title + operator slug), collision-suffixed against existing.
const taken = new Set((await sbGet(`draws?select=slug`)).map((x) => x.slug));
const base = `${slugify(d.title).slice(0, 100)}-${d.operator_slug}`.slice(0, 120);
let slug = base, i = 2;
while (taken.has(slug)) slug = `${base}-${i++}`.slice(0, 120);

const draw = {
  slug, operator_id: op.id, category_id, category_source,
  title: d.title, grand_prize: d.grand_prize || d.title,
  prize_description: d.prize_description || null,
  image_url: d.image_url, ticket_price: round2(Number(d.ticket_price)),
  total_entries: entries,
  total_prize_value: tpv,
  prize_value: null, draw_date: d.draw_date, entry_url: d.entry_url,
  affiliate_url: null, status: STATUS, featured: false,
};
const { draw: clean, ok, violations } = schemaGate(draw);
if (!ok) { console.log(`⏭ schema (${d.title.slice(0, 40)}): ${violations.join(", ")}`); process.exit(0); }
if (!clean.prize_description) clean.prize_description = templateDescription(clean);

const r = await fetch(`${SB}/rest/v1/draws`, {
  method: "POST",
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify([clean]),
});
if (!r.ok) { console.error(`INSERT ${r.status} ${await r.text()}`); process.exit(1); }
console.log(`✅ inserted [${STATUS}] ${clean.title.slice(0, 50)} | ${clean.category_id ? d.category : "no-cat"} | £${clean.ticket_price}${entries ? "×" + entries : ""} | ${clean.draw_date.slice(0, 10)}`);
