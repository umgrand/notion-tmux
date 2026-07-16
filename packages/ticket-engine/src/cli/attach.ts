import { spawn } from "node:child_process";

export function parseAttachArgs(argv: string[]): { logPath?: string; ref?: string } {
  let logPath: string | undefined;
  let ref: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") {
      ref = argv[++i];
    } else if (!logPath) {
      logPath = argv[i];
    }
  }
  return { logPath, ref };
}

/**
 * Stream a single run's log into the current window. `tail -F` (capital) waits
 * for a not-yet-created file and follows it across rotation, covering the race
 * where the tmux window opens before the runner writes the first chunk.
 */
export function runAttach(argv: string[]): void {
  const { logPath, ref } = parseAttachArgs(argv);
  if (!logPath) {
    console.error("usage: notion-tmux attach <logPath> [--ref <ref>]");
    process.exit(1);
    return;
  }
  process.stdout.write(`── ${ref ?? "run"} ──  ${logPath}\n`);
  const child = spawn("tail", ["-F", logPath], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => process.exit(code ?? 0));
}
