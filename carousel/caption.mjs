// Minimalist caption + exactly 5 hashtags (3 fixed + 2 category-varying).
import { GLOBAL, catCfg } from "./config.mjs";
const FIXED = GLOBAL.fixedHashtags;

const nounOf = (catName) => String(catName).replace(/\s+(draws|prizes|giveaways)$/i, "").toLowerCase();

// EVERY PRIZE LINE NAMES THE OPERATOR WHO RUNS IT. This is not a nicety.
//
// Meta suspended this Page on 4 September 2026 under Community Standards on IMPERSONATION,
// citing "pretending a Page or profile has a business relationship with a business, celebrity or
// public figure". The captions that preceded it read: "The headline act: an Apple iPad A16 for
// 99p — at 1-in-695 odds" and "A Land Rover Discovery Urban for 5p a ticket... A 2026
// Harley-Davidson Breakout". A Page called Prize Draws Daily offering an Apple iPad, a Land
// Rover and a Harley-Davidson, with prices and odds, and never saying whose competition it is,
// reads exactly one way: either the Page is running them, or it has a relationship with those
// brands. It is a DIRECTORY and has neither.
//
// The fix is attribution, not omission. "ROLEX Submariner · £25 · Elite Competitions" is a
// listing; "ROLEX Submariner · £25" from an unknown Page is a claim.
const prizeList = (items = []) => items
  .filter((it) => it && it.title)
  .map((it) => [it.title, it.price, it.operator].filter(Boolean).join(" · "))
  .join("\n");

// Stated, not implied, and placed where it cannot be cropped out of a preview. The deck says
// the same thing on the frame — the closing slide reads WE LIST DRAWS. WE RUN NONE. and every
// draw slide carries the operator's name and their own domain — but a caption travels without
// the images, into notifications and shares, so it has to carry the disclaimer itself.
const INDEPENDENCE = "We list draws. We run none — every one above is the operator's own.";

export function buildCaption(catName, slug, items = [], seoKeyword = null) {
  // Instagram caption — minimalist (link in bio), exactly 5 hashtags.
  const head = seoKeyword
    ? `${seoKeyword} closing this week 👇`
    : `UK ${nounOf(catName)} draws closing this week 👇`;
  const list = prizeList(items);
  const tags = [...FIXED, ...catCfg(slug).hashtags].join(" ");
  return list
    ? `${head}\n\n${list}\n\n${INDEPENDENCE}\nlink in bio · 18+\n\n${tags}`
    : `${head}\n${INDEPENDENCE}\nlink in bio · 18+\n\n${tags}`;
}

// Facebook caption — a fuller, self-contained post (FB supports a real clickable
// link in the body, unlike IG's "link in bio"). Used for the single captioned
// photo post (FACEBOOK_CREATE_PHOTO_POST) so FB is ONE detailed post, not a pile
// of caption-less individual photos.
export function buildFbCaption(catName, slug, items = []) {
  const noun = nounOf(catName);
  const head = `🎯 UK ${noun} draws closing this week`;
  const list = prizeList(items);
  // On Facebook the disclaimer goes ABOVE the prize list, not below it. That is where the
  // enforcement happened, and a reader — or a brand-protection team — should meet "independent
  // directory" before they meet "Rolex".
  const body = list
    ? `${head}\n\nPrize Draws Daily is an independent UK directory. ${INDEPENDENCE}\n\nClosing soon 👇\n${list}\n\n👉 See every live UK draw: https://prizedrawsdaily.co.uk`
    : `${head}\n\nPrize Draws Daily is an independent UK directory. ${INDEPENDENCE}\n\n👉 See every live UK draw: https://prizedrawsdaily.co.uk`;
  const tags = [...FIXED, ...catCfg(slug).hashtags].join(" ");
  // "18+ · UK only" is accurate: the age limit and the territory are real conditions.
  // "Play responsibly" is not — it is gambling language, and a prize competition sits OUTSIDE
  // Gambling Act 2005 licensing, so the operative code is CAP Section 8. The same reasoning
  // removed it from every rendered frame; leaving it in the caption would just move the
  // inaccuracy somewhere less visible.
  return `${body}\n\n18+ · UK only\n\n${tags}`;
}
