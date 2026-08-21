import { test, expect, describe } from "bun:test";
import { decideRuleFix } from "../backfill-categories.mjs";

const cats = { "cash-prizes": "c1", "sports-outdoors": "c2", "luxury": "c3" };
const ops = { "golf-star-competitions": { slug: "golf-star-competitions", category: "sports-outdoors" }, "plain-op": { slug: "plain-op" } };
const mk = (o) => ({ id: "d1", title: "x", grand_prize: null, entry_url: "https://x/y", status: "active", category_slug: "cash-prizes", category_source: null, op_slug: "plain-op", ...o });

describe("decideRuleFix", () => {
  test("pin overrides everything → fix", () => {
    const d = mk({ op_slug: "golf-star-competitions", title: "AUTO DRAW #9" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "fix", category: "sports-outdoors", source: "rule" });
  });
  test("rule disagrees with stored → fix", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "fix", category: "luxury", source: "rule" });
  });
  test("rule agrees with stored → stamp source only", () => {
    const d = mk({ title: "Win £2,000 Tax Free Cash" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "stamp", category: "cash-prizes", source: "rule" });
  });
  test("no evidence + active → export for Claude", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "export" });
  });
  test("no evidence + ended → leave alone", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard", status: "ended" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
  test("claude/manual source is never touched", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!", category_source: "claude" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
});
