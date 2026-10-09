// usage-watch.mjs end to end against a fake PostgREST: the request shapes it sends, the snapshot
// it writes, and the exit code the workflow step branches on (0 ok · 2 warn · 1 red · 3 no signal).
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "usage-watch.mjs");
const DAY = 864e5;

function fakeSupabase({ installed = true, counter, history = [] }) {
  const writes = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.headers.get("apikey") !== "svc") return new Response("no key", { status: 401 });
      if (!installed) return Response.json({ code: "PGRST202", message: "Could not find the function" }, { status: 404 });
      if (u.pathname === "/rest/v1/rpc/api_request_total" && req.method === "POST") return Response.json([counter]);
      if (u.pathname === "/rest/v1/usage_snapshots" && req.method === "POST") { writes.push(await req.json()); return new Response(null, { status: 201 }); }
      if (u.pathname === "/rest/v1/usage_snapshots" && req.method === "GET") return Response.json([...history, ...writes]);
      return new Response("unexpected", { status: 500 });
    },
  });
  return { server, writes, url: `http://localhost:${server.port}` };
}

async function run(fake, env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "usage-watch-"));
  const p = Bun.spawn(["bun", SCRIPT], { cwd, env: { ...process.env, SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: "svc", ...env }, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  fake.server.stop(true);
  return { code, md: readFileSync(join(cwd, "usage-watch.md"), "utf8") };
}

const reset = new Date(Date.now() - 30 * DAY).toISOString();
const yesterday = (anon) => ({ taken_at: new Date(Date.now() - DAY).toISOString(), rest_anon: anon, rest_service: 0, rest_authenticated: 0, storage: 0, stats_reset: reset });

describe("usage-watch.mjs", () => {
  test("not installed → a note, exit 3 (no signal: neither alarms nor clears an open alarm)", async () => {
    const r = await run(fakeSupabase({ installed: false }));
    expect(r.code).toBe(3);
    expect(r.md).toContain("not installed yet");
  });

  test("records a snapshot and stays quiet at low traffic", async () => {
    const fake = fakeSupabase({ counter: { rest_anon: 105000, rest_service: 1000, rest_authenticated: 0, storage: 0, stats_reset: reset }, history: [yesterday(100000)] });
    const r = await run(fake);
    expect(r.code).toBe(0);
    expect(fake.writes.length).toBe(1);
    expect(fake.writes[0].rest_anon).toBe(105000);
    expect(r.md).toContain("✅");
  });

  test("≥50% projected → exit 2 (the issue opens, the run stays green)", async () => {
    const r = await run(fakeSupabase({ counter: { rest_anon: 122000, rest_service: 0, rest_authenticated: 0, storage: 0, stats_reset: reset }, history: [yesterday(100000)] }));
    expect(r.code).toBe(2); // 22,000/day × 30 × 4,200 B = 2.77 GB = 55%
    expect(r.md).toContain("🟡");
  });

  test("≥80% projected → exit 1 (red)", async () => {
    const r = await run(fakeSupabase({ counter: { rest_anon: 140000, rest_service: 0, rest_authenticated: 0, storage: 0, stats_reset: reset }, history: [yesterday(100000)] }));
    expect(r.code).toBe(1); // 40,000/day → 5.04 GB = 101%
    expect(r.md).toContain("🔴");
  });

  test("the calibration figure comes from the environment", async () => {
    const r = await run(fakeSupabase({ counter: { rest_anon: 122000, rest_service: 0, rest_authenticated: 0, storage: 0, stats_reset: reset }, history: [yesterday(100000)] }), { USAGE_BYTES_PER_REQUEST: "1000" });
    expect(r.code).toBe(0); // 22,000 × 30 × 1,000 = 0.66 GB
  });
});
