import { test, expect, describe } from "bun:test";
import { freeCheck } from "../lib/free.mjs";

const free = (title, extra = {}) => ({ ticket_price: 0, title, grand_prize: title, ...extra });

describe("freeCheck: genuinely free draws pass", () => {
  for (const t of [
    "FREE ENTRY – £1000 CASH FOR FREE!",
    "ABARTH 500 T-JET – FREE ENTRY! – MUST ANSWER THE QUESTION",
    "FREE TO ENTER – Milwaukee 7 Piece Kit",
    "Win £5 Cash - FREE",
    "Free Draw - £30 Site Credit",
  ]) test(t, () => expect(freeCheck(free(t))).toEqual({ free: true, reason: "free to enter" }));

  test("account required / one entry per person / postal entry stay free", () => {
    expect(freeCheck(free("Free £50 draw", { free_text: "Account required. One entry per person. Postal entry available." })).free).toBe(true);
  });
  test("'spinning reel' and 'Clubhouse' are not catches", () => {
    expect(freeCheck(free("FREE Shimano spinning reel from Clubhouse")).free).toBe(true);
  });
  test("'no cost' counts as free wording", () => {
    expect(freeCheck(free("Win £5 Cash", { free_text: "absolutely no cost to enter" })).free).toBe(true);
  });
});

describe("freeCheck: conditional or not-a-draw £0 items fail", () => {
  const cases = [
    ["FREE ENTRY - WIN £100 | SPEND £1-£5+ AND GET A TICKET", "spend £"],
    ["£200 Site Credit For Free! (Must Have Spent £10)", "spent"],
    ["Jackpot Cash Subscriber Exclusive Instant Free", "subscriber"],
    ["FREE INSTANT WIN COMP!", "instant win"],
    ["Tuesday - 5 Daily Free Spins", "spins"],
    ["🆓 £200 Active Players Only! Free", "active players"],
    ["Free VIP draw", "vip"],
    ["Free loyalty draw", "loyalty"],
    ["Free draw – members only", "members only"],
    ["Free scratchcard", "scratch"],
    ["Free wheel of fortune", "wheel"],
    ["Free draw with any order", "with any order"],
  ];
  for (const [t, phrase] of cases) test(t, () => {
    const r = freeCheck(free(t));
    expect(r.free).toBe(false);
    expect(r.reason).toBe(`free but conditional: ${phrase}`);
  });

  test("the catch can sit in free_text, not the title", () => {
    const r = freeCheck(free("FREE £250 Cash", { free_text: "To qualify you must have purchased a ticket this week." }));
    expect(r).toEqual({ free: false, reason: "free but conditional: must have purchased" });
  });
  test("HTML tags never glue words together", () => {
    const r = freeCheck(free("Win £5", { free_text: "<b>FREE</b><br>Spend £5 to qualify" }));
    expect(r.reason).toBe("free but conditional: spend £");
  });
  test("boilerplate 'instant wins' in a description rejects (fails closed, by design)", () => {
    expect(freeCheck(free("FREE £100", { free_text: "Check out our other instant wins!" })).free).toBe(false);
  });
});

describe("freeCheck: fail closed on price", () => {
  test("£0 with no free wording is treated as an unread price", () => {
    expect(freeCheck({ ticket_price: 0, title: "Win a BMW M4", grand_prize: "BMW M4" }))
      .toEqual({ free: false, reason: "£0 with no free wording" });
  });
  test("a paid draw is never 'free'", () => expect(freeCheck({ ticket_price: 0.99, title: "FREE BMW" }).free).toBe(false));
  test("a null price is never 'free'", () => expect(freeCheck({ ticket_price: null, title: "FREE BMW" }).free).toBe(false));
});
