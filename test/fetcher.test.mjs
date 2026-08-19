import { test, expect, describe } from "bun:test";
import { unwrapBrowserJson } from "../lib/fetcher.mjs";

// Cloudflare-blocked WooCommerce operators can only be reached through FlareSolverr, but
// FlareSolverr returns what the BROWSER rendered. Chrome's JSON viewer wraps a JSON body in
// <pre>, so wooOperator's JSON.parse(text) throws inside a catch that swallows it, and the
// operator silently reports zero draws. These tests pin the unwrap that makes the "plain" and
// "flaresolverr" strategies genuinely interchangeable.
describe("unwrapBrowserJson", () => {
  const payload = '[{"id":1,"name":"Win a BMW","is_purchasable":true}]';

  test("extracts JSON from Chrome's <pre> JSON viewer", () => {
    const html = `<html><head></head><body><pre style="word-wrap: break-word;">${payload}</pre></body></html>`;
    expect(unwrapBrowserJson(html)).toBe(payload);
    expect(JSON.parse(unwrapBrowserJson(html))[0].name).toBe("Win a BMW");
  });

  test("strips the syntax-colour spans the viewer injects", () => {
    const html = `<body><pre><span class="s">[{</span><span>"id":1,"name":"Win a BMW","is_purchasable":true</span><span>}]</span></pre></body>`;
    expect(JSON.parse(unwrapBrowserJson(html))[0].id).toBe(1);
  });

  test("decodes the entities the viewer escapes", () => {
    const html = `<body><pre>[{&quot;name&quot;:&quot;Win a BMW &amp; £2,000&quot;}]</pre></body>`;
    expect(JSON.parse(unwrapBrowserJson(html))[0].name).toBe("Win a BMW & £2,000");
  });

  test("handles an object body, not just an array", () => {
    const html = `<body><pre>{"products":[{"id":9}]}</pre></body>`;
    expect(JSON.parse(unwrapBrowserJson(html)).products[0].id).toBe(9);
  });

  test("passes raw JSON straight through untouched", () => {
    expect(unwrapBrowserJson(payload)).toBe(payload);
  });

  // The critical safety property: a genuine product PAGE must never be mangled, because the
  // same fetcher serves HTML to the render path.
  test("leaves real HTML alone", () => {
    const page = `<html><body><h1>Win a BMW</h1><pre>some preformatted text</pre></body></html>`;
    expect(unwrapBrowserJson(page)).toBe(page);
  });

  test("leaves HTML whose <pre> is not valid JSON alone", () => {
    const page = `<html><body><pre>{not really json}</pre></body></html>`;
    expect(unwrapBrowserJson(page)).toBe(page);
  });

  test("empty and missing input are safe", () => {
    expect(unwrapBrowserJson("")).toBe("");
    expect(unwrapBrowserJson(null)).toBe(null);
    expect(unwrapBrowserJson(undefined)).toBe(undefined);
  });
});
