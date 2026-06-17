// Classify every operator: can we reliably read its draws (woo/shopify/render) or must it be
// added manually (blocked / no findable draws)? Writes probe-results.json + prints a skip-list.
// Uses NO LLM — pure fetch + headless render — so it costs nothing against the AI quota.
import { chromium } from "playwright";

const SB = "https://kkuuwksgyypicnblwubs.supabase.co";
const ANON = "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Excluded by the user: review-only + free-model + hard-blocked.
const EXCLUDE = new Set(["omaze", "the-birthday-draw", "good-life-plus", "bounty-competitions", "jammy"]);
const DONE = new Set(["seven-days-perf", "ukcc", "dream-car-giveaways", "rev-comps"]); // already automated

const DRAW_RE = /\/(product|competition|competitions|draw|draws|raffle|raffles|win|prize|prizes|comp|comps|giveaway|giveaways|ticket|tickets)\/[a-z0-9][a-z0-9-]{3,}\/?$/i;
const BAD_LINK = /\/(category|categories|collections|product-category|draw-results|winners?|results|past|account|cart|checkout|basket|blog|faq|about|contact|terms|privacy|how-it-works|page)\b/i;

async function tryFetch(url, ms = 12000) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms), redirect: "follow" });
    return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
  } catch (e) { return { status: 0, err: e.message, ct: "", body: "" }; }
}
const jsonCount = (r, key) => {
  if (r.status === 200 && r.ct.includes("json")) { try { const a = JSON.parse(r.body); return Array.isArray(a) ? a.length : (a[key] || []).length; } catch {} }
  return 0;
};

const ops = await (await fetch(`${SB}/rest/v1/operators?select=name,slug,website_url&order=name`, { headers: { apikey: ANON } })).json();
const targets = ops.filter((o) => o.website_url && !EXCLUDE.has(o.slug));
console.log(`Probing ${targets.length} operators (excluded ${EXCLUDE.size}, already-automated ${DONE.size})\n`);

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });

const results = [];
for (const op of targets) {
  const base = op.website_url.replace(/\/+$/, "");
  let method = "?", detail = "", drawLinks = [];
  const woo = await tryFetch(`${base}/wp-json/wc/store/v1/products?per_page=3&orderby=date`);
  const wc = jsonCount(woo);
  let sc = 0;
  if (!wc) { const sh = await tryFetch(`${base}/products.json?limit=3`); sc = jsonCount(sh, "products"); }
  if (wc > 0) { method = "woo"; detail = `${wc} products`; }
  else if (sc > 0) { method = "shopify"; detail = `${sc} products`; }
  else {
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3500);
      const text = await page.evaluate(() => document.body.innerText);
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
      const origin = new URL(base).origin;
      const blocked = [403, 503, 429].includes(resp?.status()) || /just a moment|checking your browser|attention required|cf-browser|access to this (site|service) has been limited|enable javascript and cookies|performing security|verify you are human/i.test(text);
      drawLinks = [...new Set(links.filter((h) => h.startsWith(origin)).map((h) => h.split("?")[0].split("#")[0]).filter((h) => DRAW_RE.test(h) && !BAD_LINK.test(h)))];
      if (blocked) { method = "blocked"; detail = `HTTP ${resp?.status()} ${text.slice(0, 35).replace(/\s+/g, " ")}`; }
      else if (drawLinks.length >= 2) { method = "render"; detail = `${drawLinks.length} draw links`; }
      else { method = "no-draws"; detail = `only ${drawLinks.length} draw-like links (${text.length}b)`; }
    } catch (e) { method = "error"; detail = (e.message || "").slice(0, 45); }
    finally { await page.close(); }
  }
  const readable = ["woo", "shopify", "render"].includes(method);
  const rec = { name: op.name, slug: op.slug, base, method, detail, readable, done: DONE.has(op.slug), sample: drawLinks.slice(0, 2) };
  results.push(rec);
  console.log(`${readable ? "✅" : "⛔"} ${(rec.done ? "[done] " : "").padStart(0)}${op.name.slice(0, 26).padEnd(26)} | ${method.padEnd(9)} | ${detail}`);
}
await browser.close();
await Bun.write("probe-results.json", JSON.stringify(results, null, 2));

const readable = results.filter((r) => r.readable && !r.done);
const skip = results.filter((r) => !r.readable);
console.log(`\n\n===== SUMMARY =====`);
console.log(`already automated: ${results.filter((r) => r.done).length}`);
console.log(`NEW readable (can automate): ${readable.length}  [woo:${readable.filter(r=>r.method==="woo").length} shopify:${readable.filter(r=>r.method==="shopify").length} render:${readable.filter(r=>r.method==="render").length}]`);
console.log(`SKIP (manual): ${skip.length}`);
console.log(`\n--- SKIP LIST (you add these manually) ---`);
for (const r of skip) console.log(`• ${r.name.padEnd(28)} ${r.method} — ${r.detail}`);
