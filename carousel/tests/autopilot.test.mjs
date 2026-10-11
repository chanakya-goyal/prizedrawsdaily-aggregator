import { test, expect } from "bun:test";
import { reportStatus, ukHour, inWindow } from "../autopilot/status.mjs";

test("REPORT.md status is read from an exact first line only", () => {
  expect(reportStatus("STATUS: PUBLISHED\ncategory: car-draws")).toBe("PUBLISHED");
  expect(reportStatus("STATUS: DRY-RUN")).toBe("DRY-RUN");
  expect(reportStatus("STATUS: SKIPPED\n")).toBe("SKIPPED");
  // anything a run could write by accident reads as unknown, which the wrapper treats as FAILED
  expect(reportStatus("")).toBeNull();
  expect(reportStatus("Status: published")).toBeNull();
  expect(reportStatus("notes\nSTATUS: PUBLISHED")).toBeNull();
  expect(reportStatus("STATUS: DONE")).toBeNull();
});

test("the posting window is UK wall-clock hours, across both clock changes", () => {
  // 16:15 IST = 10:45 UTC: 11:45 BST in summer, 10:45 GMT in winter — both inside the window
  expect(ukHour(new Date("2026-07-01T10:45:00Z"))).toBe(11);
  expect(ukHour(new Date("2026-12-01T10:45:00Z"))).toBe(10);
  expect(inWindow(new Date("2026-07-01T10:45:00Z"))).toBe(true);
  expect(inWindow(new Date("2026-12-01T10:45:00Z"))).toBe(true);
  // a catch-up when the Mac wakes at 3am UK must not post
  expect(inWindow(new Date("2026-07-01T02:00:00Z"))).toBe(false);
  expect(inWindow(new Date("2026-12-01T20:30:00Z"))).toBe(false);
});

test("AUTOPILOT.md keeps the rules the wrapper depends on", async () => {
  const md = await Bun.file(new URL("../AUTOPILOT.md", import.meta.url)).text();
  for (const s of ["STATUS: PUBLISHED", "STATUS: SKIPPED", "STATUS: DRY-RUN", "STATUS: FAILED",
                   "DRY RUN STOPS HERE", "caption-check.mjs", "state-mark.mjs fb_album skipped", "Never publish a frame you have not looked at"]) {
    expect(md).toContain(s);
  }
});
