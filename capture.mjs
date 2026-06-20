// Dev helper (read-only): snapshot a live operator's pages into test/fixtures/ so parser
// tests can run offline. Usage: bun capture.mjs <slug>
import { chromium } from "playwright";
import { makeContext, renderPage, UA } from "./extractor.mjs";

const slug = process.argv[2];
if (!slug) { console.error("usage: bun capture.mjs <slug>"); process.exit(1); }
const operators = await Bun.file("operators.json").json();
const op = operators.find((o) => o.slug === slug);
if (!op) { console.error(`unknown operator: ${slug}`); process.exit(1); }

const dir = `test/fixtures/${op.method}`;
await Bun.$`mkdir -p ${dir}`.quiet();
const save = async (name, content) => { await Bun.write(`${dir}/${name}`, content); console.log(`  saved ${dir}/${name}`); };

if (op.method === "woo") {
  const products = await (await fetch(`${op.base}/wp-json/wc/store/v1/products?per_page=3&orderby=date`, { headers: { "User-Agent": UA } })).json();
  await save(`${slug}.products.json`, JSON.stringify(products, null, 2));
  if (products[0]?.permalink) await save(`${slug}.product.html`, await (await fetch(products[0].permalink, { headers: { "User-Agent": UA } })).text());
} else if (op.method === "shopify") {
  const data = await (await fetch(`${op.base}/products.json?limit=3`, { headers: { "User-Agent": UA } })).json();
  await save(`${slug}.products.json`, JSON.stringify(data, null, 2));
  const h = data.products?.[0]?.handle;
  if (h) await save(`${slug}.product.html`, await (await fetch(`${op.base}/products/${h}`, { headers: { "User-Agent": UA } })).text());
} else {
  const browser = await chromium.launch({ headless: true });
  const ctx = await makeContext(browser);
  const listing = await renderPage(ctx, op.listing || op.base, op.wait || 4000);
  await save(`${slug}.listing.html`, listing.html);
  const firstDraw = listing.links.find((l) => /\/(product|competition|draw|raffle|comp|giveaway|prize)s?\//i.test(l));
  if (firstDraw) { const d = await renderPage(ctx, firstDraw, 5000); await save(`${slug}.product.html`, d.html); }
  await browser.close();
}
console.log("done.");
