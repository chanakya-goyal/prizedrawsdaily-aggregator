// carousel/cleanup.mjs — bucket retention (spec §4.2/9). Once every carousel_posts
// row for TODAY has reached status "published" (carousel + fb_photo + any reel/story
// that ran), the day's raw source assets — {date}/{slug}/*.jpg|mp4 in the public
// bucket — have done their job (Composio already pulled them into IG/FB) and can be
// freed. Refuses while anything is still pending/in-flight, so a slow or retried
// Composio post can never lose the assets it still needs mid-publish.
//
//   bun carousel/cleanup.mjs
//
// Needs SUPABASE_SERVICE_ROLE_KEY (bucket deletes require the service role — the
// publishable-key fallback state.mjs uses for reads can't delete storage objects).
import { GLOBAL } from "./config.mjs";
import { recentPosts, todayLondon } from "./state.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || GLOBAL.supabaseUrl;
const BUCKET = GLOBAL.bucket;

// readyForCleanup — pure. True only when there's at least one row for the day, every
// row has reached a TERMINAL state ("published" OR "skipped" — a format that was
// deliberately dropped this run, e.g. a failed FB video falling back to photo, or a
// rejected story, per state-mark.mjs), and at least one row is actually "published"
// (all-skipped, e.g. every format failed/was dropped, is NOT "ready" — there's
// nothing to have copied the assets in, so cleanup would just delete them unused).
// An empty list means nothing was confirmed published today, so that's a refusal
// too, not a vacuous "ready".
export function readyForCleanup(rows) {
  return rows.length > 0
    && rows.every((r) => r.status === "published" || r.status === "skipped")
    && rows.some((r) => r.status === "published");
}

async function listObjects(key, prefix) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  if (!r.ok) throw new Error(`list ${prefix} failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function deleteObject(key, path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!r.ok) throw new Error(`delete ${path} failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// CLI body only runs when this file is executed directly — importing readyForCleanup
// for tests must never require a live key or touch the network.
if (import.meta.main) {
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) {
    console.error("✗ SUPABASE_SERVICE_ROLE_KEY missing. Add it to ~/pdd-aggregator/.env:");
    console.error("  SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Supabase dashboard → Settings → API>");
    process.exit(1);
  }

  const today = todayLondon();
  const rows = (await recentPosts(1)).filter((r) => r.date === today);

  if (!readyForCleanup(rows)) {
    if (rows.length === 0) {
      console.error(`✗ No carousel_posts rows found for ${today} — nothing confirmed published yet. Refusing to clean up.`);
    } else if (!rows.some((r) => r.status === "published")) {
      console.error(`✗ ${today} has no "published" row(s) — every format is pending/skipped. Refusing to clean up.`);
    } else {
      // "skipped" is terminal (a format deliberately dropped this run), not in-flight —
      // don't list it as something cleanup is waiting on.
      const inFlight = rows.filter((r) => r.status !== "published" && r.status !== "skipped").map((r) => `${r.format}:${r.status}`);
      console.error(`✗ ${today} still has row(s) in flight (${inFlight.join(", ")}). Refusing to clean up until everything is published.`);
    }
    process.exit(1);
  }

  console.log(`✓ All ${rows.length} row(s) for ${today} are published — freeing storage.`);
  const slugs = [...new Set(rows.map((r) => r.category).filter(Boolean))];
  let freed = 0;
  for (const slug of slugs) {
    const prefix = `${today}/${slug}/`;
    const objects = await listObjects(KEY, prefix);
    if (!objects?.length) { console.log(`  (nothing under ${prefix})`); continue; }
    for (const obj of objects) {
      const path = `${prefix}${obj.name}`;
      await deleteObject(KEY, path);
      freed++;
      console.log(`  ✓ freed ${path}`);
    }
  }
  console.log(`\n✓ Cleanup done — ${freed} object(s) freed across ${slugs.length} folder(s).`);
}
