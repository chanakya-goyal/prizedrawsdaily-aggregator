// carousel/links.mjs — links to the site that say which platform and which post sent the visit.
//
// Google Analytics reads the utm_* tags off the landing URL, so a visit from a Facebook Reel shows up as
// facebook / social / reel instead of a bare referral. The site's pages set a tag-free canonical, so search
// engines still see one address per page. Every platform the autopilot posts to builds its link here.
import { CFG } from "./config.mjs";

export const SITE_URL = "https://prizedrawsdaily.co.uk";

export function trackedUrl(path, { source, medium = "social", campaign, content } = {}) {
  if (!source) throw new Error("trackedUrl: a source (the platform) is required");
  const u = new URL(path, SITE_URL);
  for (const [k, v] of Object.entries({ source, medium, campaign, content })) if (v) u.searchParams.set(`utm_${k}`, String(v));
  return u.toString();
}

// A Reel is about one draw, so it links to that draw's page; a carousel is a category round-up, so it links
// to the category page. A category the site has no page for falls back to the home page.
export function postLink({ source, kind, category = null, hero = null, date = null }) {
  const path = kind === "reel" && hero ? `/draws/${encodeURIComponent(hero)}`
    : category && CFG.categories[category] ? `/category/${encodeURIComponent(category)}` : "/";
  return trackedUrl(path, { source, campaign: kind, content: date });
}
