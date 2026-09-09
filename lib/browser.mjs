// Chromium launch options, with the sandbox's proxy folded in.
//
// ⚠️ PLAYWRIGHT DOES NOT INHERIT THE SHELL'S PROXY. Measured in the cloud routine sandbox
// 2026-09-09: every operator page died with `net::ERR_CONNECTION_RESET` while plain `curl` to
// the SAME url returned HTTP 200. That environment has no direct egress — everything leaves
// through HTTPS_PROXY, which curl reads from the environment and Chromium does not. Passing
// `proxy` to newContext() does not rescue it either: Chromium honours a per-context proxy only
// when the BROWSER was launched with one. So the proxy has to be decided at launch, which is
// what this module is for.
//
// Locally and in GitHub Actions no proxy variable is set, `proxyFromEnv` returns null, and the
// launch options are passed through byte-identical — the render path behaves exactly as before.

// Playwright wants a real scheme. `new URL()` alone is too permissive to use as the test:
// "localhost:8080" parses happily (scheme "localhost:") and would hand Chromium a proxy it
// cannot dial. A malformed value must cost us the proxy, never the browser.
const PROXY_SCHEME = /^(?:https?|socks[45]?):\/\/\S+$/i;

export function proxyFromEnv(env = process.env) {
  const raw = env?.HTTPS_PROXY || env?.https_proxy || env?.HTTP_PROXY || env?.http_proxy || "";
  const server = String(raw).trim();
  if (!server || !PROXY_SCHEME.test(server)) return null;
  const bypass = String(env?.NO_PROXY || env?.no_proxy || "").trim();
  return bypass ? { server, bypass } : { server };
}

// Never override a proxy the caller set deliberately — the environment is the fallback, not
// the authority.
export function chromiumLaunchOptions(base = {}, env = process.env) {
  if (base?.proxy) return { ...base };
  const proxy = proxyFromEnv(env);
  return proxy ? { ...base, proxy } : { ...base };
}
