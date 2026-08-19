import { test, expect, describe } from "bun:test";
import { partitionKnownFirst, SHOPIFY_FEED_LIMIT } from "../extractor.mjs";

// A per-run cap must bound how many NEW competitions we take, never whether we re-read one we
// have already published. Slicing the whole list stranded 18 golf-star rows on a NULL ticket
// cap and 33 gaming-giveaways rows on a stale prize pool, with nothing able to reach them.
describe("partitionKnownFirst", () => {
  const url = (n) => `https://x.co.uk/product/p${n}`;
  const items = (n) => Array.from({ length: n }, (_, i) => ({ permalink: url(i) }));
  const idOf = (p) => p.permalink;

  test("every already-published item survives a cap smaller than their count", () => {
    const known = new Set(Array.from({ length: 30 }, (_, i) => url(i)));
    const r = partitionKnownFirst(items(50), idOf, known, 10);
    expect(r.known).toHaveLength(30);
    expect(r.products).toHaveLength(30); // all 30 known, no budget left for new ones
    for (let i = 0; i < 30; i++) expect(r.products.map(idOf)).toContain(url(i));
  });

  test("the remaining budget goes to new items", () => {
    const known = new Set([url(0), url(1)]);
    const r = partitionKnownFirst(items(50), idOf, known, 10);
    expect(r.products).toHaveLength(10); // 2 known + 8 new
    expect(r.products.slice(0, 2).map(idOf)).toEqual([url(0), url(1)]);
  });

  test("with nothing known it behaves exactly like a plain cap", () => {
    const r = partitionKnownFirst(items(50), idOf, new Set(), 10);
    expect(r.products).toHaveLength(10);
    expect(r.products.map(idOf)).toEqual(items(10).map(idOf));
  });

  test("a cap larger than the catalogue takes everything", () => {
    expect(partitionKnownFirst(items(5), idOf, new Set(), 60).products).toHaveLength(5);
  });

  test("URL churn (trailing slash, query, case) still counts as known", () => {
    const known = new Set(["https://x.co.uk/product/p0"]);
    const r = partitionKnownFirst(
      [{ permalink: "https://X.co.uk/product/P0/?utm_source=fb" }], idOf, known, 0,
    );
    expect(r.known).toHaveLength(1);
    expect(r.products).toHaveLength(1); // survives even a zero budget
  });

  test("a zero cap still re-reads everything already published", () => {
    const known = new Set([url(0), url(1)]);
    const r = partitionKnownFirst(items(10), idOf, known, 0);
    expect(r.products).toHaveLength(2);
    expect(r.fresh).toHaveLength(8);
  });

  test("empty input is safe", () => {
    expect(partitionKnownFirst([], idOf, new Set(), 10).products).toEqual([]);
  });

  // ⚠️ The partition can only re-check a published row if that row is in the FEED at all.
  // Fetching products.json with `limit = perOp + 4` made it inert for exactly the operators
  // it exists for — the ones with more live products than the per-run cap.
  test("the shopify feed is fetched at the API maximum, not the per-run cap", () => {
    expect(SHOPIFY_FEED_LIMIT).toBe(250);
  });
});
