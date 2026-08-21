// One-off (re-runnable, idempotent) category backfill. Three modes:
//   MODE=rules  [DRY_RUN=true|false]  — apply rule/pin verdicts + stamp category_source
//   MODE=export                        — write backfill-unknowns.json (active rows Claude must judge)
//   MODE=apply DECISIONS=<file> [DRY_RUN] — apply {id → category} judgments as category_source='claude'
// Never touches status. Every write is logged old→new to backfill-log-<ts>.json.
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
  return d.status === "active" ? { action: "export" } : { action: "skip" };
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
  const opsRaw = JSON.parse(readFileSync(new URL("./operators.json", import.meta.url), "utf8"));
  const opsBySlug = Object.fromEntries((Array.isArray(opsRaw) ? opsRaw : opsRaw.operators).map((o) => [o.slug, o]));
  const cats = await fetchAll("categories?select=id,slug");
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const draws = (await fetchAll("draws?select=id,title,grand_prize,entry_url,status,category_source,categories(slug),operators(slug)&status=in.(active,draft,ended)&order=id"))
    .map((d) => ({ ...d, category_slug: d.categories?.slug ?? null, op_slug: d.operators?.slug ?? null }));
  console.log(`${draws.length} draws · mode=${MODE} · DRY_RUN=${DRY}`);
  const log = [];

  if (MODE === "rules") {
    let fixed = 0, stamped = 0, exported = 0, skipped = 0;
    for (const d of draws) {
      const v = decideRuleFix(d, opsBySlug, catBySlug);
      if (v.action === "fix") {
        log.push({ id: d.id, title: d.title, from: d.category_slug, to: v.category, source: v.source });
        if (await patch(d.id, { category_id: catBySlug[v.category], category_source: v.source })) fixed++;
      } else if (v.action === "stamp") {
        if (await patch(d.id, { category_source: v.source })) stamped++;
      } else if (v.action === "export") exported++;
      else skipped++;
    }
    console.log(`fixed=${fixed} stamped=${stamped} needs-claude=${exported} skipped=${skipped}`);
  }

  if (MODE === "export") {
    const un = draws.filter((d) => decideRuleFix(d, opsBySlug, catBySlug).action === "export")
      .map((d) => ({ id: d.id, title: d.title, grand_prize: d.grand_prize, current: d.category_slug, op: d.op_slug, entry_url: d.entry_url }));
    writeFileSync("backfill-unknowns.json", JSON.stringify(un, null, 2));
    console.log(`wrote backfill-unknowns.json (${un.length} rows)`);
  }

  if (MODE === "apply") {
    const dec = JSON.parse(readFileSync(process.env.DECISIONS || "backfill-decisions.json", "utf8"));
    let applied = 0, invalid = 0;
    for (const { id, category } of dec) {
      if (!catBySlug[category]) { console.error(`  ✗ ${id}: '${category}' is not a slug — refused`); invalid++; continue; }
      const d = draws.find((x) => x.id === id);
      log.push({ id, title: d?.title, from: d?.category_slug, to: category, source: "claude" });
      if (await patch(id, { category_id: catBySlug[category], category_source: "claude" })) applied++;
    }
    console.log(`applied=${applied} invalid=${invalid}`);
  }

  if (log.length && !DRY) {
    const f = `backfill-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(f, JSON.stringify(log, null, 2));
    console.log(`log → ${f}`);
  }
}
