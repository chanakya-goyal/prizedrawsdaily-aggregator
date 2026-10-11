import { test, expect } from "bun:test";
import { closesLabel, priceLabel, cleanTitle } from "../format.mjs";

// 30 Jun 2026 was a Tuesday. en-GB "30/06/2026" is unparseable by new Date() —
// the old code returned the generic label instead of TONIGHT/TOMORROW.
test("closesLabel: tonight/tomorrow across day>12 dates", () => {
  const now = new Date("2026-06-30T10:00:00+01:00"); // London morning, Jun 30
  expect(closesLabel("2026-06-30T21:00:00+01:00", now)).toBe("CLOSES TONIGHT");
  expect(closesLabel("2026-07-01T21:00:00+01:00", now)).toBe("CLOSES TOMORROW (WED)");
});

test("closesLabel: London day boundary vs IST machine clock", () => {
  // 23:30 UTC Jul 1 = 00:30 London Jul 2 (BST) = 05:00 IST Jul 2.
  const now = new Date("2026-07-01T23:30:00Z");
  // Draw closes 21:00 London Jul 2 — same *London* day as `now` → TONIGHT.
  expect(closesLabel("2026-07-02T21:00:00+01:00", now)).toBe("CLOSES TONIGHT");
});

test("closesLabel: month boundary rollover", () => {
  const now = new Date("2026-07-31T12:00:00+01:00");
  expect(closesLabel("2026-08-01T20:00:00+01:00", now)).toBe("CLOSES TOMORROW (SAT)");
});

test("format helpers unchanged", () => {
  expect(priceLabel(0.05)).toBe("5p");
  expect(priceLabel(2)).toBe("£2");
  expect(priceLabel(49.97)).toBe("£49.97");
  expect(cleanTitle("Win this BMW M340d Touring + £1,000 cash!")).toBe("BMW M340d Touring");
});

// ── cash attached to a prize: BONUS (on top) vs ALTERNATIVE (instead) ──────────────────────────
// Real live titles, 2026-10-11. The old cashAlt() matched any "£X cash" and called it an
// alternative, so "Tiguan R + £2,000 cash" (a bonus) read "or £2k cash", a cash-only draw got its
// own prize as an "alternative", and every amount was stamped TAX-FREE whatever the operator said.
import { cashExtras, cashAlt, shortMoney } from "../format.mjs";

const alt = (t) => cashExtras(t).alternative;
const bonus = (t) => cashExtras(t).bonus;

test("cashExtras: '+ £X cash' is a BONUS, never an alternative", () => {
  for (const t of ["Win This Volkswagen Tiguan R + £2,000 Cash!", "Win This Porsche 911 Carrera S + £2,000 Cash!",
                   "FORD TRANSIT CUSTOM MS-RT + £5,000 CASH!", "Win This VW Transporter + Dewalt Tool Bundle + £1,000 Cash!"]) {
    expect(alt(t)).toBeNull();
    expect(bonus(t)).not.toBeNull();
  }
  expect(bonus("Win This Volkswagen Tiguan R + £2,000 Cash!")).toEqual({ amount: 2000, taxFree: false });
});

test("cashExtras: 'or £X' / 'CASH ALT(ERNATIVE)' is an ALTERNATIVE", () => {
  expect(alt("Win a Legendary Mercedes 190E Cosworth Evo 1 Build or £22,500 Cash!")).toEqual({ amount: 22500, taxFree: false });
  expect(alt("NINJA CRISPi DualZone 8-Function Glass Air Fryer or £200 Cash!")).toEqual({ amount: 200, taxFree: false });
  expect(alt("BRAND NEW IPHONE DUO 1TB | £2,000 CASH ALTERNATIVE")).toEqual({ amount: 2000, taxFree: false });
  expect(alt("WIN AN OMEGA SPEEDMASTER MOONWATCH PROFESSIONAL | £4,500 CASH ALT")).toEqual({ amount: 4500, taxFree: false });
  expect(alt("LEGO Halloween Wreath or £30 Cash alt")).toEqual({ amount: 30, taxFree: false });
  expect(alt("His & Hers Creed Aventus or £400 Cash!")).toEqual({ amount: 400, taxFree: false });
  expect(alt("Tower Bridge Lego Set or £190 - 13/10/2026 | Apex Competitions")).toEqual({ amount: 190, taxFree: false });
  expect(alt("CHLOE SIGNATURE Eau De Parfum 100ml Gift Set OR £115")).toEqual({ amount: 115, taxFree: false });
});

test("cashExtras: a package with both — bonus on top AND a cash alternative", () => {
  const m4 = cashExtras("Win This BMW M4 and £3,000 or £30,000 Tax-Free");
  expect(m4.bonus).toEqual({ amount: 3000, taxFree: false });
  expect(m4.alternative).toEqual({ amount: 30000, taxFree: true });
  const m340 = cashExtras("Win this 2026 BMW M340i Touring & £2,000 or £45,000 Tax Free Cash");
  expect(m340.bonus).toEqual({ amount: 2000, taxFree: false });
  expect(m340.alternative).toEqual({ amount: 45000, taxFree: true });
});

test("cashExtras: instant-win pools, end prizes and jackpots are neither", () => {
  expect(cashExtras("Audi Q2 or £10,000 Cash + 100 x £100 Breeze Cash Instant Wins!!")).toEqual({ alternative: { amount: 10000, taxFree: false }, bonus: null });
  expect(cashExtras("Toyota Yaris 1.6T GR Circuit AWD or £18,000 Cash + £15K Instant Wins").bonus).toBeNull();
  for (const t of ["🪄 MAGIC MONEY – £5,000 TOP PRIZE + £10,000 CASH INSTANTS 🔮",
                   "Treasure Hunters – £5,000 Cash + £10K Find & Win Instants 💰",
                   "50/50 CHANCE OF WINNING! 125,000 PRIZES INCLUDING 10 VEHICLES + £2,000 END PRIZE!",
                   "Cauldron of Cash – Every Ticket Wins – Prize Every Time! & £250 Jackpot",
                   "12 Mystery Bobbing Apples – £3k Cash Instants & £200 Main Prize – 22p"]) {
    expect(cashExtras(t)).toEqual({ alternative: null, bonus: null });
  }
});

test("cashExtras: when the main prize IS cash there is nothing to attach", () => {
  for (const t of ["Win £1000 Tax Free Cash for just 1p!", "💰£2,000 Cash – Super Low Odds", "£250 CASH",
                   "£5,000 Cash + 30 Mystery Instant Wins!", "Win £15,000 Cash For 99p! | Podium Prize",
                   "£500 Tickets To The Big £155k Cash Money Comp + Instant Wins #1"]) {
    expect(cashExtras(t)).toEqual({ alternative: null, bonus: null });
  }
});

test("cashExtras: cash instead of a SUB-item is not an alternative to the prize", () => {
  // the £3,500 replaces the tools, not the van
  expect(cashExtras("Ford Transit Custom Sport + Your Choice of Milwaukee Tools or £3,500 CASH")).toEqual({ alternative: null, bonus: null });
});

test("cashExtras: first source that states it wins; later sources fill the gap", () => {
  // grand_prize lost the cash; the title still carries it
  expect(cashExtras("BMW X3M", "Win This BMW X3 X-Drive 30D M-Sport + £5,000 Cash!").bonus).toEqual({ amount: 5000, taxFree: false });
  expect(cashExtras(null, undefined, "")).toEqual({ alternative: null, bonus: null });
});

test("cashAlt (legacy string): alternative only, TAX-FREE only when the operator says so", () => {
  expect(cashAlt("Win This Volkswagen Tiguan R + £2,000 Cash!")).toBeNull();
  expect(cashAlt("Win a Legendary Mercedes 190E Cosworth Evo 1 Build or £22,500 Cash!")).toBe("£22,500 CASH");
  expect(cashAlt("Win This BMW M4 and £3,000 or £30,000 Tax-Free")).toBe("£30,000 TAX-FREE CASH");
});

test("shortMoney: bubble-sized amounts", () => {
  expect(shortMoney(30000)).toBe("£30k");
  expect(shortMoney(22500)).toBe("£22.5k");
  expect(shortMoney(2000)).toBe("£2k");
  expect(shortMoney(400)).toBe("£400");
  expect(shortMoney(1250000)).toBe("£1.25m");
});
