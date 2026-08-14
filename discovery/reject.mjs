// Reject a queued candidate so it never resurfaces (knownOperatorSet reads rejected.json).
//   bun discovery/reject.mjs <slug> "<reason>"
if (import.meta.path === Bun.main) {
  const [slug, ...reasonParts] = process.argv.slice(2);
  const reason = reasonParts.join(" ").trim();
  if (!slug || !reason) { console.error('usage: bun discovery/reject.mjs <slug> "<reason>"'); process.exit(1); }

  const queuePath = new URL("queue.json", import.meta.url);
  const queue = await Bun.file(queuePath).json().catch(() => []);
  const entry = queue.find((c) => c.slug === slug);
  if (!entry) { console.error(`'${slug}' not in the queue`); process.exit(1); }

  const rejectedPath = new URL("rejected.json", import.meta.url);
  const rejected = await Bun.file(rejectedPath).json().catch(() => []);
  rejected.push({ domain: entry.domain, reason, date: new Date().toISOString().slice(0, 10) });
  await Bun.write(rejectedPath, JSON.stringify(rejected, null, 2) + "\n");

  await Bun.write(queuePath, JSON.stringify(queue.filter((c) => c.slug !== slug), null, 2) + "\n");
  console.log(`⛔ rejected ${entry.domain} — "${reason}" (ledger: discovery/rejected.json)`);
}
