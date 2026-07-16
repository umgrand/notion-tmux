import { spawnSync } from "node:child_process";

export type Spawn = (cmd: string, args: string[]) => { status: number | null };

const defaultSpawn: Spawn = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return { status: r.status };
};

/**
 * Thin wrapper over the tmux CLI. The child-process spawner is injected so the
 * argv can be asserted in tests without a real tmux install.
 */
export class Tmux {
  constructor(
    private readonly session: string,
    private readonly spawn: Spawn = defaultSpawn,
  ) {}

  static isInstalled(spawn: Spawn = defaultSpawn): boolean {
    return spawn("tmux", ["-V"]).status === 0;
  }

  ensureSession(): void {
    if (this.spawn("tmux", ["has-session", "-t", this.session]).status === 0) return;
    this.spawn("tmux", ["new-session", "-d", "-s", this.session]);
  }

  newWindow(name: string, command: string): void {
    this.spawn("tmux", ["new-window", "-t", this.session, "-n", name, command]);
  }
}
