// One-shot discovery probe: take CompWatch's operator slugs, subtract operators we already have,
// guess the live domain for each remaining candidate, and DETERMINISTICALLY confirm it's a real,
// active UK comp site by hitting its WooCommerce/Shopify product API. No LLM, no hallucination —
// a candidate only survives if its API actually returns live, purchasable products right now.
//
//   bun probe-candidates.mjs            → prints a verified shortlist (domain, method, live count, sample)
// Reads CompWatch slugs from arg 1 (a comma list) or the teardown file's slug line.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT = 12000;
const CONCURRENCY = 16;

// --- candidate slugs (CompWatch) ---
const slugsArg = process.argv[2];
let slugs = [];
if (slugsArg) slugs = slugsArg.split(",");
else {
  const md = await Bun.file(`${process.env.HOME}/Desktop/pdd-competitor-teardown.md`).text().catch(() => "");
  // the slug inventory is the one very long comma line of lowercase-hyphen tokens
  const line = md.split("\n").find((l) => (l.match(/,/g) || []).length > 40 && /^[a-z0-9-]+,/.test(l.trim()));
  slugs = line ? line.split(",") : [];
}
slugs = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9-]{2,}$/.test(s)))];

// --- exclusion set: operators we already have (operators.json bases + their slugs) ---
const norm = (s) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
  .replace(/\.(co\.uk|org\.uk|me\.uk|com|co|uk|scot|online|net|io|shop|store|gg|win)$/g, "").replace(/[^a-z0-9]/g, "");
const ours = await Bun.file("operators.json").json();
const have = new Set();
for (const o of ours) { have.add(norm(o.slug)); have.add(norm(o.base)); have.add(norm(o.name)); }
const candidates = slugs.filter((s) => !have.has(norm(s)));

// --- domain guesses per slug (slug → likely live domain) ---
function domainsFor(slug) {
  const flat = slug.replace(/-/g, "");
  const variants = new Set([
    `${flat}.co.uk`, `${flat}.com`, `${slug}.co.uk`, `${slug}.com`,
    `${flat}.uk`, `${flat}.competitions.co.uk`,
  ]);
  return [...variants];
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return { ok: false, status: r.status };
    const t = await r.text();
    try { return { ok: true, json: JSON.parse(t) }; } catch { return { ok: false, status: "non-json" }; }
  } catch (e) { return { ok: false, status: (e.name === "TimeoutError" ? "timeout" : "err") }; }
}

async function probe(slug) {
  for (const host of domainsFor(slug)) {
    const base = `https://${host}`;
    // WooCommerce Store API
    const woo = await fetchJson(`${base}/wp-json/wc/store/v1/products?per_page=20&orderby=date`);
    if (woo.ok && Array.isArray(woo.json)) {
      const live = woo.json.filter((p) => p.is_in_stock !== false && p.is_purchasable !== false);
      if (live.length) return { slug, base, method: "woo", live: live.length, total: woo.json.length, sample: (live[0]?.name || "").slice(0, 50) };
    }
    // Shopify
    const sh = await fetchJson(`${base}/products.json?limit=20`);
    if (sh.ok && Array.isArray(sh.json?.products) && sh.json.products.length) {
      const ps = sh.json.products;
      return { slug, base, method: "shopify", live: ps.length, total: ps.length, sample: (ps[0]?.title || "").slice(0, 50) };
    }
  }
  return { slug, method: null };
}

// bounded concurrency
const results = [];
let i = 0;
async function worker() { while (i < candidates.length) { const idx = i++; results[idx] = await probe(candidates[idx]); } }
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const hits = results.filter((r) => r.method);
hits.sort((a, b) => b.live - a.live);
console.log(`\nCANDIDATES probed: ${candidates.length} | VERIFIED active+scrapeable: ${hits.length}\n`);
for (const h of hits) console.log(`${h.method.padEnd(8)} live=${String(h.live).padStart(3)}  ${h.base.padEnd(42)} "${h.sample}"`);
console.log(`\n--- operators.json snippets (verified, type woo/shopify) ---`);
for (const h of hits) console.log(`  { "name": "${h.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}", "slug": "${h.slug}", "base": "${h.base}", "method": "${h.method}" },`);
