// Can we still find images for ENDED draws?
//
// repair-images.mjs only ever asked Woo for LIVE products (wooOperator pages the
// listing feed), and asked the product page for og:image. Both fail for an ended
// draw. But Woo's Store API can be queried BY SLUG, which returns sold-out and
// ended products too — and Woo keeps the image on the product record long after
// the comp closes.
//
// This probes that hypothesis across the operators that own the visible gaps.
//   bun probe-ended-images.mjs [sampleSize]

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEAD = "kkuuwksgyypicnblwubs";
const N = Number(process.argv[2] || 3);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const rows = await (await fetch(
  `${SB}/rest/v1/draws?select=slug,entry_url,status,operators(slug)&image_url=like.*${DEAD}*&limit=400`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();

// group by operator, take N each
const byOp = new Map();
for (const r of rows) {
  const o = r.operators?.slug; if (!o || !r.entry_url) continue;
  if (!byOp.has(o)) byOp.set(o, []);
  if (byOp.get(o).length < N) byOp.get(o).push(r);
}

const productSlug = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "").split("/").pop(); } catch { return null; } };
const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };

async function tryJson(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    return { j };
  } catch (e) { return { err: e.name || "error" }; }
}

function imageOf(j) {
  const p = Array.isArray(j) ? j[0] : j;
  if (!p) return null;
  if (Array.isArray(p.images) && p.images[0]?.src) return p.images[0].src;      // store API
  if (p.image?.src) return p.image.src;
  return null;
}

console.log(`Probing ${byOp.size} operator(s), ${N} ended/broken draw(s) each\n`);
const tally = { storeV1: 0, store: 0, wc: 0, none: 0, total: 0 };

for (const [op, list] of byOp) {
  for (const d of list) {
    const base = origin(d.entry_url), ps = productSlug(d.entry_url);
    if (!base || !ps) continue;
    tally.total++;
    const routes = [
      ["storeV1", `${base}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(ps)}`],
      ["store",   `${base}/wp-json/wc/store/products?slug=${encodeURIComponent(ps)}`],
      ["wc",      `${base}/?rest_route=/wc/store/v1/products&slug=${encodeURIComponent(ps)}`],
    ];
    let hit = null, via = null;
    for (const [name, url] of routes) {
      const { j, err } = await tryJson(url);
      if (err || !j) continue;
      const img = imageOf(j);
      if (img) { hit = img; via = name; break; }
    }
    if (hit) { tally[via]++; console.log(`  ✓ ${op.padEnd(26)} ${via.padEnd(8)} ${hit.slice(0, 58)}`); }
    else { tally.none++; console.log(`  ✗ ${op.padEnd(26)} no image via any Store API route`); }
  }
}

console.log(`\n${"═".repeat(58)}`);
console.log(`  probed ${tally.total} — recovered ${tally.total - tally.none} (${Math.round((tally.total - tally.none) / Math.max(tally.total, 1) * 100)}%)`);
console.log(`  routes: store/v1=${tally.storeV1}  store=${tally.store}  rest_route=${tally.wc}  none=${tally.none}`);
console.log("═".repeat(58));
