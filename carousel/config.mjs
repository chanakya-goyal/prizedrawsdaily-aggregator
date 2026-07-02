// carousel/config.mjs — loads config.json once; the single source of truth for
// category identity, theme, IDs and paths. Env PDD_DIR overrides the working dir.
import raw from "./config.json";

export const CFG = raw;
export const GLOBAL = raw.global;

const FALLBACK = {
  visualWeight: 0.6, theme: "default", hashtags: ["#ukraffle", "#livedraws"],
  particles: { type: "embers", count: 46 }, valueLineMin: Infinity,
};

export function catCfg(slug) {
  const c = CFG.categories[slug];
  if (!c) return { ...FALLBACK, name: slug || "Prize", hook: "WIN BIG", seoKeyword: "UK competitions" };
  return { ...FALLBACK, ...c };
}

export const themeOf = (slug) => catCfg(slug).theme;

export function workDir() {
  if (process.env.PDD_DIR) return process.env.PDD_DIR;
  return GLOBAL.workDir.replace(/^~/, process.env.HOME || "/Users/chanakyagoyal");
}
