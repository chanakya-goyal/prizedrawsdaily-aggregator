// The scrape is split across two workflows, and two of their settings are only correct
// *together*. Both are the kind of thing a later edit changes innocently, in one file, without
// realising the other exists — so they are asserted here rather than left to a comment.
import { test, expect, describe } from "bun:test";

const read = async (f) => await Bun.file(new URL(`../.github/workflows/${f}`, import.meta.url)).text();
const RENDER = await read("aggregate.yml");
const JSON_SWEEP = await read("aggregate-json.yml");
const num = (yaml, key) => Number((yaml.match(new RegExp(`${key}:\\s*"?(\\d+)"?`)) || [])[1]);
const cronsOf = (yaml) => [...yaml.matchAll(/-\s*cron:\s*"([^"]+)"/g)].map((m) => m[1]);
// "0 1,13,19 * * *" → 3 runs a day; "0 7 * * *" → 1.
const methodsOf = (yaml) => ((yaml.match(/METHODS:\s*"([^"]+)"/) || [])[1] || "").split(",").map((x) => x.trim()).filter(Boolean);
const runsPerDay = (yaml) => cronsOf(yaml).reduce((n, c) => n + c.split(/\s+/)[1].split(",").length, 0);

describe("split aggregator workflows", () => {
  test("both sweeps share one concurrency group, so they queue instead of overlapping", () => {
    // AUTO_PUBLISH_MAX is a per-process counter: two concurrent runs would each cap
    // independently and publish double the intended budget.
    for (const y of [RENDER, JSON_SWEEP]) expect(y).toMatch(/group:\s*aggregator\b/);
    for (const y of [RENDER, JSON_SWEEP]) expect(y).toMatch(/cancel-in-progress:\s*false/);
  });

  test("the two schedules never collide", () => {
    const renderHours = cronsOf(RENDER).flatMap((c) => c.split(/\s+/)[1].split(","));
    const jsonHours = cronsOf(JSON_SWEEP).flatMap((c) => c.split(/\s+/)[1].split(","));
    expect(renderHours.some((h) => jsonHours.includes(h))).toBe(false);
  });

  test("the DAILY publish ceiling stays one deliberate number, not a per-sweep copy", () => {
    // The failure this catches is not "the cap is too high" — it is raising one sweep's cap
    // without noticing there are four runs a day, so the real ceiling silently becomes 4x the
    // intended one. The caps are budgeted together (30 + 50 x 3 = 180/day as of 2026-09-07);
    // DAILY_CEILING is the number manager/PROMPT.md always named as the destination.
    const DAILY_CEILING = 200;
    const daily = num(RENDER, "AUTO_PUBLISH_MAX") * runsPerDay(RENDER)
                + num(JSON_SWEEP, "AUTO_PUBLISH_MAX") * runsPerDay(JSON_SWEEP);
    expect(daily).toBeGreaterThan(0);
    expect(daily, `daily publish ceiling is ${daily}`).toBeLessThanOrEqual(DAILY_CEILING);
  });

  test("any sweep running more than once a day MUST set an observation gap", () => {
    // Without it, several runs a day collapse the two-observation publish rule into a single
    // afternoon — exactly what manager/PROMPT.md forbids the cowork routine from doing.
    for (const [name, y] of [["render", RENDER], ["json", JSON_SWEEP]]) {
      if (runsPerDay(y) <= 1) continue;
      expect(num(y, "MIN_OBSERVATION_GAP_MS"), `${name} runs ${runsPerDay(y)}x/day`).toBeGreaterThanOrEqual(12 * 3600e3);
    }
  });

  test("the JSON sweep keeps FlareSolverr — 3 woo operators depend on it", async () => {
    const ops = await Bun.file(new URL("../operators.json", import.meta.url)).json();
    const needy = ops.filter((o) => o.enabled !== false && o.fetcher === "flaresolverr" && o.method !== "render");
    if (needy.length) expect(JSON_SWEEP).toContain("flaresolverr");
  });

  test("the two sweeps cover every method between them, with no overlap", () => {
    const r = methodsOf(RENDER), j = methodsOf(JSON_SWEEP);
    expect(r.some((m) => j.includes(m))).toBe(false);           // no operator scraped twice
    expect([...r, ...j].sort()).toEqual(["api", "render", "shopify", "woo"]); // none dropped
  });

  test("every ENABLED operator is actually claimed by one of the sweeps", async () => {
    // The assertion above compares the two workflows to a hardcoded list, which cannot notice an
    // operator added with a method neither sweep runs — it would simply never be scraped again,
    // and the only symptom is one more name on the silent-operators list. Check operators.json
    // itself, so the config and the schedule cannot drift apart.
    const ops = await Bun.file(new URL("../operators.json", import.meta.url)).json();
    const covered = new Set([...methodsOf(RENDER), ...methodsOf(JSON_SWEEP)]);
    const orphans = ops
      .filter((o) => o.enabled !== false && !covered.has(o.method))
      .map((o) => `${o.slug} (method=${o.method})`);
    expect(orphans, "operators no workflow scrapes").toEqual([]);
  });
});
