import { test, expect, describe } from "bun:test";
import { norm, domainsFor, probeDomain, knownOperatorSet } from "../discovery/lib.mjs";
import { trustScreen } from "../discovery/trust.mjs";

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });

describe("discovery lib", () => {
  test("norm strips scheme, www, UK TLD tails and punctuation", () => {
    expect(norm("https://www.7DaysPerformance.co.uk/")).toBe(norm("7days-performance"));
    expect(norm("rev-comps")).toBe(norm("https://www.revcomps.com"));
  });
  test("domainsFor guesses flat and hyphenated UK variants", () => {
    const d = domainsFor("prize-kings");
    expect(d).toContain("prizekings.co.uk");
    expect(d).toContain("prize-kings.co.uk");
  });
  test("probeDomain confirms a woo site with live products", async () => {
    const fetchImpl = async (url) => url.includes("/wp-json/wc/store/v1/products")
      ? jsonResponse([{ name: "Win a GT3", is_in_stock: true, is_purchasable: true }])
      : new Response("nf", { status: 404 });
    const r = await probeDomain("https://example.co.uk", { fetchImpl });
    expect(r.method).toBe("woo");
    expect(r.live).toBe(1);
    expect(r.sample).toContain("GT3");
  });
  test("probeDomain falls through to shopify", async () => {
    const fetchImpl = async (url) => url.includes("/products.json")
      ? jsonResponse({ products: [{ title: "Rolex Daytona draw" }] })
      : new Response("nf", { status: 404 });
    const r = await probeDomain("https://example.com", { fetchImpl });
    expect(r.method).toBe("shopify");
    expect(r.sample).toContain("Rolex");
  });
  test("probeDomain returns null when neither API answers", async () => {
    const fetchImpl = async () => new Response("nf", { status: 404 });
    expect(await probeDomain("https://example.co.uk", { fetchImpl })).toBeNull();
  });
  test("knownOperatorSet covers configured operators and the skip list", async () => {
    const known = await knownOperatorSet();
    expect(known.has(norm("rev-comps"))).toBe(true); // operators.json
    expect(known.has(norm("goodlifeplus.co.uk"))).toBe(true); // skipped-operators.csv
  });
});

describe("trustScreen", () => {
  const page = `<html><body>Registered in England, Company No. 12345678
    <a href="/terms-and-conditions">Terms</a>
    <a href="https://www.instagram.com/acmecomps">ig</a></body></html>`;
  const rdap = { events: [{ eventAction: "registration", eventDate: "2021-03-01T00:00:00Z" }] };
  const tp = `<html><script type="application/ld+json">{"@type":"LocalBusiness","aggregateRating":{"ratingValue":"4.6"}}</script></html>`;
  const fetchImpl = async (url) => {
    if (url.includes("rdap.org")) return new Response(JSON.stringify(rdap), { status: 200 });
    if (url.includes("trustpilot.com")) return new Response(tp, { status: 200 });
    return new Response(page, { status: 200 });
  };
  test("extracts company number, terms, socials, rating, age", async () => {
    const t = await trustScreen("acmecomps.co.uk", { fetchImpl });
    expect(t.companyNumber).toBe("12345678");
    expect(t.hasTerms).toBe(true);
    expect(t.socials.some((s) => s.includes("instagram.com/acmecomps"))).toBe(true);
    expect(t.trustpilotScore).toBe(4.6);
    expect(t.trustpilotUrl).toContain("trustpilot.com/review/acmecomps.co.uk");
    expect(t.domainAgeDays).toBeGreaterThan(1000);
  });
  test("every probe failing yields a null-shaped result, not a throw", async () => {
    const t = await trustScreen("dead.co.uk", { fetchImpl: async () => { throw new Error("net"); } });
    expect(t).toEqual({ domainAgeDays: null, companyNumber: null, hasTerms: false, trustpilotUrl: null, trustpilotScore: null, socials: [] });
  });
});

describe("discovery sources", () => {
  test("extractCompDomains finds comp-flavoured external hosts only", async () => {
    const { extractCompDomains } = await import("../discovery/sources/crosslink.mjs");
    const html = `<a href="https://www.acmecompetitions.co.uk/win">x</a>
      <a href="https://twitter.com/foo">no</a>
      <a href="https://rafflekings.com/">y</a>`;
    const out = extractCompDomains(html, { excludeHosts: new Set() });
    expect(out).toContain("acmecompetitions.co.uk");
    expect(out).toContain("rafflekings.com");
    expect(out).not.toContain("twitter.com");
  });
  test("extractCompDomains respects excludeHosts", async () => {
    const { extractCompDomains } = await import("../discovery/sources/crosslink.mjs");
    const html = `<a href="https://rafflekings.com/">y</a>`;
    expect(extractCompDomains(html, { excludeHosts: new Set(["rafflekings.com"]) })).toEqual([]);
  });
  test("seeds.txt lines become candidates, comments and blanks skipped", async () => {
    const { candidates } = await import("../discovery/sources/seeds.mjs");
    await Bun.write("discovery/seeds-test-fixture.txt", "# comment\n\nexamplecomps.co.uk\n");
    const out = await candidates({ seedsPath: "discovery/seeds-test-fixture.txt" });
    expect(out).toEqual([{ domain: "examplecomps.co.uk", via: "seed" }]);
    const { unlinkSync } = await import("node:fs");
    unlinkSync("discovery/seeds-test-fixture.txt");
  });
  test("serpapi source is a no-op without a key", async () => {
    const { candidates } = await import("../discovery/sources/serpapi.mjs");
    const prev = process.env.SERPAPI_KEY;
    delete process.env.SERPAPI_KEY;
    expect(await candidates({})).toEqual([]);
    if (prev) process.env.SERPAPI_KEY = prev;
  });
});

describe("buildQueue", () => {
  test("renders sorted json + md with config snippet and trust evidence", async () => {
    const { buildQueue } = await import("../discovery/run.mjs");
    const probed = [
      { domain: "acmecomps.co.uk", base: "https://acmecomps.co.uk", via: "seed", method: "woo", live: 12, total: 14,
        sample: "Win a GT3", trust: { domainAgeDays: 900, companyNumber: "12345678", hasTerms: true,
        trustpilotUrl: null, trustpilotScore: null, socials: [] }, foundAt: "2026-08-14" },
      { domain: "bigraffle.com", base: "https://bigraffle.com", via: "crosslink:rev-comps", method: "shopify", live: 30,
        total: 30, sample: "Rolex", trust: { domainAgeDays: null, companyNumber: null, hasTerms: false,
        trustpilotUrl: null, trustpilotScore: null, socials: [] }, foundAt: "2026-08-14" },
    ];
    const { json, md } = buildQueue(probed);
    expect(json[0].domain).toBe("bigraffle.com");            // live desc
    expect(json[0].slug).toBe("bigraffle");
    expect(md).toContain('"method": "shopify"');             // paste-ready snippet
    expect(md).toContain("12345678");                        // trust evidence surfaced
    expect(md).toContain("⚠️");                              // missing trust signals flagged
    expect(md).toContain("bun discovery/approve.mjs bigraffle");
  });
});

describe("approve builders", () => {
  test("produce exact insert shapes", async () => {
    const { buildOperatorConfig, buildDbRow } = await import("../discovery/approve.mjs");
    const entry = { slug: "acmecomps", domain: "acmecomps.co.uk", base: "https://acmecomps.co.uk", method: "woo" };
    expect(buildOperatorConfig(entry)).toEqual({ name: "Acmecomps", slug: "acmecomps", base: "https://acmecomps.co.uk", method: "woo" });
    const row = buildDbRow(entry);
    expect(row.review_status).toBeNull(); // site must show it as unverified, never "verified"
    expect(row.website_url).toBe("https://acmecomps.co.uk");
    expect(row.slug).toBe("acmecomps");
  });
});

describe("competitor sources", () => {
  const { candidates, domainFromOperatorPage, slugOf, resolveSlug } = require("../discovery/sources/competitors.mjs");
  const known = new Set([norm("rev-comps")]);
  const fx = (map) => async (url) => {
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) return typeof v === "number" ? new Response("x", { status: v }) : new Response(v, { status: 200 });
    return new Response("nf", { status: 404 });
  };
  test("slugOf + domainFromOperatorPage prefer the Trustpilot link", () => {
    expect(slugOf("https://findcompetitions.com/operators/elite-competitions")).toBe("elite-competitions");
    const html = '<a href="https://www.begambleaware.org">x</a><a href="https://www.trustpilot.com/review/elitecompetitions.co.uk">tp</a>';
    expect(domainFromOperatorPage(html, "findcompetitions.com")).toBe("elitecompetitions.co.uk");
  });
  test("findcompetitions: extracts domains, skips known operators without fetching them", async () => {
    const seen = [];
    const base = fx({
      "/sitemap.xml": "<sitemapindex><loc>https://findcompetitions.com/sitemap-operators.xml</loc><loc>https://findcompetitions.com/sitemap-blog.xml</loc></sitemapindex>",
      "sitemap-operators.xml": "<urlset><loc>https://findcompetitions.com/operators/rev-comps</loc><loc>https://findcompetitions.com/operators/new-comps</loc></urlset>",
      "/operators/new-comps": '<a href="https://www.trustpilot.com/review/newcomps.co.uk">t</a>',
    });
    const fetchImpl = async (u, o) => { seen.push(u); return base(u, o); };
    const sources = [{ name: "findcompetitions", kind: "operator-pages", sitemap: "https://findcompetitions.com/sitemap.xml", pathMatch: /^\/operators\/[^/]+$/, childMatch: /sitemap-operators/, limit: 10 }];
    const out = await candidates({ fetchImpl, delayMs: 0, sources, known });
    expect(out).toEqual([{ domain: "newcomps.co.uk", via: "competitor:findcompetitions", name: "new-comps" }]);
    expect(seen.some((u) => u.includes("rev-comps"))).toBe(false);
    expect(seen.some((u) => u.includes("sitemap-blog"))).toBe(false);
  });
  test("compwatch: slugs only, never opens its pages; resolves a live domain", async () => {
    const seen = [];
    const base = fx({
      "/sitemap.xml": "<sitemapindex><loc>https://compwatch.co.uk/sitemap-sites.xml</loc></sitemapindex>",
      "sitemap-sites.xml": "<urlset><loc>https://compwatch.co.uk/sites/rev-comps</loc><loc>https://compwatch.co.uk/sites/lucky-lizards</loc></urlset>",
      "luckylizards.co.uk": "<html>ok</html>",
    });
    const fetchImpl = async (u, o) => { seen.push(u); return base(u, o); };
    const sources = [{ name: "compwatch", kind: "slugs", sitemap: "https://compwatch.co.uk/sitemap.xml", pathMatch: /^\/sites\/[^/]+$/, childMatch: /sitemap-sites/, limit: 10 }];
    const out = await candidates({ fetchImpl, delayMs: 0, sources, known });
    expect(out.map((c) => c.domain)).toEqual(["luckylizards.co.uk"]);
    expect(seen.some((u) => u.includes("compwatch.co.uk/sites/"))).toBe(false);
  });
  test("a 403 stops the source; other sources still run", async () => {
    const base = fx({
      "blocked.test/sitemap.xml": 403,
      "ok.test/sitemap.xml": "<urlset><loc>https://ok.test/operators/a-comps</loc></urlset>",
      "/operators/a-comps": '<a href="https://www.trustpilot.com/review/acomps.co.uk">t</a>',
    });
    const mk = (n, h) => ({ name: n, kind: "operator-pages", sitemap: `https://${h}/sitemap.xml`, pathMatch: /operators/, childMatch: /./, limit: 5 });
    const out = await candidates({ fetchImpl: base, delayMs: 0, known, sources: [mk("b", "blocked.test"), mk("o", "ok.test")] });
    expect(out.map((c) => c.domain)).toEqual(["acomps.co.uk"]);
  });
  test("resolveSlug returns null when no variant answers", async () => {
    expect(await resolveSlug("nothing-here", { fetchImpl: async () => new Response("nf", { status: 404 }) })).toBeNull();
  });
});
