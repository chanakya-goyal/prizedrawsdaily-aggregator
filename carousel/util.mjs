// carousel/util.mjs — shared retry + checked-fetch helpers (used by select/state/publish).
export async function withRetry(fn, { tries = 3, baseMs = 250, label = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt < tries - 1) await Bun.sleep(baseMs * 2 ** attempt);
    }
  }
  throw new Error(`${label ? label + ": " : ""}${lastErr?.message || lastErr}`, { cause: lastErr });
}

export async function fetchOk(url, init = {}, label = "fetch") {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
