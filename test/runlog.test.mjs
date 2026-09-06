// These parse text that OTHER files produce, which is why they are tested here: when
// lib/manager.mjs started grouping silent operators by cause, topup.mjs's regex stopped
// matching and reported zero silent operators — no error, no warning, just a tool that
// quietly did nothing. The last test wires the real report generator to the real parser so
// that particular drift cannot happen again unnoticed.
import { test, expect, describe } from "bun:test";
import { blockedHosts, blockedNames, silentSlugs } from "../lib/runlog.mjs";
import { buildHealthReport, reportMarkdown } from "../lib/manager.mjs";

// `gh run view --log` prefixes every line; the parsers must survive it.
const withPrefix = (s) => s.split("\n").map((l) => `aggregate-json\tScrape\t2026-09-06T01:02:03.4Z ${l}`).join("\n");

describe("blockedHosts / blockedNames", () => {
  test("reads the woo 403 hostname, www-stripped and de-duplicated", () => {
    const log = withPrefix([
      "  woo API 403 for https://www.example-comps.co.uk/wp-json/wc/store/products",
      "  woo API 403 for https://example-comps.co.uk/wp-json/wc/store/products",
      "  woo API 403 for https://other.co.uk/x",
    ].join("\n"));
    expect(blockedHosts(log).sort()).toEqual(["example-comps.co.uk", "other.co.uk"]);
  });

  test("reads an operator that gave up after retrying", () => {
    const log = withPrefix("── Some Operator (render) ──\n  ⛔ blocked after retry");
    expect(blockedNames(log)).toEqual(["Some Operator"]);
  });

  test("finds nothing in a clean log", () => {
    expect(blockedHosts(withPrefix("all good"))).toEqual([]);
    expect(blockedNames(withPrefix("all good"))).toEqual([]);
  });
});

describe("silentSlugs", () => {
  const known = (t) => ["alpha", "beta", "gamma"].includes(t);

  test("reads the flat pre-2026-09 report line", () => {
    const log = withPrefix("⚠️ **Silent operators (0 draws — check selectors / blocked):** alpha, beta");
    expect(silentSlugs(log, known).sort()).toEqual(["alpha", "beta"]);
  });

  test("reads the current cause-grouped report", () => {
    const log = withPrefix([
      "⚠️ **Silent operators (0 draws) — 3 total**",
      "",
      "- **blocked (403 — refused our IP)** (2): alpha, beta",
      "- **unreachable (DNS/connection failed)** (1): gamma",
      "",
      "| operator | scraped | inserted | published | draft |",
      "| noise | 0 | 0 | 0 | 0 |",
    ].join("\n"));
    expect(silentSlugs(log, known).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("never invents a slug we have no config for", () => {
    const log = withPrefix("⚠️ **Silent operators (0 draws) — 1 total**\n\n- **blocked** (1): alpha, not-an-operator");
    expect(silentSlugs(log, known)).toEqual(["alpha"]);
  });

  test("merges both halves of the split scrape without duplicating", () => {
    const renderLog = withPrefix("⚠️ **Silent operators (0 draws) — 1 total**\n\n- **blocked** (1): alpha\n\n| operator |");
    const jsonLog = withPrefix("⚠️ **Silent operators (0 draws) — 2 total**\n\n- **blocked** (2): alpha, beta\n\n| operator |");
    expect(silentSlugs(renderLog + jsonLog, known).sort()).toEqual(["alpha", "beta"]);
  });

  test("round-trips the REPORT THE SCRAPER ACTUALLY WRITES", () => {
    // The regression guard: reportMarkdown is the producer, silentSlugs the consumer. If the
    // report's shape changes again, this fails here instead of in a tool nobody is watching.
    const md = reportMarkdown(buildHealthReport({
      counts: [
        { slug: "alpha", scraped: 0, silentReason: "blocked (403 — refused our IP)" },
        { slug: "beta", scraped: 0, silentReason: "blocked (403 — refused our IP)" },
        { slug: "gamma", scraped: 0, silentReason: "unreachable (DNS/connection failed)" },
      ],
      expected: ["alpha", "beta", "gamma"],
    }));
    expect(silentSlugs(withPrefix(md), known).sort()).toEqual(["alpha", "beta", "gamma"]);
  });
});
