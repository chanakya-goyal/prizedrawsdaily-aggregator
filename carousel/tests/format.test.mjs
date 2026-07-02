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
