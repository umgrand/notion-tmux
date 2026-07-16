// packages/ticket-engine/src/cli/watch.ts
import path from "node:path";
import { TicketEngine } from "../core/engine.js";
import { loadLegacyConfig } from "./config.js";
import { Tmux } from "./tmux.js";
import { WindowTracker } from "./windows.js";

const SESSION = "notion-tmux";

/** Shell-quote a single argument for embedding in a tmux command string. */
function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runWatch(): Promise<void> {
  const { config, notionToken, dataDir } = loadLegacyConfig(process.cwd());
  const automationDir = path.join(dataDir, "automation");

  if (!Tmux.isInstalled()) {
    console.error("tmux not found — install with: brew install tmux");
    process.exit(1);
    return;
  }
  const tmux = new Tmux(SESSION);
  tmux.ensureSession();

  const tracker = new WindowTracker();
  const node = process.execPath;
  const self = process.argv[1]; // absolute path to dist/cli/flint.js

  const engine = new TicketEngine({
    config,
    notionToken,
    dataDir,
    emit: (event) => {
      for (const action of tracker.onEvent(event)) {
        if (action.kind === "status") {
          console.log(action.text);
          continue;
        }
        const abs = path.resolve(automationDir, action.logPath);
        const command = `${sh(node)} ${sh(self)} attach ${sh(abs)} --ref ${sh(action.name)}`;
        tmux.newWindow(action.name, command);
      }
    },
  });

  const shutdown = async () => {
    await engine.stop({ cancelActiveRun: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await engine.start();
  console.log(`notion-tmux watching every ${config.pollIntervalSec}s. attach with: tmux attach -t ${SESSION}`);
}
