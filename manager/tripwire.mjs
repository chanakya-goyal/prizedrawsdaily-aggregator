// Tripwire: exits 1 (and writes tripwire.md) when the daily pipeline is silently broken —
// the scrape step didn't succeed, or live inventory fell under the floor. The Aug 2026
// outage (carousel tests skipping the scrape for 10+ days) is exactly what this catches.
// Usage (CI): SCRAPE_OUTCOME=${{ steps.scrape.outcome }} bun manager/tripwire.mjs
const SB = process.env.SUPABASE_URL || "https://kkuuwksgyypicnblwubs.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function evaluateTripwire({ activeCount, floor, scrapeOutcome }) {
  const reasons = [];
  if (scrapeOutcome !== "success") reasons.push(`scrape step outcome was '${scrapeOutcome}' (expected 'success')`);
  if (activeCount != null && activeCount < floor) reasons.push(`live inventory ${activeCount} is under the floor of ${floor}`);
  return { tripped: reasons.length > 0, reasons };
}

if (import.meta.path === Bun.main) {
  const floor = Number(process.env.TRIPWIRE_FLOOR || 350);
  const scrapeOutcome = process.env.SCRAPE_OUTCOME || "unknown";
  let activeCount = null;
  try {
    const r = await fetch(`${SB}/rest/v1/draws?select=id&status=eq.active`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact", Range: "0-0" },
    });
    activeCount = Number((r.headers.get("content-range") || "/0").split("/")[1]);
    if (Number.isNaN(activeCount)) activeCount = null;
  } catch { /* count stays null — outcome check still applies */ }
  const { tripped, reasons } = evaluateTripwire({ activeCount, floor, scrapeOutcome });
  const body = [
    `## 🔴 Aggregator tripwire — ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...reasons.map((x) => `- ${x}`),
    "",
    `Active draws: **${activeCount ?? "unknown"}** (floor ${floor}) · scrape outcome: **${scrapeOutcome}**`,
    "",
    "Check the run's coverage-report step summary for the per-operator picture.",
  ].join("\n");
  await Bun.write("tripwire.md", body);
  if (tripped) { console.error(reasons.join("; ")); process.exit(1); }
  console.log(`tripwire ok — active ${activeCount}, scrape ${scrapeOutcome}`);
}
