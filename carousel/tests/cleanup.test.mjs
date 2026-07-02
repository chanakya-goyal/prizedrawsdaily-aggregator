import { test, expect } from "bun:test";
import { readyForCleanup } from "../cleanup.mjs";

test("cleanup only when every row is published", () => {
  expect(readyForCleanup([{ status: "published" }, { status: "published" }])).toBe(true);
  expect(readyForCleanup([{ status: "published" }, { status: "assets_uploaded" }])).toBe(false);
  expect(readyForCleanup([])).toBe(false);
});
