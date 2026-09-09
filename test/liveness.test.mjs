import { test, expect, describe } from "bun:test";
import { isPurchasable, hasAvailableVariant, productSlug, isPercentLiteralSlug, permalinkKey, pickProductForUrl, FINISHED_RE, saysFinished } from "../lib/liveness.mjs";

describe("isPurchasable — the Woo Store API type bug", () => {
  test("boolean true/false behave as expected", () => {
    expect(isPurchasable({ is_purchasable: true })).toBe(true);
    expect(isPurchasable({ is_purchasable: false })).toBe(false);
  });

  // The regression this module exists for. gaming-giveaways returns the NUMBER 0 for
  // finished comps (page 4 = 100/100 of them). `0 !== false` kept them as live in the
  // scraper; `0 === false` stopped ended-sweep from ever expiring them.
  test("NUMBER 0 is not live", () => {
    expect(isPurchasable({ is_purchasable: 0 })).toBe(false);
  });
  test("number 1 is live", () => {
    expect(isPurchasable({ is_purchasable: 1 })).toBe(true);
  });
  test("string forms are not live", () => {
    for (const v of ["0", "false", "False", "FALSE", "no", "off", " 0 "]) {
      expect(isPurchasable({ is_purchasable: v })).toBe(false);
    }
  });
  test("string 'true'/'1' are live", () => {
    expect(isPurchasable({ is_purchasable: "true" })).toBe(true);
    expect(isPurchasable({ is_purchasable: "1" })).toBe(true);
  });
  test("an ABSENT flag stays live — absence is not evidence of closure", () => {
    expect(isPurchasable({})).toBe(true);
    expect(isPurchasable({ is_purchasable: undefined })).toBe(true);
    expect(isPurchasable({ is_purchasable: null })).toBe(true);
  });
  test("a missing product object does not throw", () => {
    expect(isPurchasable(null)).toBe(true);
    expect(isPurchasable(undefined)).toBe(true);
  });
});

describe("hasAvailableVariant (shopify)", () => {
  test("true when any variant is available", () => {
    expect(hasAvailableVariant({ variants: [{ available: false }, { available: true }] })).toBe(true);
  });
  test("false when none are, or the list is missing", () => {
    expect(hasAvailableVariant({ variants: [{ available: false }] })).toBe(false);
    expect(hasAvailableVariant({ variants: [] })).toBe(false);
    expect(hasAvailableVariant({})).toBe(false);
  });
  test("only a strict true counts — a truthy string is not availability", () => {
    expect(hasAvailableVariant({ variants: [{ available: "yes" }] })).toBe(false);
  });
});

describe("productSlug", () => {
  test("takes the last path segment, ignoring trailing slash and query", () => {
    expect(productSlug("https://x.co.uk/product/win-a-bmw-9/")).toBe("win-a-bmw-9");
    expect(productSlug("https://x.co.uk/competition/abc?utm=1#z")).toBe("abc");
  });

  // Woo stores the percent escapes VERBATIM in product.slug, so the raw segment is the
  // matching form. Decoding it would match nothing.
  test("does NOT decode percent-escapes — Woo stores them literally", () => {
    expect(productSlug("https://easylivingcompetitions.co.uk/product/%f0%9f%8e%b0-33-for-33-instant-wins/"))
      .toBe("%f0%9f%8e%b0-33-for-33-instant-wins");
  });
  test("empty / missing input is safe", () => {
    expect(productSlug("")).toBe("");
    expect(productSlug(null)).toBe("");
  });
});

describe("isPercentLiteralSlug — flags slugs ?slug= cannot resolve", () => {
  test("true for emoji-derived slugs", () => {
    expect(isPercentLiteralSlug("%f0%9f%92%b7-win-200-cash-super-low-odds-5")).toBe(true);
  });
  test("false for ordinary ascii slugs", () => {
    expect(isPercentLiteralSlug("dino-doors")).toBe(false);
    expect(isPercentLiteralSlug("win-a-bmw-m2-210826")).toBe(false);
  });
  test("safe on empty input", () => {
    expect(isPercentLiteralSlug("")).toBe(false);
    expect(isPercentLiteralSlug(null)).toBe(false);
  });
});

describe("permalinkKey — matches a stored entry_url to a product permalink", () => {
  test("ignores trailing slash, query, fragment and case", () => {
    const a = permalinkKey("https://X.co.uk/product/Win-A-BMW/");
    expect(permalinkKey("https://x.co.uk/product/win-a-bmw")).toBe(a);
    expect(permalinkKey("https://x.co.uk/product/win-a-bmw/?utm_source=fb")).toBe(a);
    expect(permalinkKey("https://x.co.uk/product/win-a-bmw#enter")).toBe(a);
  });
  test("keeps genuinely different products apart", () => {
    expect(permalinkKey("https://x.co.uk/product/a")).not.toBe(permalinkKey("https://x.co.uk/product/b"));
  });
  test("safe on empty input", () => {
    expect(permalinkKey(null)).toBe("");
  });
});

describe("FINISHED_RE", () => {
  // Moved verbatim from ended-sweep.mjs — these lock its EXISTING contract so the move is
  // provably behaviour-preserving. Deliberately not widened here: loosening the match is a
  // separate decision (it would start expiring draws), not a side effect of relocating it.
  test("matches the common finished phrasings", () => {
    for (const s of [
      "This competition has now finished",
      "This competition has finished",
      "The competition is now closed",
      "this draw has ended",
      "This draw has now closed",
    ]) {
      expect(FINISHED_RE.test(s)).toBe(true);
    }
  });
  test("does not match ordinary live copy", () => {
    expect(FINISHED_RE.test("Enter now before this competition sells out!")).toBe(false);
  });
  // Known gap, documented rather than silently fixed: the bare two-word form needs "is".
  test("bare 'Competition closed' is NOT matched (needs 'is')", () => {
    expect(FINISHED_RE.test("Competition closed")).toBe(false);
  });
});

describe("saysFinished — the marker must come from VISIBLE text", () => {
  // The 2026-08-26 regression. wc-lottery ships an i18n string bundle on every page it
  // renders, live or finished, and the bundle carries the literal finished phrase. Testing
  // raw HTML expired every draw on those operators ~38 minutes after ingest; 42 were found
  // at status='ended' with a draw_date still in the future.
  const WC_LOTTERY_I18N = `<!doctype html><html><head>
    <script id="wc-lottery-i18n" type="application/json">
      {"sold_out":"Sold out","finished":"This competition has finished","closing":"Closing soon"}
    </script></head>
    <body><h1>Win a Range Rover Sport</h1><p>Only 4,000 tickets. Entry from £4.00.</p>
    <button>Add to basket</button></body></html>`;

  test("a finished phrase inside <script> does NOT count as finished", () => {
    expect(FINISHED_RE.test(WC_LOTTERY_I18N)).toBe(true);   // the raw-HTML bug, still reproducible
    expect(saysFinished(WC_LOTTERY_I18N)).toBe(false);      // the fix
  });

  test("a finished phrase in <template> or <noscript> does NOT count either", () => {
    expect(saysFinished(`<body><template><p>This competition has finished</p></template>
      <h1>Win a Rolex</h1></body>`)).toBe(false);
    expect(saysFinished(`<body><noscript>This competition has finished</noscript>
      <h1>Win a Rolex</h1></body>`)).toBe(false);
  });

  test("a finished phrase in real body copy DOES count", () => {
    expect(saysFinished(`<body><h1>Win a Rolex</h1>
      <p class="notice">This competition has now finished.</p></body>`)).toBe(true);
  });

  test("survives tags and entities splitting the phrase's surroundings", () => {
    expect(saysFinished(`<body><div><strong>Update:</strong>&nbsp;this draw has ended</div></body>`)).toBe(true);
  });

  test("ordinary live copy stays live, and empty input is not finished", () => {
    expect(saysFinished(`<body><p>Enter now before this competition sells out!</p></body>`)).toBe(false);
    expect(saysFinished("")).toBe(false);
    expect(saysFinished(null)).toBe(false);
  });
});

// ── The CloudFront cache-key bug ────────────────────────────────────────────────────────
// Measured on lucky-day-competitions 2026-09-09: `/wp-json/wc/store/v1/products?slug=…` sits
// behind a CDN that does NOT include the query string in its cache key, so ONE cached body is
// served for every slug — including a slug that does not exist. Within ten minutes the same
// endpoint returned, for EVERY slug asked:
//     age=16     → [ samsung-galaxy-s26… ]   (one real product, the wrong one)
//     age=15995  → [ ]                        (empty)
// ended-sweep took `arr[0]` on trust, so ~10 different draws were each bound to whichever
// product happened to be cached — and that product then decided their price (the audit
// proposed one identical ticket_price across all of them), their draw date, and, far worse,
// their PURCHASABILITY: one cached sold-out product would have expired the operator's entire
// live catalogue. Identity has to be checked; position in the array proves nothing.
describe("pickProductForUrl — never trust a product you did not ask for", () => {
  const ninjaUrl = "https://www.luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series/";
  const ninja = { slug: "ninja-luxe-cafe-pro-series", permalink: "https://luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series/" };
  const samsung = { slug: "samsung-galaxy-s26-256-gb", permalink: "https://luckydaycompetitions.com/product/samsung-galaxy-s26-256-gb/" };

  test("returns the product when the slug matches what we asked for", () => {
    expect(pickProductForUrl([ninja], ninjaUrl)).toBe(ninja);
  });

  // THE REGRESSION. A single wrong product is exactly what the cache serves.
  test("returns null when the ONLY product returned is a different one", () => {
    expect(pickProductForUrl([samsung], ninjaUrl)).toBe(null);
  });

  test("picks the matching product out of a multi-product response", () => {
    expect(pickProductForUrl([samsung, ninja], ninjaUrl)).toBe(ninja);
  });

  test("an empty response is null, not a throw", () => {
    expect(pickProductForUrl([], ninjaUrl)).toBe(null);
    expect(pickProductForUrl(null, ninjaUrl)).toBe(null);
    expect(pickProductForUrl(undefined, ninjaUrl)).toBe(null);
  });

  // operators.json holds the apex base while stored entry_urls carry www (lucky-day is exactly
  // this shape), so a strict permalink comparison would reject the CORRECT product and cost us
  // verification coverage on a real operator. Identity is the path, not the host.
  test("www vs apex on the permalink does not reject a correct product", () => {
    expect(pickProductForUrl([ninja], ninjaUrl)).toBe(ninja);
    const wwwPermalink = { slug: "ninja-luxe-cafe-pro-series", permalink: "https://www.luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series/" };
    expect(pickProductForUrl([wwwPermalink], "https://luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series")).toBe(wwwPermalink);
  });

  test("trailing slash and query string on the stored url do not matter", () => {
    expect(pickProductForUrl([ninja], "https://www.luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series?ref=fb")).toBe(ninja);
  });

  test("slug comparison is case-insensitive", () => {
    expect(pickProductForUrl([{ slug: "Ninja-Luxe-Cafe-Pro-Series" }], ninjaUrl)).toBeTruthy();
  });

  // Some Woo builds omit `slug` from the Store API payload; the permalink still identifies it.
  test("falls back to the permalink path when the product has no slug field", () => {
    const noSlug = { permalink: "https://luckydaycompetitions.com/product/ninja-luxe-cafe-pro-series/" };
    expect(pickProductForUrl([noSlug], ninjaUrl)).toBe(noSlug);
    expect(pickProductForUrl([{ permalink: "https://luckydaycompetitions.com/product/something-else/" }], ninjaUrl)).toBe(null);
  });

  test("a product carrying neither slug nor permalink can never match", () => {
    expect(pickProductForUrl([{ name: "Ninja Luxe Cafe Pro Series" }], ninjaUrl)).toBe(null);
  });
});
