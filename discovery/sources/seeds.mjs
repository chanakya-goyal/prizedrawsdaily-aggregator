// Manual seed list: one domain per line in discovery/seeds.txt, '#' comments allowed.
export async function candidates({ seedsPath } = {}) {
  const file = seedsPath ? Bun.file(seedsPath) : Bun.file(new URL("../seeds.txt", import.meta.url));
  const text = await file.text().catch(() => "");
  return text.split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"))
    .map((domain) => ({ domain: domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0], via: "seed" }));
}
