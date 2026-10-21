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
