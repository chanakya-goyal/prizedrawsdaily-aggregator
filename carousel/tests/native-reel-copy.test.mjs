import { test, expect } from "bun:test";
import { brandOf, shortTitle, pickHeroes, hookFor, HOOKS, reelModel, reelStrings, reelCaption } from "../native-reel-copy.mjs";
import * as compliance from "../compliance.mjs";

const draw = (over = {}) => ({
  slug: "win-this-467bhp-subaru-impreza", title: "Win this 467bhp Subaru Impreza GB270 Sport Wagon",
  grand_prize: "467bhp Subaru Impreza GB270 Sport Wagon", ticket_price: 0.03, draw_date: "2026-10-23T20:00:00Z",
  operators: { name: "LLF Games" }, ...over,
});
const sel = { slug: "car-draws", date: "2026-10-20T10:45:31.420Z" };
const now = new Date("2026-10-20T11:00:00Z");

test("brandOf finds a named brand and never guesses", () => {
  expect(brandOf("467bhp Subaru Impreza GB270")).toBe("Subaru");
  expect(brandOf("VW Golf R Line")).toBe("VW");
  expect(brandOf("Ninja Creami Scoop")).toBe(null);
});

test("shortTitle never truncates a prize name", () => {
  expect(shortTitle("VW Golf R Line")).toBe(null); // 4 words: "VW Golf R" is a different car
  expect(shortTitle("Rolex Submariner Date")).toBe("Rolex Submariner Date");
});

test("heroes: cheapest first, never a child-appeal prize or an unnamed operator, operators spread", () => {
  const ds = [
    draw({ slug: "a", ticket_price: 0.05, operators: { name: "Redline" } }),
    draw({ slug: "b", ticket_price: 0.03, operators: { name: "LLF Games" } }),
    draw({ slug: "c", ticket_price: 0.01, grand_prize: "LEGO Batman Gotham City", operators: { name: "X" } }),
    draw({ slug: "d", ticket_price: 0.02, operators: { name: "" } }),
    draw({ slug: "e", ticket_price: 0.04, operators: { name: "LLF Games" } }),
  ];
  expect(pickHeroes(ds).map((d) => d.slug)).toEqual(["b", "a"]);
});

test("every hook pattern that applies stays within six words and passes the class-A gate", () => {
  const facts = compliance.factsTable({ drawsRendered: 1, prices: ["0.03"], daysToClose: [3] });
  const h = { price: "3p", short: "Rolex Submariner Date", brand: "Rolex", cashAlt: 10000 };
  for (const [key, fn] of Object.entries(HOOKS)) {
    const line = fn(h);
    if (!line) continue;
    const hits = [...compliance.checkUnit(line, { facts, surface: "asset", operatorNames: ["LLF Games"] }),
      ...compliance.checkQuestionUnit(line, facts)].filter((x) => x.class === compliance.CLASS.A);
    expect({ key, hits: hits.map((x) => x.predicate) }).toEqual({ key, hits: [] });
    expect(line.replace(/[^\p{L}\p{N}£.\s-]/gu, "").trim().split(/\s+/).length).toBeLessThanOrEqual(6);
  }
});

test("hookFor is deterministic and falls back to the plain price", () => {
  const d = draw();
  expect(hookFor(d, sel.date)).toEqual(hookFor(d, sel.date));
  const long = draw({ grand_prize: "Brand New Garden Furniture Set With Parasol", ticket_price: 2 });
  expect(hookFor(long, sel.date).line).toBe("£2 a ticket 👀");
});

test("the Reel names the operator and its caption carries no em dash, no 'you', no ask to share", () => {
  const d = draw();
  const m = reelModel({ d, sel, photo: "x.jpg", now });
  expect(m.copy.operator.text).toBe("via LLF Games");
  expect(reelStrings(m).some(([f]) => f === "fine")).toBe(true);
  const cap = reelCaption({ sel, m, d, now });
  expect(cap).toContain("via LLF Games");
  expect(cap).not.toMatch(/—/);
  expect(cap).not.toMatch(/\byou\b/i);
  expect(cap).not.toMatch(/\b(share|tag|send)\b/i);
  expect(reelCaption({ sel, m, d, now, adLabel: true }).startsWith("Ad · ")).toBe(true);
});
