// The one place that decides what a single-draw patch may contain, shared by draw-update.mjs
// (writes now), propose.mjs (the QA routine records a patch) and apply-proposals.mjs (the owner
// applies the routine's patches). Before 2026-10-21 these rules lived only in draw-update.mjs;
// the routine's cloud classifier now denies its database writes, so the same patch has to be
// checked twice — once when proposed, again when applied — and two copies would drift.
import { rehostImage } from "../lib/rehost.mjs";

export const ALLOWED = new Set(["prize_description", "status", "category_id", "category_source", "title", "grand_prize", "image_url", "draw_date", "ticket_price", "total_entries", "total_prize_value", "featured", "figures_source_url", "figures_checked_at", "total_entries_method", "free_entry_route"]);

// category_source is provenance, not data, and the value decides whether the daily scrape may
// ever change this category again: 'rule' = machine-derived and re-checkable, 'claude' = judged
// from the page, 'manual' = human — the last two are immune to rule verdicts in run.mjs. A typo
// would therefore either strand a judgment as re-litigable or freeze a machine guess against
// correction, and the DB CHECK constraint would reject it as an opaque 400. Validate it here.
export const CATEGORY_SOURCES = ["rule", "claude", "manual"];

// total_entries_method is the same kind of thing for the same reason, and it decides whether
// the carousel may render an odds figure from this row at all. Validate it here rather than
// letting the DB CHECK return an opaque 400 — and note that an agent editing a cap by hand is
// 'agent-read', never the method the scraper would have used. Guessing a provenance we did not
// observe is worse than recording none.
export const ENTRIES_METHODS = ["operator-pattern", "labelled-cap", "derived-sum", "progress-bar", "bare-count", "agent-read", "manual"];
export const FREE_ENTRY_ROUTES = ["postal", "online-free", "none-stated", "unknown"];

// The routine never publishes (PROMPT.md rule 1); draft→active belongs to the verify gate.
// 'rejected' (2026-10-14) permanently hides a £0 draw whose page states a catch: existing.mjs
// still loads it, so run.mjs never re-inserts the URL, and route.mjs skips every status but
// active/draft/ended. The site only ever shows active and ended rows.
export const STATUSES = ["draft", "ended", "rejected"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDrawId = (id) => typeof id === "string" && UUID.test(id);

// Returns { body, errors }. `body` is a copy with the provenance stamps added; the input is
// never mutated. Any error means the patch must not be written.
export function validatePatch(input, { now = new Date() } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { body: null, errors: ["patch must be a JSON object"] };
  const body = { ...input };
  const keys = Object.keys(body);
  if (!keys.length) errors.push("patch is empty");
  const bad = keys.filter((k) => !ALLOWED.has(k));
  if (bad.length) errors.push(`disallowed fields: ${bad.join(", ")}`);
  if ("category_source" in body && !CATEGORY_SOURCES.includes(body.category_source)) {
    errors.push(`category_source must be one of ${CATEGORY_SOURCES.join(", ")} — got ${JSON.stringify(body.category_source)}`);
  }
  if ("total_entries_method" in body && body.total_entries_method !== null && !ENTRIES_METHODS.includes(body.total_entries_method)) {
    errors.push(`total_entries_method must be one of ${ENTRIES_METHODS.join(", ")} (or null) — got ${JSON.stringify(body.total_entries_method)}`);
  }
  if ("free_entry_route" in body && !FREE_ENTRY_ROUTES.includes(body.free_entry_route)) {
    errors.push(`free_entry_route must be one of ${FREE_ENTRY_ROUTES.join(", ")} — got ${JSON.stringify(body.free_entry_route)}`);
  }
  if ("status" in body && !STATUSES.includes(body.status)) {
    errors.push(`status must be one of ${STATUSES.join(", ")} — got ${JSON.stringify(body.status)}`);
  }
  // Changing total_entries by hand without saying so would leave the row wearing whatever
  // provenance the scraper last wrote — a method describing a number that is no longer there.
  if ("total_entries" in body && !("total_entries_method" in body)) {
    body.total_entries_method = "agent-read";
    body.figures_checked_at = now.toISOString();
  }
  return { body: errors.length ? null : body, errors };
}

// Writes one validated patch. Re-hosts a fresh image_url onto our own storage first (same
// reason as draw-insert: the live site proxies every image through weserv, which some hosts
// block). Returns the updated row; throws on a failed PATCH.
export async function applyPatch(id, body, { base, key, fetchImpl = fetch, log = console.log } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const out = { ...body };
  if (out.image_url && /^https?:\/\//i.test(out.image_url) && !out.image_url.startsWith(base)) {
    try {
      const [row] = await (await fetchImpl(`${base}/rest/v1/draws?id=eq.${id}&select=slug,operators(slug)`, { headers })).json();
      if (row?.slug) {
        const res = await rehostImage(out.image_url, row.operators?.slug || "misc", row.slug, { supabaseUrl: base, serviceKey: key });
        if (res.changed) { log(`🖼  re-hosted image [${res.via}]`); out.image_url = res.url; }
      }
    } catch (e) { log(`! re-host failed: ${(e.message || "").slice(0, 60)}`); }
  }
  const r = await fetchImpl(`${base}/rest/v1/draws?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(out),
  });
  if (!r.ok) throw new Error(`PATCH → ${r.status} ${await r.text()}`);
  const [row] = await r.json();
  return row;
}

// ---------- proposals (routine proposes, owner applies) ----------

// One proposal per JSONL line: { id, title, operator, patch, keys, before, reason, proposed_at }.
// `keys` are the fields the routine chose to set (before validatePatch added provenance stamps);
// `before` holds the row's values for those keys when the routine judged it.
export function parseProposals(text) {
  const items = [];
  const errors = [];
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try { items.push(JSON.parse(t)); } catch (e) { errors.push(`line ${i + 1}: ${e.message}`); }
  });
  return { items, errors };
}

// Several proposals for one draw (e.g. a category stamp in 2b and a description in step 3)
// fold into one patch. A later proposal wins a clashing field; its `before` is kept from the
// first sighting, because that is the state the routine actually judged.
export function mergeProposals(items) {
  const byId = new Map();
  for (const p of items) {
    const cur = byId.get(p.id);
    if (!cur) { byId.set(p.id, { ...p, patch: { ...p.patch }, keys: [...(p.keys || Object.keys(p.patch || {}))], before: { ...(p.before || {}) }, reasons: [p.reason].filter(Boolean) }); continue; }
    Object.assign(cur.patch, p.patch);
    for (const k of p.keys || Object.keys(p.patch || {})) {
      if (!cur.keys.includes(k)) { cur.keys.push(k); if (p.before && k in p.before) cur.before[k] = p.before[k]; }
    }
    if (p.reason) cur.reasons.push(p.reason);
  }
  return [...byId.values()];
}

// A proposal is stale when the row moved after the routine judged it: the scraper rewrote a
// field, another run already stamped it, or the draw ended. Applying anyway would overwrite
// newer evidence with an older judgment, so a stale proposal is skipped, never forced.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function staleKeys(proposal, current) {
  return (proposal.keys || []).filter((k) => proposal.before && k in proposal.before && !same(proposal.before[k], current?.[k]));
}

// Category judgments carry an extra rule from PROMPT.md 2b: never overwrite a human's category,
// nor one Claude judged after this proposal was made. Checked against the CURRENT row.
export function blockedReason(proposal, current) {
  if (!current) return "draw not found";
  const touchesCategory = proposal.keys.includes("category_id") || proposal.keys.includes("category_source");
  // A human's category is final for the routine (PROMPT.md 2b), even if it was already there
  // when the routine judged the row.
  if (touchesCategory && current.category_source === "manual") return "category was set by hand (manual)";
  if (touchesCategory && ["claude", "manual"].includes(current.category_source) && !same(proposal.before?.category_source, current.category_source)) {
    return `category already judged (${current.category_source}) since the proposal`;
  }
  return null;
}
