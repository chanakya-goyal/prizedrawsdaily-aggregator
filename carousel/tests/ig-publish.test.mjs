import { test, expect } from "bun:test";
import { authHeaders, idOf, BASE } from "../ig-publish.mjs";

test("a consumer key (the hosted-MCP project) and a project key use different headers", () => {
  expect(authHeaders("ck_abc")).toHaveProperty("x-consumer-api-key", "ck_abc");
  expect(authHeaders("ak_abc")).toHaveProperty("x-api-key", "ak_abc");
  expect(() => authHeaders("")).toThrow(/COMPOSIO_API_KEY/);
});

test("the Graph id is found at any of Composio's wrapping depths", () => {
  expect(idOf({ data: { id: "1" } })).toBe("1");
  expect(idOf({ data: { data: { id: "2" } } })).toBe("2");
  expect(idOf({ data: { response_data: { id: "3" } } })).toBe("3");
  expect(idOf({ data: {} })).toBeNull();
});

test("calls go to the v3.1 API, where an omitted toolkit version means latest", () => {
  expect(BASE).toBe("https://backend.composio.dev/api/v3.1");
});

test("the Facebook caption drops the Instagram-only 'link in bio' and keeps everything else", async () => {
  const { fbCaption } = await import("../ig-publish.mjs");
  const reel = "£20 for a Rolex, via Bonkers Competitions 👀\n\nmore luxury prizes closing soon on prizedrawsdaily.co.uk, link in bio\n\nWe list draws. We run none.\n\n#ukcompetition";
  expect(fbCaption(reel)).toBe("£20 for a Rolex, via Bonkers Competitions 👀\n\nmore luxury prizes closing soon on prizedrawsdaily.co.uk\n\nWe list draws. We run none.\n\n#ukcompetition");
  const deck = "head\n\nlines\n\nwho\nT&Cs on each site\nlink in bio\n\n#tags";
  expect(fbCaption(deck)).toBe("head\n\nlines\n\nwho\nT&Cs on each site\n\n#tags");
  expect(fbCaption(reel)).toContain("via Bonkers Competitions");
});

test("a consumer-key call's answer is unwrapped from the MCP envelope; a failed tool throws", async () => {
  const { parseMcpResult } = await import("../ig-publish.mjs");
  const wrap = (o) => ({ result: { content: [{ type: "text", text: JSON.stringify(o) }] } });
  const ok = wrap({ successful: true, data: { results: [{ response: { successful: true, data: { id: "179" } }, tool_slug: "X", index: 0 }] } });
  expect(parseMcpResult(ok, "X")).toEqual({ successful: true, data: { id: "179" } });
  const bad = wrap({ successful: true, data: { results: [{ response: { successful: false, error: "Media ID is not available" }, tool_slug: "X" }] } });
  expect(() => parseMcpResult(bad, "X")).toThrow(/Media ID is not available/);
  expect(() => parseMcpResult({ error: { message: "nope" } }, "X")).toThrow(/nope/);
});

test("Facebook gets the Instagram tags plus its own; Instagram's line is untouched elsewhere", async () => {
  const { fbCaption } = await import("../ig-publish.mjs");
  const ig = "£20 for a Rolex, via Bonkers Competitions 👀\n\nmore on prizedrawsdaily.co.uk, link in bio\n\n#prizedrawsdaily #ukcompetition #ukprizedraws #luxury #ukraffle";
  const fb = fbCaption(ig, "luxury");
  const tags = fb.split("\n").pop().split(" ");
  expect(tags.slice(0, 5)).toEqual(["#prizedrawsdaily", "#ukcompetition", "#ukprizedraws", "#luxury", "#ukraffle"]);
  expect(tags).toContain("#luxurycomps");
  expect(new Set(tags).size).toBe(tags.length);
  expect(tags.length).toBeLessThanOrEqual(12);
  expect(fb).not.toMatch(/link in bio/);
  expect(fbCaption(ig)).toBe(fbCaption(ig, null)); // no category: no extra tags
});

test("every category's Facebook tags pass the caption gate and the config check", async () => {
  const { fbCaption } = await import("../ig-publish.mjs");
  const { CFG, GLOBAL, configProblems } = await import("../config.mjs");
  const c = await import("../compliance.mjs");
  expect(configProblems()).toEqual([]);
  for (const slug of Object.keys(CFG.categories)) {
    const ig = `£1 for a prize, via Op 👀\n\n${[...GLOBAL.fixedHashtags, ...CFG.categories[slug].hashtags].join(" ")}`;
    const hits = c.checkUnit(fbCaption(ig, slug), { surface: "caption", bannedPhrases: GLOBAL.bannedPhrases, operatorNames: ["Op"],
      facts: c.factsTable({ drawsRendered: 1, prices: ["1"] }) }).filter((h) => h.class === c.CLASS.A);
    expect({ slug, hits: hits.map((h) => h.predicate) }).toEqual({ slug, hits: [] });
  }
});

test("Facebook posts carry a tracked link under the prize block: a Reel's draw page, a carousel's category page", async () => {
  const { fbCaption } = await import("../ig-publish.mjs");
  const { postLink } = await import("../links.mjs");
  const reelLink = postLink({ source: "facebook", kind: "reel", category: "luxury", hero: "fortnum-and-mason-beauty-advent-croc-comps", date: "2026-10-21" });
  expect(reelLink).toBe("https://prizedrawsdaily.co.uk/draws/fortnum-and-mason-beauty-advent-croc-comps?utm_source=facebook&utm_medium=social&utm_campaign=reel&utm_content=2026-10-21");
  const reel = "£1 for Fortnum & Mason Beauty Advent, via Croc Comps 👀\n\nFortnum & Mason Beauty Advent · £1 · ends sun 25 oct · via Croc Comps\n\nmore luxury prizes closing soon on prizedrawsdaily.co.uk, link in bio\n\nWe list draws. We run none.\n\n#prizedrawsdaily #luxury";
  const fb = fbCaption(reel, "luxury", reelLink);
  expect(fb.split("\n\n")[1]).toBe(`Fortnum & Mason Beauty Advent · £1 · ends sun 25 oct · via Croc Comps\n👉 ${reelLink}`);
  expect(fbCaption(fb, "luxury", reelLink).split(reelLink).length).toBe(2); // never twice

  const deckLink = postLink({ source: "facebook", kind: "carousel", category: "car-draws", date: "2026-10-22" });
  expect(deckLink).toBe("https://prizedrawsdaily.co.uk/category/car-draws?utm_source=facebook&utm_medium=social&utm_campaign=carousel&utm_content=2026-10-22");
  const deck = "head ✨\n+ more below\n\nA · £1 · Op\nB · £2 · Op\n\nsave this for later 📌\n\nWe list draws.\nlink in bio\n\n#tags";
  expect(fbCaption(deck, null, deckLink).split("\n\n")[1]).toBe(`A · £1 · Op\nB · £2 · Op\n👉 ${deckLink}`);
  // a short caption still gets the link, above the tags
  expect(fbCaption("head\n\n#tags", null, deckLink)).toBe(`head\n👉 ${deckLink}\n\n#tags`);
  // no link given: the caption is exactly what it was
  expect(fbCaption(deck)).not.toContain("👉");
});

test("a category without a site page, or a Reel without a draw, links to the home page", async () => {
  const { postLink, trackedUrl } = await import("../links.mjs");
  expect(postLink({ source: "facebook", kind: "carousel", category: "nope" })).toBe("https://prizedrawsdaily.co.uk/?utm_source=facebook&utm_medium=social&utm_campaign=carousel");
  expect(postLink({ source: "pinterest", kind: "reel", category: "luxury" })).toBe("https://prizedrawsdaily.co.uk/category/luxury?utm_source=pinterest&utm_medium=social&utm_campaign=reel");
  expect(() => trackedUrl("/")).toThrow(/source/);
});

test("a Reel's hosted video is freed only after the Facebook post has fetched it", async () => {
  const src = await Bun.file(new URL("../ig-publish.mjs", import.meta.url)).text();
  const body = src.slice(src.indexOf("export async function reel("), src.indexOf("export async function verify("));
  expect(body).toContain("done(slot, media, { free: false })");
  const fb = body.indexOf("await fbReel(item)"), free = body.indexOf("await freeDay(item.date)");
  expect(fb).toBeGreaterThan(0);
  expect(free).toBeGreaterThan(fb);
});
