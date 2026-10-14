// One-off repair for the neighbour-block leaks fixed on 2026-10-15 (lib/parse.mjs
// withoutNeighbours, the wpgenie `.max` cap, the Zap countdown fallback).
//
// Live rows already stored with a NEIGHBOUR's figure do not all heal on their own:
//   * the nightly correction only rewrites a row whose fresh read passes the gate, so a row
//     whose leaked cap was the only cap it ever had (Prize Paradise "6,000,000", Capital
//     "199,999" on a 99-ticket draw) is skipped every night and stays live with the wrong odds;
//   * correction compares the draw DAY only, so a same-day time error never moves.
//
// The signature of this bug, per field, is: the OLD parser and the FIXED parser read the SAME
// page differently, and the stored value disagrees with the fixed reading. Both parsers see
// byte-identical responses (each URL is fetched once and replayed), so a carousel rotating
// between requests cannot fake a difference. Anything else is not this bug and is left alone.
//
// What it writes, conditional on the stored values not having changed since the read:
//   fixed read passes the gate → draw_date / total_entries (+ method, prize pool) are patched
//   fixed read fails on the CAP → an ACTIVE row is set back to `draft`, because the cap it is
//                                 published with was never this draw's (DECISIONS.md:
//                                 total_entries is required). Drafts are left as they are, and
//                                 a fixed read that fails on time is left to ended-sweep.
//
//   bun repair-leaks-2026-10.mjs              # dry run: prints the plan, writes nothing
//   APPLY=true bun repair-leaks-2026-10.mjs   # writes the planned patches
//   ONLY=slug,slug …                          # limit to some operators
//   OLD_DIR=…                                 # a checkout of the pre-fix code (default below)
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./lib/browser.mjs";
import * as NX from "./extractor.mjs";
import * as NP from "./lib/parse.mjs";
import { gate } from "./gate.mjs";
import { permalinkKey } from "./lib/liveness.mjs";
import { poolValue } from "./lib/route.mjs";
import { supabaseUrl, sbGetAll } from "./lib/sb.mjs";

const OLD_DIR = process.env.OLD_DIR || `${process.env.HOME}/pdd-aggregator-drawhouse`;
const OX = await import(`${OLD_DIR}/extractor.mjs`);
const OP = await import(`${OLD_DIR}/lib/parse.mjs`);
if (OP.withoutNeighbours) { console.error(`${OLD_DIR} already has the fix — point OLD_DIR at a pre-fix checkout (15269c8)`); process.exit(1); }

const SB = supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.env.APPLY === "true";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const now = new Date();

// Every response fetched once, replayed to both sides.
const realFetch = globalThis.fetch;
const cache = new Map();
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  // `after=` is now()-lookback to the second, so the two sides would otherwise page different listings.
  const k = `${init.method || "GET"} ${String(url).replace(/after=[^&]+/, "after=*")} ${typeof init.body === "string" ? init.body : ""}`;
  if (!cache.has(k)) cache.set(k, (async () => {
    const { signal, ...rest } = init;
    const r = await realFetch(input, { ...rest, signal: AbortSignal.timeout(30000) });
    return { status: r.status, headers: [...r.headers], body: await r.arrayBuffer() };
  })().catch((error) => ({ error })));
  const v = await cache.get(k);
  if (v.error) throw v.error;
  return new Response(v.body.slice(0), { status: v.status, headers: v.headers });
};

// Paged: PostgREST returns at most 1,000 rows per request whatever `limit` says.
const rows = await sbGetAll("draws?status=in.(active,draft)&select=id,title,status,draw_date,total_entries,total_entries_method,ticket_price,total_prize_value,entry_url,operators(slug)", { key: KEY });
const bySlug = Object.groupBy(rows, (r) => r.operators?.slug);
const ops = (await Bun.file("operators.json").json()).filter((o) => o.enabled !== false && bySlug[o.slug] && (!ONLY || ONLY.has(o.slug)));
// FlareSolverr/ScraperAPI operators only resolve inside the Action; they are listed, not guessed.
const local = ops.filter((o) => ["woo", "shopify", "render"].includes(o.method) && !o.fetcher);
const skippedFetcher = ops.filter((o) => o.fetcher && ["woo", "shopify", "render"].includes(o.method));
console.log(`${rows.length} stored active/draft rows · ${local.length} operators to re-read${APPLY ? "" : " (DRY)"}`);
if (skippedFetcher.length) console.log(`  not re-read here (fetcher runs in CI only): ${skippedFetcher.map((o) => o.slug).join(", ")}`);

const browser = local.some((o) => o.method === "render") ? await chromium.launch(chromiumLaunchOptions({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })) : null;
const ctx = browser ? await NX.makeContext(browser) : null;

const sameInstant = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(new Date(a) - new Date(b)) < 60e3);
const plan = [];
for (const op of local) {
  let OLD = [], NEW = [];
  try {
    if (op.method === "render") {
      const listing = await NX.renderPage(ctx, op.listing || op.base, op.wait || 4000);
      const ex = (op.exclude || []).map((e) => NP.compileOpRegex(e)).filter(Boolean);
      const urls = NX.pickDrawLinks(listing.links, op.base, NP.compileOpRegex(op.drawMatch) || NX.DRAW_RE, ex.length ? ex : [NX.BAD_LINK, NX.CATEGORY_TAIL], 40);
      for (const url of urls) {
        let d; try { d = await NX.renderPage(ctx, url, op.wait ? 5000 : 2500); } catch { continue; }
        if (NX.looksBlocked(d.text)) continue;
        OLD.push(OP.fieldsFromHtml({ html: d.html, url, op, knownImage: d.ogImage }));
        NEW.push(NP.fieldsFromHtml({ html: d.html, url, op, knownImage: d.ogImage }));
      }
    } else {
      const run = (X) => (op.method === "woo" ? X.wooOperator(op, 300) : X.shopifyOperator(op, 300));
      OLD = (await run(OX)) || [];
      NEW = (await run(NX)) || [];
    }
  } catch (e) { console.log(`  ${op.slug}: re-read failed — ${e.message}`); continue; }
  const oldBy = new Map(OLD.map((d) => [permalinkKey(d.entry_url), d]));
  const newBy = new Map(NEW.map((d) => [permalinkKey(d.entry_url), d]));
  let mine = 0;
  for (const r of bySlug[op.slug]) {
    const o = oldBy.get(permalinkKey(r.entry_url)), n = newBy.get(permalinkKey(r.entry_url));
    if (!o || !n) continue;
    const fields = [];
    if (!sameInstant(o.draw_date, n.draw_date) && !sameInstant(r.draw_date, n.draw_date)) fields.push("draw_date");
    if (Number(o.total_entries) !== Number(n.total_entries) && Number(r.total_entries) !== Number(n.total_entries)) fields.push("total_entries");
    if (!fields.length) continue;
    const g = gate({ ...n }, now);
    if (g.pass) {
      const patch = {};
      if (fields.includes("draw_date")) patch.draw_date = g.draw.draw_date;
      if (fields.includes("total_entries")) Object.assign(patch, { total_entries: g.draw.total_entries, total_entries_method: g.draw.total_entries_method ?? null, total_prize_value: poolValue(g.draw) });
      plan.push({ r, op: op.slug, kind: "patch", patch, fields });
    } else if (r.status === "active" && g.reasons.some((x) => /total.entries|entries — /i.test(x))) {
      // Only when the CAP is what fails: the published odds were a neighbour's. A fixed read that
      // fails on time ("already closed", ">35d") is the date question, which ended-sweep owns.
      plan.push({ r, op: op.slug, kind: "unpublish", patch: { status: "draft" }, fields, why: g.reasons.join(", ") });
    } else continue;
    mine++;
  }
  console.log(`· ${op.slug.padEnd(34)} ${String(bySlug[op.slug].length).padStart(3)} stored, ${String(mine).padStart(3)} carry a neighbour's figure`);
}
if (browser) await browser.close();

const fmt = (v) => (v == null ? "∅" : String(v));
console.log(`\nplan: ${plan.filter((p) => p.kind === "patch").length} rows corrected · ${plan.filter((p) => p.kind === "unpublish").length} live rows back to draft`);
for (const p of plan) {
  const what = p.fields.map((f) => `${f} ${fmt(p.r[f])} → ${p.kind === "patch" ? fmt(p.patch[f]) : "(fixed read has no valid value)"}`).join("; ");
  console.log(`  ${p.kind === "patch" ? "✎" : "⤓"} ${p.op}: ${p.r.title.slice(0, 44)} [${p.r.status}] ${what}${p.why ? ` — ${p.why}` : ""}`);
}

if (APPLY) {
  let ok = 0;
  for (const p of plan) {
    // Conditional on every value this plan was computed from: a row changed since the read is left alone.
    const q = [`id=eq.${p.r.id}`, `status=eq.${p.r.status}`];
    q.push(p.r.draw_date == null ? "draw_date=is.null" : `draw_date=eq.${encodeURIComponent(p.r.draw_date)}`);
    q.push(p.r.total_entries == null ? "total_entries=is.null" : `total_entries=eq.${p.r.total_entries}`);
    const res = await fetch(`${SB}/rest/v1/draws?${q.join("&")}`, {
      method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(p.patch),
    });
    const body = res.ok ? await res.json() : null;
    if (res.ok && body?.length === 1) ok++;
    else console.log(`  ✗ ${p.r.id} ${res.status}${res.ok ? " (changed since the read — left alone)" : ""}`);
  }
  console.log(`applied ${ok}/${plan.length}`);
}
