import { test, expect } from "bun:test";
import { readyForCleanup } from "../cleanup.mjs";

test("cleanup only when every row is published", () => {
  expect(readyForCleanup([{ status: "published" }, { status: "published" }])).toBe(true);
  expect(readyForCleanup([{ status: "published" }, { status: "assets_uploaded" }])).toBe(false);
  expect(readyForCleanup([])).toBe(false);
});

test("skipped is a terminal state alongside published", () => {
  expect(readyForCleanup([{ status: "published" }, { status: "skipped" }])).toBe(true);
});

test("all-skipped is NOT ready (nothing was actually published)", () => {
  expect(readyForCleanup([{ status: "skipped" }, { status: "skipped" }])).toBe(false);
});

test("skipped + still-in-flight is NOT ready", () => {
  expect(readyForCleanup([{ status: "skipped" }, { status: "assets_uploaded" }])).toBe(false);
});
