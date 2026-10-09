// Decide whether image storage needs a human, from numbers storage-watch.mjs has measured.
// Pure, so the rules are pinned in test/storage-watch.test.mjs.
//
//   Supabase ≥ threshold (70%) full   → alarm, whatever the write target. A full project is a
//                                       402 on EVERY API — the site goes down. During the move
//                                       the bucket sits near 98% until it is emptied; that is
//                                       the real risk, so it stays red until then.
//   new draw-images objects after the → alarm. Some writer — most likely the cowork routine,
//   switch (write target ≠ Supabase)    which keeps its own env outside every repo — was missed.
//   provider on, credentials broken   → alarm. run.mjs keeps the operator's URL when an upload
//                                       fails, so every new draw would silently hotlink again.
//   Cloudinary ≥ threshold of credits → alarm. Credits are metered over a ROLLING 30 days (no
//                                       monthly reset), and an account left over its limit is
//                                       eventually disabled — delivery included.
//
// A usage read that FAILED is reported but never alarms by itself.

const MB = (b) => `${(b / 1048576).toFixed(0)} MB`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function assessStorage({ supabase, cloudinary = null, threshold = 0.7, config = null }) {
  const lines = [];
  let alarm = false;

  if (config?.error) {
    alarm = true;
    lines.push(`🔴 IMAGE_PROVIDER=${config.provider} but its credentials do not work (${config.error}). Every new draw photo is being hotlinked from the operator's site instead of stored — fix the secret (CLOUDINARY.md).`);
  }

  const used = supabase.bytes / supabase.limitBytes;
  const head = `Supabase storage: ${MB(supabase.bytes)} of ${MB(supabase.limitBytes)} (${pct(used)})`;
  if (used >= threshold) {
    alarm = true;
    if (supabase.writeTarget) {
      // Measured growth beats a remembered constant: "fills in weeks" is a lie at 98%.
      const perDay = supabase.recentBytes != null ? supabase.recentBytes / ((supabase.recentWindowH ?? 48) / 24) : null;
      const left = Math.max(0, supabase.limitBytes - supabase.bytes);
      const eta = perDay > 0 ? `at the measured ~${MB(perDay)}/day it is full in ~${Math.floor(left / perDay)} day(s)` : "it keeps growing with every scrape";
      lines.push(`🔴 ${head} — past the ${pct(threshold)} line and new images are still being written here; ${eta}. When it is full, Supabase returns 402 on EVERY API and the site goes down. Move images off it (CLOUDINARY.md).`);
    } else {
      lines.push(`🔴 ${head} — past the ${pct(threshold)} line. New images go elsewhere now, but the project is still one stray write from a 402 on every API. Finish the move: run migrate-images.mjs --phase=empty-check, then empty the bucket (CLOUDINARY.md).`);
    }
  } else lines.push(`✅ ${head} — under ${pct(threshold)}.`);

  if (!supabase.writeTarget && supabase.recentWrites > 0) {
    alarm = true;
    lines.push(`🔴 ${supabase.recentWrites} new object(s) appeared in Supabase draw-images in the last ${supabase.recentWindowH ?? 48}h although images now go elsewhere. Something is still writing images to Supabase: check IMAGE_PROVIDER/CLOUDINARY_URL in the GitHub secrets AND in the cowork routine's own environment.`);
  }

  if (cloudinary) {
    if (cloudinary.error) lines.push(`⚠️ Cloudinary: could not read usage (${cloudinary.error}). Not alarming on a missing signal.`);
    else {
      const u = cloudinary.usedPercent / 100;
      const detail = cloudinary.creditsUsed != null ? ` (${cloudinary.creditsUsed} of ${cloudinary.creditsLimit} credits)` : "";
      if (u >= threshold) {
        alarm = true;
        lines.push(`🔴 Cloudinary: ${pct(u)} of the free credits used over the last 30 days${detail}. Cloudinary meters a rolling window — a heavy day stays on the meter for 30 days, there is no reset on the 1st — and an account left over its limit is eventually disabled, which breaks every draw photo. Check the transformations figure first: uploads must be raw (CLOUDINARY.md); then bandwidth, then lower RETENTION_DAYS.`);
      } else lines.push(`✅ Cloudinary: ${pct(u)} of the free credits used over the last 30 days${detail}.`);
    }
  }
  return { alarm, lines };
}
