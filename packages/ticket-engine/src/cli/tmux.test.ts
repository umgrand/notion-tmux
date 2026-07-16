import test from "node:test";
import assert from "node:assert/strict";
import { Tmux, type Spawn } from "./tmux.js";

function recorder(statusFor: (cmd: string, args: string[]) => number) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn: Spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: statusFor(cmd, args) };
  };
  return { calls, spawn };
}

test("isInstalled reflects `tmux -V` exit status", () => {
  const ok = recorder(() => 0);
  const missing = recorder(() => 127);
  assert.equal(Tmux.isInstalled(ok.spawn), true);
  assert.equal(Tmux.isInstalled(missing.spawn), false);
});

test("ensureSession creates a detached session only when absent", () => {
  const present = recorder((_c, args) => (args[0] === "has-session" ? 0 : 0));
  new Tmux("notion-tmux", present.spawn).ensureSession();
  assert.deepEqual(present.calls.map((c) => c.args[0]), ["has-session"]);

  const absent = recorder((_c, args) => (args[0] === "has-session" ? 1 : 0));
  new Tmux("notion-tmux", absent.spawn).ensureSession();
  assert.deepEqual(absent.calls.map((c) => c.args[0]), ["has-session", "new-session"]);
  assert.deepEqual(absent.calls[1].args, ["new-session", "-d", "-s", "notion-tmux"]);
});

test("newWindow passes the exact argv", () => {
  const r = recorder(() => 0);
  new Tmux("notion-tmux", r.spawn).newWindow("PROJ-12", "node /x/flint.js attach /y.log");
  assert.deepEqual(r.calls[0], {
    cmd: "tmux",
    args: ["new-window", "-t", "notion-tmux", "-n", "PROJ-12", "node /x/flint.js attach /y.log"],
  });
});
