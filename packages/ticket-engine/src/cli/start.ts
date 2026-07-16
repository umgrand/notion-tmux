import { TicketEngine } from "../core/engine.js";
import { loadLegacyConfig } from "./config.js";

const loaded = loadLegacyConfig();
const engine = new TicketEngine({
  ...loaded,
  emit: (event) => console.log(`[${event.event}]`, JSON.stringify(event.payload)),
});

await engine.start();
console.log(`notion-tmux ticket engine polling every ${loaded.config.pollIntervalSec}s`);

async function shutdown() {
  await engine.stop({ cancelActiveRun: true });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
