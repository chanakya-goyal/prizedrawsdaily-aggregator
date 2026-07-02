import { test, expect } from "bun:test";
import { withRetry, fetchOk } from "../util.mjs";

test("withRetry retries then succeeds", async () => {
  let n = 0;
  const out = await withRetry(async () => {
    if (++n < 3) throw new Error("transient");
    return "ok";
  }, { tries: 3, baseMs: 1 });
  expect(out).toBe("ok");
  expect(n).toBe(3);
});

test("withRetry exhausts and rethrows with label", async () => {
  let n = 0;
  await expect(withRetry(async () => { n++; throw new Error("boom"); },
    { tries: 2, baseMs: 1, label: "supabase" })).rejects.toThrow(/supabase.*boom/);
  expect(n).toBe(2);
});

test("fetchOk throws on !ok with status and body", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  try {
    await expect(fetchOk("https://x.test/", {}, "upload")).rejects.toThrow(/upload 401: bad key/);
  } finally { globalThis.fetch = orig; }
});
