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

console.log("Reading the latest aggregator run from GitHub…");
// The in-progress run has no health report yet, so always read the last COMPLETED one.
const runs = JSON.parse(await sh(["gh", "run", "list", "--workflow=aggregate.yml", "--status", "completed", "--limit", "1", "--json", "databaseId,createdAt"]) || "[]");
if (!runs.length) { console.error("Could not read any Action run — is `gh` authenticated?"); process.exit(1); }
const log = await sh(["gh", "run", "view", String(runs[0].databaseId), "--log"]);
console.log(`  run ${runs[0].databaseId} · ${runs[0].createdAt}\n`);

// Three distinct signals of "CI got nothing", each read straight from the run log.
const blocked = new Set();
for (const m of log.matchAll(/woo API 403 for https?:\/\/(?:www\.)?([^\s/]+)/g)) {
  const op = byHost.get(m[1]); if (op) blocked.add(op.slug);
}
for (const m of log.matchAll(/── (.+?) \((?:render|woo|shopify|api)\) ──[\s\S]{0,200}?⛔ blocked after retry/g)) {
  const op = operators.find((o) => o.name === m[1]); if (op) blocked.add(op.slug);
}
const silentLine = log.match(/Silent operators \(0 draws[^)]*\):\*\*([^\n]+)/);
const silent = silentLine ? silentLine[1].split(",").map((s) => s.trim()).filter((s) => bySlug.has(s)) : [];

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

const candidates = [...new Set([...blocked, ...silent])].sort();
console.log(`CI came back empty for ${candidates.length} operators. Working out which are worth retrying here…\n`);
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
    ...(PUBLISH ? { AUTO_PUBLISH: "true" } : {}),
    // Refresh stored fields on live rows while we are here — these operators' draws are
    // otherwise never re-read, so a stale draw_date can leave a finished comp looking live.
    CORRECT_LIVE: process.env.CORRECT_LIVE || "true",
  },
  stdout: "inherit", stderr: "inherit",
});
process.exit(await proc.exited);
