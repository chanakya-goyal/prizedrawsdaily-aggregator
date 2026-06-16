// Probe each operator for the cheapest acquisition method:
// WooCommerce Store API > Shopify products.json > plain static fetch > (else headless)
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" };

const OPS = [
  ["Good Life Plus", "https://goodlifeplus.co.uk"],
  ["BOTB", "https://www.botb.com"],
  ["7Days Performance", "https://7daysperformance.co.uk"],
  ["Dream Car Giveaways", "https://dreamcargiveaways.co.uk"],
  ["Rev Comps", "https://www.revcomps.com"],
  ["Bounty Competitions", "https://bountycompetitions.co.uk"],
  ["UKCC", "https://ukcc.co.uk"],
  ["Jammy", "https://www.jammy.co.uk"],
];

async function tryFetch(url, label) {
  try {
    const ctl = AbortSignal.timeout(15000);
    const r = await fetch(url, { headers: UA, signal: ctl, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    return { ok: r.ok, status: r.status, ct, len: body.length, body };
  } catch (e) {
    return { ok: false, status: 0, err: e.message, len: 0, body: "" };
  }
}

for (const [name, base] of OPS) {
  let method = "??", detail = "";

  // 1) WooCommerce Store API
  const woo = await tryFetch(`${base}/wp-json/wc/store/v1/products?per_page=3`, "woo");
  let wooCount = 0;
  if (woo.ok && woo.ct.includes("json")) {
    try { wooCount = JSON.parse(woo.body).length; } catch {}
  }

  // 2) Shopify products.json
  const shop = await tryFetch(`${base}/products.json?limit=3`, "shop");
  let shopCount = 0;
  if (shop.ok && shop.ct.includes("json")) {
    try { shopCount = (JSON.parse(shop.body).products || []).length; } catch {}
  }

  // 3) plain homepage
  const home = await tryFetch(base, "home");
  const isSPA = home.ok && home.len < 60000 && /<div id="(root|app|__next)"|window\.__NUXT__|__NEXT_DATA__/.test(home.body);

  if (wooCount > 0) { method = "WooCommerce API ✅ (cheapest)"; detail = `${wooCount} products`; }
  else if (shopCount > 0) { method = "Shopify API ✅ (cheapest)"; detail = `${shopCount} products`; }
  else if (home.status === 403 || home.status === 503 || home.status === 0) { method = "BLOCKED → needs headless"; detail = home.err || `HTTP ${home.status}`; }
  else if (isSPA) { method = "SPA → needs headless"; detail = `${home.len} bytes, JS-rendered`; }
  else if (home.ok) { method = "Static fetch ✓"; detail = `HTTP 200, ${home.len} bytes`; }
  else { method = "?? → needs headless"; detail = `HTTP ${home.status}`; }

  console.log(`${name.padEnd(22)} | ${method.padEnd(30)} | ${detail}`);
  console.log(`${" ".repeat(22)} | woo:${woo.status} shop:${shop.status} home:${home.status}`);
}
