// Single-URL operator classifier + onboarding helper for PrizeDrawsDaily — KEYLESS (no LLM).
// Replaces the old 8-operator toy: tells you the cheapest acquisition method for a site and
// prints a paste-ready operators.json entry. Reuses the SAME link regexes the scraper uses
// (DRAW_RE/BAD_LINK/pickDrawLinks from extractor.mjs) so probe and run agree by construction.
//
// Usage:
//   bun probe.mjs https://site.co.uk                       # classify one URL
//   bun probe.mjs https://site.co.uk --slug s --name "N"   # + print the operators.json entry
//   bun probe.mjs --all                                    # classify every DB operator
//
// Cascade (cheapest first): woo → shopify → render → aiAssist (server-rendered SPA) →
// blocked (retry via FlareSolverr if FLARESOLVERR_URL is set) → dead.
import { chromium } from "playwright";
import { renderPage, makeContext, pickDrawLinks, DRAW_RE, BAD_LINK, CATEGORY_TAIL, looksBlocked } from "./extractor.mjs";
import { fetchHtml } from "./lib/fetcher.mjs";
import { load, parseJsonLd, findProductLd } from "./lib/parse.mjs";

const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw_3xh_XPKs";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "";

const BLOCK_RE = /just a moment|checking your browser|attention required|cf-browser|access to this (site|service) has been limited|enable javascript and cookies|performing security|verify(ing)? you are human/i;
const SPA_RE = /__NEXT_DATA__|window\.__NUXT__|__remixContext|id="__next"|id="root"|id="app"/;
const PAYLOAD_RE = /"(?:numTickets|maxTickets|totalTickets|maximumEntries)"\s*:/i;
const CAN = ["woo", "shopify", "render", "aiAssist"];

const argVal = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const slugFromUrl = (base) => {
  try { return new URL(base).hostname.replace(/^www\./, "").replace(/\.(co\.uk|com|net|org|scot|uk)$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase(); }
  catch { return "operator"; }
};

// Non-empty JSON array (or {products:[]}) from an API endpoint, via the chosen fetcher.
async function jsonArray(url, op) {
  const r = await fetchHtml(url, op).catch(() => null);
  if (!r || !r.ok) return 0;
  try { const a = JSON.parse(r.text); return (Array.isArray(a) ? a : a.products || []).length; } catch { return 0; }
}

// woo / shopify probe (cheapest; no browser). Shared by the plain pass and the FlareSolverr retry.
async function staticClassify(base, op) {
  if (await jsonArray(`${base}/wp-json/wc/store/v1/products?per_page=3&orderby=date`, op) > 0) return { method: "woo", detail: "woo Store API" };
  if (await jsonArray(`${base}/products.json?limit=3`, op) > 0) return { method: "shopify", detail: "shopify products.json" };
  return null;
}

function scanLinks(html, base) {
  const $ = load(html);
  const hrefs = [];
  $("a[href]").each((_, el) => { try { hrefs.push(new URL($(el).attr("href"), base).href); } catch { /* skip */ } });
  return pickDrawLinks(hrefs, base, DRAW_RE, [BAD_LINK, CATEGORY_TAIL], 8);
}

async function classify(base, ctx, opBase = {}) {
  // 1-2) woo / shopify  (opBase carries insecureTLS for misconfigured-cert sites)
  const stat = await staticClassify(base, opBase);
  if (stat) return stat;

  // Need the homepage: rendered DOM (for links) + raw HTML (for SPA payload sniffing).
  let page = null;
  try { page = await renderPage(ctx, base, 4000); } catch { /* blocked/timeout handled below */ }
  const raw = await fetchHtml(base, opBase).catch(() => ({ ok: false, status: 0, text: "" }));

  // 5) blocked — Cloudflare/403. Retry through FlareSolverr if it's configured.
  const blocked = [403, 503, 429].includes(raw.status) || (page && looksBlocked(page.text)) || BLOCK_RE.test(raw.text || "");
  if (blocked) {
    if (FLARESOLVERR_URL) {
      const cleared = await staticClassify(base, { ...opBase, fetcher: "flaresolverr" });
      if (cleared) return { ...cleared, detail: `via FlareSolverr — ${cleared.detail}`, fetcher: "flaresolverr" };
      const fr = await fetchHtml(base, { ...opBase, fetcher: "flaresolverr" }).catch(() => null);
      if (fr?.ok && fr.text && !BLOCK_RE.test(fr.text)) {
        const links = scanLinks(fr.text, base);
        if (links.length >= 2) return { method: "render", detail: `via FlareSolverr — ${links.length} draw links`, fetcher: "flaresolverr", sample: links.slice(0, 2) };
      }
      return { method: "blocked", detail: "Cloudflare — FlareSolverr could not clear it" };
    }
    return { method: "blocked", detail: "Cloudflare/403 (set FLARESOLVERR_URL to retry — deferred round)" };
  }

  // 3) render — draw links present in the rendered DOM
  const links = page ? pickDrawLinks(page.links, base, DRAW_RE, [BAD_LINK, CATEGORY_TAIL], 8) : [];
  if (links.length >= 2) return { method: "render", detail: `${links.length} draw links`, sample: links.slice(0, 2) };

  // 4) aiAssist — thin DOM but a rich raw payload (Next/Nuxt/JSON-LD-Product/numTickets)
  const $ = load(raw.text || "");
  const ld = findProductLd(parseJsonLd($));
  const spaWithComps = SPA_RE.test(raw.text || "") && /competition|raffle|draw|prize|ticket/i.test(raw.text || "");
  if (ld || PAYLOAD_RE.test(raw.text || "") || spaWithComps) {
    return { method: "aiAssist", detail: "server-rendered payload (Next/Nuxt/JSON-LD) — route to cowork" };
  }

  return { method: "dead", detail: `reachable but no draws/payload (${(raw.text || "").length}b rendered)` };
}

// Paste-ready operators.json entry from a classification.
function emitEntry(name, slug, base, r, insecure) {
  const e = { name, slug, base, method: r.method === "aiAssist" ? "render" : r.method };
  if (r.method === "aiAssist") { e.aiAssist = true; e.drawMatch = "/competitions/[a-z0-9][a-z0-9-]+/?$"; e.drawUrlTemplate = "/competitions/{slug}"; }
  if (r.fetcher) e.fetcher = r.fetcher;
  if (insecure) e.insecureTLS = true;
  return e;
}

async function runOne(base, slug, name, insecure) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await makeContext(browser, { insecureTLS: insecure });
  let r; try { r = await classify(base, ctx, { insecureTLS: insecure }); } catch (e) { r = { method: "error", detail: (e.message || "").slice(0, 60) }; }
  await browser.close();

  console.log(`\n${r.method.toUpperCase().padEnd(9)} ${base}`);
  console.log(`  ${r.detail}`);
  if (r.sample?.length) console.log(`  e.g. ${r.sample.join("   ")}`);
  if (CAN.includes(r.method)) {
    console.log(`\n// paste into operators.json:`);
    console.log(JSON.stringify(emitEntry(name, slug, base, r, insecure), null, 2));
    console.log(`// then add a matching row to the operators DB table (slug "${slug}").`);
  }
}

async function runAll() {
  const ops = await (await fetch(`${SB}/rest/v1/operators?select=name,slug,website_url&order=name`, { headers: { apikey: ANON } })).json();
  const targets = (Array.isArray(ops) ? ops : []).filter((o) => o.website_url);
  console.log(`Classifying ${targets.length} operators${FLARESOLVERR_URL ? " (FlareSolverr on)" : ""}\n`);
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await makeContext(browser);
  const results = [];
  for (const op of targets) {
    const base = op.website_url.replace(/\/+$/, "");
    let r; try { r = await classify(base, ctx); } catch (e) { r = { method: "error", detail: (e.message || "").slice(0, 50) }; }
    results.push({ name: op.name, slug: op.slug, base, ...r });
    console.log(`${CAN.includes(r.method) ? "✅" : "⛔"} ${(op.name || "").slice(0, 26).padEnd(26)} | ${r.method.padEnd(9)} | ${r.detail}`);
  }
  await browser.close();
  await Bun.write("probe-results.json", JSON.stringify(results, null, 2));
  const can = results.filter((r) => CAN.includes(r.method));
  const by = (m) => can.filter((r) => r.method === m).length;
  console.log(`\n${can.length}/${results.length} classifiable [woo:${by("woo")} shopify:${by("shopify")} render:${by("render")} aiAssist:${by("aiAssist")}]  → probe-results.json`);
}

// ---- entry point ----
if (process.argv.includes("--all")) {
  await runAll();
} else {
  const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
  if (!url) { console.error('usage: bun probe.mjs <url> [--slug s --name "N"] [--insecure]  |  bun probe.mjs --all'); process.exit(1); }
  const base = url.replace(/\/+$/, "");
  await runOne(base, argVal("--slug") || slugFromUrl(base), argVal("--name") || argVal("--slug") || slugFromUrl(base), process.argv.includes("--insecure"));
}
