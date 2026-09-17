// The brand system as DATA, not as text scraped out of a stylesheet.
//
// WHY THIS FILE EXISTS
// The three video templates used to build their CSS by regex-scraping styles.css for `:root{}`
// and `[data-theme]{}` blocks. That is the architectural defect Stage A set out to remove: only
// flat token declarations survive the lift, so any rule with a descendant selector rendered on
// the carousel and silently vanished from the Reel and the Story. Tokens now come from here, by
// import, and no file reads another file's CSS as text.
//
// Single source: styles.css no longer declares these. It consumes them.
export const TOKENS = {
  "--ground": "#F7F5F0",
  "--surface": "#FFFFFF",
  "--scene-tone": "#EAE4D6",
  "--ink": "#14161A",
  "--ink-meta": "#5A5F66",
  "--hairline": "#D8D3C8",
  "--rule": "#8C8677",
  "--rail": "#14385F",
  "--rail-ink": "#F7F5F0",
  "--rail-meta": "#B9C6D6",
  "--rail-accent": "#FFC53D",
  "--verdict": "#0F6B45",
  "--verdict-tint": "#E6F2EA",
  "--deadline": "#B3202C",
  "--closing": "#FFC53D",
  "--dot-hit": "#0F6B45",
  "--dot-size": "10px",
  "--dot-gap": "5px",
  "--font-text": "'Inter'",
  "--font-figure": "'JetBrains Mono'",
  "--font-chrome": "'Inter'",
  "--fs-hero": "150px",
  "--lh-hero": "150px",
  "--fs-figure": "120px",
  "--lh-figure": "120px",
  "--fs-display": "88px",
  "--lh-display": "90px",
  "--fs-title": "68px",
  "--lh-title": "70px",
  "--fs-lead": "56px",
  "--lh-lead": "60px",
  "--fs-body": "48px",
  "--lh-body": "60px",
  "--fs-label": "44px",
  "--lh-label": "50px",
  "--fs-legal": "38px",
  "--lh-legal": "45px",
  "--fs-micro": "34px",
  "--lh-micro": "40px",
  "--tr-display": "-0.02em",
  "--tr-label": "0.08em",
  "--tr-figure": "0",
  "--gutter": "65px",
  "--sp-0": "5px",
  "--sp-1": "10px",
  "--sp-15": "15px",
  "--sp-2": "20px",
  "--sp-3": "30px",
  "--sp-4": "40px",
  "--sp-5": "60px",
  "--sp-6": "90px",
  "--sp-7": "120px",
  "--scene-wash": "rgba(247,245,240,.86)",
};

// Emitted as a :root block so a stylesheet can consume it unchanged, and so a per-canvas
// override still works by cascade order — a later :root in a template's own CSS wins.
export const tokenCss = () =>
  ":root{" + Object.entries(TOKENS).map(([k, v]) => `${k}:${v}`).join(";") + "}";

// A few callers want a number rather than a CSS string (a renderer reserving height, a gate
// asserting a floor). Parsing it here keeps the unit in one place.
export const px = (name) => {
  const v = TOKENS[name];
  const n = v && parseFloat(String(v));
  if (!Number.isFinite(n)) throw new Error(`tokens: ${name} is not a px value (got ${v})`);
  return n;
};
