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
  // decodeURIComponent is inside the guard, not after it: `new URL()` accepts a malformed
  // escape like `%zz` in the credentials and only the DECODE throws. Left outside, a single
  // stray percent in a proxy password would take down every chromium launch in the repo,
  // because chromiumLaunchOptions calls this on the way to launch.
  let u, username, password;
  try {
    u = new URL(value);
    username = decodeURIComponent(u.username || "");
    password = decodeURIComponent(u.password || "");
  } catch { return null; }
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
//
// The credential boundary is the LAST `@` in the authority, not the first: a password may
// legally contain an unescaped `@`, and `http://alice:pass@word@proxy:8080` has the password
// `pass@word`. Splitting on the first `@` masked `alice:pass` and printed `word@proxy:8080` —
// still a leak. The match is scoped to the authority so an `@` later in a path can never be
// mistaken for the boundary either.
export function redactProxyUrl(value) {
  const s = String(value || "");
  if (!s) return s;
  const m = s.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i);
  if (!m) return s;
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf("@");
  if (at === -1) return s;
  const creds = authority.slice(0, at);
  return `${scheme}${creds.includes(":") ? "***:***" : "***"}@${authority.slice(at + 1)}${rest}`;
}

// Never override a proxy the caller set deliberately — the environment is the fallback, not
// the authority.
export function chromiumLaunchOptions(base = {}, env = process.env) {
  if (base?.proxy) return { ...base };
  const proxy = proxyFromEnv(env);
  return proxy ? { ...base, proxy } : { ...base };
}
