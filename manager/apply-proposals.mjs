// Owner helper: apply the QA routine's proposed draw patches to the database.
// Usage (from your checkout, after `git pull`):
//   bun manager/apply-proposals.mjs                 # dry run: newest qa-proposals/* branch
//   APPLY=1 bun manager/apply-proposals.mjs         # write them
//   BRANCH=qa-proposals/2026-10-21 bun manager/apply-proposals.mjs
//   bun manager/apply-proposals.mjs path/to/file.jsonl
//
// The routine records patches with propose.mjs and pushes them on a `qa-proposals/<date>`
// branch (PROMPT.md step 4b). Every patch is validated again here with the same rules as
// draw-update.mjs, and a row that changed after the routine judged it is SKIPPED, never forced:
// the scraper or another run has newer evidence than the proposal. Nothing is written without
// APPLY=1. Applied branches are logged in manager/proposals/applied.log (git-ignored).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required — write).
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";
import { supabaseUrl } from "../lib/sb.mjs";
import { validatePatch, applyPatch, parseProposals, mergeProposals, staleKeys, blockedReason, isDrawId } from "./draw-patch.mjs";

const SB = supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const APPLY = process.env.APPLY === "1";
const LOG = "manager/proposals/applied.log";
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

// ---- 1. find the proposals ----
let source, text;
const arg = process.argv[2];
const applied = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").map((l) => l.split("\t")[0]).filter(Boolean) : [];
if (arg) {
  source = arg;
  text = readFileSync(arg, "utf8");
} else {
  // Passed as interpolations so Bun's shell neither globs the `*` nor parses the parentheses.
  const refspec = "+refs/heads/qa-proposals/*:refs/remotes/origin/qa-proposals/*";
  const fmt = "--format=%(refname:short)";
  await $`git fetch -q origin ${refspec}`.quiet().nothrow();
  const refs = (await $`git for-each-ref ${fmt} refs/remotes/origin/qa-proposals/`.text()).split("\n").filter(Boolean).sort();
  if (!refs.length) { console.log("No qa-proposals/* branch on origin — the routine has nothing waiting."); process.exit(0); }
  const ref = process.env.BRANCH ? `origin/${process.env.BRANCH}` : refs[refs.length - 1];
  if (!refs.includes(ref)) { console.error(`no such branch: ${ref}`); process.exit(1); }
  const files = (await $`git ls-tree --name-only ${ref} manager/proposals/`.text()).split("\n").filter((f) => f.endsWith(".jsonl"));
  if (!files.length) { console.error(`${ref} has no manager/proposals/*.jsonl`); process.exit(1); }
  source = ref;
  text = (await Promise.all(files.map((f) => $`git show ${ref}:${f}`.text()))).join("\n");
  const waiting = refs.filter((r) => r !== ref && !applied.includes(r));
  if (waiting.length) console.log(`ℹ️  older branches not applied from this machine: ${waiting.join(", ")} (BRANCH=… to apply one)\n`);
  if (applied.includes(ref)) console.log(`ℹ️  ${ref} was already applied from this machine; rows that changed since will show as stale.\n`);
}

const { items, errors: parseErrors } = parseProposals(text);
parseErrors.forEach((e) => console.log(`⚠️  unreadable ${e}`));
const proposals = mergeProposals(items.filter((p) => {
  if (isDrawId(p.id) && p.patch && typeof p.patch === "object") return true;
  console.log(`⚠️  malformed proposal skipped: ${JSON.stringify(p).slice(0, 120)}`);
  return false;
}));
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${proposals.length} draw(s) from ${source}\n`);
if (!proposals.length) process.exit(0);

// ---- 2. read the rows as they are now ----
const cols = new Set(["id", "status", "category_source"]);
proposals.forEach((p) => p.keys.forEach((k) => cols.add(k)));
const current = new Map();
for (let i = 0; i < proposals.length; i += 50) {
  const ids = proposals.slice(i, i + 50).map((p) => p.id).join(",");
  const r = await fetch(`${SB}/rest/v1/draws?id=in.(${ids})&select=${[...cols].join(",")}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { console.error(`read → ${r.status} ${await r.text()}`); process.exit(1); }
  for (const row of await r.json()) current.set(row.id, row);
}

// ---- 3. decide each one ----
const kind = (p) => {
  if (p.keys.includes("status")) return `status → ${p.patch.status}`;
  if (p.keys.includes("category_id")) return "category";
  if (p.keys.includes("free_entry_route")) return "free draw checked";
  if (p.keys.length === 1 && p.keys[0] === "prize_description") return "description";
  return "field fix";
};
const ready = [], skipped = [];
for (const p of proposals) {
  const row = current.get(p.id);
  const { body, errors } = validatePatch(p.patch);
  const why = errors.length ? errors.join("; ") : blockedReason(p, row) || (staleKeys(p, row).length ? `changed since proposed: ${staleKeys(p, row).join(", ")}` : null);
  (why ? skipped : ready).push({ p, body, why });
}

const counts = {};
ready.forEach(({ p }) => { counts[kind(p)] = (counts[kind(p)] || 0) + 1; });
for (const { p } of ready) {
  const shown = p.keys.map((k) => `${k}=${String(JSON.stringify(p.patch[k])).slice(0, 50)}`).join(" ");
  console.log(`✓ ${p.operator || "?"} / ${String(p.title || "").slice(0, 60)}\n    ${shown}\n    why: ${p.reasons.join(" | ").slice(0, 200) || "(no reason given)"}`);
}
for (const { p, why } of skipped) console.log(`⏭  ${p.operator || "?"} / ${String(p.title || "").slice(0, 60)} — ${why}`);
console.log(`\nReady: ${ready.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}) · skipped: ${skipped.length}`);

if (!APPLY) {
  console.log("\nNothing written. Read the list above, then run again with APPLY=1 in front.");
  process.exit(0);
}

// ---- 4. write ----
let ok = 0, failed = 0;
for (const { p, body } of ready) {
  try { await applyPatch(p.id, body, { base: SB, key: KEY }); ok++; }
  catch (e) { failed++; console.log(`✗ ${p.id}: ${e.message.slice(0, 160)}`); }
}
console.log(`\n✅ applied ${ok}${failed ? ` · ✗ failed ${failed}` : ""} · skipped ${skipped.length}`);
mkdirSync("manager/proposals", { recursive: true });
appendFileSync(LOG, `${source}\t${new Date().toISOString()}\tapplied=${ok}\tfailed=${failed}\tskipped=${skipped.length}\n`);
if (failed) process.exit(1);
