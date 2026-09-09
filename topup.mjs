// LOCAL TOP-UP — scrape the operators the GitHub Action cannot reach.
//
// Why this exists: the daily Action runs on GitHub's Azure runners, whose IPs sit in
// datacenter ranges that ~18 operators' WAFs refuse outright ("woo API 403" in the run log)
// even though the same URL serves a full catalogue to an ordinary home connection. A few
// others (Nitrous → HTTP 451, Jammy, Raffle Master) are UK-gated. FlareSolverr cannot fix
// either case: it solves Cloudflare's JS challenge but keeps the same IP.
//
// So this reads the LATEST Action run, extracts exactly who was blocked or silent, and
// re-runs those operators through the ordinary pipeline from this machine's residential IP.
// Nothing about the scraping logic changes — same adapters, same gate, same draft rules.
//
//   bun topup.mjs             # dry run: show what would be captured
//   bun topup.mjs --write     # insert (as draft)
//   bun topup.mjs --write --publish   # ALSO publish drafts a second scrape agrees with
//   bun topup.mjs --list      # just print who CI is missing, scrape nothing
//
// On --publish: a draft only ever goes live when an INDEPENDENT later scrape re-reads the same
// URL and agrees with the stored row (lib/verify.mjs). The daily Action does this for operators
// it can reach; for these operators it never can, so their drafts would otherwise stay drafts
// forever. This run is that second observation. The agreement check is NOT bypassed — a row that
// has drifted, lost its date, or is no longer purchasable still fails and stays a draft.
import { blockedHosts, blockedNames, silentSlugs, pageBlockedSlugs } from "./lib/runlog.mjs";

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const PUBLISH = args.has("--publish");
if (PUBLISH && !WRITE) { console.error("--publish requires --write"); process.exit(1); }

const sh = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
};

const operators = await Bun.file("operators.json").json().then((j) => (Array.isArray(j) ? j : j.operators));
const bySlug = new Map(operators.map((o) => [o.slug, o]));
const byHost = new Map(operators.map((o) => [new URL(o.base).hostname.replace(/^www\./, ""), o]));

console.log("Reading the latest aggregator runs from GitHub…");
// BOTH workflows, because the scrape is split and each half only reports its own operators.
// The JSON sweep is the one that matters most here — "woo API 403" is the signal this whole
// script keys off, and after the split it appears ONLY in aggregate-json.yml. Reading just
// aggregate.yml (render-only) would find nothing and silently do nothing.
// The in-progress run has no health report yet, so always read the last COMPLETED one.
const WORKFLOWS = ["aggregate-json.yml", "aggregate.yml"];
let log = "";
for (const wf of WORKFLOWS) {
  const runs = JSON.parse(await sh(["gh", "run", "list", `--workflow=${wf}`, "--status", "completed", "--limit", "1", "--json", "databaseId,createdAt"]) || "[]");
  if (!runs.length) { console.log(`  ${wf.padEnd(20)} no completed run yet — skipping`); continue; }
  log += await sh(["gh", "run", "view", String(runs[0].databaseId), "--log"]);
  console.log(`  ${wf.padEnd(20)} run ${runs[0].databaseId} · ${runs[0].createdAt}`);
}
if (!log) { console.error("Could not read any Action run — is `gh` authenticated?"); process.exit(1); }
console.log();

// Three distinct signals of "CI got nothing", each read straight from the run log. The parsing
// is in lib/runlog.mjs so it can be tested — it reads text another file formats, and it broke
// silently once already when the health report changed shape.
const blocked = new Set();
for (const host of blockedHosts(log)) { const op = byHost.get(host); if (op) blocked.add(op.slug); }
for (const name of blockedNames(log)) { const op = operators.find((o) => o.name === name); if (op) blocked.add(op.slug); }
const silent = silentSlugs(log, (t) => bySlug.has(t));
// A fourth signal, and the one that hid the longest: operators CI reaches perfectly well at the
// listing level whose PRODUCT PAGES the same WAF refuses. They never appear silent — they
// scrape, and then shed individual draws, because the ticket cap and close date exist only in
// the page body. On 8 Sep 2026 that was 420 draws in a day, reported by the gate as
// "missing total_entries" and therefore read as a parser gap for months. This machine's
// residential IP is the entire remedy, which is what topup already is.
// Keyed on draws LOST, not pages refused. An operator whose API description already carried
// the cap and date loses nothing even with every page refused, and re-running it here would be
// pure waste. The floor keeps one flaky page from dragging an otherwise healthy operator in.
const PAGE_BLOCK_FLOOR = Number(process.env.PAGE_BLOCK_FLOOR || 3);
const pageBlocked = pageBlockedSlugs(log, (t) => bySlug.has(t)).filter((x) => x.lost >= PAGE_BLOCK_FLOOR);
if (pageBlocked.length) {
  const lost = pageBlocked.reduce((a, x) => a + x.lost, 0);
  console.log(`Product pages refused: ${lost} draw(s) lost across ${pageBlocked.length} operator(s) that otherwise scraped fine:`);
  for (const x of pageBlocked.slice(0, 12)) console.log(`  ${x.slug.padEnd(30)} ${x.lost} lost · ${x.blocked} of ${x.total} pages refused`);
  console.log();
}

// Decide who is worth attempting. A plain fetch is NOT the right test on its own: a
// Cloudflare "challenge" (cf-mitigated: challenge) defeats fetch but a real Chromium often
// walks straight through it, and render operators drive a real Chromium. So only exclude on
// signals a browser cannot overcome either: 451 (an explicit legal geo-block), 503 from a live
// UK host, or no response at all.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const classify = async (op) => {
  let r;
  try { r = await fetch(op.base, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) }); }
  catch { return { go: false, why: "no response at all — likely dead" }; }
  if (r.ok) return { go: true, why: "serves us normally" };
  if (r.status === 451) return { go: false, why: "HTTP 451 — explicit geo-block, needs a UK IP" };
  if (r.status === 503) return { go: false, why: "503 from a live UK host — UK-gated" };
  const challenge = r.headers.get("cf-mitigated") === "challenge";
  if (challenge && op.method === "render") return { go: true, why: "Cloudflare challenge — a real browser may pass it" };
  if (challenge) return { go: false, why: "Cloudflare challenge on a JSON endpoint — needs FlareSolverr" };
  return { go: false, why: `HTTP ${r.status}` };
};

const candidates = [...new Set([...blocked, ...silent, ...pageBlocked.map((x) => x.slug)])].sort();
console.log(`CI came back empty or partial for ${candidates.length} operators. Working out which are worth retrying here…\n`);
const verdicts = await Promise.all(candidates.map(async (s) => [s, await classify(bySlug.get(s))]));

const canDo = verdicts.filter(([, v]) => v.go).map(([s]) => s);
const cannot = verdicts.filter(([, v]) => !v.go);
console.log(`WILL RETRY HERE (${canDo.length}): ${canDo.join(", ")}\n`);
console.log(`SKIPPING (${cannot.length}):`);
for (const [s, v] of cannot) console.log(`  ${s.padEnd(28)} ${v.why}`);
console.log();

if (args.has("--list") || !canDo.length) process.exit(0);

console.log(`${WRITE ? (PUBLISH ? "WRITING + PUBLISHING" : "WRITING (draft only)") : "DRY RUN"} — running ${canDo.length} operators through the normal pipeline…\n`);
const proc = Bun.spawn(["bun", "run.mjs"], {
  // Secrets are NOT passed here — run.mjs picks them up from .env itself.
  env: {
    ...process.env,
    ONLY: canDo.join(","),
    DRY_RUN: WRITE ? "false" : "true",
    PER_OP: process.env.PER_OP || "12",
    // Publishing still has to clear the observation gap. These drafts were written by an
    // EARLIER topup run (CI can never reach these operators), so a real gap has passed — but
    // running this script twice in one sitting must not let the second run act as the second
    // observation for drafts the first one just created.
    ...(PUBLISH ? { AUTO_PUBLISH: "true", MIN_OBSERVATION_GAP_MS: process.env.MIN_OBSERVATION_GAP_MS || "64800000" } : {}),
    // Refresh stored fields on live rows while we are here — these operators' draws are
    // otherwise never re-read, so a stale draw_date can leave a finished comp looking live.
    CORRECT_LIVE: process.env.CORRECT_LIVE || "true",
  },
  stdout: "inherit", stderr: "inherit",
});
process.exit(await proc.exited);
