// The product page a WAF refused must never reach the parser — and the refusal must be
// counted, because for months it surfaced as "required: missing total_entries" and was read
// as a parser gap. Offline: globalThis.fetch is stubbed, no Chromium, no network.
//
// Two counters are under test and they are deliberately NOT the same number:
//   blocked — pages refused
//   starved — draws that ended up with no cap or no date BECAUSE of it
// An operator whose API description already carried the cap loses nothing even with every
// page refused, so only `starved` may drive the report headline or topup's retry list.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readProductPage, pageBlockNote, starvedByPage, pageBlocks, resetPageBlocks } from "../extractor.mjs";
import { fieldsFromHtml } from "../lib/parse.mjs";
import { pageBlockedSlugs } from "../lib/runlog.mjs";

const realFetch = globalThis.fetch;
const op = { slug: "golf-star-competitions", base: "https://golfstarcompetitions.co.uk" };

// A real Cloudflare interstitial, trimmed. It clears looksBlocked's length floor on its own,
// so only the phrase can catch it — which is the point. It also carries a number that looks
// like a cap, which is what made feeding it to the parser dangerous rather than merely useless.
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>
<h1>Just a moment...</h1><p>Verifying you are human. This may take a few seconds.</p>
<p>golfstarcompetitions.co.uk needs to review the security of your connection before proceeding.
Ray ID: 9c2f1a. Performance &amp; security by Cloudflare. 25000 25000 25000</p></body></html>`;

// A page shaped like the ones this actually costs us: the cap lives only here.
const GOOD = `<html><body><div class="summary"><h1>WIN A TAYLORMADE SPIDER ZT</h1>
<p>Live draw 23/9/26 @ 8:00 PM</p><p>24999 tickets available</p><p>Maximum 500 tickets per person</p>
<p>Sold: 6165 of 24999</p></div></body></html>`;

// Single attempt: these cases assert the GUARD, not the retry policy (which test/fetcher.test.mjs
// owns), and a real backoff sleep per case makes suite runtime depend on the wall clock.
const NO_SLEEP = { attempts: 1 };
const stub = (impl) => { globalThis.fetch = impl; };
beforeEach(() => resetPageBlocks());
afterEach(() => { globalThis.fetch = realFetch; });

const tally = () => pageBlocks.get(op.slug);

test("a readable page is returned and counted as ok", async () => {
  stub(async () => new Response(GOOD, { status: 200 }));
  expect(await readProductPage("https://x/p", op)).toEqual({ html: GOOD, refused: false });
  expect(tally()).toEqual({ ok: 1, blocked: 0, starved: 0, causes: {} });
});

test("a 403 is not parsed, and names itself", async () => {
  stub(async () => new Response(CHALLENGE, { status: 403 }));
  expect(await readProductPage("https://x/p", op, NO_SLEEP)).toEqual({ html: "", refused: true });
  expect(tally().blocked).toBe(1);
  expect(tally().causes["HTTP 403"]).toBe(1);
});

test("a challenge served with HTTP 200 is still refused", async () => {
  stub(async () => new Response(CHALLENGE, { status: 200 }));
  expect(await readProductPage("https://x/p", op)).toEqual({ html: "", refused: true });
  expect(tally().causes["challenge/empty"]).toBe(1);
});

test("a network failure is counted, not swallowed", async () => {
  stub(async () => { throw new Error("ECONNRESET"); });
  expect(await readProductPage("https://x/p", op, NO_SLEEP)).toEqual({ html: "", refused: true });
  expect(tally().causes.network).toBe(1);
});

// The whole point: the block page must not be able to donate a field to the draw. Non-vacuous —
// it first asserts the parser CAN read a cap from a real page.
test("the block page can no longer donate a ticket cap to the draw", async () => {
  const poisoned = fieldsFromHtml({ html: CHALLENGE, url: "https://x/p", op });
  const honest = fieldsFromHtml({ html: GOOD, url: "https://x/p", op });
  expect(honest.total_entries).toBe(24999);          // the parser CAN read a real page
  stub(async () => new Response(CHALLENGE, { status: 403 }));
  const { html } = await readProductPage("https://x/p", op, NO_SLEEP);
  expect(html).toBe("");                              // …and never sees the challenge
  expect(fieldsFromHtml({ html, url: "https://x/p", op }).total_entries).toBe(null);
  expect(poisoned.title).not.toBe(honest.title);      // proof they are different documents
});

// ---- blocked ≠ lost ---------------------------------------------------------------------
// Counting a refused page as a lost draw would overstate the damage and send topup after
// operators that are perfectly fine (Trade Tool: every page refused, nothing lost, because the
// zap ajax fills cap+date afterwards).
test("a refused page whose draw still has a cap and a date is not a loss", () => {
  expect(starvedByPage(true, { total_entries: 25000, draw_date: "2026-09-15T21:30:00Z" })).toBe(false);
});

test("a refused page that left the draw without a cap, or without a date, is a loss", () => {
  expect(starvedByPage(true, { total_entries: null, draw_date: "2026-09-15T21:30:00Z" })).toBe(true);
  expect(starvedByPage(true, { total_entries: 25000, draw_date: null })).toBe(true);
});

test("a draw that simply has no cap is not blamed on the page when the page read fine", () => {
  expect(starvedByPage(false, { total_entries: null, draw_date: null })).toBe(false);
});

// ---- the log line, producer → consumer ---------------------------------------------------
test("pageBlockNote leads with draws lost, and round-trips through the log parser", () => {
  const note = pageBlockNote("golf-star-competitions", { ok: 13, blocked: 87, starved: 41, causes: { "HTTP 403": 80, "challenge/empty": 7 } });
  expect(note).toContain("87 of 100 product pages unreadable");
  expect(note).toContain("HTTP 403×80");
  expect(note).toContain("41 left a draw with no cap or date");
  // `gh run view --log` prefixes every line; nothing may anchor to line start.
  const line = `aggregate-json\tScrape\t2026-09-09T00:00:00Z   ⚠️ ${note}`;
  expect(pageBlockedSlugs(line)).toEqual([{ slug: "golf-star-competitions", blocked: 87, total: 100, lost: 41 }]);
});

test("an operator that lost nothing still reports, and parses back as lost: 0", () => {
  const note = pageBlockNote("trade-tool-giveaways", { ok: 0, blocked: 60, starved: 0, causes: { "HTTP 403": 60 } });
  expect(note).toContain("no draw left short");
  expect(pageBlockedSlugs(`x\ty\tZ   ⚠️ ${note}`)).toEqual([{ slug: "trade-tool-giveaways", blocked: 60, total: 60, lost: 0 }]);
});

test("pageBlockNote stays silent when nothing was refused", () => {
  expect(pageBlockNote("x", { ok: 10, blocked: 0, starved: 0, causes: {} })).toBe(null);
  expect(pageBlockNote("x", null)).toBe(null);
});

test("the log parser refuses a slug we have no config for", () => {
  const note = pageBlockNote("not-an-operator", { ok: 1, blocked: 9, starved: 9, causes: { "HTTP 403": 9 } });
  expect(pageBlockedSlugs(`  ⚠️ ${note}`, (s) => s === "known-op")).toEqual([]);
});

test("several operators in one log come back worst-loss first, not most-blocked first", () => {
  const mk = (slug, t) => `x\ty\tZ   ⚠️ ${pageBlockNote(slug, t)}`;
  const log = [
    mk("trade-tool-giveaways", { ok: 0, blocked: 60, starved: 0, causes: { "HTTP 403": 60 } }),
    mk("albo-competitions", { ok: 0, blocked: 12, starved: 12, causes: { "HTTP 403": 12 } }),
    mk("golf-star-competitions", { ok: 13, blocked: 87, starved: 41, causes: { "HTTP 403": 87 } }),
  ].join("\n");
  expect(pageBlockedSlugs(log).map((x) => x.slug))
    .toEqual(["golf-star-competitions", "albo-competitions", "trade-tool-giveaways"]);
});

// The three cases above pass attempts:1 to stay fast. This one deliberately does NOT, so the
// default PER_PRODUCT_RETRY wiring cannot rot unnoticed: a 403 must be retried before we give up.
test("the default retry budget is still wired — a 403 is attempted more than once", async () => {
  let calls = 0;
  stub(async () => { calls++; return new Response(CHALLENGE, { status: 403 }); });
  await readProductPage("https://x/p", op);
  expect(calls).toBeGreaterThan(1);
});
