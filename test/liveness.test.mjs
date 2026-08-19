import { test, expect, describe } from "bun:test";
import { isPurchasable, hasAvailableVariant, productSlug, isPercentLiteralSlug, permalinkKey, FINISHED_RE } from "../lib/liveness.mjs";

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
