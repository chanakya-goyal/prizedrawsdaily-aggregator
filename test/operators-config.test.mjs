// operators.json is the control surface for all 105 operators and had NO validation: a typo in
// `apiStyle`, an unknown `fetcher`, or a duplicated slug fails silently in production and shows
// up only as an operator that mysteriously scrapes nothing. This is the cheapest place to catch
// that — offline, no network, no Chromium, so it can safely gate the daily scrape.
import { test, expect, describe } from "bun:test";
import { KNOWN_FETCHERS } from "../lib/fetcher.mjs";

const raw = await Bun.file(new URL("../operators.json", import.meta.url)).json();
const operators = Array.isArray(raw) ? raw : raw.operators;

const METHODS = new Set(["api", "woo", "shopify", "render"]);
// Must match API_ADAPTERS in extractor.mjs; `rest_route` is the woo URL-form variant.
const API_STYLES = new Set(["raffle-engine", "hydra", "inertia", "click"]);
const WOO_STYLES = new Set(["rest_route"]);
// Every key the code reads, including the dormant escape hatches no entry currently uses —
// they are legitimate, so listing them keeps this test from blocking a valid future config.
const ALLOWED_KEYS = new Set([
  "name", "slug", "base", "method", "enabled", "aiAssist", "disabledReason", "apiStyle",
  "fetcher", "listing", "listApi", "drawPath", "drawMatch", "exclude", "wait", "maxLive",
  "category", "patterns", "selectors", "note", "insecureTLS", "maxPages", "lookbackDays",
  "apiLimit", "currency", "fetcherOpts",
]);

describe("operators.json integrity", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(operators)).toBe(true);
    expect(operators.length).toBeGreaterThan(0);
  });

  test("every entry has name, slug and a parseable base URL", () => {
    for (const o of operators) {
      expect(typeof o.name, `${o.slug}: name`).toBe("string");
      expect(o.name.length, `${o.slug}: name`).toBeGreaterThan(0);
      expect(typeof o.slug, `${JSON.stringify(o.name)}: slug`).toBe("string");
      expect(o.slug, `${o.name}: slug must be kebab-case`).toMatch(/^[a-z0-9-]+$/);
      expect(() => new URL(o.base), `${o.slug}: base "${o.base}"`).not.toThrow();
      expect(o.base, `${o.slug}: base must be http(s)`).toMatch(/^https?:\/\//);
    }
  });

  test("slugs are unique — a duplicate silently shadows an operator", () => {
    const seen = new Map();
    for (const o of operators) {
      expect(seen.has(o.slug), `duplicate slug "${o.slug}"`).toBe(false);
      seen.set(o.slug, true);
    }
  });

  test("base origins are unique — two entries scraping one site double-count it", () => {
    const seen = new Map();
    for (const o of operators) {
      const origin = new URL(o.base).origin.replace(/^https?:\/\/www\./, "https://");
      expect(seen.has(origin), `"${o.slug}" shares an origin with "${seen.get(origin)}"`).toBe(false);
      seen.set(origin, o.slug);
    }
  });

  test("method is one the dispatcher in run.mjs understands", () => {
    for (const o of operators) expect(METHODS.has(o.method), `${o.slug}: method "${o.method}"`).toBe(true);
  });

  test("method:'api' names an adapter that actually exists", () => {
    // Without this, a typo means apiOperator finds no adapter and the operator yields nothing.
    for (const o of operators.filter((x) => x.method === "api")) {
      expect(typeof o.apiStyle, `${o.slug}: method 'api' needs an apiStyle`).toBe("string");
      expect(API_STYLES.has(o.apiStyle), `${o.slug}: unknown apiStyle "${o.apiStyle}"`).toBe(true);
    }
  });

  test("method:'woo' only uses a known apiStyle variant", () => {
    for (const o of operators.filter((x) => x.method === "woo" && x.apiStyle)) {
      expect(WOO_STYLES.has(o.apiStyle), `${o.slug}: unknown woo apiStyle "${o.apiStyle}"`).toBe(true);
    }
  });

  test("fetcher is implemented — catches 'stealth', which is documented but does not exist", () => {
    // lib/fetcher.mjs's header describes a `stealth` strategy that was never built; setting it
    // silently degrades the operator to a plain fetch. Fail here rather than in production.
    for (const o of operators.filter((x) => x.fetcher)) {
      expect(KNOWN_FETCHERS.has(o.fetcher), `${o.slug}: fetcher "${o.fetcher}" has no implementation`).toBe(true);
    }
  });

  test("no unknown top-level keys — catches 'pattern' vs 'patterns'", () => {
    for (const o of operators) {
      for (const k of Object.keys(o)) {
        expect(ALLOWED_KEYS.has(k), `${o.slug}: unknown key "${k}"`).toBe(true);
      }
    }
  });

  test("regex overrides compile", () => {
    for (const o of operators) {
      if (o.drawMatch) expect(() => new RegExp(o.drawMatch), `${o.slug}: drawMatch`).not.toThrow();
      for (const [k, v] of Object.entries(o.patterns || {})) {
        expect(() => new RegExp(v), `${o.slug}: patterns.${k}`).not.toThrow();
      }
    }
  });

  // Deliberately NOT asserted: that every disabled operator carries a disabledReason. Four of
  // the six currently lack one (win-a-bundle, red-hot-raffles, the-birthday-draw, omaze). That
  // is a documentation gap, and this suite gates the daily scrape — blocking a day's inventory
  // over a missing comment would cost more than the comment is worth.
  test("enabled, when present, is a boolean", () => {
    for (const o of operators.filter((x) => "enabled" in x)) {
      expect(typeof o.enabled, `${o.slug}: enabled`).toBe("boolean");
    }
  });
});
