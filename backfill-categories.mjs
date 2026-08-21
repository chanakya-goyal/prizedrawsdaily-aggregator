// One-off (re-runnable, idempotent) category backfill. Three modes:
//   MODE=rules  [DRY_RUN=true|false]  — apply rule/pin verdicts + stamp category_source; also
//                                        clears a draft's stale null-sourced guess when its title
//                                        now yields no rule evidence (the one sanctioned nulling)
//   MODE=export                        — write backfill-unknowns.json (active rows Claude must judge)
//   MODE=apply DECISIONS=<file> [DRY_RUN] — apply {id → category} judgments as category_source='claude'
// Never touches status. Every category CHANGE is logged old→new to backfill-log-<ts>.json (stamps have no delta to revert).
import { readFileSync, writeFileSync } from "fs";
import { resolveCategory } from "./lib/parse.mjs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const DRY = process.env.DRY_RUN !== "false";

export function decideRuleFix(d, opsBySlug, catBySlug) {
  if (["claude", "manual"].includes(d.category_source)) return { action: "skip" };
  const op = opsBySlug[d.op_slug] || {};
  const verdict = resolveCategory({ op, title: d.title, grand_prize: d.grand_prize, url: d.entry_url, apiCategories: [] });
  if (verdict && catBySlug[verdict]) {
    return verdict === d.category_slug
      ? { action: "stamp", category: verdict, source: "rule" }
      : { action: "fix", category: verdict, source: "rule" };
  }
  if (d.status === "active") return { action: "export" };
  // A pre-existing DRAFT row carrying an old fallback-GUESSED category (category_source null)
  // whose title now yields NO rule evidence would keep its guess, publish via the second-
  // observation gate (stored category satisfies hasStoredCategory), and then be invisible to
  // backfill/2b/patrol forever. Clear it — this is the ONE sanctioned category-nulling: it
  // converts a silent guess into a held draft that the daily cowork step 2b will judge before
  // it can ever publish.
  if (d.status === "draft" && verdict == null && d.category_source == null && d.category_slug != null) {
    return { action: "clear" };
  }
  return { action: "skip" };
}

async function fetchAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function patch(id, body) {
  if (DRY) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/draws?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify(body) });
  if (!r.ok) console.error(`  ✗ ${id}: HTTP ${r.status} ${await r.text()}`);
  return r.ok;
}

if (import.meta.main) {
  const MODE = process.env.MODE || "rules";
  const VALID_MODES = ["rules", "export", "apply"];
  if (!VALID_MODES.includes(MODE)) {
    console.error(`✗ unknown MODE '${MODE}' — expected one of: ${VALID_MODES.join(", ")}`);
    process.exit(1);
  }
  const opsRaw = JSON.parse(readFileSync(new URL("./operators.json", import.meta.url), "utf8"));
  const opsBySlug = Object.fromEntries((Array.isArray(opsRaw) ? opsRaw : opsRaw.operators).map((o) => [o.slug, o]));
  const cats = await fetchAll("categories?select=id,slug");
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const draws = (await fetchAll("draws?select=id,title,grand_prize,entry_url,status,category_source,categories(slug),operators(slug)&status=in.(active,draft,ended)&order=id"))
    .map((d) => ({ ...d, category_slug: d.categories?.slug ?? null, op_slug: d.operators?.slug ?? null }));
  console.log(`${draws.length} draws · mode=${MODE} · DRY_RUN=${DRY}`);
  const log = [];

  if (MODE === "rules") {
    let fixed = 0, stamped = 0, cleared = 0, exported = 0, skipped = 0;
    for (const d of draws) {
      const v = decideRuleFix(d, opsBySlug, catBySlug);
      if (v.action === "fix") {
        const ok = await patch(d.id, { category_id: catBySlug[v.category], category_source: v.source });
        if (ok) { fixed++; log.push({ id: d.id, title: d.title, from: d.category_slug, to: v.category, source: v.source }); }
      } else if (v.action === "stamp") {
        if (await patch(d.id, { category_source: v.source })) stamped++;
      } else if (v.action === "clear") {
        // The ONE sanctioned category-nulling: converts a silent guess into a held draft that
        // the daily cowork step 2b will judge before it can ever publish.
        const ok = await patch(d.id, { category_id: null, category_source: null });
        if (ok) { cleared++; log.push({ id: d.id, title: d.title, from: d.category_slug, to: null, source: null }); }
      } else if (v.action === "export") exported++;
      else skipped++;
    }
    console.log(`fixed=${fixed} stamped=${stamped} cleared=${cleared} needs-claude=${exported} skipped=${skipped}`);
  }

  if (MODE === "export") {
    const un = draws.filter((d) => decideRuleFix(d, opsBySlug, catBySlug).action === "export")
      .map((d) => ({ id: d.id, title: d.title, grand_prize: d.grand_prize, current: d.category_slug, op: d.op_slug, entry_url: d.entry_url }));
    writeFileSync("backfill-unknowns.json", JSON.stringify(un, null, 2));
    console.log(`wrote backfill-unknowns.json (${un.length} rows)`);
  }

  if (MODE === "apply") {
    const dec = JSON.parse(readFileSync(process.env.DECISIONS || "backfill-decisions.json", "utf8"));
    let applied = 0, invalid = 0, stale = 0;
    for (const { id, category } of dec) {
      if (!catBySlug[category]) { console.error(`  ✗ ${id}: '${category}' is not a slug — refused`); invalid++; continue; }
      const d = draws.find((x) => x.id === id);
      // Guard against a stale backfill-decisions.json: rules mode may have re-run, or a human
      // may have re-categorised, in the gap between export and apply. Re-validate the row's
      // CURRENT state (not its state at export time) before writing — never trust the file alone.
      if (!d) { console.error(`  ⚠ ${id}: not found in current row set — stale decision, skipped`); stale++; continue; }
      if (["claude", "manual"].includes(d.category_source)) { console.error(`  ⚠ ${id}: already ${d.category_source}-stamped — stale decision, skipped`); stale++; continue; }
      if (d.status === "ended") { console.error(`  ⚠ ${id}: row has ended — stale decision, skipped`); stale++; continue; }
      const ok = await patch(id, { category_id: catBySlug[category], category_source: "claude" });
      if (ok) { applied++; log.push({ id, title: d.title, from: d.category_slug, to: category, source: "claude" }); }
    }
    console.log(`applied=${applied} invalid=${invalid} stale=${stale}`);
  }

  if (log.length && !DRY) {
    const f = `backfill-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(f, JSON.stringify(log, null, 2));
    console.log(`log → ${f}`);
  }
}
