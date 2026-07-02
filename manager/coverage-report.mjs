// Daily coverage audit: DB operators × operators.json × live-draw counts. Read-only.
// Surfaces the gaps a single scrape run can't see: operators with no config at all,
// configured-but-never-scraped, and operators whose live inventory has gone to zero.
// Usage: bun manager/coverage-report.mjs             # markdown (also appended to the
//                                                    # GitHub Action step summary)
//        JSON=true bun manager/coverage-report.mjs   # machine-readable, for the cowork routine
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_PUBLISHABLE_KEY for read).
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_PUBLISHABLE_KEY"); process.exit(1); }

const get = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { console.error(`GET ${path} → ${r.status} ${await r.text()}`); process.exit(1); }
  return r.json();
};
// PostgREST caps any select at 1000 rows — page through (same bug class run.mjs hit at 1117 draws).
const getAll = async (path, pageSize = 1000) => {
  const sep = path.includes("?") ? "&" : "?";
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await get(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
};

const config = await Bun.file(new URL("../operators.json", import.meta.url)).json();
const cfgBySlug = Object.fromEntries(config.map((o) => [o.slug, o]));

const ops = await getAll("operators?select=id,slug,name,website_url,created_at&order=created_at.asc");
const draws = await getAll("draws?select=operator_id,status,draw_date,created_at");

const now = Date.now();
const days = (iso) => (iso ? Math.floor((now - new Date(iso).getTime()) / 864e5) : null);

const agg = {};
for (const d of draws) {
  const a = (agg[d.operator_id] ||= { total: 0, live: 0, draft: 0, ended: 0, lastInsert: null, lastDraw: null });
  a.total++;
  if (d.status === "draft") a.draft++;
  else if (d.status === "ended") a.ended++;
  else if (d.status === "active" && d.draw_date && new Date(d.draw_date).getTime() > now) a.live++;
  if (!a.lastInsert || d.created_at > a.lastInsert) a.lastInsert = d.created_at;
  if (!a.lastDraw || (d.draw_date && d.draw_date > a.lastDraw)) a.lastDraw = d.draw_date;
}

const rows = ops.map((op) => {
  const cfg = cfgBySlug[op.slug];
  const a = agg[op.id] || { total: 0, live: 0, draft: 0, ended: 0, lastInsert: null, lastDraw: null };
  return {
    slug: op.slug,
    website: op.website_url || null,
    configured: !!cfg,
    enabled: cfg ? cfg.enabled !== false : null,
    method: cfg?.method || null,
    fetcher: cfg?.fetcher || null,
    aiAssist: !!cfg?.aiAssist,
    ...a,
    daysSinceInsert: days(a.lastInsert),
    daysSinceAdded: days(op.created_at),
  };
});

// Decide the health bucket for one operator row.
// row: { slug, method ("woo"|"shopify"|"render"|null), fetcher, enabled, configured, aiAssist,
//        total, live, draft, ended, daysSinceInsert, daysSinceAdded }
// Returns "missing-config" | "disabled" | "never-scraped" | "stalled" | "quiet" | "healthy".
function classify(row) {
  if (!row.configured) return "missing-config";
  if (row.enabled === false) return "disabled";
  if (row.total === 0) return "never-scraped";
  if (row.live > 0) return "healthy";
  if (row.draft > 0) return "quiet"; // scraper works; the publish loop owns these
  // No live draws and nothing ingested recently = the daily sweep keeps coming back empty.
  // API silence is louder than browser silence: woo/shopify get a full-catalogue sweep every
  // day, so 4 clean misses is a real signal; render (headless browser) gets a flakiness week.
  const grace = row.method === "render" ? 7 : 4;
  if (row.daysSinceInsert != null && row.daysSinceInsert <= grace) return "quiet";
  return "stalled";
}
for (const r of rows) r.bucket = classify(r);

const orphans = config.filter((o) => !ops.some((db) => db.slug === o.slug)).map((o) => o.slug);
const by = (bucket) => rows.filter((r) => r.bucket === bucket);
const totals = {
  db_operators: ops.length,
  configured: rows.filter((r) => r.configured).length,
  enabled: rows.filter((r) => r.enabled).length,
  with_live: rows.filter((r) => r.live > 0).length,
  live_draws: rows.reduce((s, r) => s + r.live, 0),
  drafts: rows.reduce((s, r) => s + r.draft, 0),
  missing_config: by("missing-config").length,
  never_scraped: by("never-scraped").length,
  stalled: by("stalled").length,
  quiet: by("quiet").length,
  disabled: by("disabled").length,
  config_orphans: orphans.length,
};

if (process.env.JSON === "true") {
  console.log(JSON.stringify({ totals, rows, orphans }, null, 2));
  process.exit(0);
}

const table = (rs, cols) =>
  `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n` +
  rs.map((r) => `| ${cols.map((c) => r[c] ?? "—").join(" | ")} |`).join("\n") + "\n";

let md = `## Coverage report — ${new Date(now).toISOString().slice(0, 10)}\n\n`;
md += `**${totals.db_operators} operators in DB** · ${totals.configured} configured · ${totals.enabled} enabled · `;
md += `**${totals.with_live} with live draws (${totals.live_draws} live)** · ${totals.drafts} drafts waiting\n`;
md += `Gaps: ${totals.missing_config} missing config · ${totals.never_scraped} never scraped · ${totals.stalled} stalled · ${totals.quiet} quiet · ${totals.disabled} disabled\n\n`;
if (by("missing-config").length) md += `### ⚠️ In DB but no operators.json entry\n` + table(by("missing-config"), ["slug", "website"]) + "\n";
if (by("never-scraped").length) md += `### 🕳 Configured but never scraped\n` + table(by("never-scraped"), ["slug", "method", "fetcher", "daysSinceAdded"]) + "\n";
if (by("stalled").length) md += `### 🔴 Stalled (has draws, none live — needs fixing)\n` + table(by("stalled"), ["slug", "method", "fetcher", "live", "draft", "daysSinceInsert"]) + "\n";
if (by("quiet").length) md += `### 💤 Quiet (plausibly between comps)\n` + table(by("quiet"), ["slug", "method", "live", "daysSinceInsert"]) + "\n";
if (by("disabled").length) md += `### ⏸ Disabled in config\n${by("disabled").map((r) => r.slug).join(", ")}\n\n`;
if (orphans.length) md += `### 👻 In config but not in DB\n${orphans.join(", ")}\n\n`;

console.log(md);
const f = process.env.GITHUB_STEP_SUMMARY;
if (f) { try { await Bun.write(f, (await Bun.file(f).text().catch(() => "")) + "\n" + md) } catch { /* non-fatal */ } }
