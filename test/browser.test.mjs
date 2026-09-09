import { test, expect, describe } from "bun:test";
import { proxyFromEnv, chromiumLaunchOptions } from "../lib/browser.mjs";

// ── Playwright does not inherit the shell's proxy ───────────────────────────────────────
// Measured in the cloud routine sandbox 2026-09-09: every operator page died with
// `net::ERR_CONNECTION_RESET` while plain `curl` to the SAME url returned HTTP 200. The
// sandbox has no direct egress — everything goes through HTTPS_PROXY=http://127.0.0.1:41489,
// which curl reads from the environment and Chromium does not. Passing `proxy` to
// newContext() does not rescue it either: Chromium only honours a per-context proxy when the
// BROWSER was launched with one. So the proxy has to be decided at launch.
describe("proxyFromEnv", () => {
  test("no proxy in the environment → null, so nothing changes locally or in CI", () => {
    expect(proxyFromEnv({})).toBe(null);
  });
  test("HTTPS_PROXY is used", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:41489" })).toEqual({ server: "http://127.0.0.1:41489" });
  });
  test("lowercase https_proxy is used — both spellings appear in the wild", () => {
    expect(proxyFromEnv({ https_proxy: "http://127.0.0.1:41489" })).toEqual({ server: "http://127.0.0.1:41489" });
  });
  test("HTTP_PROXY is the fallback when HTTPS_PROXY is absent", () => {
    expect(proxyFromEnv({ HTTP_PROXY: "http://proxy:8080" })).toEqual({ server: "http://proxy:8080" });
  });
  test("HTTPS_PROXY wins over HTTP_PROXY", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" }).server).toBe("http://a:1");
  });
  test("whitespace is trimmed", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "  http://p:3128  " })).toEqual({ server: "http://p:3128" });
  });
  // A malformed value must never take the browser down with it: no proxy beats no browser.
  test("an unparseable value is ignored rather than thrown", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "not a url" })).toBe(null);
    expect(proxyFromEnv({ HTTPS_PROXY: "   " })).toBe(null);
  });
  test("NO_PROXY becomes the bypass list", () => {
    expect(proxyFromEnv({ HTTPS_PROXY: "http://p:3128", NO_PROXY: "localhost,127.0.0.1" }))
      .toEqual({ server: "http://p:3128", bypass: "localhost,127.0.0.1" });
  });
  test("NO_PROXY alone does nothing — there is no proxy to bypass", () => {
    expect(proxyFromEnv({ NO_PROXY: "localhost" })).toBe(null);
  });
});

describe("chromiumLaunchOptions", () => {
  const base = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };
  test("without a proxy the options are passed through untouched", () => {
    expect(chromiumLaunchOptions(base, {})).toEqual(base);
  });
  test("with a proxy the caller's own options survive alongside it", () => {
    const o = chromiumLaunchOptions(base, { HTTPS_PROXY: "http://127.0.0.1:41489" });
    expect(o.headless).toBe(true);
    expect(o.args).toEqual(base.args);
    expect(o.proxy).toEqual({ server: "http://127.0.0.1:41489" });
  });
  test("an explicit proxy from the caller is never overridden by the environment", () => {
    const o = chromiumLaunchOptions({ ...base, proxy: { server: "http://explicit:9" } }, { HTTPS_PROXY: "http://env:1" });
    expect(o.proxy).toEqual({ server: "http://explicit:9" });
  });
  test("called with no arguments it still returns usable options", () => {
    expect(chromiumLaunchOptions()).toBeTruthy();
  });
});
