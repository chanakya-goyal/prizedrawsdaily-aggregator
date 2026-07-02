// carousel/state-mark.mjs — mark today's row: bun carousel/state-mark.mjs <format> <status> [--ig ID] [--fb ID] [--container ID]
import { markStatus, todayLondon } from "./state.mjs";

const [format, status] = Bun.argv.slice(2);
if (!format || !status) { console.error("usage: bun carousel/state-mark.mjs <format> <status> [--ig ID] [--fb ID] [--container ID]"); process.exit(1); }
const patch = {};
const flag = (name, col) => { const i = Bun.argv.indexOf(name); if (i > -1 && Bun.argv[i + 1]) patch[col] = Bun.argv[i + 1]; };
flag("--ig", "ig_media_id"); flag("--fb", "fb_post_id"); flag("--container", "ig_container_id");
await markStatus(todayLondon(), format, status, patch);
console.log(`✓ ${todayLondon()} ${format} → ${status}`, patch);
