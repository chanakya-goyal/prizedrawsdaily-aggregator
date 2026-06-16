// Discovery: render each JS operator like a real browser, then report what draw links exist.
import { chromium } from "playwright";

const OPS = [
  ["7Days Performance", "https://7daysperformance.co.uk"],
  ["UKCC", "https://ukcc.co.uk"],
  ["BOTB", "https://www.botb.com"],
  ["Good Life Plus", "https://goodlifeplus.co.uk"],
  ["Dream Car Giveaways", "https://dreamcargiveaways.co.uk"],
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

for (const [name, base] of OPS) {
  const page = await ctx.newPage();
  console.log(`\n===== ${name} (${base}) =====`);
  try {
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000); // let client-side JS render the list
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: (a.innerText || "").trim().slice(0, 45) })),
    );
    const origin = new URL(base).origin;
    const drawLinks = links
      .filter((l) => l.href.startsWith(origin))
      .filter((l) => /\/(product|competition|draw|raffle|win|comp|prize|enter|ticket|game|spin)s?[\/\-]/i.test(l.href));
    const uniq = [...new Map(drawLinks.map((l) => [l.href.split("?")[0], l])).values()].slice(0, 12);
    console.log(`title: ${title}`);
    console.log(`rendered body: ${text.length} chars | snippet: ${text.slice(0, 140).replace(/\s+/g, " ")}`);
    console.log(`total links: ${links.length} | draw-like: ${uniq.length}`);
    for (const l of uniq) console.log(`   ${l.href}   [${l.text}]`);
    if (uniq.length === 0) {
      // show the most common path prefixes to spot the draw pattern
      const paths = links.filter((l) => l.href.startsWith(origin)).map((l) => new URL(l.href).pathname.split("/").slice(0, 2).join("/"));
      const freq = {};
      for (const p of paths) freq[p] = (freq[p] || 0) + 1;
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log(`   (no obvious draw links — top path prefixes: ${top.map(([p, n]) => `${p}(${n})`).join(", ")})`);
    }
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
