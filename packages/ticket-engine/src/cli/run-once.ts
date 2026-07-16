import { TicketEngine } from "../core/engine.js";
import { loadLegacyConfig } from "./config.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [project, page] = args.filter((arg) => !arg.startsWith("--"));
if (!project || !page) {
  console.error("Usage: npm run run-once -- <project> <page-id-or-url> [--force]");
  process.exit(1);
}

const loaded = loadLegacyConfig();
let terminal = false;
let succeeded = false;
const engine = new TicketEngine({
  ...loaded,
  emit: (event) => {
    if (event.event === "run.stageChanged") {
      console.log(`${event.payload.projectKey}/${event.payload.ticketRef ?? event.payload.pageId}: ${event.payload.message}`);
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.event)) {
      const record = event.payload as any;
      console.log(`${record.stage}: ${record.message}${record.prUrl ? `\n${record.prUrl}` : ""}`);
      terminal = true;
      succeeded = record.stage === "completed";
    }
  },
});

await engine.runOnce(project, page, force);
while (!terminal) await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(succeeded ? 0 : 1);
