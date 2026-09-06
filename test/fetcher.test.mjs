import { test, expect, describe } from "bun:test";
import { unwrapBrowserJson, isRetryableStatus, backoffMs, fetchWithRetry } from "../lib/fetcher.mjs";

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

// ---- retry policy ----
// The bug this fixes: a single transient refusal used to cost an operator its whole day,
// because extractor.mjs bails the operator when listing page 1 fails and nothing retried.
describe("isRetryableStatus", () => {
  test("retries the transient refusals we actually see", () => {
    for (const s of [403, 408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });
  test("never retries 451 — a legal geo-block cannot succeed on attempt two", () => {
    expect(isRetryableStatus(451)).toBe(false);
  });
  test("never retries a stable client-side answer", () => {
    for (const s of [400, 401, 404, 410, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
  test("a success is not a retry case", () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("backoffMs", () => {
  test("stays short — run.mjs's operator loop is serial, so delay is additive over ~105 operators", () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1500);
    expect(backoffMs(3)).toBe(4000);
  });
  test("is capped, so a long ladder can never eat RUN_DEADLINE_MIN", () => {
    expect(backoffMs(9)).toBe(4000);
  });
});

describe("fetchWithRetry", () => {
  const stub = (responses) => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(url);
      const next = responses[calls.length - 1];
      if (next instanceof Error) throw next;
      return new Response("body", { status: next });
    };
    return { calls, restore: () => { globalThis.fetch = orig; } };
  };
  // baseMs 0 keeps these tests instant — the policy under test is the retry COUNT, not the sleep.
  const fast = { baseMs: 0, maxMs: 0 };

  test("a transient 403 succeeds on the second attempt", async () => {
    const s = stub([403, 200]);
    try {
      const r = await fetchWithRetry("https://x.test/", {}, { ...fast });
      expect(r.status).toBe(200);
      expect(s.calls.length).toBe(2);
    } finally { s.restore(); }
  });

  test("gives up after the attempt budget and returns the last response, not a throw", async () => {
    const s = stub([403, 403, 403]);
    try {
      const r = await fetchWithRetry("https://x.test/", {}, { attempts: 3, ...fast });
      expect(r.status).toBe(403);
      expect(s.calls.length).toBe(3);
    } finally { s.restore(); }
  });

  test("a 451 is returned immediately — retrying a geo-block only burns the run's budget", async () => {
    const s = stub([451, 200]);
    try {
      const r = await fetchWithRetry("https://x.test/", {}, { ...fast });
      expect(r.status).toBe(451);
      expect(s.calls.length).toBe(1);
    } finally { s.restore(); }
  });

  test("a 404 is not retried", async () => {
    const s = stub([404, 200]);
    try {
      await fetchWithRetry("https://x.test/", {}, { ...fast });
      expect(s.calls.length).toBe(1);
    } finally { s.restore(); }
  });

  test("a network throw is retried, then rethrown if it never recovers", async () => {
    const s = stub([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    try {
      await expect(fetchWithRetry("https://x.test/", {}, { attempts: 2, ...fast })).rejects.toThrow("ECONNRESET");
      expect(s.calls.length).toBe(2);
    } finally { s.restore(); }
  });

  test("a network throw that recovers returns the good response", async () => {
    const s = stub([new Error("ECONNRESET"), 200]);
    try {
      const r = await fetchWithRetry("https://x.test/", {}, { ...fast });
      expect(r.status).toBe(200);
    } finally { s.restore(); }
  });
});

// The bug this guards: init built ONCE carries an AbortSignal.timeout that stays aborted after
// it fires, so a timed-out attempt made every retry abort instantly — the retry looked present
// and did nothing, on precisely the failure (a timeout) it was added to survive.
describe("fetchWithRetry — init freshness", () => {
  test("an init factory is re-invoked for every attempt", async () => {
    const orig = globalThis.fetch;
    const seen = [];
    let n = 0;
    globalThis.fetch = async (_url, init) => { seen.push(init.token); return new Response("", { status: ++n < 3 ? 503 : 200 }); };
    try {
      const r = await fetchWithRetry("https://x.test/", () => ({ token: seen.length }), { baseMs: 0, maxMs: 0 });
      expect(r.status).toBe(200);
      expect(seen).toEqual([0, 1, 2]); // a fresh init each time, not the same object reused
    } finally { globalThis.fetch = orig; }
  });

  test("a plain object init still works, for callers with no signal", async () => {
    const orig = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => new Response("", { status: ++n < 2 ? 503 : 200 });
    try {
      const r = await fetchWithRetry("https://x.test/", { headers: {} }, { baseMs: 0, maxMs: 0 });
      expect(r.status).toBe(200);
    } finally { globalThis.fetch = orig; }
  });
});
