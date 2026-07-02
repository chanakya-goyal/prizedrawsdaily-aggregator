import { test, expect } from "bun:test";
import { encodeVideo, assertVideoContract } from "../encode.mjs";
import { mkdir } from "node:fs/promises";

const TMP = "carousel/tests/tmp/enc";

test("encode meets the IG contract incl. faststart and sting mix", async () => {
  await mkdir(TMP, { recursive: true });
  // 30 dummy frames (1s @30fps)
  await Bun.spawn(["/opt/homebrew/bin/ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=orange:size=1080x1920:duration=1:rate=30", `${TMP}/f%05d.png`]).exited;
  const out = await encodeVideo({
    framesDir: TMP, fps: 30, out: `${TMP}/test.mp4`,
    audio: { file: "stamp-sting.wav", stingFile: "stamp-sting.wav", stingTimesMs: [200] },
  });
  const c = await assertVideoContract(out, { minDurS: 0.5, maxDurS: 3 });
  expect(c.vcodec).toBe("h264");
  expect(c.acodec).toBe("aac");
  expect(c.w).toBe(1080);
  expect(c.moovFront).toBe(true);
}, 120000);

test("contract catches wrong dimensions", async () => {
  await Bun.spawn(["/opt/homebrew/bin/ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:size=640x480:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${TMP}/bad.mp4`]).exited;
  await expect(assertVideoContract(`${TMP}/bad.mp4`, {})).rejects.toThrow(/1080|dimension/i);
}, 60000);
