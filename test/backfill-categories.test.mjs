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
  test("claude source is never touched", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!", category_source: "claude" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
  test("manual source is never touched", () => {
    const d = mk({ title: "Win A 5g Gold Bar for Just 3p!", category_source: "manual" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
  test("draft + no evidence + null source + has category → clear (stale guess, held for 2b)", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard", status: "draft" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "clear" });
  });
  test("active + no evidence + null source + has category → still export (actives are judged via the worklist, never blanked — they're on the public site)", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard", status: "active" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "export" });
  });
  test("draft + no evidence + claude source → still skip", () => {
    const d = mk({ title: "Mando's Jungle Leaderboard", status: "draft", category_source: "claude" });
    expect(decideRuleFix(d, ops, cats)).toEqual({ action: "skip" });
  });
});
