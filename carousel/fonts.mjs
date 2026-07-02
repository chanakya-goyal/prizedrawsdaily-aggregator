// Inline the bundled woff2 fonts as base64 @font-face so rendering is deterministic,
// crisp ("HD") and CDN-independent. Returns a <style>-ready CSS string.
const FACES = [
  // vibrant carousel display + condensed sub-type (matches the user's reference posts)
  ["Anton", 400, "anton-latin-400-normal.woff2"],
  ["Oswald", 500, "oswald-latin-500-normal.woff2"],
  ["Oswald", 600, "oswald-latin-600-normal.woff2"],
  ["Oswald", 700, "oswald-latin-700-normal.woff2"],
  ["Bricolage Grotesque", 400, "bricolage-grotesque-latin-400-normal.woff2"],
  ["Bricolage Grotesque", 700, "bricolage-grotesque-latin-700-normal.woff2"],
  ["Bricolage Grotesque", 800, "bricolage-grotesque-latin-800-normal.woff2"],
  ["Inter", 400, "inter-latin-400-normal.woff2"],
  ["Inter", 500, "inter-latin-500-normal.woff2"],
  ["Inter", 600, "inter-latin-600-normal.woff2"],
  ["Inter", 700, "inter-latin-700-normal.woff2"],
];

export async function fontFaceCss() {
  const out = [];
  for (const [family, weight, file] of FACES) {
    try {
      const buf = Buffer.from(await Bun.file(new URL(`./assets/fonts/${file}`, import.meta.url)).arrayBuffer());
      const b64 = buf.toString("base64");
      out.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
    } catch (e) { /* missing font file -> skip; CDN link is the fallback */ }
  }
  return out.join("\n");
}
