// One-off repair for the October 2026 clock-change bug (fixed in lib/parse.mjs ukOffset).
//
// The old rule called BST "April to September", so every UK wall-clock time dated 1–24 October
// was stored an hour late. Live-row correction (lib/verify.mjs) compares the draw DAY only, so
// the fixed parser alone never repairs rows that are already stored.
//
// This re-scrapes each affected operator with the FIXED code and patches draw_date only where
// the fresh reading is EXACTLY one hour earlier than the stored one, which is the bug's
// signature. Any other disagreement is reported and left alone, because it is not this bug.
// Sources that already gave a true instant (click, drawhouse, epoch attributes) read
// identically and are untouched.
//
//   bun repair-bst-2026.mjs                  # dry run: prints the plan, writes nothing
//   APPLY=true bun repair-bst-2026.mjs       # writes the planned patches
//   ONLY=slug,slug …                         # limit to some operators
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./lib/browser.mjs";
import { renderOperator, wooOperator, shopifyOperator, apiOperator, makeContext } from "./extractor.mjs";
import { permalinkKey } from "./lib/liveness.mjs";
import { supabaseUrl, sbGetAll } from "./lib/sb.mjs";

const SB = supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.env.APPLY === "true";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const FROM = new Date().toISOString();
const TO = "2026-10-25T01:00:00Z"; // the clocks go back; GMT stamps are right from here on
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Paged: PostgREST returns at most 1,000 rows per request whatever `limit` says, and the first
// APPLY run on 2026-10-15 read exactly 1,000 — so rows past the first page were never checked.
const rows = await sbGetAll(`draws?status=in.(active,draft)&draw_date=gte.${FROM}&draw_date=lt.${TO}&select=id,title,status,draw_date,entry_url,operators(slug)`, { key: KEY });
const ops = (await Bun.file("operators.json").json()).filter((o) => o.enabled !== false);
const bySlug = Object.groupBy(rows, (r) => r.operators?.slug);
const targets = ops.filter((o) => bySlug[o.slug] && (!ONLY || ONLY.has(o.slug)));
console.log(`${rows.length} stored rows dated ${FROM.slice(0, 10)} → ${TO.slice(0, 10)} across ${targets.length} operators${APPLY ? "" : " (DRY)"}\n`);

const needsBrowser = targets.some((o) => o.method === "render");
const browser = needsBrowser ? await chromium.launch(chromiumLaunchOptions({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })) : null;
const ctx = browser ? await makeContext(browser) : null;

const plan = [], other = [];
let unread = 0;
for (const op of targets) {
  let fresh = [];
  try {
    fresh = op.method === "woo" ? await wooOperator(op, 300)
      : op.method === "shopify" ? await shopifyOperator(op, 300)
      : op.method === "api" ? await apiOperator(op, 300)
      : await renderOperator(ctx, op, 40);
  } catch (e) { console.log(`  ${op.slug}: scrape failed — ${e.message}`); }
  const freshBy = new Map((fresh || []).map((d) => [permalinkKey(d.entry_url), d]));
  let mine = 0;
  for (const r of bySlug[op.slug]) {
    const f = freshBy.get(permalinkKey(r.entry_url));
    if (!f?.draw_date) { unread++; continue; }
    const diff = new Date(r.draw_date) - new Date(f.draw_date);
    if (diff === 36e5) { plan.push({ ...r, to: f.draw_date }); mine++; }
    else if (diff !== 0) other.push({ slug: op.slug, title: r.title, stored: r.draw_date, fresh: f.draw_date });
  }
  console.log(`· ${op.slug.padEnd(32)} ${String(bySlug[op.slug].length).padStart(3)} stored, ${String(mine).padStart(3)} an hour late`);
}
if (browser) await browser.close();

console.log(`\nplan: ${plan.length} rows move one hour earlier · ${other.length} other disagreements (left alone) · ${unread} not re-read (left alone)`);
for (const o of other.slice(0, 20)) console.log(`  ≠ ${o.slug}: ${o.title.slice(0, 40)}  stored ${o.stored}  fresh ${o.fresh}`);

if (APPLY) {
  let ok = 0;
  for (const p of plan) {
    // Conditional on the stored value: a row changed since the read is left alone.
    const r = await fetch(`${SB}/rest/v1/draws?id=eq.${p.id}&draw_date=eq.${encodeURIComponent(p.draw_date)}`, {
      method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ draw_date: p.to }),
    });
    if (r.ok) ok++; else console.log(`  ✗ ${p.id} ${r.status}`);
  }
  console.log(`applied ${ok}/${plan.length}`);
}
