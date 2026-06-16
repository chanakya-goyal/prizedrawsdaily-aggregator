// What do Bounty + Jammy actually render through the stealth browser?
import { chromium } from "playwright";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const OPS = [
  ["Bounty Competitions", "https://bountycompetitions.co.uk"],
  ["Jammy", "https://www.jammy.co.uk"],
];

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  locale: "en-GB",
  timezoneId: "Europe/London",
  extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
});

for (const [name, base] of OPS) {
  const page = await ctx.newPage();
  console.log(`\n===== ${name} (${base}) =====`);
  try {
    const resp = await page.goto(base, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(9000);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const origin = new URL(base).origin;
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
    const internal = links.filter((h) => h.startsWith(origin));
    const prefixes = {};
    for (const h of internal) {
      const seg = new URL(h).pathname.split("/").slice(0, 2).join("/") || "/";
      prefixes[seg] = (prefixes[seg] || 0) + 1;
    }
    const top = Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const cloudflare = /just a moment|checking your browser|cf-browser-verification|enable javascript and cookies/i.test(text);
    console.log(`HTTP ${resp?.status()} | title: "${title}"`);
    console.log(`cloudflare challenge? ${cloudflare ? "YES — still blocked" : "no — real page rendered"}`);
    console.log(`body: ${text.length} chars | snippet: ${text.slice(0, 180).replace(/\s+/g, " ")}`);
    console.log(`internal links: ${internal.length} | top path prefixes:`);
    for (const [p, n] of top) console.log(`   ${p}  (${n})`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
