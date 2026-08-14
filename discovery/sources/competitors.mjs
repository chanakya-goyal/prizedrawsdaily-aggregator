// Competitor aggregators maintain exactly the operator list we want. Their sitemaps point
// at per-operator pages; each page links out to the operator's real domain.
import { UA } from "../lib.mjs";
import { extractCompDomains } from "./crosslink.mjs";

const SOURCES = [
  { name: "competitionshowroom", url: "https://competitionshowroom.com/sitemap.xml" },
];
const PAGE_MATCH = /operator|site|review|compan/i;
const MAX_PAGES_PER_SOURCE = 40;
const TIMEOUT = 12000;

async function getText(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.text();
}

export async function candidates({ fetchImpl = fetch } = {}) {
  const found = [];
  for (const src of SOURCES) {
    try {
      let xml = await getText(src.url, fetchImpl);
      // sitemap index → pull the child sitemaps in too (one level)
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      const childMaps = locs.filter((u) => u.endsWith(".xml")).slice(0, 5);
      for (const child of childMaps) {
        try { xml += await getText(child, fetchImpl); } catch { /* skip child */ }
      }
      const pages = [...new Set([...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]))]
        .filter((u) => !u.endsWith(".xml") && PAGE_MATCH.test(new URL(u).pathname))
        .slice(0, MAX_PAGES_PER_SOURCE);
      const selfHost = new URL(src.url).hostname.replace(/^www\./, "");
      for (const page of pages) {
        try {
          const html = await getText(page, fetchImpl);
          for (const domain of extractCompDomains(html, { excludeHosts: new Set([selfHost]) })) {
            found.push({ domain, via: `competitor:${src.name}` });
          }
        } catch { /* one dead page never blocks the source */ }
      }
    } catch { /* a dead competitor source never blocks discovery */ }
  }
  return found;
}
