// carousel/state-setup.mjs — checks the state tables exist; prints setup SQL if not.
// Run: bun carousel/state-setup.mjs
import { GLOBAL } from "./config.mjs";
import { supabaseUrl } from "../lib/sb.mjs";

// Resolved per call, never at import (tests import this module); no default project — lib/sb.mjs.
const URL_ = () => supabaseUrl();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || GLOBAL.supabasePublishableKey;

async function tableExists(name) {
  const r = await fetch(`${URL_()}/rest/v1/${name}?limit=1`, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  return r.ok;
}

const posts = await tableExists("carousel_posts");
const metrics = await tableExists("carousel_metrics");
if (posts && metrics) { console.log("✓ carousel_posts + carousel_metrics exist. State layer ready."); process.exit(0); }
console.log("✗ Missing state tables. ONE-TIME setup (~30s):");
const ref = URL_().match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
console.log(`  1. Open ${ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : "the SQL Editor of the project in SUPABASE_URL"}`);
console.log("  2. Paste and run the SQL below (also in carousel/state-schema.sql):\n");
console.log(await Bun.file(new URL("./state-schema.sql", import.meta.url)).text());
process.exit(1);
