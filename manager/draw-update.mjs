// Cowork/Claude helper: update one draw by id.
// Usage: bun manager/draw-update.mjs <id> '<json>'
//   <json> = columns to set, e.g. '{"prize_description":"..."}' — status may only be
//   draft / ended / rejected: publishing is the verify gate's job, never this script's.
//   To change category, pass {"category_id":"<uuid>"} (ids come from drafts-fetch output).
//   When YOU judged that category rather than a rule deriving it, stamp the provenance too:
//   {"category_id":"<uuid>","category_source":"claude"} — that is what stops the next scrape
//   overwriting your judgment with a keyword guess (see run.mjs's category write paths).
// The rules for what a patch may contain live in draw-patch.mjs, shared with propose.mjs and
// apply-proposals.mjs (the QA routine proposes; the owner applies).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required — write).
import { supabaseUrl } from "../lib/sb.mjs";
import { validatePatch, applyPatch } from "./draw-patch.mjs";

const SB = supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const [, , id, json] = process.argv;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!id || !json) { console.error("usage: bun manager/draw-update.mjs <id> '<json>'"); process.exit(1); }

let input;
try { input = JSON.parse(json); } catch (e) { console.error("invalid JSON:", e.message); process.exit(1); }

const { body, errors } = validatePatch(input);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

try {
  const row = await applyPatch(id, body, { base: SB, key: KEY });
  console.log(`✅ updated ${id} → ${Object.keys(body).join(", ")}${row ? ` (status=${row.status})` : ""}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
