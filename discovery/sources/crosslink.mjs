// Cross-link mining: UK comp operators habitually link to sister brands, partner raffles
// and "other comps we like" — every plain-fetchable configured operator's homepage is a
// free candidate source. Render/flaresolverr-gated ops are skipped (browser cost).
import { UA } from "../lib.mjs";

const COMP_HOST = /comp(etition)?s?|raffle|draw|giveaway|prize|win/i;
const TIMEOUT = 12000;
const CONCURRENCY = 8;

// Pull external hostnames whose domain smells like a comp operator.
export function extractCompDomains(html, { excludeHosts }) {
  const out = new Set();
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
    let host;
    try { host = new URL(m[1]).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
    // test the host minus its public suffix so "win" in ".win" TLDs doesn't self-match
    const label = host.split(".")[0];
    if (!COMP_HOST.test(label)) continue;
    if (excludeHosts.has(host)) continue;
    out.add(host);
  }
  return [...out];
}

export async function candidates({ fetchImpl = fetch } = {}) {
  const ops = await Bun.file(new URL("../../operators.json", import.meta.url)).json();
  const excludeHosts = new Set(ops.map((o) => {
    try { return new URL(o.base).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  }).filter(Boolean));
  const fetchable = ops.filter((o) => o.enabled !== false && !o.fetcher);

  const found = [];
  let i = 0;
  async function worker() {
    while (i < fetchable.length) {
      const op = fetchable[i++];
      try {
        const r = await fetchImpl(op.base, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
        if (!r.ok) continue;
        const html = await r.text();
        for (const domain of extractCompDomains(html, { excludeHosts })) {
          found.push({ domain, via: `crosslink:${op.slug}` });
        }
      } catch { /* one dead homepage never blocks the sweep */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}
