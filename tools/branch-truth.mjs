// Which remote branches are actually unmerged work, and which just LOOK unmerged?
//
// WHY THIS EXISTS: `git branch --no-merged` is the wrong tool for this repo, and trusting it
// cost real work. Every PR here lands as a SQUASH merge, which creates a brand-new commit on
// main containing none of the branch's commits. Git therefore reports the branch as unmerged
// forever. On 2026-08-31 that meant ten fully-merged branches read as open work, and a
// planning session took `maximise-scraper` (PR #22, merged 2026-08-19) to be an open piece of
// work and built three false beliefs on top of it — including "the render adapter is dead",
// which described code that had been fixed five days earlier.
//
// The authority is the PR state, not the commit graph. This cross-references `gh pr list
// --state all` against `git branch -r` and prints the truth.
//
// Usage: bun tools/branch-truth.mjs              # human-readable
//        bun tools/branch-truth.mjs --json       # machine-readable
//        bun tools/branch-truth.mjs --count-unbacked   # just the number (scorecard gate G3)
//
// It never deletes anything. Deleting a branch is a repo-admin act, and the site repo's own
// convention is to RENAME to `archived/*` rather than delete, which preserves the history.

import { $ } from "bun";

const PROTECTED = new Set(["main", "master", "HEAD"]);

export function classify({ remoteBranches, prs }) {
  // headRefName → the most decisive PR state for that branch. MERGED beats OPEN beats CLOSED:
  // a branch can carry several PRs over its life and one of them merging is what matters.
  const rank = { MERGED: 3, OPEN: 2, CLOSED: 1 };
  const byBranch = new Map();
  for (const pr of prs) {
    const prev = byBranch.get(pr.headRefName);
    if (!prev || rank[pr.state] > rank[prev.state]) byBranch.set(pr.headRefName, pr);
  }

  const rows = [];
  for (const b of remoteBranches) {
    if (PROTECTED.has(b)) continue;
    const pr = byBranch.get(b);
    if (!pr) rows.push({ branch: b, state: "NO-PR", pr: null, verdict: "unbacked", note: "no PR ever opened — real unmerged work, or a forgotten branch" });
    else if (pr.state === "MERGED") rows.push({ branch: b, state: "MERGED", pr: pr.number, verdict: "deletable", note: `#${pr.number} merged — squash, so git still calls it unmerged` });
    else if (pr.state === "OPEN") rows.push({ branch: b, state: "OPEN", pr: pr.number, verdict: "active", note: `#${pr.number} open` });
    else rows.push({ branch: b, state: "CLOSED", pr: pr.number, verdict: "unbacked", note: `#${pr.number} closed without merging` });
  }
  return rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.branch.localeCompare(b.branch));
}

if (import.meta.main) {
  // Plain `git branch -r`, not --format=%(refname:short): Bun's shell parser chokes on the
  // parentheses in the format string.
  const remoteBranches = (await $`git branch -r`.text())
    .trim().split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.includes("->"))          // drop the `origin/HEAD -> origin/main` alias
    .map((s) => s.replace(/^origin\//, ""))
    .filter(Boolean);
  const prs = JSON.parse(await $`gh pr list --state all --limit 200 --json number,state,headRefName`.text());

  const rows = classify({ remoteBranches, prs });
  const deletable = rows.filter((r) => r.verdict === "deletable");
  const unbacked = rows.filter((r) => r.verdict === "unbacked");
  const active = rows.filter((r) => r.verdict === "active");

  if (process.argv.includes("--count-unbacked")) { console.log(deletable.length); process.exit(0); }
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ deletable, unbacked, active }, null, 2)); process.exit(0); }

  console.log(`## Branch truth\n`);
  console.log(`${active.length} active · ${deletable.length} merged-but-present · ${unbacked.length} unbacked\n`);
  if (deletable.length) {
    console.log(`### Merged, safe to retire (${deletable.length})`);
    console.log(`git branch --no-merged says these are open work. Their PRs say otherwise.\n`);
    for (const r of deletable) console.log(`  ${r.branch.padEnd(34)} ${r.note}`);
    console.log(`\nRetire them (the site repo's convention — keeps the history):`);
    for (const r of deletable) console.log(`  git push origin origin/${r.branch}:refs/heads/archived/${r.branch} :${r.branch}`);
    console.log("");
  }
  if (unbacked.length) {
    console.log(`### No merged PR backing these (${unbacked.length}) — check before touching`);
    for (const r of unbacked) console.log(`  ${r.branch.padEnd(34)} ${r.note}`);
    console.log("");
  }
  if (active.length) {
    console.log(`### Open PRs (${active.length})`);
    for (const r of active) console.log(`  ${r.branch.padEnd(34)} ${r.note}`);
  }
}
