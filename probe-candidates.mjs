// One-shot discovery probe: take CompWatch's operator slugs, subtract operators we already have,
// guess the live domain for each remaining candidate, and DETERMINISTICALLY confirm it's a real,
// active UK comp site by hitting its WooCommerce/Shopify product API. No LLM, no hallucination —
// a candidate only survives if its API actually returns live, purchasable products right now.
//
//   bun probe-candidates.mjs            → prints a verified shortlist (domain, method, live count, sample)
// Reads CompWatch slugs from arg 1 (a comma list) or the teardown file's slug line.
import { norm, domainsFor, probeDomain, knownOperatorSet } from "./discovery/lib.mjs";
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

// --- exclusion set: operators we already have (config + skip list + rejections) ---
const have = await knownOperatorSet();
const candidates = slugs.filter((s) => !have.has(norm(s)));

async function probe(slug) {
  for (const host of domainsFor(slug)) {
    const base = `https://${host}`;
    const hit = await probeDomain(base);
    if (hit) return { slug, base, ...hit };
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
