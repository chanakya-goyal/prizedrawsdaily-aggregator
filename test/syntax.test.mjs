// Nothing in the suite imports run.mjs, ended-sweep.mjs, topup.mjs or the other top-level
// scripts — they are entry points, not modules — so a syntax error in the most consequential
// file in the repo would sail past a fully green test run and only surface when the daily
// Action tried to scrape. That happened: a refactor left a duplicate `const tpv` in run.mjs
// and all 578 tests still passed.
//
// Bun's transpiler parses without executing, so this stays offline and side-effect free.
import { test, expect, describe } from "bun:test";
import { readdirSync } from "fs";

const ROOT = new URL("..", import.meta.url).pathname;
const transpiler = new Bun.Transpiler({ loader: "js" });

const scripts = readdirSync(ROOT)
  .filter((f) => f.endsWith(".mjs"))
  .sort();

const libs = ["lib", "lib/adapters", "manager", "discovery"].flatMap((dir) => {
  try { return readdirSync(`${ROOT}${dir}`).filter((f) => f.endsWith(".mjs")).map((f) => `${dir}/${f}`); }
  catch { return []; }
}).sort();

describe("every script parses", () => {
  test("there are scripts to check (guards against a silently empty sweep)", () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(libs.length).toBeGreaterThan(5);
  });

  for (const rel of [...scripts, ...libs]) {
    test(rel, async () => {
      const src = await Bun.file(`${ROOT}${rel}`).text();
      // Throws on a syntax error — including a duplicate top-level declaration.
      expect(() => transpiler.transformSync(src)).not.toThrow();
    });
  }
});
