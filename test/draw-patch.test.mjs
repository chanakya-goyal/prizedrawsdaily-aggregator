import { test, expect } from "bun:test";
import { validatePatch, applyPatch, parseProposals, mergeProposals, staleKeys, blockedReason, isDrawId } from "../manager/draw-patch.mjs";

const ID = "7f2364cb-ed89-4fb8-ae2c-4b6a8b041c7c";
const NOW = new Date("2026-10-21T08:00:00Z");

test("validatePatch never lets a patch publish", () => {
  expect(validatePatch({ status: "active" }).errors[0]).toContain("status must be one of draft, ended, rejected");
  for (const s of ["draft", "ended", "rejected"]) expect(validatePatch({ status: s }).errors).toEqual([]);
});

test("validatePatch rejects unknown fields, bad provenance and empty patches", () => {
  expect(validatePatch({ slug: "x" }).errors).toEqual(["disallowed fields: slug"]);
  expect(validatePatch({ category_id: "c", category_source: "guess" }).errors[0]).toContain("category_source");
  expect(validatePatch({ free_entry_route: "free" }).errors[0]).toContain("free_entry_route");
  expect(validatePatch({ total_entries: 10, total_entries_method: "eyeballed" }).errors[0]).toContain("total_entries_method");
  expect(validatePatch({}).errors).toEqual(["patch is empty"]);
  expect(validatePatch([]).errors).toEqual(["patch must be a JSON object"]);
  expect(validatePatch({ slug: "x" }).body).toBeNull();
});

test("a hand-set cap is stamped agent-read without mutating the input", () => {
  const input = { total_entries: 1500 };
  const { body, errors } = validatePatch(input, { now: NOW });
  expect(errors).toEqual([]);
  expect(body).toEqual({ total_entries: 1500, total_entries_method: "agent-read", figures_checked_at: "2026-10-21T08:00:00.000Z" });
  expect(input).toEqual({ total_entries: 1500 });
  expect(validatePatch({ total_entries: 9, total_entries_method: "labelled-cap" }).body.total_entries_method).toBe("labelled-cap");
});

test("isDrawId accepts uuids only", () => {
  expect(isDrawId(ID)).toBe(true);
  expect(isDrawId("abc")).toBe(false);
  expect(isDrawId("1;drop")).toBe(false);
});

test("applyPatch PATCHes the row and throws on a failed write", async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify([{ id: ID, status: "draft" }]), { status: 200 }); };
  const row = await applyPatch(ID, { status: "draft" }, { base: "https://x.supabase.co", key: "k", fetchImpl: ok });
  expect(row.status).toBe("draft");
  expect(calls[0].url).toBe(`https://x.supabase.co/rest/v1/draws?id=eq.${ID}`);
  expect(calls[0].init.method).toBe("PATCH");
  expect(JSON.parse(calls[0].init.body)).toEqual({ status: "draft" });
  const bad = async () => new Response("nope", { status: 400 });
  await expect(applyPatch(ID, { status: "draft" }, { base: "https://x.supabase.co", key: "k", fetchImpl: bad })).rejects.toThrow("PATCH → 400 nope");
});

test("parseProposals reads JSONL and reports broken lines", () => {
  const { items, errors } = parseProposals(`{"id":"${ID}","patch":{"status":"ended"}}\n\nnot json\n`);
  expect(items.length).toBe(1);
  expect(errors.length).toBe(1);
  expect(errors[0]).toStartWith("line 3:");
});

test("mergeProposals folds several patches for one draw, keeping the first before", () => {
  const merged = mergeProposals([
    { id: ID, patch: { category_id: "c1", category_source: "claude" }, keys: ["category_id", "category_source"], before: { category_id: null, category_source: null }, reason: "LEGO set" },
    { id: ID, patch: { prize_description: "New text." }, keys: ["prize_description"], before: { prize_description: "Old" }, reason: "template copy" },
    { id: ID, patch: { category_id: "c2" }, keys: ["category_id"], before: { category_id: "c-should-not-replace" }, reason: "second look" },
  ]);
  expect(merged.length).toBe(1);
  expect(merged[0].patch).toEqual({ category_id: "c2", category_source: "claude", prize_description: "New text." });
  expect(merged[0].before).toEqual({ category_id: null, category_source: null, prize_description: "Old" });
  expect(merged[0].reasons).toEqual(["LEGO set", "template copy", "second look"]);
});

test("staleKeys flags fields that moved after the routine judged them", () => {
  const p = { keys: ["ticket_price", "category_id"], before: { ticket_price: 2.5, category_id: null } };
  expect(staleKeys(p, { ticket_price: 2.5, category_id: null })).toEqual([]);
  expect(staleKeys(p, { ticket_price: 3, category_id: null })).toEqual(["ticket_price"]);
  expect(staleKeys(p, { ticket_price: 2.5, category_id: undefined })).toEqual([]);
});

test("blockedReason refuses a missing draw and an already-judged category", () => {
  const p = { keys: ["category_id", "category_source"], before: { category_id: null, category_source: null } };
  expect(blockedReason(p, undefined)).toBe("draw not found");
  expect(blockedReason(p, { category_source: "manual" })).toBe("category was set by hand (manual)");
  expect(blockedReason({ keys: ["category_id"], before: { category_source: "manual" } }, { category_source: "manual" })).toBe("category was set by hand (manual)");
  expect(blockedReason(p, { category_source: "claude" })).toContain("already judged (claude)");
  expect(blockedReason(p, { category_source: "rule" })).toBeNull();
  // 2c stamps rows whose rule category was already set; that is allowed.
  expect(blockedReason({ keys: ["category_id"], before: { category_source: "claude" } }, { category_source: "claude" })).toBeNull();
  expect(blockedReason({ keys: ["prize_description"], before: {} }, { category_source: "manual" })).toBeNull();
});
