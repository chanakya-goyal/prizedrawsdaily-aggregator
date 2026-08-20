// Human approval gate: promote one queued candidate into a real operator.
//   bun discovery/approve.mjs <slug>              → inserts the site-DB row + operators.json entry
//   DRY_RUN=true bun discovery/approve.mjs <slug> → prints both payloads, writes nothing
// The DB row lands with review_status: null so the site renders the operator as UNVERIFIED —
// the editorial review (cowork) is what earns the "verified" badge, never this script.
const SB = process.env.SUPABASE_URL || "https://ilnegxrsalmzpljotgpe.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.env.DRY_RUN === "true";

const titleFor = (slug) => slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function buildOperatorConfig(entry) {
  return { name: titleFor(entry.slug), slug: entry.slug, base: entry.base, method: entry.method };
}

export function buildDbRow(entry) {
  return {
    slug: entry.slug,
    name: titleFor(entry.slug),
    website_url: entry.base,
    description: "UK prize-draw operator — listed via PDD discovery; review pending.",
    review_status: null,
  };
}

if (import.meta.path === Bun.main) {
  const slug = process.argv[2];
  if (!slug) { console.error("usage: bun discovery/approve.mjs <slug>"); process.exit(1); }

  const queuePath = new URL("queue.json", import.meta.url);
  const queue = await Bun.file(queuePath).json().catch(() => null);
  if (!queue) { console.error("no discovery/queue.json — run `bun discovery/run.mjs` first"); process.exit(1); }
  const entry = queue.find((c) => c.slug === slug);
  if (!entry) { console.error(`'${slug}' not in the queue. Queued: ${queue.map((c) => c.slug).join(", ")}`); process.exit(1); }

  const opsPath = new URL("../operators.json", import.meta.url);
  const ops = await Bun.file(opsPath).json();
  const clash = ops.find((o) => o.slug === entry.slug || o.base === entry.base);
  if (clash) { console.error(`collision: operators.json already has slug/base '${clash.slug}' — reject or rename instead`); process.exit(1); }

  const cfg = buildOperatorConfig(entry);
  const row = buildDbRow(entry);
  if (DRY) {
    console.log("DRY RUN — would insert:\n\noperators table row:", JSON.stringify(row, null, 2));
    console.log("\noperators.json entry:", JSON.stringify(cfg, null, 2));
    process.exit(0);
  }
  if (!KEY) { console.error("need SUPABASE_SERVICE_ROLE_KEY (repo .env)"); process.exit(1); }

  const r = await fetch(`${SB}/rest/v1/operators`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  if (!r.ok) { console.error(`DB insert failed → ${r.status} ${await r.text()}`); process.exit(1); }
  const [inserted] = await r.json();
  console.log(`✅ DB operator row: ${inserted.id} (${inserted.slug}, unverified)`);

  ops.push(cfg);
  await Bun.write(opsPath, JSON.stringify(ops, null, 1) + "\n");
  console.log(`✅ operators.json: appended '${cfg.slug}' (${ops.length} operators)`);

  const rest = queue.filter((c) => c.slug !== slug);
  await Bun.write(queuePath, JSON.stringify(rest, null, 2) + "\n");
  console.log(`✅ queue: ${rest.length} candidates remain`);
  console.log(`\nnext: git add operators.json && git commit && git push — the daily Action scrapes it from main.`);
}
