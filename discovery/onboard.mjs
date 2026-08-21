// One-command operator onboarding — classify a candidate URL, draft its operators.json entry,
// and dry-run it through the REAL scrape → gate → category pipeline (run.mjs, ONLY + DRY_RUN)
// so the verdict comes from the actual pipeline agreeing (or not), not a guess. KEYLESS, no LLM.
//
// Usage:
//   bun discovery/onboard.mjs <url> [--slug s] [--name "N"]
//
// Writes discovery/onboard-<slug>.json (the report: the proposed operators.json entry + the
// dry-run verdict) and prints a human summary. NEVER touches the real operators.json — the
// dry-run spawn reads a throwaway temp copy via run.mjs's OPERATORS_FILE env override, appended
// with the drafted candidate, and the temp file is deleted afterwards (success or failure).
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchJson } from "./lib.mjs";

const TIMEOUT = 12000;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- platform detection -----------------------------------------------------------------------
// Cascade per the task spec: woo store API → shopify products.json → render fallback. Cheapest
// possible probe (per_page=1 / limit=1) since this only needs to fingerprint the PLATFORM, not
// count live products the way discovery/lib.mjs#probeDomain (candidate-vetting) does.
export async function detectPlatform(baseUrl, { fetchImpl = fetch, timeout = TIMEOUT } = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  const woo = await fetchJson(`${base}/wp-json/wc/store/v1/products?per_page=1`, { fetchImpl, timeout });
  if (woo.ok && Array.isArray(woo.json)) return "woo";
  const shopify = await fetchJson(`${base}/products.json?limit=1`, { fetchImpl, timeout });
  if (shopify.ok && Array.isArray(shopify.json?.products)) return "shopify";
  return "render";
}

// ---- entry drafting ----------------------------------------------------------------------------
// Same host → slug convention as probe.mjs#slugFromUrl, the existing single-URL classifier.
const slugFromUrl = (base) => {
  try {
    return new URL(base).hostname.replace(/^www\./, "")
      .replace(/\.(co\.uk|com|net|org|scot|uk)$/i, "")
      .replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  } catch { return "operator"; }
};
const titleFor = (slug) => slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// operators.json's real shape is {name, slug, base, method} — see discovery/approve.mjs's
// buildOperatorConfig, which builds this exact kind of entry from a probed discovery candidate.
// NOT {url, methods}: `base` (not `url`) and `method` is a single string (not an array).
export function draftEntry({ url, platform, name, slug }) {
  const base = url.replace(/\/+$/, "");
  const s = slug || slugFromUrl(base);
  return { name: name || titleFor(s), slug: s, base, method: platform };
}

// ---- parsing run.mjs's real console output -----------------------------------------------------
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The health-report table (lib/manager.mjs#reportMarkdown, always printed — dry run or live) is
// the most reliable source for scraped/gate-passed totals: `| slug | scraped | inserted |
// published | draft |`. `inserted` increments exactly when a draw passes the gate.
function parseHealthRow(output, slug) {
  const re = new RegExp(`^\\| ${escapeRegExp(slug)} \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|$`, "m");
  const m = re.exec(output);
  return m ? { scraped: +m[1], gatePassed: +m[2], published: +m[3], heldDraft: +m[4] } : null;
}

// Per-line detail: gate-fail reasons, per-draw category (from the NEW-insert ✅ line, which is
// "title | category | £price×entries" — three ' | '-separated segments; the OTHER ✅ format,
// for re-verifying an EXISTING draw, has only two and carries no category, so it's ignored here
// by construction), the "not in DB" skip, and the categories-table startup gate.
function parseLines(output, entryName) {
  const gateFails = [];
  const categories = {};
  let notInDb = false;
  let categoriesBlocked = null;
  for (const line of output.split("\n")) {
    let m;
    if ((m = /^ {2}⏭ {2}.+ — (\w+): (.+)$/.exec(line))) {
      gateFails.push({ stage: m[1], reasons: m[2].split(",").map((s) => s.trim()).filter(Boolean) });
      continue;
    }
    if ((m = /^ {2}✅ (.+)$/.exec(line))) {
      const parts = m[1].split(" | ");
      if (parts.length >= 3) categories[parts[1]] = (categories[parts[1]] || 0) + 1;
      continue;
    }
    if (entryName && line === `· ${entryName}: not in DB, skip`) { notInDb = true; continue; }
    if ((m = /^✖ categories table is missing (\d+) slug/.exec(line))) {
      categoriesBlocked = { missingCount: Number(m[1]), slugs: [] };
      continue;
    }
    if (categoriesBlocked && (m = /^ {4}· (\S+)$/.exec(line))) categoriesBlocked.slugs.push(m[1]);
  }
  return { gateFails, categories, notInDb, categoriesBlocked };
}

// Pure verdict logic — no IO, fully unit-testable against canned run.mjs output. `entry` only
// needs .name/.slug (used to find "this operator's" health-report row / not-in-DB line).
//
// Verdict design (not specified by the brief beyond the 3-way split, so documented here):
//   BLOCKED  — the pipeline could not produce usable data at all: spawn failure, the run.mjs
//              startup assertion (categories table), the operator not yet existing in the DB,
//              zero draws found, or every scraped draw failing the gate.
//   NEEDS-CONFIG — draws were scraped and at least one passed the gate, but something needs
//              human/Claude attention before the entry can be committed as-is: some draws
//              failed the gate, or some resolved no category (null → "will need Claude").
//   READY    — every scraped draw passed the gate AND resolved a category. The drafted entry
//              can be pasted into operators.json as-is.
export function summariseRun({ entry, stdout = "", stderr = "", exitCode = null, spawnError = null }) {
  if (spawnError) {
    return {
      verdict: `BLOCKED(spawn failed: ${spawnError})`, exitCode: null,
      scraped: 0, gatePassed: 0, gateFailed: 0, gateFailReasons: {}, categories: {}, needsClaude: 0, notInDb: false,
    };
  }
  const output = `${stdout}\n${stderr}`;
  const { gateFails, categories, notInDb, categoriesBlocked } = parseLines(output, entry?.name);
  const row = parseHealthRow(output, entry?.slug);

  const gateFailReasons = {};
  for (const { stage, reasons } of gateFails) {
    for (const reason of reasons) {
      const key = `${stage}: ${reason}`;
      gateFailReasons[key] = (gateFailReasons[key] || 0) + 1;
    }
  }
  const insertsCounted = Object.values(categories).reduce((a, b) => a + b, 0);
  const scraped = row ? row.scraped : insertsCounted + gateFails.length;
  const gatePassed = row ? row.gatePassed : insertsCounted;
  const gateFailed = gateFails.length;
  const needsClaude = categories["null"] || 0;

  const base = { exitCode, scraped, gatePassed, gateFailed, gateFailReasons, categories, needsClaude, notInDb };

  if (exitCode !== 0) {
    if (categoriesBlocked) {
      const which = categoriesBlocked.slugs.length ? categoriesBlocked.slugs.join(", ") : `${categoriesBlocked.missingCount} row(s)`;
      return { ...base, verdict: `BLOCKED(categories table missing ${which} — apply the pending Supabase migration, then re-run)` };
    }
    return { ...base, verdict: `BLOCKED(run.mjs exited ${exitCode})` };
  }
  if (notInDb) {
    return { ...base, verdict: "BLOCKED(operator not yet in the operators DB table — insert its row first, e.g. via discovery/approve.mjs, then re-run onboarding)" };
  }
  if (scraped === 0) {
    return { ...base, verdict: "BLOCKED(no draws found on the site — check the detected platform/method)" };
  }
  if (gatePassed === 0) {
    return { ...base, verdict: `BLOCKED(all ${scraped} scraped draw(s) failed the gate)` };
  }
  if (gatePassed < scraped || needsClaude > 0) {
    return { ...base, verdict: "NEEDS-CONFIG" };
  }
  return { ...base, verdict: "READY" };
}

// ---- the dry-run spawn --------------------------------------------------------------------------
// Writes `operatorsList` (the real operators.json + the drafted candidate) to `tmpPath`, spawns
// `bun run.mjs` against it with ONLY/DRY_RUN/AUTO_PUBLISH/OPERATORS_FILE, and ALWAYS deletes the
// temp file afterwards — success or failure alike (finally). `spawnImpl` is injectable so this
// (and main()) can be tested without a real subprocess.
export async function runDryRun(entry, operatorsList, tmpPath, { spawnImpl = (cmd, opts) => Bun.spawnSync(cmd, opts), cwd = REPO_ROOT } = {}) {
  let stdout = "", stderr = "", exitCode = null, spawnError = null;
  try {
    await Bun.write(tmpPath, JSON.stringify(operatorsList, null, 1));
    const proc = spawnImpl(["bun", "run.mjs"], {
      cwd,
      env: { ...process.env, ONLY: entry.slug, DRY_RUN: "true", AUTO_PUBLISH: "false", OPERATORS_FILE: tmpPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    stdout = proc.stdout?.toString?.() ?? "";
    stderr = proc.stderr?.toString?.() ?? "";
    exitCode = proc.exitCode ?? null;
  } catch (e) {
    spawnError = e?.message || String(e);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* never got written, or already gone */ }
  }
  return { stdout, stderr, exitCode, spawnError };
}

// ---- human summary + orchestration ---------------------------------------------------------------
function printSummary(report) {
  const s = report.dryRun;
  console.log(`\n==== onboarding verdict: ${s.verdict} ====`);
  console.log(`draws found: ${s.scraped} · gate-passed: ${s.gatePassed} · gate-failed: ${s.gateFailed}`);
  if (Object.keys(s.gateFailReasons).length) {
    console.log("gate-fail reasons:");
    for (const [reason, count] of Object.entries(s.gateFailReasons)) console.log(`  ${String(count).padStart(3)} × ${reason}`);
  }
  if (Object.keys(s.categories).length) {
    console.log("category distribution:");
    for (const [cat, count] of Object.entries(s.categories)) console.log(`  ${String(count).padStart(3)} × ${cat}`);
  }
  if (s.needsClaude) console.log(`⚠️  ${s.needsClaude} draw(s) resolved to no category — will need Claude`);
}

export async function main({ argv = process.argv.slice(2), fetchImpl = fetch, spawnImpl } = {}) {
  const url = argv.find((a) => /^https?:\/\//.test(a));
  if (!url) {
    console.error('usage: bun discovery/onboard.mjs <url> [--slug s] [--name "N"]');
    process.exitCode = 1;
    return null;
  }
  const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const base = url.replace(/\/+$/, "");

  console.log(`\n🔎 detecting platform: ${base}`);
  const platform = await detectPlatform(base, { fetchImpl });
  console.log(`   → ${platform}`);

  const entry = draftEntry({ url: base, platform, name: argVal("--name"), slug: argVal("--slug") });
  console.log(`\n📋 drafted operators.json entry:\n${JSON.stringify(entry, null, 1)}`);

  const opsUrl = new URL("../operators.json", import.meta.url);
  const realOps = await Bun.file(opsUrl).json();
  const clash = realOps.find((o) => o.slug === entry.slug || o.base === entry.base);
  if (clash) console.log(`\n⚠️  '${clash.slug}' is already in operators.json — dry-running the draft anyway (nothing is written for real).`);

  const tmpPath = `${tmpdir()}/pdd-onboard-${entry.slug}-${crypto.randomUUID()}.json`;
  console.log(`\n🧪 dry-run scraping via run.mjs (ONLY=${entry.slug} DRY_RUN=true AUTO_PUBLISH=false) …`);
  const dry = await runDryRun(entry, [...realOps, entry], tmpPath, { spawnImpl });

  const summary = summariseRun({ entry, ...dry });
  // Keep a bounded tail of the raw spawn output alongside the parsed verdict — the verdict
  // string already names the specific reason for the cases this tool recognises (categories
  // gate, not-in-DB, gate failures...), but an unrecognised failure (BLOCKED(run.mjs exited N))
  // is otherwise a dead end for whoever reads the report next.
  const rawOutputTail = `${dry.stdout || ""}\n${dry.stderr || ""}`.trim().split("\n").slice(-40).join("\n");
  const report = { url: base, platform, entry, dryRun: summary, rawOutputTail, generatedAt: new Date().toISOString() };

  const reportUrl = new URL(`onboard-${entry.slug}.json`, import.meta.url);
  await Bun.write(reportUrl, JSON.stringify(report, null, 1) + "\n");

  printSummary(report);
  console.log(`\n📄 report: discovery/onboard-${entry.slug}.json`);
  return report;
}

if (import.meta.path === Bun.main) {
  await main();
}
