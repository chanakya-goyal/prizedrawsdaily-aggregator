import { test, expect, describe } from "bun:test";
import { $ } from "bun";

// The `sb_publishable_h-iA9…` literal has returned 401 since the project moved to
// ilnegxrsalmzpljotgpe. It sat as a `|| "sb_publishable_…"` fallback in nine scripts, which
// made a keyless invocation look supported and then failed three layers down with an opaque
// 401 from whichever request happened to run first. Removing it once is not enough — the
// pattern is trivially reintroduced by copying any nearby file — so CI holds the line.
//
// Scanned via `git ls-files` rather than `grep -r`: it is bounded to tracked source (a
// recursive walk of this repo takes minutes and would make the suite unusable), and it is
// exactly the right scope — an untracked scratch file cannot ship a bad fallback.
//
// docs/ and .superpowers/ are excluded deliberately: the historical plans and archived review
// diffs quote the key as a record of what was once configured, and rewriting history to
// satisfy a lint is worse than the lint.
const DEAD_KEY = ["sb_publishable_h-iA9nWMpXeZHX8uA1Yeyw", "_3xh_XPKs"].join("");

async function trackedSource() {
  const files = (await $`git ls-files`.text()).trim().split("\n").filter(Boolean);
  return files.filter((f) => !f.startsWith("docs/") && !f.startsWith(".superpowers/") && f !== "test/no-dead-key.test.mjs");
}

describe("no dead publishable-key fallback", () => {
  test("the stale key appears nowhere in tracked source", async () => {
    const hits = [];
    for (const f of await trackedSource()) {
      const t = await Bun.file(f).text().catch(() => "");
      if (t.includes(DEAD_KEY)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });

  test("no script offers ANY hardcoded sb_publishable_ literal as a fallback", async () => {
    // The general form, not just this one key: the next stale key fails identically.
    const FALLBACK = /\|\|\s*["']sb_publishable_[A-Za-z0-9_-]+["']/;
    const hits = [];
    for (const f of await trackedSource()) {
      const t = await Bun.file(f).text().catch(() => "");
      if (FALLBACK.test(t)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
