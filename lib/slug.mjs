// Collision-suffix a slug against the ones already taken, never exceeding `max`.
// The suffix is made room for by trimming the BASE: slicing `${base}-2` back to `max` drops the
// suffix whenever the base is already `max` long, returns the same taken slug, and loops forever
// (the 2026-09-27 JSON-sweep hang).
export function uniqueSlug(base, taken, max = 120) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const s = `${base.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(s)) return s;
  }
}
