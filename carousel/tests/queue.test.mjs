import { test, expect } from "bun:test";
import { londonToUtc, slotWindow, dueVerdict, slotForNow, addDays, airTime, RUNWAY_MS } from "../autopilot/queue.mjs";

test("London wall-clock to UTC holds across both clock changes", () => {
  expect(londonToUtc("2026-10-21", "17:30").toISOString()).toBe("2026-10-21T16:30:00.000Z"); // BST
  expect(londonToUtc("2026-10-26", "17:30").toISOString()).toBe("2026-10-26T17:30:00.000Z"); // GMT
  expect(londonToUtc("2026-10-25", "07:30").toISOString()).toBe("2026-10-25T07:30:00.000Z"); // the change day, after 02:00
  expect(londonToUtc("2027-03-28", "07:30").toISOString()).toBe("2027-03-28T06:30:00.000Z"); // spring forward
  expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
});

test("slots: reel the same evening, reel-2 the next morning", () => {
  expect(slotWindow("reel", "2026-10-21")).toEqual({ from: new Date("2026-10-21T16:30:00Z"), to: new Date("2026-10-21T18:30:00Z") });
  expect(slotWindow("reel-2", "2026-10-24")).toEqual({ from: new Date("2026-10-25T07:30:00Z"), to: new Date("2026-10-25T09:30:00Z") });
  expect(() => slotWindow("story", "2026-10-21")).toThrow();
});

test("slotForNow reads the UK hour, so every launchd firing maps to the right slot", () => {
  // 22:15 / 23:15 IST in winter = 16:45 / 17:45 GMT: only the second is the evening slot
  expect(slotForNow(new Date("2026-12-01T16:45:00Z"))).toBe(null);
  expect(slotForNow(new Date("2026-12-01T17:45:00Z"))).toBe("reel");
  // 12:15 / 13:15 IST in summer = 07:45 / 08:45 BST
  expect(slotForNow(new Date("2026-07-01T06:45:00Z"))).toBe("reel-2");
  expect(slotForNow(new Date("2026-07-01T12:00:00Z"))).toBe(null);
});

test("dueVerdict: only inside the window, only once, only while the draw is open", () => {
  const item = { from: "2026-10-21T16:30:00Z", to: "2026-10-21T18:30:00Z" };
  const now = new Date("2026-10-21T16:45:00Z");
  const draw = { status: "active", draw_date: "2026-10-23T20:00:00Z" };
  expect(dueVerdict(item, { now, draw }).ok).toBe(true);
  expect(dueVerdict(item, { now: new Date("2026-10-21T15:00:00Z"), draw }).ok).toBe(false);
  expect(dueVerdict(item, { now: new Date("2026-10-21T19:00:00Z"), draw }).expired).toBe(true);
  expect(dueVerdict(item, { now, draw, row: { status: "published" } }).done).toBe(true);
  expect(dueVerdict(item, { now, draw: null }).ok).toBe(false); // unreadable draw: never post blind
  expect(dueVerdict(item, { now, draw: { ...draw, status: "ended" } }).expired).toBe(true);
  const closing = { status: "active", draw_date: new Date(now.getTime() + RUNWAY_MS - 60000).toISOString() };
  expect(dueVerdict(item, { now, draw: closing }).expired).toBe(true);
  expect(dueVerdict(null).ok).toBe(false);
});

test("airTime: each built Reel is worded for the moment its own slot opens", () => {
  const lunch = new Date("2026-10-21T11:15:00Z"); // 12:15 BST build
  expect(airTime(0, lunch).toISOString()).toBe("2026-10-21T16:30:00.000Z");
  expect(airTime(1, lunch).toISOString()).toBe("2026-10-22T06:30:00.000Z");
  const late = new Date("2026-10-21T17:00:00Z"); // built inside the evening slot: now, not the past
  expect(airTime(0, late)).toEqual(late);
  expect(airTime(5, lunch)).toEqual(lunch);
});
