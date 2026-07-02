// carousel/encode.mjs — frames+audio → IG-contract mp4 (spec §4.4 encode contract).
const FF = "/opt/homebrew/bin/ffmpeg", FP = "/opt/homebrew/bin/ffprobe";
const AUDIO_DIR = new URL("./assets/audio/", import.meta.url).pathname;

async function run(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.slice(-400)}`);
  return new Response(p.stdout).text();
}

import { readdir } from "node:fs/promises";

export async function encodeVideo({ framesDir, fps, out, audio }) {
  const frameCount = (await readdir(framesDir)).filter((f) => /^f\d+\.png$/.test(f)).length;
  if (!frameCount) throw new Error(`encode: no frames in ${framesDir}`);
  const durS = frameCount / fps;
  const track = `${AUDIO_DIR}${audio.file}`;
  const inputs = ["-framerate", String(fps), "-i", `${framesDir}/f%05d.png`, "-ss", String((audio.trimToOnsetMs || 0) / 1000), "-i", track];
  let filter = `[1:a]atrim=duration=${durS},loudnorm=I=-16:TP=-1.5[a0]`;
  let amixInputs = ["[a0]"];
  (audio.stingTimesMs || []).forEach((t, i) => {
    inputs.push("-i", `${AUDIO_DIR}${audio.stingFile}`);
    filter += `;[${2 + i}:a]adelay=${t}|${t}[s${i}]`;
    amixInputs.push(`[s${i}]`);
  });
  filter += `;${amixInputs.join("")}amix=inputs=${amixInputs.length}:normalize=0,alimiter,apad=whole_dur=${durS}[aout]`;
  await run([FF, "-y", ...inputs, "-filter_complex", filter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-g", String(fps * 2), "-flags", "+cgop",
    "-r", String(fps), "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-movflags", "+faststart", "-t", String(durS), out]);
  return out;
}

export async function assertVideoContract(path, { w = 1080, h = 1920, minDurS = 3, maxDurS = 90 } = {}) {
  const probe = JSON.parse(await run([FP, "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path]));
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const durS = Number(probe.format.duration);
  const head = Buffer.from(await Bun.file(path).slice(0, 65536).arrayBuffer());
  const moov = head.indexOf("moov"), mdat = head.indexOf("mdat");
  const moovFront = moov !== -1 && (mdat === -1 || moov < mdat);
  const fail = (m) => { throw new Error(`video contract violation (${path}): ${m}`); };
  if (!v || v.codec_name !== "h264") fail(`vcodec=${v?.codec_name}, want h264`);
  if (v.pix_fmt !== "yuv420p") fail(`pix_fmt=${v.pix_fmt}`);
  if (Number(v.width) !== w || Number(v.height) !== h) fail(`dimensions ${v.width}x${v.height}, want ${w}x${h}`);
  if (!a || a.codec_name !== "aac") fail(`acodec=${a?.codec_name}, want aac`);
  if (Number(a.sample_rate) > 48000) fail(`sample_rate=${a.sample_rate}`);
  if (!(durS >= minDurS && durS <= maxDurS)) fail(`duration ${durS}s outside [${minDurS},${maxDurS}]`);
  if (!moovFront) fail("moov atom not at front (add -movflags +faststart)");
  return { durS, w: Number(v.width), h: Number(v.height), vcodec: v.codec_name, acodec: a.codec_name, moovFront };
}
