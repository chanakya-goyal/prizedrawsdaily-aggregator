// Decide whether image storage needs a human, from numbers storage-watch.mjs has measured.
// Pure, so the rules are pinned in test/storage-watch.test.mjs.
//
// Two different questions depending on where new images are being written:
//
//   Supabase IS the write target   → "is it filling up?"  Alarm at `threshold` (70%) full —
//                                     weeks of warning at ~16 MB/day, instead of finding out
//                                     from a 402 as we did in Aug and Oct 2026.
//   Supabase is FROZEN (an archive) → "is anything still writing to it?"  It is left near its
//                                     cap on purpose once images move, so a percentage
//                                     alarm there would be red forever and ignored. A new
//                                     object is the real signal: some writer — most likely
//                                     the cowork routine, which keeps its own env outside
//                                     every repo — was missed in the switch.
//
// The new provider (Cloudinary) always gets the percentage rule.

const MB = (b) => `${(b / 1048576).toFixed(0)} MB`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function assessStorage({ supabase, cloudinary = null, threshold = 0.7 }) {
  const lines = [];
  let alarm = false;

  const used = supabase.bytes / supabase.limitBytes;
  const head = `Supabase storage: ${MB(supabase.bytes)} of ${MB(supabase.limitBytes)} (${pct(used)})`;
  if (supabase.writeTarget) {
    if (used >= threshold) {
      alarm = true;
      lines.push(`🔴 ${head} — past the ${pct(threshold)} line and new images are still being written here. At ~16 MB/day the free bucket fills in weeks; when it does, Supabase returns 402 on EVERY API and the site goes down. Move images off it (CLOUDINARY.md).`);
    } else lines.push(`✅ ${head} — write target, under ${pct(threshold)}.`);
  } else {
    if (supabase.bytes >= supabase.limitBytes) {
      alarm = true;
      lines.push(`🔴 ${head} — OVER the free limit. Expect a 402 restriction on the whole project.`);
    } else if (supabase.recentWrites > 0) {
      alarm = true;
      lines.push(`🔴 ${head} — frozen archive, but ${supabase.recentWrites} new object(s) appeared in the last ${supabase.recentWindowH ?? 48}h. Something is still writing images to Supabase: check IMAGE_PROVIDER/CLOUDINARY_URL in the GitHub secrets AND in the cowork routine's own environment.`);
    } else lines.push(`✅ ${head} — frozen archive, nothing new written.`);
  }

  if (cloudinary) {
    if (cloudinary.error) lines.push(`⚠️ Cloudinary: could not read usage (${cloudinary.error}). Not alarming on a missing signal.`);
    else {
      const u = cloudinary.usedPercent / 100;
      const detail = cloudinary.creditsUsed != null ? ` (${cloudinary.creditsUsed} of ${cloudinary.creditsLimit} credits)` : "";
      if (u >= threshold) {
        alarm = true;
        lines.push(`🔴 Cloudinary: ${pct(u)} of this month's free credits used${detail}. The Free plan stops serving when it runs out, which breaks every draw photo until the month resets. Lower RETENTION_DAYS or review what is using bandwidth.`);
      } else lines.push(`✅ Cloudinary: ${pct(u)} of this month's free credits used${detail}.`);
    }
  }
  return { alarm, lines };
}
