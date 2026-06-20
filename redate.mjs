// One-off: re-read each already-stored draw's page and correct its draw_date with the fixed logic.
import { chromium } from "playwright";
import { renderPage, makeContext, sleep } from "./extractor.mjs";
import { fieldsFromHtml } from "./lib/parse.mjs";

const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOMAINS = ["7daysperformance.co.uk", "ukcc.co.uk", "dreamcargiveaways.co.uk", "revcomps.com"];

if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const rows = await (await fetch(`${SB}/rest/v1/draws?select=id,title,status,draw_date,entry_url,operator:operators(name)`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
const mine = rows.filter((r) => r.entry_url && DOMAINS.some((d) => r.entry_url.includes(d)));
console.log(`Re-dating ${mine.length} draws (from our 4 operators)\n`);

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await makeContext(browser);
let fixed = 0;
for (const r of mine) {
  try {
    const d = await renderPage(ctx, r.entry_url, 4000);
    const f = fieldsFromHtml({ html: d.html, url: r.entry_url, op: {}, knownImage: d.ogImage });
    const newDate = f.draw_date;
    if (newDate && newDate !== r.draw_date) {
      const res = await fetch(`${SB}/rest/v1/draws?id=eq.${r.id}`, {
        method: "PATCH",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ draw_date: newDate }),
      });
      if (res.ok) { fixed++; console.log(`✏️  [${r.status}] ${r.title.slice(0, 36).padEnd(36)} ${r.draw_date}  →  ${newDate}`); }
      else console.log(`✗  PATCH failed ${res.status} for ${r.title.slice(0, 30)}`);
    } else {
      console.log(`✓  [${r.status}] ${r.title.slice(0, 36).padEnd(36)} unchanged (${r.draw_date})`);
    }
  } catch (e) {
    console.log(`✗  ${r.title.slice(0, 36)} — ${e.message.slice(0, 50)}`);
  }
  await sleep(6000);
}
await browser.close();
console.log(`\nDone — corrected ${fixed} of ${mine.length}.`);
