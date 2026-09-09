import { test, expect, describe, beforeEach } from "bun:test";
import { wooProductForUrl, wooFeed, resetWooFeedCache } from "../lib/woo.mjs";

const op = { slug: "op", base: "https://shop.test" };
const ninjaUrl = "https://www.shop.test/product/ninja/";
const ninja = { slug: "ninja", permalink: "https://www.shop.test/product/ninja/", is_purchasable: true };
const stranger = { slug: "someone-else", permalink: "https://www.shop.test/product/someone-else/" };

// A CDN that ignores the query string: every ?slug= answers with the same cached body, while the
// listing feed still carries the real catalogue.
function fakeFetch({ slugAnswer, feedPages = [[]] }) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const isFeed = url.includes("per_page=100");
    if (isFeed) {
      const page = Number(new URL(url).searchParams.get("page") || 1);
      return { json: async () => feedPages[page - 1] ?? [] };
    }
    return { json: async () => slugAnswer };
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => resetWooFeedCache());

describe("wooProductForUrl", () => {
  test("uses the ?slug= answer when it really is our product", async () => {
    const f = fakeFetch({ slugAnswer: [ninja] });
    expect(await wooProductForUrl(op, ninjaUrl, { fetchImpl: f })).toBe(ninja);
    expect(f.calls.some((u) => u.includes("per_page=100"))).toBe(false); // no wasted feed fetch
  });

  // THE REGRESSION THE REVIEW CAUGHT: qa-fix used to stop here and skip the row entirely.
  test("a stranger from the cache falls through to the feed, which resolves it correctly", async () => {
    const f = fakeFetch({ slugAnswer: [stranger], feedPages: [[stranger, ninja]] });
    expect(await wooProductForUrl(op, ninjaUrl, { fetchImpl: f })).toBe(ninja);
  });

  test("the mismatch is reported to the caller so it can be counted", async () => {
    const seen = [];
    const f = fakeFetch({ slugAnswer: [stranger], feedPages: [[ninja]] });
    await wooProductForUrl(op, ninjaUrl, { fetchImpl: f, onMismatch: (s) => seen.push(s) });
    expect(seen).toEqual(["op"]);
  });

  test("an EMPTY ?slug= answer is not a mismatch — nothing came back to be wrong about", async () => {
    const seen = [];
    const f = fakeFetch({ slugAnswer: [], feedPages: [[ninja]] });
    expect(await wooProductForUrl(op, ninjaUrl, { fetchImpl: f, onMismatch: (s) => seen.push(s) })).toBe(ninja);
    expect(seen).toEqual([]);
  });

  test("null when neither source has it — the row stays unverifiable, never wrongly judged", async () => {
    const f = fakeFetch({ slugAnswer: [stranger], feedPages: [[stranger]] });
    expect(await wooProductForUrl(op, ninjaUrl, { fetchImpl: f })).toBe(null);
  });

  test("a throwing ?slug= request still reaches the feed", async () => {
    const impl = async (url) => {
      if (!url.includes("per_page=100")) throw new Error("ECONNRESET");
      return { json: async () => [ninja] };
    };
    expect(await wooProductForUrl(op, ninjaUrl, { fetchImpl: impl })).toBe(ninja);
  });

  // Percent-literal slugs cannot be resolved by ?slug= for ANY encoding (easy-living had 56 of
  // its newest 100 in this shape), so the request is skipped rather than spent.
  test("percent-literal slugs skip ?slug= entirely and go straight to the feed", async () => {
    const emoji = { slug: "%f0%9f%92%b7-win-200", permalink: "https://www.shop.test/product/%f0%9f%92%b7-win-200/" };
    const f = fakeFetch({ slugAnswer: [stranger], feedPages: [[emoji]] });
    const got = await wooProductForUrl(op, "https://www.shop.test/product/%f0%9f%92%b7-win-200/", { fetchImpl: f });
    expect(got).toBe(emoji);
    expect(f.calls.every((u) => !u.includes("?slug="))).toBe(true);
  });
});

describe("wooFeed", () => {
  test("pages until a short page and keys on permalink", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ slug: `p${i}`, permalink: `https://www.shop.test/product/p${i}/` }));
    const f = fakeFetch({ slugAnswer: [], feedPages: [page1, [ninja]] });
    const map = await wooFeed(op, { fetchImpl: f });
    expect(map.size).toBe(101);
    expect(map.get("https://www.shop.test/product/ninja")).toBe(ninja);
  });
  test("is cached per operator — a second call costs no requests", async () => {
    const f = fakeFetch({ slugAnswer: [], feedPages: [[ninja]] });
    await wooFeed(op, { fetchImpl: f });
    const n = f.calls.length;
    await wooFeed(op, { fetchImpl: f });
    expect(f.calls.length).toBe(n);
  });
  test("rest_route operators get the alternate url shape", async () => {
    const f = fakeFetch({ slugAnswer: [], feedPages: [[ninja]] });
    await wooFeed({ slug: "rr", base: "https://rr.test", apiStyle: "rest_route" }, { fetchImpl: f });
    expect(f.calls[0]).toContain("rest_route=/wc/store/v1/products");
  });
});
