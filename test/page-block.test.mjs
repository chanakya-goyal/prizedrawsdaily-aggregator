// The product page a WAF refused must never reach the parser — and the refusal must be
// counted, because for months it surfaced as "required: missing total_entries" and was read
// as a parser gap. Offline: globalThis.fetch is stubbed, no Chromium, no network.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readProductPage, pageBlockNote, pageBlocks, resetPageBlocks } from "../extractor.mjs";
import { fieldsFromHtml } from "../lib/parse.mjs";
import { pageBlockedSlugs } from "../lib/runlog.mjs";

const realFetch = globalThis.fetch;
const op = { slug: "golf-star-competitions", base: "https://golfstarcompetitions.co.uk" };

// A real Cloudflare interstitial, trimmed. It is long enough to clear looksBlocked's length
// floor on its own, so only the phrase can catch it — which is the point.
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body>
<h1>Just a moment...</h1><p>Verifying you are human. This may take a few seconds.</p>
<p>golfstarcompetitions.co.uk needs to review the security of your connection before proceeding.
Ray ID: 9c2f1a. Performance &amp; security by Cloudflare. 25000 25000 25000</p></body></html>`;

// A page shaped like the ones this actually costs us: the cap lives only here.
const GOOD = `<html><body><div class="summary"><h1>WIN A TAYLORMADE SPIDER ZT</h1>
<p>Live draw 23/9/26 @ 8:00 PM</p><p>24999 tickets available</p><p>Maximum 500 tickets per person</p>
<p>Sold: 6165 of 24999</p></div></body></html>`;

const stub = (impl) => { globalThis.fetch = impl; };
beforeEach(() => resetPageBlocks());
afterEach(() => { globalThis.fetch = realFetch; });

const tally = () => pageBlocks.get(op.slug);

test("a readable page is returned and counted as ok", async () => {
  stub(async () => new Response(GOOD, { status: 200 }));
  const html = await readProductPage("https://x/p", op);
  expect(html).toBe(GOOD);
  expect(tally()).toEqual({ ok: 1, blocked: 0, causes: {} });
});

test("a 403 is not parsed, and names itself", async () => {
  stub(async () => new Response(CHALLENGE, { status: 403 }));
  expect(await readProductPage("https://x/p", op)).toBe("");
  expect(tally().blocked).toBe(1);
  expect(tally().causes["HTTP 403"]).toBe(1);
});

test("a challenge served with HTTP 200 is still refused", async () => {
  stub(async () => new Response(CHALLENGE, { status: 200 }));
  expect(await readProductPage("https://x/p", op)).toBe("");
  expect(tally().causes["challenge/empty"]).toBe(1);
});

test("a network failure is counted, not swallowed", async () => {
  stub(async () => { throw new Error("ECONNRESET"); });
  expect(await readProductPage("https://x/p", op)).toBe("");
  expect(tally().causes.network).toBe(1);
});

// The whole point: the block page must not be able to donate a field to the draw. This is
// non-vacuous — assert first that the SAME html would otherwise yield a cap.
test("the block page can no longer donate a ticket cap to the draw", async () => {
  const poisoned = fieldsFromHtml({ html: CHALLENGE, url: "https://x/p", op });
  const honest = fieldsFromHtml({ html: GOOD, url: "https://x/p", op });
  expect(honest.total_entries).toBe(24999);          // the parser CAN read a real page
  stub(async () => new Response(CHALLENGE, { status: 403 }));
  const html = await readProductPage("https://x/p", op);
  expect(html).toBe("");                              // …and never sees the challenge
  expect(fieldsFromHtml({ html, url: "https://x/p", op }).total_entries).toBe(null);
  expect(poisoned.title).not.toBe(honest.title);      // proof they are different documents
});

test("pageBlockNote stays silent when nothing was refused", () => {
  expect(pageBlockNote("x", { ok: 10, blocked: 0, causes: {} })).toBe(null);
  expect(pageBlockNote("x", null)).toBe(null);
});

test("pageBlockNote round-trips through the log parser", () => {
  const note = pageBlockNote("golf-star-competitions", { ok: 13, blocked: 87, causes: { "HTTP 403": 80, "challenge/empty": 7 } });
  expect(note).toContain("87 of 100 product pages unreadable");
  expect(note).toContain("HTTP 403×80");
  // `gh run view --log` prefixes every line; nothing may anchor to line start.
  const line = `aggregate-json\tScrape\t2026-09-08T17:02:10Z   ⚠️ ${note}`;
  expect(pageBlockedSlugs(line)).toEqual([{ slug: "golf-star-competitions", blocked: 87, total: 100 }]);
});

test("the log parser refuses a slug we have no config for", () => {
  const note = pageBlockNote("not-an-operator", { ok: 1, blocked: 9, causes: { "HTTP 403": 9 } });
  expect(pageBlockedSlugs(`  ⚠️ ${note}`, (s) => s === "known-op")).toEqual([]);
});

test("two operators in one log are both found, worst first", () => {
  const log = [
    `x\ty\tZ   ⚠️ ${pageBlockNote("albo-competitions", { ok: 0, blocked: 60, causes: { "HTTP 403": 60 } })}`,
    `x\ty\tZ   ⚠️ ${pageBlockNote("plum-competitions", { ok: 2, blocked: 34, causes: { network: 34 } })}`,
  ].join("\n");
  expect(pageBlockedSlugs(log).map((x) => x.slug)).toEqual(["albo-competitions", "plum-competitions"]);
});
