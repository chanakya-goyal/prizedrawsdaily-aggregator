import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { supabaseUrl } from "../lib/sb.mjs";

// The URL twin of no-dead-key.test.mjs. That file guards hard-coded KEYS; nothing guarded
// hard-coded project URLS, and that asymmetry is how ~20 scripts, ended-sweep.mjs (no env read
// at all), lib/sb.mjs's DEFAULT_BASE and carousel/config.json all came to name one specific
// Supabase project. In Oct 2026 the database moved project because the old organisation ran
// past its free quota — every one of those would have kept reading and writing the OLD
// project after the cutover, with no error anywhere. The project URL now comes from
// SUPABASE_URL alone (lib/sb.mjs supabaseUrl()), and CI holds the line.
//
// Scanned via `git ls-files` (same reasons as no-dead-key): bounded, fast, and exactly the
// scope that can ship. docs/ and .superpowers/ are excluded — historical plans quote URLs as
// a record. Markdown is not executed, so it is excluded too.
const PROJECT_URL = /https:\/\/[a-z0-9]{20}\.supabase\.co/;

// The ONLY allowed literals: URLs of a DEAD project used as DATA — a fixture proving that rows
// still pointing at the dead project are recognised and skipped. Never a connection target.
const ALLOWED = [
  {
    file: "test/migration.test.mjs",
    contains: "kkuuwksgyypicnblwubs",
    why: "fixture for selectToMove's dead-project recogniser (rows still holding dead URLs are skipped)",
  },
];

async function trackedSource() {
  const files = (await $`git ls-files`.text()).trim().split("\n").filter(Boolean);
  return files.filter(
    (f) => /\.(mjs|js|json|ya?ml)$/.test(f) && !f.startsWith("docs/") && !f.startsWith(".superpowers/") && f !== "test/no-hardcoded-project-url.test.mjs"
  );
}

describe("no hard-coded Supabase project URL", () => {
  test("no tracked script, config or workflow names a project URL (dead-project fixtures excepted)", async () => {
    const hits = [];
    for (const f of await trackedSource()) {
      const lines = (await Bun.file(f).text().catch(() => "")).split("\n");
      lines.forEach((line, i) => {
        if (!PROJECT_URL.test(line)) return;
        if (ALLOWED.some((a) => a.file === f && line.includes(a.contains))) return;
        hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("every allowlist entry still matches something (an unused exemption is a loophole)", async () => {
    for (const a of ALLOWED) {
      const t = await Bun.file(a.file).text();
      expect(t.split("\n").some((l) => PROJECT_URL.test(l) && l.includes(a.contains))).toBe(true);
    }
  });
});

describe("supabaseUrl()", () => {
  test("reads SUPABASE_URL and drops trailing slashes", () => {
    expect(supabaseUrl({ SUPABASE_URL: "https://abc.supabase.co/" })).toBe("https://abc.supabase.co");
    expect(supabaseUrl({ SUPABASE_URL: "  https://abc.supabase.co  " })).toBe("https://abc.supabase.co");
  });

  test("throws when SUPABASE_URL is unset or blank — there is no default project", () => {
    expect(() => supabaseUrl({})).toThrow(/SUPABASE_URL is not set/);
    expect(() => supabaseUrl({ SUPABASE_URL: "   " })).toThrow(/SUPABASE_URL is not set/);
  });
});
