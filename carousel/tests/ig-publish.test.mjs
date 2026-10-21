import { test, expect } from "bun:test";
import { authHeaders, idOf, BASE } from "../ig-publish.mjs";

test("a consumer key (the hosted-MCP project) and a project key use different headers", () => {
  expect(authHeaders("ck_abc")).toHaveProperty("x-consumer-api-key", "ck_abc");
  expect(authHeaders("ak_abc")).toHaveProperty("x-api-key", "ak_abc");
  expect(() => authHeaders("")).toThrow(/COMPOSIO_API_KEY/);
});

test("the Graph id is found at any of Composio's wrapping depths", () => {
  expect(idOf({ data: { id: "1" } })).toBe("1");
  expect(idOf({ data: { data: { id: "2" } } })).toBe("2");
  expect(idOf({ data: { response_data: { id: "3" } } })).toBe("3");
  expect(idOf({ data: {} })).toBeNull();
});

test("calls go to the v3.1 API, where an omitted toolkit version means latest", () => {
  expect(BASE).toBe("https://backend.composio.dev/api/v3.1");
});

test("the Facebook caption drops the Instagram-only 'link in bio' and keeps everything else", async () => {
  const { fbCaption } = await import("../ig-publish.mjs");
  const reel = "£20 for a Rolex, via Bonkers Competitions 👀\n\nmore luxury prizes closing soon on prizedrawsdaily.co.uk, link in bio\n\nWe list draws. We run none.\n\n#ukcompetition";
  expect(fbCaption(reel)).toBe("£20 for a Rolex, via Bonkers Competitions 👀\n\nmore luxury prizes closing soon on prizedrawsdaily.co.uk\n\nWe list draws. We run none.\n\n#ukcompetition");
  const deck = "head\n\nlines\n\nwho\nT&Cs on each site\nlink in bio\n\n#tags";
  expect(fbCaption(deck)).toBe("head\n\nlines\n\nwho\nT&Cs on each site\n\n#tags");
  expect(fbCaption(reel)).toContain("via Bonkers Competitions");
});

test("a consumer-key call's answer is unwrapped from the MCP envelope; a failed tool throws", async () => {
  const { parseMcpResult } = await import("../ig-publish.mjs");
  const wrap = (o) => ({ result: { content: [{ type: "text", text: JSON.stringify(o) }] } });
  const ok = wrap({ successful: true, data: { results: [{ response: { successful: true, data: { id: "179" } }, tool_slug: "X", index: 0 }] } });
  expect(parseMcpResult(ok, "X")).toEqual({ successful: true, data: { id: "179" } });
  const bad = wrap({ successful: true, data: { results: [{ response: { successful: false, error: "Media ID is not available" }, tool_slug: "X" }] } });
  expect(() => parseMcpResult(bad, "X")).toThrow(/Media ID is not available/);
  expect(() => parseMcpResult({ error: { message: "nope" } }, "X")).toThrow(/nope/);
});
