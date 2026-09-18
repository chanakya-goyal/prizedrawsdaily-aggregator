// Per-category visual identity, owned in ONE place (spec §8).
//
// WHY THIS MODULE EXISTS
// The still renderer and the three video templates used to share design by REGEX-SCRAPING
// carousel/styles.css for `:root{…}` and `[data-theme="x"]{…}` blocks. Only flat token blocks
// survive that lift, so any rule with a descendant selector — `[data-theme="tech"] .techgrid`,
// `[data-theme="collect"] .card::after` — rendered on the carousel and silently vanished from
// the Reel and the Story. That was not a hypothetical: it was the shipped state of three of the
// six themes. A scene is STRUCTURE, not a token, so under the old architecture the brief's own
// idea — a looping turf scene for sports — would have appeared on the one surface that cannot
// animate and disappeared from the two that can.
//
// So: every surface imports this module. Nothing reads another file's CSS as text.
//
// THE BOX
// A scene never knows what canvas it is on. It is handed a BOX — {x, y, w, h, ground} — and
// draws relative to it. On 9:16 a box is a lane (the brand rail, the insert card); on 4:5 it is
// sceneRegion(role). `ground` is "paper" or "rail" and decides paint, because the same stroke
// that reads as a hairline on newsprint would be invisible on rail blue.
//
// WHAT A SCENE MAY DRAW IN
// --ink, --ink-meta, --hairline, --ground and --rail. NEVER --closing (amber), --verdict
// (green) or --deadline (red): those three are DATA STATES, and spending them on decoration
// devalues the signal the data layer depends on. This is why the sports scene has no amber
// pennant and the cash ghost has no green dot.

// Alpha caps are §8.4's, and they are per-pixel tone limits rather than taste: a field may not
// darken its ground by more than ΔL 0.10 on paper or 0.016 on rail blue.
const FIELD_INK = 0.05;   // a filled field on paper, e.g. mown stripes
const LINEWORK_RAIL = 0.17; // --rail line work on paper
const LINEWORK_INK = 0.15;  // --ink line work on paper
const RAIL_WASH = 0.06;   // anything drawn on a rail-blue lane

// On rail blue every scene paints in --ground at 6%; on paper it paints in --hairline at full
// strength. One helper so no scene has to remember which surface it is on.
// On the STILL every scene pixel resolves to one flat tone, --scene-tone. That is not a
// simplification for its own sake: a 4:5 slide has no motion to carry a texture, so varying
// alpha across a scene region only produces a visible edge where the region stops — which reads
// as a rendering fault rather than as paper. One tone has no edge to notice.
const stroke = (box) => box.ground === "still" ? "var(--scene-tone)"
  : box.ground === "rail" ? `rgba(247,245,240,${RAIL_WASH})` : "var(--hairline)";
// A field's alpha is baked into the colour rather than applied as a group opacity, so it cannot
// be lost the way the cash ghost's was. FIELD_INK is §8.4's cap for a filled field on paper.
const fieldFill = (box) => box.ground === "still" ? "var(--scene-tone)"
  : box.ground === "rail" ? `rgba(247,245,240,${RAIL_WASH})` : `rgba(20,22,26,${FIELD_INK})`;
const railInk = (box) => box.ground === "still" ? "var(--scene-tone)"
  : box.ground === "rail" ? `rgba(247,245,240,${RAIL_WASH})` : `rgba(20,56,95,${LINEWORK_RAIL})`;
const inkBar = (box) => box.ground === "still" ? "var(--scene-tone)"
  : box.ground === "rail" ? `rgba(247,245,240,${RAIL_WASH})` : `rgba(20,22,26,${LINEWORK_INK})`;

// Every scene draws into an SVG sized exactly to its box, so coordinates in the scene bodies
// are box-relative and a scene can be dropped into any lane without rewriting its geometry.
const svg = (box, inner, cls = "") =>
  `<svg class="sc-svg ${cls}" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}" `
  + `fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${inner}</svg>`;

// Phase-anchoring: the scene's field is anchored to the SAFE AREA's origin (x 65, y 269), not to
// the box. Two lanes on the same frame therefore show one continuous field rather than two
// fields that happen to sit near each other. `firstAt` returns the first gridline of pitch `p`
// at or above the box edge, given an absolute anchor.
const firstAt = (anchorAbs, pitch, boxAbs) => {
  const k = Math.ceil((boxAbs - anchorAbs) / pitch);
  return anchorAbs + k * pitch;
};
const SAFE_X = 65, SAFE_Y = 269;

// ---------------------------------------------------------------- the nine definitions

// NEUTRAL is what an unrecognised slug gets. It is a real scene, not an empty one, so a new
// category added to the taxonomy renders as PAPER rather than as a car draw — which is what
// used to happen, because the fallback theme was the orange "default" block.
const NEUTRAL = {
  id: "neutral", title: "Paper", loopMs: 0, amplitudeClass: "envelope", amplitudePx: 0,
  structural: ["sc-baseline"],
  back(box) {
    const p = 45, out = [];
    for (let y = firstAt(SAFE_Y, p, box.y); y < box.y + box.h; y += p) {
      out.push(`<line class="sc-baseline" x1="0" y1="${y - box.y}" x2="${box.w}" y2="${y - box.y}" stroke="${stroke(box)}" stroke-width="1"/>`);
    }
    return svg(box, out.join(""));
  },
};

// 1. car-draws — "The Logbook". The V5C service-record page, not the showroom. Deliberately
// avoids the chequer-plate garage floor that Dream Car Giveaways and Click Competitions both
// use, and the dark-plus-glow ground PDD currently shares with Omaze, Elite and BOTB.
const CAR = {
  id: "car-draws", title: "The Logbook", loopMs: 3600, amplitudeClass: "field", amplitudePx: 45,
  structural: ["sc-rules", "sc-spine"],
  back(box) {
    const p = 45, rules = [];
    // Drawn one pitch over-tall: the field translates by exactly one pitch, so the row that
    // leaves the top must be replaced by one entering the bottom or the loop shows a seam.
    for (let y = firstAt(SAFE_Y, p, box.y) - p; y < box.y + box.h + p; y += p) {
      rules.push(`<line x1="0" y1="${y - box.y}" x2="${box.w}" y2="${y - box.y}" stroke="${stroke(box)}" stroke-width="1"/>`);
    }
    return svg(box, `<g class="sc-rules">${rules.join("")}</g>`
      + `<rect class="sc-spine" x="50" y="0" width="5" height="${box.h}" fill="${railInk(box)}"/>`);
  },
};

// 2. cash-prizes — "The Count". Cash is 39% of enterable inventory and the category where
// flying banknotes are most expected (observed on Storm twice, Elite and BOTB). This is the
// opposite move: the odds lattice itself, ghosted to 12%.
//
// The scene publishes NO lattice geometry of its own — §4.4 owns dot size, gap and pitch, and
// the ghost is an echo of that lattice. It carries no green dot in either state: at 12% the
// lattice is not countable, so a mark inside it would be a claim with no visible denominator,
// which is the exact CAP 8.20/8.21 emphasis hazard the odds device exists to avoid.
const CASH = {
  id: "cash-prizes", title: "The Count", loopMs: 4000, amplitudeClass: "envelope", amplitudePx: 0,
  structural: ["sc-lattice"],
  back(box) {
    const d = 10, gap = 5, p = d + gap;
    const dots = [];
    for (let y = firstAt(SAFE_Y, p, box.y); y < box.y + box.h; y += p) {
      for (let x = firstAt(SAFE_X, p, box.x); x < box.x + box.w; x += p) {
        dots.push(`<circle cx="${x - box.x + d / 2}" cy="${y - box.y + d / 2}" r="${d / 2}"/>`);
      }
    }
    // The BASE opacity lives here, not in the motion keyframes. It was only in the keyframes,
    // which apply via `.sc-anim` — so on every static surface (the whole of 4:5, the Reel cover,
    // the Story) the lattice rendered at FULL strength: eight times darker than intended, and a
    // ghost that is not a ghost. The measurement tool caught it; no test could, because the
    // markup was correct and only the composite was wrong.
    return svg(box, `<g class="sc-lattice" fill="${stroke(box)}" opacity="0.12">${dots.join("")}</g>`);
  },
};

// 3. house-draws — "The Sheet". Ordnance-Survey register: territory at landscape scale.
// Distinguished from home-garden by SCALE — house is territory (40px survey grid, contours),
// home-garden is an object (25px squared paper, a dimension line). Deliberately avoids the red
// estate-agent board. Built and gated off: house-draws has zero enterable inventory, so the
// selector can never pick it, but the gate renders it from a fixture every run so it cannot rot.
const HOUSE = {
  id: "house-draws", title: "The Sheet", loopMs: 5000, amplitudeClass: "discrete", amplitudePx: 20,
  structural: ["sc-grid", "sc-contours"],
  back(box) {
    const p = 40, v = [], h = [];
    for (let x = firstAt(SAFE_X, p, box.x) - p * 5; x < box.x + box.w; x += p) {
      if (x < box.x) continue;
      const major = (x - SAFE_X) % 200 === 0;
      v.push(`<line x1="${x - box.x}" y1="0" x2="${x - box.x}" y2="${box.h}" stroke="${stroke(box)}" stroke-width="${major ? 2 : 1}" opacity="${major ? 1 : 0.5}"/>`);
    }
    for (let y = firstAt(SAFE_Y, p, box.y); y < box.y + box.h; y += p) {
      const major = (y - SAFE_Y) % 200 === 0;
      h.push(`<line x1="0" y1="${y - box.y}" x2="${box.w}" y2="${y - box.y}" stroke="${stroke(box)}" stroke-width="${major ? 2 : 1}" opacity="${major ? 1 : 0.5}"/>`);
    }
    // Two contour arcs, radius 7300, centres 40px apart on x 540. Equal radii with centres one
    // grid pitch apart puts them exactly 40px apart at EVERY x, so they can never cross — which
    // is what a contour interval means. Drawn over-wide and clipped so the box stays filled at
    // every motion phase.
    const R = 7300, B = box.h;
    const arc = (crestY) =>
      `<path d="M -40 ${crestY + 20} Q ${box.w / 2} ${crestY - 20} ${box.w + 40} ${crestY + 20}" stroke="${stroke(box)}" stroke-width="1.5" fill="none"/>`;
    return svg(box, `<g class="sc-grid">${v.join("")}${h.join("")}</g>`
      + `<g class="sc-contours">${arc(B - 85)}${arc(B - 45)}</g>`
      + `<rect x="${Math.max(0, SAFE_X - box.x)}" y="${Math.max(0, box.h - 60)}" width="2" height="25" fill="${railInk(box)}"/>`);
  },
};

// 4. tech-giveaways — "The Drawing". The technical drawing, not the keynote. Replaces the
// scanline grid and the chromatic split, which are the American arcade register and which were
// carousel-only anyway. The thinnest scene in the set at 0.511% coverage.
const TECH = {
  id: "tech-giveaways", title: "The Drawing", loopMs: 3000, amplitudeClass: "discrete", amplitudePx: 5,
  structural: ["sc-anchors", "sc-dims"],
  back(box) {
    // One row of four anchors, not two: a 116px rail lane cannot hold two rows plus a frame.
    const cy = 5 * Math.round(box.h / 10);
    const sw = box.ground === "rail" ? 1 : 0.5; // never thinner than 1px on rail blue: at the
    // 0.016 ΔL ceiling a 0.5px stroke resolves below the gate's own measurement threshold.
    const a = [];
    for (let k = 1; k <= 4; k++) {
      const x = 65 + 120 * k - box.x;
      if (x < 0 || x > box.w) continue;
      a.push(`<circle class="sc-anchor sc-a${k}" cx="${x}" cy="${cy}" r="15" stroke="${stroke(box)}" stroke-width="${sw}" fill="none"/>`);
      // The leader starts at the PEAK radius edge so the pulse can never overrun it.
      a.push(`<line x1="${x - 60}" y1="${cy}" x2="${x - 20}" y2="${cy}" stroke="${stroke(box)}" stroke-width="${sw}"/>`);
    }
    // Dimension frame on two sides only, inset 20px — outside the gate's outermost border ring,
    // and on two sides so it can never read as a border (borders are an Instagram demotion).
    const dims = `<line x1="20" y1="20" x2="20" y2="${box.h - 20}" stroke="${stroke(box)}" stroke-width="${sw}"/>`
      + `<line x1="20" y1="${box.h - 20}" x2="${box.w - 20}" y2="${box.h - 20}" stroke="${stroke(box)}" stroke-width="${sw}"/>`
      + `<line x1="15" y1="20" x2="25" y2="20" stroke="${stroke(box)}" stroke-width="${sw}"/>`
      + `<line x1="${box.w - 20}" y1="${box.h - 25}" x2="${box.w - 20}" y2="${box.h - 15}" stroke="${stroke(box)}" stroke-width="${sw}"/>`;
    return svg(box, `<g class="sc-anchors">${a.join("")}</g><g class="sc-dims">${dims}</g>`);
  },
};

// 5. luxury — "The Catalogue". The auction catalogue page. Restraint IS the register: luxury
// earns it, and it is the one register unavailable to an operator who needs glow. No gold
// anywhere, which is the point.
const LUX = {
  id: "luxury", title: "The Catalogue", loopMs: 4800, amplitudeClass: "discrete", amplitudePx: 10,
  structural: ["sc-margin", "sc-lot"],
  back(box) {
    return svg(box,
      `<line class="sc-margin" x1="170" y1="0" x2="170" y2="${box.h}" stroke="${stroke(box)}" stroke-width="1"/>`
      + `<line x1="0" y1="55" x2="${box.w}" y2="55" stroke="${stroke(box)}" stroke-width="1"/>`
      // Welded at the TOP of the margin rule, so when it breathes only its bottom edge moves.
      + `<rect class="sc-lot" x="168" y="0" width="5" height="65" fill="${inkBar(box)}"/>`);
  },
};

// 6. collectibles — "The Uncut Sheet". The printer's press sheet: the collectible as one cell
// of something not yet cut. Replaces the holographic sheen sweep.
const COLLECT = {
  id: "collectibles", title: "The Uncut Sheet", loopMs: 4400, amplitudeClass: "envelope", amplitudePx: 0,
  structural: ["sc-cells", "sc-crops"],
  back(box) {
    const pw = 220, ph = 230, cells = [], crops = [];
    for (let x = firstAt(SAFE_X, pw, box.x); x < box.x + box.w; x += pw)
      cells.push(`<line x1="${x - box.x}" y1="0" x2="${x - box.x}" y2="${box.h}" stroke="${stroke(box)}" stroke-width="1"/>`);
    for (let y = firstAt(SAFE_Y, ph, box.y); y < box.y + box.h; y += ph)
      cells.push(`<line x1="0" y1="${y - box.y}" x2="${box.w}" y2="${y - box.y}" stroke="${stroke(box)}" stroke-width="1"/>`);
    for (let x = firstAt(SAFE_X, pw, box.x); x < box.x + box.w; x += pw)
      for (let y = firstAt(SAFE_Y, ph, box.y); y < box.y + box.h; y += ph) {
        const cx = x - box.x, cy = y - box.y;
        crops.push(`<line x1="${cx + 5}" y1="${cy}" x2="${cx + 20}" y2="${cy}" stroke="${stroke(box)}" stroke-width="1"/>`
          + `<line x1="${cx}" y1="${cy + 5}" x2="${cx}" y2="${cy + 20}" stroke="${stroke(box)}" stroke-width="1"/>`);
      }
    // Same fix as the cash ghost: the crop marks' 8-16% wave is a MODULATION of a base opacity,
    // and the base has to be in the markup or the static surfaces paint them solid.
    return svg(box, `<g class="sc-cells" opacity="0.5">${cells.join("")}</g>`
      + `<g class="sc-crops" opacity="0.12">${crops.join("")}</g>`);
  },
};

// 7. sports-outdoors — "The Marked Ground". The third-largest category (102 draws) and one of
// the two that had no theme at all — they rendered as CAR DRAWS. This is the brief's own idea
// made honest.
//
// What ships is an animated CHROME TEXTURE, not an animated backdrop. The stripes drift inside
// the data card and stand still in the brand rail. If the mental model was turf BEHIND the
// prize photograph, this is deliberately not that: it is the only version that keeps the
// full-bleed photograph, and therefore keeps the chrome constants and the no-border rule.
//
// HONEST CAVEAT: lib/parse.mjs contains no team-sport term at all — no hockey, football, rugby,
// cricket or tennis. The 102 draws are golf equipment, angling tackle, bikes, gym kit and
// camping gear. The pitch marking is therefore the fallback, not the typical case.
const SPORT = {
  id: "sports-outdoors", title: "The Marked Ground", loopMs: 5200, amplitudeClass: "field", amplitudePx: 90,
  structural: ["sc-turf"],
  back(box) {
    const period = 90, w = 45, bands = [];
    // One period over-wide at each end: the field translates by exactly one period, so a band
    // leaving the left must be replaced by one entering the right or the loop shows a seam.
    for (let x = firstAt(SAFE_X, period, box.x) - period * 2; x < box.x + box.w + period; x += period) {
      bands.push(`<rect x="${x - box.x}" y="0" width="${w}" height="${box.h}" fill="${fieldFill(box)}"/>`);
    }
    return svg(box, `<g class="sc-turf">${bands.join("")}</g>`);
  },
  // The marking is the ONLY thing a variant selects. The stripes are the category's GROUND and
  // are never withdrawn by a variant — a translating field that vanished at a row swap would
  // pop mid-loop with no specified transition.
  variantOf(draw) {
    const t = `${draw?.title || ""} ${draw?.grand_prize || ""}`.toLowerCase();
    if (/\b(golf|taylormade|callaway|titleist|mizuno|srixon|powakaddy|motocaddy|odyssey|scotty cameron|pxg|footjoy|irons|wedges|putters|fairway woods|rangefinder)\b/.test(t)) return "golf";
    if (/\b(fishing|tackle|carp|angling|paddle board|kayak|wetsuit|tent|camping)\b/.test(t)) return "water";
    if (/\b(e-bike|e-scooter|electric scooter|bicycle|cycling|peloton|mountain bike|road bike|gravel bike)\b/.test(t)) return "lane";
    if (/\b(treadmill|dumbbells|kettlebells|home gym)\b/.test(t)) return "none";
    return "pitch";
  },
};

// 8. home-garden — "The Plan". The other category that had no theme. The classifier shows what
// this actually is: DeWalt tool chests, rattan furniture, Ooni pizza ovens, hot tubs, sheds,
// lawnmowers. Not plants. So the register is the measured drawing, not the seed packet.
const HOME = {
  id: "home-garden", title: "The Plan", loopMs: 4000, amplitudeClass: "discrete", amplitudePx: 10,
  structural: ["sc-squared", "sc-dimension"],
  back(box) {
    const minor = 25, out = [];
    for (let x = firstAt(SAFE_X, minor, box.x); x < box.x + box.w; x += minor) {
      const major = (x - SAFE_X) % 100 === 0;
      out.push(`<line x1="${x - box.x}" y1="0" x2="${x - box.x}" y2="${box.h}" stroke="${stroke(box)}" stroke-width="1" opacity="${major ? 1 : 0.3}"/>`);
    }
    for (let y = firstAt(SAFE_Y, minor, box.y); y < box.y + box.h; y += minor) {
      const major = (y - SAFE_Y) % 100 === 0;
      out.push(`<line x1="0" y1="${y - box.y}" x2="${box.w}" y2="${y - box.y}" stroke="${stroke(box)}" stroke-width="1" opacity="${major ? 1 : 0.3}"/>`);
    }
    // A dimension line with a 90px break where a drawing would put its figure — left
    // deliberately empty, because a scene carries no text. The break is CENTRED, so when it
    // widens each painted end travels 10px, not 20.
    const by = box.h - 12, mid = box.w / 2;
    const dim = `<line class="sc-dimL" x1="0" y1="${by}" x2="${mid - 45}" y2="${by}" stroke="${stroke(box)}" stroke-width="1"/>`
      + `<line class="sc-dimR" x1="${mid + 45}" y1="${by}" x2="${box.w}" y2="${by}" stroke="${stroke(box)}" stroke-width="1"/>`
      + `<line x1="2" y1="${by - 5}" x2="2" y2="${by + 5}" stroke="${railInk(box)}" stroke-width="2"/>`
      + `<line x1="${box.w - 2}" y1="${by - 5}" x2="${box.w - 2}" y2="${by + 5}" stroke="${railInk(box)}" stroke-width="2"/>`;
    return svg(box, `<g class="sc-squared">${out.join("")}</g><g class="sc-dimension">${dim}</g>`);
  },
};

const SCENES = [CAR, CASH, HOUSE, TECH, LUX, COLLECT, SPORT, HOME];
const BY_ID = new Map(SCENES.map((s) => [s.id, s]));

// Total function of the slug alone. Never throws. There is no `scene` key in config.json and
// there must not be: SceneDef.id IS the slug, so a config key would be a second source of truth
// that can drift from this file.
export function sceneFor(slug) {
  const s = BY_ID.get(String(slug || ""));
  return s ? withDefaults(s) : withDefaults(NEUTRAL);
}
export const ALL_SCENE_IDS = SCENES.map((s) => s.id);

function withDefaults(s) {
  return {
    tokens: {},                       // §3.3: category identity carries NO colour.
    front: () => "",                  // at most one mark; not mounted on still-4x5
    variantOf: () => null,
    stillPhase: 0,
    ...s,
  };
}

// ---------------------------------------------------------------- surfaces

// A surface is DATA, not a hard-coded canvas. There are four, not three: reel.mjs's
// buildCoverHtml() renders a separate 1080x1920 card used as the Reel's thumbnail, and a scene
// that skips it makes the thumbnail disagree with the video it fronts.
export const SURFACES = {
  "still-4x5":       { w: 1080, h: 1350, dpr: 2, layers: ["back"],          motion: false },
  "reel-cover-9x16": { w: 1080, h: 1920, dpr: 1, layers: ["back", "front"], motion: false },
  "reel-9x16":       { w: 1080, h: 1920, dpr: 1, layers: ["back", "front"], motion: true  },
  "story-9x16":      { w: 1080, h: 1920, dpr: 1, layers: ["back", "front"], motion: false },
};

// Lane rects on 9:16 are TRANSCLUSIONS of the chrome tables, never literals typed here — the
// insert card has moved three times (h 272 -> 285 -> 346) and every typed copy of it in the
// design document was wrong after at least one of those moves.
export const LANES = {
  "reel-cover-9x16": [{ x: 0, y: 269, w: 1080, h: 116, ground: "rail" }],
  "reel-9x16": [
    { x: 0, y: 269, w: 1080, h: 116, ground: "rail" },   // R — brand rail, static always
    { x: 0, y: 661, w: 1080, h: 346, ground: "paper" },  // C — insert card, the only animated lane
  ],
  "story-9x16": [
    { x: 0, y: 0,    w: 1080, h: 269, ground: "rail" },
    { x: 0, y: 1152, w: 1080, h: 768, ground: "rail" },
  ],
};

// On 4:5 the scene paints behind the content, in the region left over once the slide's own
// blocks are subtracted. The region is a geometric consequence of the block tables, not an
// art-direction negotiation.
export function sceneRegion(role) {
  const R = {
    cover:   { y: 132, h: 740 },
    count:   { y: 132, h: 300 },
    draw:    { y: 632, h: 235 },
    closing: { y: 132, h: 1050 },
  }[role];
  return R ? { x: 0, y: R.y, w: 1080, h: R.h, ground: "still" } : null;
}

// ---------------------------------------------------------------- emit

export function sceneCss() {
  return `
.sc-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden}
.sc-box{position:absolute;overflow:hidden}
.sc-svg{display:block;position:absolute;left:0;top:0}
/* The scene subtrees are granted "no meaning" categorically, which is what lets a lane bleed
   to the frame edge exactly as a chrome band does. The guard is that a node in here carrying
   a text node fails the build. */
#scene-back,#scene-front{position:absolute;inset:0;pointer-events:none}
`.trim();
}

// Motion is emitted on reel-9x16 ONLY. Every loop is closed by construction: a periodic field
// translates by exactly one period, and a discrete element returns to where it started. That is
// what lets the build assert frame 0 and the final frame are byte-identical.
export function sceneMotion(scene, surface) {
  if (!SURFACES[surface]?.motion || !scene.loopMs) return "";
  const ms = scene.loopMs;
  const K = {
    "car-draws": `@keyframes sc-car{from{transform:translateY(0)}to{transform:translateY(-45px)}}
.sc-anim .sc-rules{animation:sc-car ${ms}ms linear infinite}`,
    "sports-outdoors": `@keyframes sc-turf{from{transform:translateX(0)}to{transform:translateX(-90px)}}
.sc-anim .sc-turf{animation:sc-turf ${ms}ms linear infinite}`,
    "cash-prizes": `@keyframes sc-count{0%{opacity:.12}50%{opacity:.22}100%{opacity:.12}}
.sc-anim .sc-lattice{animation:sc-count ${ms}ms ease-in-out infinite}`,
    "collectibles": `@keyframes sc-crop{0%{opacity:.08}50%{opacity:.16}100%{opacity:.08}}
.sc-anim .sc-crops{animation:sc-crop ${ms}ms ease-in-out infinite}`,
    "luxury": `@keyframes sc-lot{0%{height:65px}50%{height:75px}100%{height:65px}}
.sc-anim .sc-lot{animation:sc-lot ${ms}ms ease-in-out infinite}`,
    "tech-giveaways": `@keyframes sc-pulse{0%{r:15}50%{r:20}100%{r:15}}
.sc-anim .sc-anchor{animation:sc-pulse ${ms}ms ease-in-out infinite}
.sc-anim .sc-a2{animation-delay:${Math.round(ms * 0.25)}ms}
.sc-anim .sc-a3{animation-delay:${Math.round(ms * 0.5)}ms}
.sc-anim .sc-a4{animation-delay:${Math.round(ms * 0.75)}ms}`,
    "house-draws": `@keyframes sc-sway{0%{transform:translateX(0)}50%{transform:translateX(-20px)}100%{transform:translateX(0)}}
.sc-anim .sc-contours{animation:sc-sway ${ms}ms ease-in-out infinite}`,
    "home-garden": `@keyframes sc-measL{0%{transform:translateX(0)}50%{transform:translateX(-10px)}100%{transform:translateX(0)}}
@keyframes sc-measR{0%{transform:translateX(0)}50%{transform:translateX(10px)}100%{transform:translateX(0)}}
.sc-anim .sc-dimL{animation:sc-measL ${ms}ms ease-in-out infinite}
.sc-anim .sc-dimR{animation:sc-measR ${ms}ms ease-in-out infinite}`,
  }[scene.id];
  return K || "";
}

// The single entry point a renderer calls. Returns the #scene-back markup for a surface.
export function sceneBack(scene, surface, { role, draw, animate = false } = {}) {
  const boxes = surface === "still-4x5"
    ? [sceneRegion(role)].filter(Boolean)
    : (LANES[surface] || []);
  if (!boxes.length) return "";
  const variant = scene.variantOf ? scene.variantOf(draw) : null;
  // Only Lane C animates on the Reel. The brand rail is static ALWAYS, on every surface: a
  // moving brand mark reads as an error, and the rail is where the mark lives.
  const html = boxes.map((box, i) => {
    const animated = animate && surface === "reel-9x16" && box.ground === "paper";
    return `<div class="sc-box sc-${scene.id}${animated ? " sc-anim" : ""}" `
      + `style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px">`
      + scene.back({ ...box, variant, index: i }) + `</div>`;
  }).join("");
  return `<div id="scene-back" class="sc-layer">${html}</div>`;
}
