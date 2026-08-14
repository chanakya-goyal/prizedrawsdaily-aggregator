// Discovery orchestrator: sources → dedupe vs everything known → deterministic platform
// probe → trust screen → approval queue (queue.json + QUEUE.md). Writes files only; the
// site DB is untouched until a human runs discovery/approve.mjs. No LLM anywhere.
import { norm, probeDomain, knownOperatorSet } from "./lib.mjs";
import { trustScreen } from "./trust.mjs";
import { candidates as seeds } from "./sources/seeds.mjs";
import { candidates as crosslink } from "./sources/crosslink.mjs";
import { candidates as competitors } from "./sources/competitors.mjs";
import { candidates as serpapi } from "./sources/serpapi.mjs";

const slugFor = (domain) => domain.replace(/\.(co\.uk|org\.uk|me\.uk|com|co|uk|scot|online|net|io|shop|store|gg|win)$/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titleFor = (slug) => slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const flag = (v, render = (x) => String(x)) => (v == null || v === false || (Array.isArray(v) && !v.length)) ? "⚠️ none" : render(v);

// Pure renderer — testable offline. Takes probed+screened candidates, returns both artifacts.
export function buildQueue(probed) {
  const json = probed
    .map((c) => ({ slug: slugFor(c.domain), ...c }))
    .sort((a, b) => (b.live - a.live) || (a.domain < b.domain ? -1 : 1));
  const lines = [
    "# Operator approval queue",
    "",
    `${json.length} verified-scrapeable candidates. Approve: \`bun discovery/approve.mjs <slug>\` · reject: \`bun discovery/reject.mjs <slug> "<reason>"\``,
    "",
  ];
  for (const c of json) {
    const t = c.trust || {};
    lines.push(
      `### ${c.slug}`,
      "",
      `| signal | value |`,
      `|---|---|`,
      `| found via | ${c.via} |`,
      `| platform | ${c.method} — **${c.live} live** / ${c.total} listed |`,
      `| sample | ${c.sample} |`,
      `| domain age | ${flag(t.domainAgeDays, (d) => `${d} days`)} |`,
      `| company no | ${flag(t.companyNumber)} |`,
      `| T&Cs page | ${t.hasTerms ? "yes" : "⚠️ none"} |`,
      `| Trustpilot | ${t.trustpilotScore != null ? `${t.trustpilotScore} ★ — ${t.trustpilotUrl}` : `⚠️ unverified — check https://uk.trustpilot.com/review/${c.domain}`} |`,
      `| socials | ${flag(t.socials, (s) => s.join(" · "))} |`,
      "",
      "```json",
      `  { "name": "${titleFor(c.slug)}", "slug": "${c.slug}", "base": "${c.base}", "method": "${c.method}" },`,
      "```",
      "",
      `approve: \`bun discovery/approve.mjs ${c.slug}\``,
      "",
    );
  }
  return { json, md: lines.join("\n") };
}

if (import.meta.path === Bun.main) {
  const sources = [seeds, crosslink, competitors, serpapi];
  const found = (await Promise.all(sources.map((s) => s({}).catch(() => [])))).flat();

  const known = await knownOperatorSet();
  const seen = new Set();
  const fresh = [];
  for (const c of found) {
    const key = norm(c.domain);
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    fresh.push(c);
  }
  console.log(`discovered ${found.length} → new ${fresh.length}`);

  // Deterministic platform probe (bare domain, then www.)
  const probed = [];
  let i = 0;
  async function probeWorker() {
    while (i < fresh.length) {
      const c = fresh[i++];
      const hit = (await probeDomain(`https://${c.domain}`)) || (await probeDomain(`https://www.${c.domain}`));
      if (hit) probed.push({ ...c, base: `https://${c.domain}`, ...hit });
    }
  }
  await Promise.all(Array.from({ length: 8 }, probeWorker));
  console.log(`scrapeable ${probed.length}`);

  // Trust evidence for the survivors
  let j = 0;
  async function trustWorker() {
    while (j < probed.length) { const c = probed[j++]; c.trust = await trustScreen(c.domain); }
  }
  await Promise.all(Array.from({ length: 4 }, trustWorker));

  const today = new Date().toISOString().slice(0, 10);
  for (const c of probed) c.foundAt = today;

  const { json, md } = buildQueue(probed);
  await Bun.write(new URL("queue.json", import.meta.url), JSON.stringify(json, null, 2) + "\n");
  await Bun.write(new URL("QUEUE.md", import.meta.url), md + "\n");
  console.log(`queue written: discovery/queue.json + discovery/QUEUE.md (${json.length} candidates)`);
}
