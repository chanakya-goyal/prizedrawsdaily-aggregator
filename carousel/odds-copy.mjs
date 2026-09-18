// The ONLY place an odds string is composed (spec §10.6a).
//
// WHY A WHOLE MODULE FOR SOME SENTENCES
// An odds figure is a published objective claim about a named third party's promotion, so it
// sits under CAP Section 8. Three rules from that code shape every string below:
//   8.20/8.21 — a promoter must not exaggerate a consumer's chance of winning.
//   3.7       — evidence for an objective claim must be held BEFORE publication.
//   8.17      — significant conditions must appear in the promotional material itself.
// The strings are therefore not copy, they are the compliance surface, and they are kept here
// so a CI grep can forbid an odds literal appearing anywhere else under carousel/.
//
// THE STANDING BANS, each with the reason rather than just the rule:
//   - No second person. `YOUR ODDS AT THE CAP` is false for every viewer who does not hold
//     exactly one ticket, and undefined for a viewer holding none; under 8.21 it also implies
//     the reader is already entered.
//   - No superlative comparative. `SHORTEST TICKET CAP OF THE SIX` is a superlative form and
//     hard-codes a deck size.
//   - Never `sold` or `remaining`. Both are sell-through facts the pipeline does not hold, and
//     a ticket cap is not a sell-through figure.
//   - `read from` is the only permitted provenance verb. `verified` is forbidden: PDD reads a
//     number off a page, it does not audit it.
//   - No stated time of day in a CLOSING claim. A rendered closing time asserts a response
//     deadline, which is CAP 8.22 and the DMCC Act 2024's false-urgency ban. The read-at stamp
//     is a past-tense observation and is out of scope of that ban.

const nf = new Intl.NumberFormat("en-GB");
export const group = (n) => (Number.isFinite(Number(n)) ? nf.format(Math.round(Number(n))) : null);

// §4.7's ceiling. 24 rows of 60 dots on a 15px pitch across the 895px band. Above this the
// grid stops being countable, so the encoding changes rather than the grid getting denser: the
// digit count of the figure becomes the comparison.
export const GRID_CEILING = 1440;
export const GRID_COLS = 60;
export const GRID_ROWS_MAX = 24;

export const capFigure = (cap) => group(cap);
export const eyebrow = () => "TICKET CAP";

// The one-line qualifier under the E2 figure. "At sell-out" is doing load-bearing work: the
// stored cap is the MAXIMUM tickets, so the odds it implies are the worst case, reached only
// if every ticket sells. Stating it unqualified would overstate the chance, which is the
// direction CAP 8.20 actually cares about.
export const conditional = (cap) => `1 IN ${group(cap)} AT SELL-OUT`;

// The full band's legend. Three lines, and each one answers a question the picture raises.
export const legendFull = (cap) => [
  "Each dot is one ticket.",
  `Odds at sell-out: 1 in ${group(cap)}.`,
  "We do not know which ticket wins.",
];
// The clipped state drops the middle line: above the ceiling the grid is not the whole cap, so
// a bare odds sentence beside a partial picture invites the reader to count the dots and
// believe the answer.
export const legendClipped = (cap) => [
  "Each dot is one ticket.",
  "We do not know which ticket wins.",
];

// The correction carrier. It is MANDATORY in the clipped state: the grid shows 1,440 dots for a
// cap that may be 9,999, and without this line the picture is a materially understated claim
// about the odds. Budgeted at 33 glyphs; the worst live cap (4,500,000) makes 32.
export const annotation = (shown, cap) => `${group(shown)} OF ${group(cap)} · NONE MARKED`;

// Provenance. Never approximated and never guessed — a false provenance claim is worse than
// none, so a row with no stored method renders no stamp and is simply not selected.
export const stampShort = (t) => `READ ${t}`;
export const stampLong = (t, d) => `READ FROM OPERATORS ${t} · ${d}`;

// The closing slide. Not a call to action: a statement of what PDD is, which is the one thing
// that distinguishes a directory from the operators it lists.
//
// "EACH draw above", never "every draw above". `every` and `all` are exhaustiveness claims and
// are class A unless a figure from the run's facts table binds them in the same sentence
// (§10.6 cadenceOrCoverage); `each` distributes over the named set and asserts nothing. The
// sentence loses no force and gains a gate it passes.
export const closingHeadline = () => "WE LIST DRAWS. WE RUN NONE.";
export const closingSubLine = () => "Each draw above is someone else's. We read the numbers and print them.";
// The Story carries exactly ONE draw and nothing sits above it, so the closing slide's line is
// simply false there. Same claim, correct number and correct place.
export const storySubLine = () => "This draw is someone else's. We read the numbers and print them.";
export const signOffStrapline = () => "prizedrawsdaily.co.uk";

// The cover's proof line. Generated, never authored, and the only bounded comparative permitted
// anywhere in the system — its defence is that every figure in it is checkable against the deck
// it sits on. The count word comes from what actually RENDERED, never from the config: on a
// degraded seven-draw day a cover reading "of the eight" is a false checkable claim.
export function proofLine({ drawsRendered, closesWithinDays, lowestCap }) {
  const d = Math.max(1, closesWithinDays);
  const window_ = d === 1 ? "within 24 hours" : `within ${d} days`;
  return [
    `${drawsRendered} draws closing ${window_}.`,
    `Lowest ticket cap of the ${drawsRendered}: ${group(lowestCap)}.`,
  ];
}

// The cover headline. Four archetypes rotate by day of year; each is a FORM, not a sentence, so
// the figures in it are always this deck's.
//
// `absurd-comparison` is bound to its own draw's evidence: it states an upside at hero size, so
// the proof line must carry the cap of the draw the cashAlt came from rather than the deck
// minimum, or the frame states a prize with no probability attached to it.
// The three-letter weekday token, and nothing else. A full weekday name breaks the arm twice
// over: `WEDNESDAY.` measures 1,012.35px against the 895px well, and with any full name the long
// form greedy-wraps to FOUR line boxes, which §5.5 hard-fails. A clock is banned outright — a
// rendered closing time asserts a response deadline, which is CAP 8.22 and the DMCC Act 2024.
export const DAY_TOKENS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
// Word-numbers, deliberately. A word never counts as a figure under §10.6 predicate 3, so the
// deadline form carries no digit and the two-figure rule does not fire on it at all.
const COUNT_WORD = { 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE", 6: "SIX", 7: "SEVEN", 8: "EIGHT" };

export function headline(archetype, facts) {
  const n = facts.drawsRendered;
  const priceAnchor = `${n} DRAWS. FROM ${facts.fromPrice}.`;
  switch (archetype) {
    case "question":       return `${n} DRAWS. HOW MANY TICKETS?`;
    case "price-anchor":   return priceAnchor;
    // `{count} OF THESE CLOSE {day}.` The count is the REAL number closing on the modal day, as a
    // word. Fewer than two, or no day token, and there is no deadline to state: the arm falls back
    // to price-anchor and the substitution is counted (§10.8), exactly as absurd-comparison does.
    // The previous form was `{n} DRAWS. ALL CLOSING THIS WEEK.` — an unbound exhaustiveness claim
    // (`ALL`, no figure in its sentence) that the conformance gate rejects, and a week-wide
    // deadline claim that the selection window does not evidence.
    case "deadline": {
      const w = COUNT_WORD[facts.closingCount];
      return w && DAY_TOKENS.includes(facts.day) ? `${w} OF THESE CLOSE ${facts.day}.` : priceAnchor;
    }
    case "absurd-comparison":
      return facts.cashAlt && facts.price ? `${facts.cashAlt} FOR A ${facts.price} TICKET.` : priceAnchor;
    default:               return priceAnchor;
  }
}

// Which archetype actually rendered, for carousel_posts.hook_archetype (§11.2): the template id,
// never the rendered string, so a wording revision leaves the experiment log intact. A wrong arm
// credited to the right one is a corrupted experiment, which is why this is derived from the same
// facts the headline is rather than assumed from the request.
export function headlineArm(archetype, facts) {
  if (archetype === "question") return "question:only";
  if (archetype === "deadline") {
    return COUNT_WORD[facts.closingCount] && DAY_TOKENS.includes(facts.day) ? "deadline:long" : "price-anchor:long";
  }
  if (archetype === "absurd-comparison") {
    return facts.cashAlt && facts.price ? "absurd-comparison:long" : "price-anchor:long";
  }
  return "price-anchor:long";
}

// The conditions band, §10.2. Three lines, 38px, on every asset, because the ASA does not treat
// a social post as space-limited and "link in bio" discharges nothing.
export function bandLines({ role, drawsRendered, fromPrice, closesText, price, host, freeEntryRoute }) {
  const DRAW_CARRYING = new Set(["draw", "count", "reel-card", "story"]);
  if (DRAW_CARRYING.has(role)) {
    return [
      `${closesText} · ${price} A TICKET`,
      `Enter · terms · ${host}`,
      freeEntryLine(freeEntryRoute, true),
    ];
  }
  return [
    `${drawsRendered} DRAWS IN THIS POST · TICKETS FROM ${fromPrice}`,
    "Enter · terms · each operator's own site.",
    "Free-entry routes and age limits: in those terms.",
  ];
}

// Four states, one per value of draws.free_entry_route. `unknown` is the lawful default and is
// never a failure of any class: it neither asserts nor denies a free-entry route, so CAP 3.7 is
// satisfied on day one against a column that is 100% unpopulated.
function freeEntryLine(route, singular) {
  const s = singular ? "route" : "routes";
  switch (route) {
    case "postal":      return `Free postal entry ${singular ? "route" : "routes"} and age limits: in those terms.`;
    case "online-free": return `Free online entry ${s} and age limits: in those terms.`;
    case "none-stated": return `No free entry ${s} stated. Age limits: in those terms.`;
    default:            return `Free-entry ${s} and age limits: in those terms.`;
  }
}
