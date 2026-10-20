// QA routine helper: record ONE draw patch for the owner to apply, instead of writing it.
// Usage: bun manager/propose.mjs <id> '<json>' '<reason>'
//   Same <json> as draw-update.mjs, checked by the same rules (draw-patch.mjs). <reason> is one
//   line of evidence the owner reads before applying ("page says £2.50", "LEGO set → collectibles").
//
// Why this exists: since 2026-10-16 the routine's cloud classifier denies every database write,
// and a repo .claude/settings.json allow rule is not honoured there (tested 2026-10-21). So the
// routine only READS the database and appends its patches to
//   manager/proposals/<YYYY-MM-DD>.jsonl
// with the row's current values for each field it touches. It then pushes that file on a branch
// (PROMPT.md step 4b) and the owner runs apply-proposals.mjs, which re-validates every patch and
// skips any row that changed after it was judged.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read only here).
import { mkdirSync, appendFileSync } from "node:fs";
import { supabaseUrl } from "../lib/sb.mjs";
import { validatePatch, isDrawId } from "./draw-patch.mjs";

const SB = supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const [, , id, json, reason = ""] = process.argv;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!id || !json) { console.error("usage: bun manager/propose.mjs <id> '<json>' '<reason>'"); process.exit(1); }
if (!isDrawId(id)) { console.error(`not a draw id: ${id}`); process.exit(1); }

let input;
try { input = JSON.parse(json); } catch (e) { console.error("invalid JSON:", e.message); process.exit(1); }
const { body, errors } = validatePatch(input);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

const keys = Object.keys(input);
const select = ["id", "title", "status", "category_source", ...keys].filter((k, i, a) => a.indexOf(k) === i).join(",");
const r = await fetch(`${SB}/rest/v1/draws?id=eq.${id}&select=${select},operator:operators(slug)`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
if (!r.ok) { console.error(`read → ${r.status} ${await r.text()}`); process.exit(1); }
const [row] = await r.json();
if (!row) { console.error(`draw not found: ${id}`); process.exit(1); }

const before = Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
// apply-proposals.mjs refuses to overwrite a category someone judged after this proposal, so it
// needs the provenance the routine saw even when only category_id is being set.
if (keys.includes("category_id") && !("category_source" in before)) before.category_source = row.category_source ?? null;
const now = new Date();
const day = now.toISOString().slice(0, 10);
const entry = { id, title: row.title, operator: row.operator?.slug || null, patch: body, keys, before, reason, proposed_at: now.toISOString() };
mkdirSync("manager/proposals", { recursive: true });
appendFileSync(`manager/proposals/${day}.jsonl`, JSON.stringify(entry) + "\n");
console.log(`📝 proposed ${id} (${row.operator?.slug || "?"} / ${row.title}) → ${keys.join(", ")}`);
