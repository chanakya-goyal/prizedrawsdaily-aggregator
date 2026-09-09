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

// Credentials are split OUT of `server` into playwright's own username/password fields. Two
// reasons, and the second is the one that matters: chromium wants them there anyway, and
// `server` is printed — by browser-doctor, and from there verbatim into a QA report that gets
// pushed as a notification. A proxy URL of the form http://user:pass@host would otherwise carry
// the password into every one of those. Nothing that prints a proxy should ever have to
// remember to strip it.
export function proxyFromEnv(env = process.env) {
  const raw = env?.HTTPS_PROXY || env?.https_proxy || env?.HTTP_PROXY || env?.http_proxy || "";
  const value = String(raw).trim();
  if (!value || !PROXY_SCHEME.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  const username = decodeURIComponent(u.username || "");
  const password = decodeURIComponent(u.password || "");
  // Rebuild from parts rather than URL.toString(), which appends a "/" that the caller never
  // wrote and existing callers do not expect.
  const path = u.pathname === "/" ? "" : u.pathname;
  const out = { server: `${u.protocol}//${u.host}${path}${u.search}` };
  if (username) out.username = username;
  if (password) out.password = password;
  const bypass = String(env?.NO_PROXY || env?.no_proxy || "").trim();
  if (bypass) out.bypass = bypass;
  return out;
}

// For printing a RAW environment value (which we do not control the shape of) safely.
export function redactProxyUrl(value) {
  const s = String(value || "");
  if (!s) return s;
  return s.replace(/(\/\/)[^/@\s]*:[^/@\s]*@/, "$1***:***@").replace(/(\/\/)[^/:@\s]+@/, "$1***@");
}

// Never override a proxy the caller set deliberately — the environment is the fallback, not
// the authority.
export function chromiumLaunchOptions(base = {}, env = process.env) {
  if (base?.proxy) return { ...base };
  const proxy = proxyFromEnv(env);
  return proxy ? { ...base, proxy } : { ...base };
}
