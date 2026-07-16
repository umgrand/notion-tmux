#!/usr/bin/env node
// packages/ticket-engine/src/cli/flint.ts
import { runAttach } from "./attach.js";
import { runWatch } from "./watch.js";

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "watch":
    try {
      await runWatch();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    break;
  case "attach":
    runAttach(rest);
    break;
  default:
    console.error("usage: notion-tmux <watch|attach>");
    process.exit(1);
}
