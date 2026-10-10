import { test, expect } from "bun:test";
import { captionFindings, factsFor } from "../caption-check.mjs";
import { keyFrom, verdict } from "../freshness.mjs";

const facts = factsFor({
  facts: [{ cap: 74999, price: "89p" }, { cap: 299999, price: "20p" }],
  draws: [{ draw_date: "2026-09-23T21:00:00+01:00" }],
  now: +new Date("2026-09-21T10:00:00+01:00"),
});
const preds = (t) => captionFindings(t, { facts }).map((f) => f.predicate);

test("captions Claude writes are gated: an engagement question with no figures is class A", () => {
  expect(preds("Which would you pick?")).toContain("L2.twoFigureTest");
});
test("a question carrying two verified figures from different keys is allowed", () => {
  expect(preds("So which would you rather hold — 89p into a cap of 74,999, or 20p into a cap of 299,999?")).toEqual([]);
});
test("cadence, banned phrases and gambling words are refused in captions too", () => {
  expect(preds("New draws every night 🔥")).toContain("L2.cadenceOrCoverage");
  expect(preds("you could win a BMW for 89p")).toContain("L4.bannedPhrases");
  expect(preds("hit the jackpot")).toContain("L2.gamblingFurniture");
});
test("the native caption shape passes", () => {
  const cap = "5 motors up for grabs this week 🔥\n\nBMW M4 (or £30k cash) · 89p · ends wed 23 sep · Dream Car Giveaways\n\nsave this for later 📌\n\nWe list draws. We run none — each one above is the operator's own.\nAge limits and free-entry routes: in each operator's own terms.\nlink in bio\n\n#prizedrawsdaily #ukcompetition #ukprizedraws #ukraffle #cargiveaway";
  expect(preds(cap)).toEqual([]);
});

test("freshness reads the env key, not the empty config field", () => {
  expect(keyFrom({ SUPABASE_SERVICE_ROLE_KEY: "svc" }, { supabasePublishableKey: "" })).toBe("svc");
  expect(keyFrom({ SUPABASE_PUBLISHABLE_KEY: "pub" }, { supabasePublishableKey: "" })).toBe("pub");
  expect(keyFrom({}, { supabasePublishableKey: "" })).toBe("");
});
test("freshness verdict", () => {
  const now = +new Date("2026-10-11T12:00:00Z");
  expect(verdict(null, now).ok).toBe(false);
  expect(verdict({ date: "2026-10-11", posted_at: "2026-10-11T11:00:00Z" }, now).ok).toBe(true);
  expect(verdict({ date: "2026-09-22", posted_at: "2026-09-21T23:12:52Z" }, now).line).toMatch(/^STALE \d+h/);
});
