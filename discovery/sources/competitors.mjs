// Competitor aggregators maintain exactly the operator list we want. We use them ONLY to
// discover operator names + domains - never their draw data, prices, odds or text.
// Rules: identify politely, >= 2 s between requests to one host, stop a source on 403/429,
// and only fetch paths its robots.txt allows (per-operator pages, never listings/APIs).
import { UA, norm, domainsFor, knownOperatorSet } from "../lib.mjs";
import { extractCompDomains } from "./crosslink.mjs";

export const BOT_UA = "pdd-aggregator-discovery/1.0 (+https://prizedrawsdaily.co.uk)";
const TIMEOUT = 12000;
const MAX_PAGES_PER_SOURCE = 40;
const NOT_OPERATOR_HOSTS = /(^|\.)(trustpilot|gamcare|begambleaware|gamblingcommission|gov|facebook|instagram|twitter|x|tiktok|youtube|google|apple|paypal|stripe|cloudflare|wikipedia|linkedin|pinterest|gambleaware|gamstop)\./i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sitemap-index -> child sitemaps (only those matching childMatch) -> page URLs.
// Throws { blocked: true } on 403/429 so the caller stops the source.
async function getText(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { "User-Agent": BOT_UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 403 || r.status === 429) { const e = new Error(`blocked ${r.status} ${url}`); e.blocked = true; throw e; }
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
const locs = (xml) => [...new Set([...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]))];

export async function sitemapPages(sitemapUrl, { fetchImpl, delayMs, pathMatch, childMatch = /./ }) {
  let urls = locs(await getText(sitemapUrl, fetchImpl));
  const out = [];
  for (const u of urls) {
    if (!u.endsWith(".xml")) { out.push(u); continue; }
    if (!childMatch.test(u)) continue;
    await sleep(delayMs);
    out.push(...locs(await getText(u, fetchImpl)).filter((x) => !x.endsWith(".xml")));
  }
  return [...new Set(out)].filter((u) => pathMatch.test(new URL(u).pathname));
}

// "/sites/10to2-competitions" -> "10to2-competitions"
export const slugOf = (url) => decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "").toLowerCase();

// The operator's own domain from a FindCompetitions-style operator page: prefer the
// Trustpilot review link (/review/<domain>), else the first external comp-looking link.
export function domainFromOperatorPage(html, selfHost) {
  for (const m of html.matchAll(/trustpilot\.com\/review\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const d = m[1].toLowerCase().replace(/^www\./, "");
    if (d !== selfHost) return d;
  }
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
    let host;
    try { host = new URL(m[1]).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
    if (host === selfHost || NOT_OPERATOR_HOSTS.test(host + ".")) continue;
    return host;
  }
  return null;
}

// Resolve a bare operator slug to a live domain by trying likely variants (cheap GET on the
// operator's own site, not the competitor's).
export async function resolveSlug(slug, { fetchImpl }) {
  for (const d of domainsFor(slug)) {
    for (const host of [d, `www.${d}`]) {
      try {
        const r = await fetchImpl(`https://${host}/`, { headers: { "User-Agent": BOT_UA }, signal: AbortSignal.timeout(8000), redirect: "follow" });
        if (r.status < 500 && r.status !== 404) return d;
      } catch { /* try next variant */ }
    }
  }
  return null;
}

export const SOURCES = [
  // Showroom: operator pages link out to the real domain.
  { name: "competitionshowroom", kind: "links", sitemap: "https://competitionshowroom.com/sitemap.xml", pathMatch: /operator|site|review|compan/i, childMatch: /./, limit: MAX_PAGES_PER_SOURCE },
  // FindCompetitions: sitemap-operators.xml -> /operators/<slug>; page carries the Trustpilot link.
  { name: "findcompetitions", kind: "operator-pages", sitemap: "https://findcompetitions.com/sitemap.xml", pathMatch: /^\/operators\/[^/]+$/, childMatch: /sitemap-operators/, limit: 600 },
  // CompWatch serves a Cloudflare challenge (403) to scripts, so we never open its pages:
  // the /sites/<slug> URLs in its public sitemap already carry the operator names.
  { name: "compwatch", kind: "slugs", sitemap: "https://compwatch.co.uk/sitemap.xml", pathMatch: /^\/sites\/[^/]+$/, childMatch: /sitemap-sites/, limit: 700 },
];

export async function candidates({ fetchImpl = fetch, delayMs = 2000, sources = SOURCES, known } = {}) {
  known ||= await knownOperatorSet().catch(() => new Set());
  const found = [];
  for (const src of sources) {
    try {
      const pages = (await sitemapPages(src.sitemap, { fetchImpl, delayMs, pathMatch: src.pathMatch, childMatch: src.childMatch })).slice(0, src.limit);
      const selfHost = new URL(src.sitemap).hostname.replace(/^www\./, "");
      for (const page of pages) {
        try {
          if (src.kind === "slugs") {
            const slug = slugOf(page);
            if (!slug || known.has(norm(slug))) continue;
            const domain = await resolveSlug(slug, { fetchImpl });
            if (domain) found.push({ domain, via: `competitor:${src.name}`, name: slug });
            continue;
          }
          if (src.kind === "operator-pages" && known.has(norm(slugOf(page)))) continue; // no fetch for known operators
          await sleep(delayMs);
          const html = await getText(page, fetchImpl);
          if (src.kind === "operator-pages") {
            const domain = domainFromOperatorPage(html, selfHost);
            if (domain) found.push({ domain, via: `competitor:${src.name}`, name: slugOf(page) });
          } else {
            for (const domain of extractCompDomains(html, { excludeHosts: new Set([selfHost]) })) found.push({ domain, via: `competitor:${src.name}` });
          }
        } catch (e) { if (e.blocked) throw e; /* one dead page never blocks the source */ }
      }
    } catch { /* blocked or dead competitor source never blocks discovery */ }
  }
  return found;
}
