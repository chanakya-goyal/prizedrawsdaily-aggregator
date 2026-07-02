// Minimalist caption + exactly 5 hashtags (3 fixed + 2 category-varying).
import { GLOBAL, catCfg } from "./config.mjs";
const FIXED = GLOBAL.fixedHashtags;

const nounOf = (catName) => String(catName).replace(/\s+(draws|prizes|giveaways)$/i, "").toLowerCase();
const prizeList = (items = []) => items
  .filter((it) => it && it.title)
  .map((it) => (it.price ? `${it.title} · ${it.price}` : it.title))
  .join("\n");

export function buildCaption(catName, slug, items = [], seoKeyword = null) {
  // Instagram caption — minimalist (link in bio), exactly 5 hashtags.
  const head = seoKeyword
    ? `${seoKeyword} closing this week 👇`
    : `UK ${nounOf(catName)} draws closing this week 👇`;
  const list = prizeList(items);
  const tags = [...FIXED, ...catCfg(slug).hashtags].join(" ");
  return list
    ? `${head}\n\n${list}\n\nlink in bio · 18+\n\n${tags}`
    : `${head}\nlink in bio · 18+\n\n${tags}`;
}

// Facebook caption — a fuller, self-contained post (FB supports a real clickable
// link in the body, unlike IG's "link in bio"). Used for the single captioned
// photo post (FACEBOOK_CREATE_PHOTO_POST) so FB is ONE detailed post, not a pile
// of caption-less individual photos.
export function buildFbCaption(catName, slug, items = []) {
  const noun = nounOf(catName);
  const head = `🎯 UK ${noun} draws closing this week`;
  const list = prizeList(items);
  const body = list
    ? `${head}\n\nClosing soon 👇\n${list}\n\n👉 See every live UK draw: https://prizedrawsdaily.co.uk`
    : `${head}\n\n👉 See every live UK draw: https://prizedrawsdaily.co.uk`;
  const tags = [...FIXED, ...catCfg(slug).hashtags].join(" ");
  return `${body}\n\n18+ · UK only · Play responsibly\n\n${tags}`;
}
