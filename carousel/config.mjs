// carousel/config.mjs — loads config.json once; the single source of truth for category
// identity, IDs and paths. Env PDD_DIR overrides the working dir.
import raw from "./config.json";
import { ALL_SCENE_IDS } from "./scene.mjs";

export const CFG = raw;
export const GLOBAL = raw.global;

// Six keys, and every category must carry all six. The old shape had nine: `theme` and
// `particles` belonged to the dark palette and the particle fields, and `hook` to the six
// "WIN A DREAM CAR" constants — all three are retired.
export const CATEGORY_KEYS = ["name", "visualWeight", "seoKeyword", "hashtags", "valueLineMin", "audioMood"];

// WHY THIS IS NOT A MERGE ANY MORE, AND WHY THAT MATTERS MORE THAN THE MISSING ENTRIES
//
// catCfg used to return `{ ...FALLBACK, ...c }`. That is a merge, so a category with a PARTIAL
// entry threw nothing and rendered: it silently inherited the fallback's visualWeight and an
// `Infinity` value-line floor. And a category with NO entry inherited theme "default", which
// was the orange car-draws palette — which is why sports-outdoors and home-garden, 147 draws
// and 16% of live inventory, rendered as car draws for months without one error.
//
// The failure was never the two missing entries. It was that missing and partial entries were
// indistinguishable from complete ones. So: a known slug returns its entry verbatim, and an
// unknown slug returns a FALLBACK whose visualWeight is ZERO — a tripwire rather than a default,
// because the picker multiplies by weight and can therefore never choose it.
const FALLBACK = {
  visualWeight: 0,
  hashtags: ["#ukcompetition"],
  valueLineMin: Infinity,
  audioMood: "win",
};

export function catCfg(slug) {
  const c = CFG.categories[slug];
  if (c) return c;
  return { ...FALLBACK, name: slug || "Prize", seoKeyword: "UK competitions" };
}

// The deck size is an authored constant, not an environment variable. A post whose draw count
// varies run to run cannot be read as a series: the caption, the counter chip, the band's draw
// count and the cover's proof line are all derived from what actually RENDERED.
export const drawsPerDeck = () => Number(GLOBAL.drawsPerDeck);

export function workDir() {
  if (process.env.PDD_DIR) return process.env.PDD_DIR;
  return GLOBAL.workDir.replace(/^~/, process.env.HOME || "/Users/chanakyagoyal");
}

// Called by the config gate. Kept here rather than in the test so the same check is available
// to any caller that wants to fail early rather than render something wrong.
export function configProblems() {
  const problems = [];
  const slugs = Object.keys(CFG.categories);
  const taxonomy = [...ALL_SCENE_IDS].sort();
  if (JSON.stringify([...slugs].sort()) !== JSON.stringify(taxonomy)) {
    problems.push(`category slugs do not match the taxonomy.\n  config.json: ${[...slugs].sort().join(", ")}\n  taxonomy:    ${taxonomy.join(", ")}`);
  }
  for (const [slug, c] of Object.entries(CFG.categories)) {
    const keys = Object.keys(c).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...CATEGORY_KEYS].sort())) {
      problems.push(`${slug}: key set is [${keys.join(", ")}], expected [${[...CATEGORY_KEYS].sort().join(", ")}]`);
    }
    if (!(c.visualWeight > 0 && c.visualWeight <= 1)) problems.push(`${slug}: visualWeight ${c.visualWeight} outside (0, 1]`);
    if (!(c.valueLineMin >= 1000)) problems.push(`${slug}: valueLineMin ${c.valueLineMin} below the 1000 floor`);
    for (const h of c.hashtags || []) {
      if (!/^#[a-z0-9]+$/.test(h)) problems.push(`${slug}: hashtag ${h} is not lowercase alphanumeric`);
      if (GLOBAL.fixedHashtags?.includes(h)) problems.push(`${slug}: hashtag ${h} collides with a global fixed tag`);
    }
  }
  if (!(drawsPerDeck() >= 4)) problems.push(`global.drawsPerDeck ${GLOBAL.drawsPerDeck} below the 4-draw floor`);
  return problems;
}
