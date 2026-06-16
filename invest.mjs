// Figure out the exact platform for the static operators so we pick the cleanest acquisition.
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" };

const OPS = [
  ["7Days Performance", "https://7daysperformance.co.uk"],
  ["UKCC", "https://ukcc.co.uk"],
  ["BOTB", "https://www.botb.com"],
  ["Good Life Plus", "https://goodlifeplus.co.uk"],
];

async function get(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000), redirect: "follow" });
    return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
  } catch (e) { return { status: 0, ct: "", body: "", err: e.message }; }
}

for (const [name, base] of OPS) {
  console.log(`\n===== ${name} (${base}) =====`);

  const woo = await get(`${base}/wp-json/wc/store/v1/products?per_page=2`);
  console.log(`woo store API: HTTP ${woo.status} ${woo.ct.slice(0,40)} | head: ${woo.body.slice(0,120).replace(/\s+/g," ")}`);

  const wooLegacy = await get(`${base}/wp-json/wc/v3/products`);
  console.log(`woo v3:        HTTP ${wooLegacy.status}`);

  const shop = await get(`${base}/products.json?limit=2`);
  let shopN = 0; try { shopN = (JSON.parse(shop.body).products||[]).length; } catch {}
  console.log(`shopify json:  HTTP ${shop.status} ${shop.ct.slice(0,30)} | products: ${shopN}`);

  const home = await get(base);
  const markers = [];
  if (/woocommerce|wp-content\/plugins\/woocommerce/i.test(home.body)) markers.push("WooCommerce");
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(home.body)) markers.push("Shopify");
  if (/wp-content|wp-json/i.test(home.body)) markers.push("WordPress");
  if (/__NEXT_DATA__/i.test(home.body)) markers.push("Next.js");
  if (/window\.__NUXT__/i.test(home.body)) markers.push("Nuxt");
  if (/<div id="root"/i.test(home.body)) markers.push("React-SPA");
  console.log(`homepage:      HTTP ${home.status}, ${home.body.length} bytes | platform: ${markers.join(", ") || "unknown"}`);

  // sample some links that look like draw/product/competition pages
  const links = [...home.body.matchAll(/href="([^"]+)"/g)].map(m=>m[1])
    .filter(h => /\/(product|products|competition|competitions|draw|raffle|win|prize)s?\//i.test(h));
  const uniq = [...new Set(links)].slice(0,5);
  console.log(`draw-like links: ${uniq.length ? uniq.join("  ") : "none found in homepage HTML"}`);
}
