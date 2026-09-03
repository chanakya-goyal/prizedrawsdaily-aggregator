import { test, expect, describe } from "bun:test";
import { classify } from "../tools/branch-truth.mjs";

// The scenario this tool exists for: squash-merged branches that git reports as unmerged
// forever, which a planning session read as open work and built three false conclusions on.
describe("classify", () => {
  test("a squash-merged branch is deletable, not open work", () => {
    const [r] = classify({
      remoteBranches: ["maximise-scraper"],
      prs: [{ number: 22, state: "MERGED", headRefName: "maximise-scraper" }],
    });
    expect(r.verdict).toBe("deletable");
    expect(r.pr).toBe(22);
  });

  test("an open PR's branch is active and must never be listed for deletion", () => {
    const [r] = classify({
      remoteBranches: ["fix/inventory-truth"],
      prs: [{ number: 28, state: "OPEN", headRefName: "fix/inventory-truth" }],
    });
    expect(r.verdict).toBe("active");
  });

  test("a branch with no PR at all is unbacked — possibly real work, never auto-deletable", () => {
    const [r] = classify({ remoteBranches: ["wip/experiment"], prs: [] });
    expect(r.verdict).toBe("unbacked");
    expect(r.state).toBe("NO-PR");
  });

  test("a PR closed without merging leaves its branch unbacked, not deletable", () => {
    // Deleting this would destroy work that was never merged anywhere.
    const [r] = classify({
      remoteBranches: ["abandoned-idea"],
      prs: [{ number: 9, state: "CLOSED", headRefName: "abandoned-idea" }],
    });
    expect(r.verdict).toBe("unbacked");
  });

  test("main is never classified", () => {
    expect(classify({ remoteBranches: ["main"], prs: [] })).toEqual([]);
  });

  test("a branch reused across PRs takes its most decisive state", () => {
    // One merged PR is what matters, whatever else the branch carried.
    const [r] = classify({
      remoteBranches: ["recycled"],
      prs: [
        { number: 1, state: "CLOSED", headRefName: "recycled" },
        { number: 2, state: "MERGED", headRefName: "recycled" },
        { number: 3, state: "OPEN", headRefName: "recycled" },
      ],
    });
    expect(r.verdict).toBe("deletable");
    expect(r.pr).toBe(2);
  });

  test("an open PR outranks a closed one when nothing merged", () => {
    const [r] = classify({
      remoteBranches: ["reopened"],
      prs: [
        { number: 1, state: "CLOSED", headRefName: "reopened" },
        { number: 2, state: "OPEN", headRefName: "reopened" },
      ],
    });
    expect(r.verdict).toBe("active");
  });

  test("PRs for branches that no longer exist remotely are ignored", () => {
    const rows = classify({ remoteBranches: [], prs: [{ number: 5, state: "MERGED", headRefName: "gone" }] });
    expect(rows).toEqual([]);
  });
});
