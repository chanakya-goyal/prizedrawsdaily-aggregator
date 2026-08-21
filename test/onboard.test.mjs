import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { draftEntry, detectPlatform, summariseRun, runDryRun, main } from "../discovery/onboard.mjs";

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });
const notFound = () => new Response("nf", { status: 404 });

// ---- draftEntry -----------------------------------------------------------------------------
// NOTE on the brief's Step-1 snippet: it proposed a fallback shape {name, slug, url, methods}.
// Real operators.json entries (checked: 7Days Performance, All Star Prizes, ...) and
// discovery/approve.mjs#buildOperatorConfig — which builds this exact kind of entry from a
// probed discovery candidate — both use {name, slug, base, method}: `base` not `url`, `method`
// singular (a string) not `methods` (an array). Adapted the expectations below to match reality,
// per the brief's own instruction to do so when reality differs from its fallback shape.
describe("draftEntry", () => {
  test("woo entry shape matches operators.json reality (base/method, not url/methods)", () => {
    const e = draftEntry({ url: "https://example-comps.co.uk", platform: "woo", name: "Example Comps" });
    expect(e).toEqual({ name: "Example Comps", slug: "example-comps", base: "https://example-comps.co.uk", method: "woo" });
  });
  test("render entry gets the render method", () => {
    expect(draftEntry({ url: "https://x.co.uk", platform: "render", name: "X" }).method).toBe("render");
  });
  test("shopify entry gets the shopify method", () => {
    expect(draftEntry({ url: "https://y.com", platform: "shopify", name: "Y" }).method).toBe("shopify");
  });
  test("slug derives from the hostname, stripping www / UK-TLD / punctuation", () => {
    expect(draftEntry({ url: "https://www.Big-Raffle.co.uk", platform: "woo", name: "Big Raffle" }).slug).toBe("big-raffle");
  });
  test("a trailing slash on the URL is stripped from base", () => {
    expect(draftEntry({ url: "https://example-comps.co.uk/", platform: "woo", name: "Example Comps" }).base).toBe("https://example-comps.co.uk");
  });
  test("name defaults to a title-cased slug when omitted", () => {
    expect(draftEntry({ url: "https://acme-draws.co.uk", platform: "woo" }).name).toBe("Acme Draws");
  });
  test("an explicit slug override is honoured", () => {
    const e = draftEntry({ url: "https://example-comps.co.uk", platform: "woo", name: "Example Comps", slug: "custom-slug" });
    expect(e.slug).toBe("custom-slug");
  });
});

// ---- detectPlatform ---------------------------------------------------------------------------
describe("detectPlatform", () => {
  test("woo: store API answers with a JSON array", async () => {
    const fetchImpl = async (url) => (url.includes("/wp-json/wc/store/v1/products") ? jsonResponse([{ id: 1, name: "Win a GT3" }]) : notFound());
    expect(await detectPlatform("https://example.co.uk", { fetchImpl })).toBe("woo");
  });
  test("shopify: falls through to products.json when the woo probe 404s", async () => {
    const fetchImpl = async (url) => (url.includes("/products.json") ? jsonResponse({ products: [{ id: 1, title: "Rolex draw" }] }) : notFound());
    expect(await detectPlatform("https://example.com", { fetchImpl })).toBe("shopify");
  });
  test("render: neither probe answers usefully", async () => {
    expect(await detectPlatform("https://example.org", { fetchImpl: async () => notFound() })).toBe("render");
  });
  test("render: a probe that throws (network error / timeout) doesn't propagate — falls back cleanly", async () => {
    const fetchImpl = async () => { throw new Error("boom"); };
    expect(await detectPlatform("https://dead.co.uk", { fetchImpl })).toBe("render");
  });
  test("an empty shopify products array still counts as shopify (platform shape, not liveness)", async () => {
    const fetchImpl = async (url) => (url.includes("/products.json") ? jsonResponse({ products: [] }) : notFound());
    expect(await detectPlatform("https://example.com", { fetchImpl })).toBe("shopify");
  });
  test("probes hit the cheap per_page=1 / limit=1 endpoints, in woo-then-shopify order", async () => {
    const seen = [];
    const fetchImpl = async (url) => { seen.push(url); return notFound(); };
    await detectPlatform("https://example.co.uk", { fetchImpl });
    expect(seen).toEqual([
      "https://example.co.uk/wp-json/wc/store/v1/products?per_page=1",
      "https://example.co.uk/products.json?limit=1",
    ]);
  });
  test("strips a trailing slash off the base before probing", async () => {
    const seen = [];
    const fetchImpl = async (url) => { seen.push(url); return notFound(); };
    await detectPlatform("https://example.co.uk/", { fetchImpl });
    expect(seen[0]).toBe("https://example.co.uk/wp-json/wc/store/v1/products?per_page=1");
  });
});

// ---- summariseRun: the dry-run verdict (pure — no spawning) -----------------------------------
// Fixtures reproduce run.mjs's REAL console formats verbatim: the ✅ / ⏭ per-draw lines and the
// health-report table are read straight from run.mjs + lib/manager.mjs#reportMarkdown; the
// categories-gate block was captured live from `ONLY=all-star-prizes DRY_RUN=true bun run.mjs`
// against prod on 2026-08-21 (see task-13-report.md).
describe("summariseRun", () => {
  const entry = { name: "Example Comps", slug: "example-comps", base: "https://example-comps.co.uk", method: "woo" };

  test("READY: every scraped draw passed the gate and resolved a category", () => {
    const stdout = [
      "DRY RUN — 2026-08-21T00:00:00.000Z | keyless | methods all | batch 1/1 | 1 operators | PER_OP 5 | status 'draft'",
      "",
      "loaded 8 cats, 120 operators, 4000 existing draws",
      "",
      "── Example Comps (woo) ──",
      "  ✅ Win a Porsche 911 | car-draws | £2×20000",
      "  ✅ £5,000 Cash | cash-prizes | £1×15000",
      "",
      "",
      "==== 2 new, 0 refreshed (2 pages read, 0 skipped) ====",
      "(dry run — nothing written)",
      "",
      "## Aggregator health report",
      "",
      "**Totals:** scraped 2 · inserted 2 · published 0 · held-draft 2",
      "",
      "| operator | scraped | inserted | published | draft |",
      "|---|---|---|---|---|",
      "| example-comps | 2 | 2 | 0 | 2 |",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr: "", exitCode: 0 });
    expect(s.verdict).toBe("READY");
    expect(s.scraped).toBe(2);
    expect(s.gatePassed).toBe(2);
    expect(s.gateFailed).toBe(0);
    expect(s.categories).toEqual({ "car-draws": 1, "cash-prizes": 1 });
    expect(s.needsClaude).toBe(0);
  });

  test("NEEDS-CONFIG: a draw resolves no category (null → needs Claude) and one fails the gate", () => {
    const stdout = [
      "DRY RUN — ... | 1 operators | ...",
      "── Example Comps (woo) ──",
      "  ✅ Win a Porsche 911 | car-draws | £2×20000",
      "  ✅ Mystery Bundle | null | £2×5000",
      "  ⏭  Free Entry Promo — business: no/zero ticket price",
      "==== 2 new, 0 refreshed (3 pages read, 1 skipped) ====",
      "(dry run — nothing written)",
      "| operator | scraped | inserted | published | draft |",
      "|---|---|---|---|---|",
      "| example-comps | 3 | 2 | 0 | 2 |",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr: "", exitCode: 0 });
    expect(s.verdict).toBe("NEEDS-CONFIG");
    expect(s.needsClaude).toBe(1);
    expect(s.categories).toEqual({ "car-draws": 1, "null": 1 });
    expect(s.gateFailed).toBe(1);
    expect(s.gateFailReasons).toEqual({ "business: no/zero ticket price": 1 });
  });

  test("BLOCKED: no draws found at all", () => {
    const stdout = [
      "DRY RUN — ... | 1 operators | ...",
      "── Example Comps (woo) ──",
      "==== 0 new, 0 refreshed (0 pages read, 0 skipped) ====",
      "(dry run — nothing written)",
      "| operator | scraped | inserted | published | draft |",
      "|---|---|---|---|---|",
      "| example-comps | 0 | 0 | 0 | 0 |",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr: "", exitCode: 0 });
    expect(s.verdict).toBe("BLOCKED(no draws found on the site — check the detected platform/method)");
  });

  test("BLOCKED: draws were found but every one failed the gate", () => {
    const stdout = [
      "── Example Comps (woo) ──",
      "  ⏭  Bad Draw One — required: missing draw_date",
      "  ⏭  Bad Draw Two — required: missing draw_date",
      "==== 0 new, 0 refreshed (2 pages read, 2 skipped) ====",
      "| operator | scraped | inserted | published | draft |",
      "|---|---|---|---|---|",
      "| example-comps | 2 | 0 | 0 | 0 |",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr: "", exitCode: 0 });
    expect(s.verdict).toBe("BLOCKED(all 2 scraped draw(s) failed the gate)");
    expect(s.gateFailReasons).toEqual({ "required: missing draw_date": 2 });
  });

  test("BLOCKED: operator not yet in the operators DB table", () => {
    const stdout = [
      "DRY RUN — ... | 1 operators | ...",
      "· Example Comps: not in DB, skip",
      "",
      "",
      "==== 0 new, 0 refreshed (0 pages read, 0 skipped) ====",
      "(dry run — nothing written)",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr: "", exitCode: 0 });
    expect(s.notInDb).toBe(true);
    expect(s.verdict).toContain("BLOCKED(operator not yet in the operators DB table");
  });

  test("BLOCKED: the categories-table startup gate (captured live 2026-08-21 against prod)", () => {
    const stdout = "DRY RUN — 2026-08-21T08:09:29.974Z | keyless | methods all | batch 1/1 | 1 operators | PER_OP 5 | status 'draft'\n\n";
    const stderr = [
      "✖ categories table is missing 2 slug(s) the classifier can assign:",
      "    · sports-outdoors",
      "    · home-garden",
      "  Apply supabase/migrations/20260821200000_sports_home_categories.sql in the site repo",
      "  (it adds the missing categories rows AND draws.category_source), then re-run.",
      "",
    ].join("\n");
    const s = summariseRun({ entry, stdout, stderr, exitCode: 1 });
    expect(s.verdict).toContain("BLOCKED(categories table missing");
    expect(s.verdict).toContain("sports-outdoors");
    expect(s.verdict).toContain("home-garden");
  });

  test("BLOCKED: generic nonzero exit with no recognisable reason", () => {
    const s = summariseRun({ entry, stdout: "", stderr: "TypeError: something.blew.up", exitCode: 1 });
    expect(s.verdict).toBe("BLOCKED(run.mjs exited 1)");
  });

  test("BLOCKED: the spawn itself failed", () => {
    const s = summariseRun({ entry, stdout: "", stderr: "", exitCode: null, spawnError: "bun: command not found" });
    expect(s.verdict).toBe("BLOCKED(spawn failed: bun: command not found)");
  });
});

// ---- runDryRun: temp-file + spawn wiring, fully mocked (no real subprocess, no network) -------
describe("runDryRun", () => {
  const entry = { name: "Example Comps", slug: "example-comps", base: "https://example-comps.co.uk", method: "woo" };
  const freshTmpPath = () => `/tmp/onboard-rdr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

  test("writes the temp operators file before spawning, spawns with the right env/cwd, then cleans up", async () => {
    const tmpPath = freshTmpPath();
    let seenCmd = null, seenEnv = null, seenCwd = null, seenFileContent = null;
    const spawnImpl = (cmd, opts) => {
      seenCmd = cmd; seenEnv = opts.env; seenCwd = opts.cwd;
      seenFileContent = JSON.parse(readFileSync(tmpPath, "utf8")); // file must exist BEFORE spawn
      return { stdout: Buffer.from("fake stdout"), stderr: Buffer.from(""), exitCode: 0 };
    };
    const result = await runDryRun(entry, [entry], tmpPath, { spawnImpl, cwd: "/tmp" });

    expect(seenCmd).toEqual(["bun", "run.mjs"]);
    expect(seenEnv.ONLY).toBe("example-comps");
    expect(seenEnv.DRY_RUN).toBe("true");
    expect(seenEnv.AUTO_PUBLISH).toBe("false");
    expect(seenEnv.OPERATORS_FILE).toBe(tmpPath);
    expect(seenCwd).toBe("/tmp");
    expect(seenFileContent).toEqual([entry]);
    expect(result).toEqual({ stdout: "fake stdout", stderr: "", exitCode: 0, spawnError: null });
    expect(existsSync(tmpPath)).toBe(false); // cleaned up after
  });

  test("cleans up the temp file even when the spawn throws", async () => {
    const tmpPath = freshTmpPath();
    const spawnImpl = () => { throw new Error("bun: command not found"); };
    const result = await runDryRun(entry, [entry], tmpPath, { spawnImpl, cwd: "/tmp" });
    expect(result.spawnError).toBe("bun: command not found");
    expect(result.exitCode).toBeNull();
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("never writes to the real repo operators.json", async () => {
    const tmpPath = freshTmpPath();
    const spawnImpl = () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 });
    await runDryRun(entry, [entry], tmpPath, { spawnImpl, cwd: "/tmp" });
    const real = await Bun.file(new URL("../operators.json", import.meta.url)).json();
    expect(real.some((o) => o.slug === "example-comps")).toBe(false);
  });
});

// ---- main: end-to-end wiring, fetch + spawn both mocked (no real network, no real subprocess) -
describe("main", () => {
  test("detects platform, drafts the entry, dry-runs it, and writes the report — without touching the real operators.json", async () => {
    const fetchImpl = async () => new Response("nf", { status: 404 }); // → render
    const spawnImpl = (cmd, opts) => {
      expect(opts.env.ONLY).toBe("onboard-test-fixture");
      expect(opts.env.OPERATORS_FILE).toBeTruthy();
      const stdout = [
        "── Onboard Test Fixture (render) ──",
        "  ✅ Some Draw | tech-giveaways | £2×1000",
        "==== 1 new, 0 refreshed (1 pages read, 0 skipped) ====",
        "| operator | scraped | inserted | published | draft |",
        "|---|---|---|---|---|",
        "| onboard-test-fixture | 1 | 1 | 0 | 0 |",
      ].join("\n");
      return { stdout: Buffer.from(stdout), stderr: Buffer.from(""), exitCode: 0 };
    };

    const reportUrl = new URL("../discovery/onboard-onboard-test-fixture.json", import.meta.url);
    try {
      const report = await main({ argv: ["https://onboard-test-fixture.co.uk"], fetchImpl, spawnImpl });
      expect(report.platform).toBe("render");
      expect(report.entry).toEqual({ name: "Onboard Test Fixture", slug: "onboard-test-fixture", base: "https://onboard-test-fixture.co.uk", method: "render" });
      expect(report.dryRun.verdict).toBe("READY");
      expect(report.rawOutputTail).toContain("Some Draw"); // raw evidence kept alongside the parsed verdict
      expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const onDisk = await Bun.file(reportUrl).json();
      expect(onDisk.entry.slug).toBe("onboard-test-fixture");
      expect(onDisk.dryRun.verdict).toBe("READY");

      const real = await Bun.file(new URL("../operators.json", import.meta.url)).json();
      expect(real.some((o) => o.slug === "onboard-test-fixture")).toBe(false);
    } finally {
      try { unlinkSync(fileURLToPath(reportUrl)); } catch { /* nothing to remove */ }
    }
  });

  test("prints usage and exits nonzero when no URL is given", async () => {
    const result = await main({ argv: [] });
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // don't fail the test runner's own exit code
  });
});
