import { test, expect, describe } from "bun:test";
import { weservUrl, shouldSkip, WEBP_W, WEBP_Q } from "../lib/compress.mjs";

const obj = (over = {}) => ({ name: "x.png", id: "abc", metadata: { size: 900_000, mimetype: "image/png" }, ...over });

describe("weservUrl", () => {
  test("points at weserv and encodes the target into ?url=", () => {
    const u = weservUrl("https://cdn.test/a/b.png");
    expect(u.startsWith("https://images.weserv.nl/?url=")).toBe(true);
    expect(u).toContain(encodeURIComponent("cdn.test/a/b.png"));
  });

  test("strips the scheme — weserv wants host+path, not https://", () => {
    // encodeURIComponent("https://") === "https%3A%2F%2F"; its absence proves the strip.
    expect(weservUrl("https://cdn.test/b.png")).not.toContain("https%3A%2F%2F");
    expect(weservUrl("http://cdn.test/b.png")).not.toContain("http%3A%2F%2F");
  });

  test("always requests webp at the default width/quality", () => {
    const u = weservUrl("https://cdn.test/b.png");
    expect(u).toContain("output=webp");
    expect(u).toContain(`w=${WEBP_W}`);
    expect(u).toContain(`q=${WEBP_Q}`);
  });

  test("width and quality are overridable", () => {
    const u = weservUrl("https://cdn.test/b.png", { w: 640, q: 60 });
    expect(u).toContain("w=640");
    expect(u).toContain("q=60");
  });

  test("percent-encodes spaces and & in the source path so params can't be injected", () => {
    const u = weservUrl("https://cdn.test/a b&w=9999.png");
    expect(u).toContain("%20");
    expect(u).toContain("%26");
    // exactly one w= param — the one we appended, not one smuggled in from the path
    expect(u.split("&w=").length - 1).toBe(1);
  });

  test("returns null for a missing or non-http url", () => {
    expect(weservUrl("")).toBeNull();
    expect(weservUrl(null)).toBeNull();
    expect(weservUrl("data:image/png;base64,AAAA")).toBeNull();
  });
});

describe("shouldSkip", () => {
  test("a big non-webp object is compressed", () => expect(shouldSkip(obj())).toBe(false));

  test("already webp is skipped — makes the backfill re-runnable", () => {
    expect(shouldSkip(obj({ metadata: { size: 900_000, mimetype: "image/webp" } }))).toBe(true);
  });

  test("already small is skipped — nothing left to win", () => {
    expect(shouldSkip(obj({ metadata: { size: 120_000, mimetype: "image/png" } }))).toBe(true);
  });

  test("minBytes threshold is overridable", () => {
    expect(shouldSkip(obj({ metadata: { size: 300_000, mimetype: "image/png" } }), { minBytes: 500_000 })).toBe(true);
    expect(shouldSkip(obj({ metadata: { size: 300_000, mimetype: "image/png" } }), { minBytes: 100_000 })).toBe(false);
  });

  test("a folder entry (id === null) is skipped", () => {
    expect(shouldSkip({ name: "some-operator", id: null, metadata: null })).toBe(true);
  });

  test("missing metadata is skipped rather than throwing", () => {
    expect(shouldSkip(obj({ metadata: undefined }))).toBe(true);
    expect(shouldSkip(obj({ metadata: { mimetype: "image/png" } }))).toBe(true);
  });
});
