// SerpApi source — real Google UK results for comp-intent queries. Local/cowork only:
// the key must never reach CI, so this module is a silent no-op without SERPAPI_KEY.
const QUERIES = [
  "uk car competition win tickets",
  "uk prize draw enter site:co.uk",
  "win a house raffle uk",
  "cash competitions uk instant win",
];

export async function candidates({ fetchImpl = fetch } = {}) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  const found = [];
  for (const q of QUERIES) {
    try {
      const u = `https://serpapi.com/search.json?engine=google&gl=uk&num=20&q=${encodeURIComponent(q)}&api_key=${key}`;
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const j = await r.json();
      for (const res of j.organic_results || []) {
        try {
          const domain = new URL(res.link).hostname.toLowerCase().replace(/^www\./, "");
          found.push({ domain, via: "serpapi" });
        } catch { /* malformed link */ }
      }
    } catch { /* one failed query never blocks the rest */ }
  }
  return found;
}
