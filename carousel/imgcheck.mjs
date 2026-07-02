// Reject tiny images before they become stamp-sized slides (2026-07-02 incident:
// a 150×100 operator thumbnail sailed through to a broken hero).
// Pure header decoding — no image library, no browser.
// PNG: bytes 16-24 big-endian w/h. JPEG: scan SOF markers. WEBP: VP8X/VP8/VP8L.
export function dimsFromBuffer(buf) {
  if (buf.length < 32) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) // PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk segments to SOFn
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
    const fmt = buf.slice(12, 16).toString();
    if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export async function minDimOk(path, min = 500) {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const d = dimsFromBuffer(buf);
  if (!d) return true; // unknown format → let the render gate judge
  return Math.max(d.w, d.h) >= min;
}
