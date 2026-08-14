// Trust screen — deterministic evidence about a candidate operator's legitimacy.
// Screens, never verdicts: every signal (or its absence) is surfaced in the approval
// queue for the human to weigh. Each sub-check is best-effort and can only degrade to
// null/false — a network failure must never sink an otherwise-scrapeable candidate.
import { UA } from "./lib.mjs";

const TIMEOUT = 12000;

async function get(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.text();
}

export async function trustScreen(domain, { fetchImpl = fetch } = {}) {
  const out = { domainAgeDays: null, companyNumber: null, hasTerms: false, trustpilotUrl: null, trustpilotScore: null, socials: [] };

  try {
    const rdap = JSON.parse(await get(`https://rdap.org/domain/${domain}`, fetchImpl));
    const reg = (rdap.events || []).filter((e) => e.eventAction === "registration")
      .map((e) => new Date(e.eventDate).getTime()).filter((t) => !isNaN(t)).sort()[0];
    if (reg) out.domainAgeDays = Math.floor((Date.now() - reg) / 864e5);
  } catch { /* age stays null */ }

  try {
    const html = await get(`https://${domain}`, fetchImpl);
    const m = html.match(/company\s*(?:no|number|registration)[.:\s#]*(\d{8})/i)
      || html.match(/registered .{0,60}?(\d{8})/is);
    if (m) out.companyNumber = m[1];
    out.hasTerms = /<a[^>]+href="[^"]*(terms(?:-and-conditions)?|t&amp;cs|t&cs)[^"]*"/i.test(html);
    const socials = new Set();
    for (const sm of html.matchAll(/href="(https?:\/\/(?:www\.)?(?:facebook|instagram|tiktok)\.com\/[^"?#]+)/gi)) {
      if (socials.size < 5) socials.add(sm[1].replace(/\/$/, ""));
    }
    out.socials = [...socials];
  } catch { /* homepage signals stay empty */ }

  try {
    const url = `https://uk.trustpilot.com/review/${domain}`;
    const html = await get(url, fetchImpl);
    const m = html.match(/"ratingValue"\s*:\s*"?(\d(?:\.\d+)?)"?/);
    if (m) { out.trustpilotUrl = url; out.trustpilotScore = Number(m[1]); }
  } catch { /* no trustpilot presence */ }

  return out;
}
