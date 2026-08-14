import { test, expect, describe } from "bun:test";
import { norm, domainsFor, probeDomain, knownOperatorSet } from "../discovery/lib.mjs";

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
