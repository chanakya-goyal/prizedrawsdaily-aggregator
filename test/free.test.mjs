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
  test("'no cost' in the title counts as free wording", () => {
    expect(freeCheck(free("Win £5 Cash – no cost to enter")).free).toBe(true);
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

// Found by the 2026-10-15 A/B, reading every passing £0 draw against its own page.
describe("freeCheck: live A/B findings (2026-10-15)", () => {
  test("'No purchase required' is free wording, not a catch (Bonkers)", () => {
    const r = freeCheck(free("ABARTH 500 T-JET – FREE ENTRY! – MUST ANSWER THE PHONE!", { free_text: "✅ 5 FREE tickets per person ✅ No purchase required 💥" }));
    expect(r).toEqual({ free: true, reason: "free to enter" });
  });
  test("'Spend over £1 … to qualify' decides the prize, so it is a catch (RaffledUp)", () => {
    const r = freeCheck(free("FREEBIE FRIDAY!", { free_text: "Spend over £1 on DRAWN NEXT COMPS – Get £100 RU Credit (in the same order as your free ticket(s) to qualify.)" }));
    expect(r.reason).toBe("free but conditional: spend over £");
  });
  test("a spend-for-a-bonus line also rejects (Pawsome; fails closed, by design)", () => {
    expect(freeCheck(free("FREE ENTRY – Amazon Echo Dot", { free_text: "Bonus: Spend over £1 on the order that includes this free ticket and you'll also bag £20 credit" })).free).toBe(false);
  });
  test("'NEW CUSTOMERS ONLY' in the title is a catch, as Click's means 'place your first order' (Click)", () => {
    expect(freeCheck(free("Win £1,000 Tax Free Cash For FREE! *NEW CUSTOMERS ONLY*")).reason).toBe("free but conditional: new customers only");
  });
  test("'place your first order' is a catch", () => {
    expect(freeCheck(free("FREE £1,000", { free_text: "Simply place your first order on any live competition and you'll receive your free entry." })).reason).toBe("free but conditional: first order");
  });
});

// Whole-branch review findings (2026-10-15).
describe("freeCheck: a paid draw misread as £0 is never 'free' (review, Critical)", () => {
  test("'Free postal entry' boilerplate in the description is not free wording", () => {
    expect(freeCheck(free("Win A 2025 Apple iPad!", { grand_prize: "Apple iPad", free_text: "Free postal entry route available. See T&Cs." })))
      .toEqual({ free: false, reason: "£0 with no free wording" });
  });
  test("'no cost' in the description alone is not free wording", () => {
    expect(freeCheck(free("Win A Rolex", { grand_prize: "Rolex", free_text: "Enter by post at no cost." })).free).toBe(false);
  });
  test("'tax free' and 'free delivery' in the title are not free wording", () => {
    expect(freeCheck(free("£10,000 TAX FREE CASH", { grand_prize: "£10,000 cash" })).free).toBe(false);
    expect(freeCheck(free("Dyson V15 + Free Delivery", { grand_prize: "Dyson V15" })).free).toBe(false);
  });
  test("a title that says free still passes", () => {
    expect(freeCheck(free("Win £5 Cash - FREE", { free_text: "Free postal entry available" })).free).toBe(true);
  });
});

describe("freeCheck: more ways a catch is written (review, Important)", () => {
  const cases = [
    ["FREE £100", "Spend over £20 to qualify", "spend over £"],
    ["FREE £100", "Spend a minimum of £10 this week", "spend a minimum of £"],
    ["FREE £100", "Buy any ticket this week and you're automatically entered", "buy any ticket"],
    ["FREE £100", "Open to customers who have made a deposit", "deposit"],
    ["FREE £100", "Open to ticket holders of our main draw", "ticket holders"],
    ["FREE £100", "<p>Spend &pound;5 to enter</p>", "spend £"],
  ];
  for (const [t, ft, phrase] of cases) test(ft, () => expect(freeCheck(free(t, { free_text: ft })).reason).toBe(`free but conditional: ${phrase}`));
});
