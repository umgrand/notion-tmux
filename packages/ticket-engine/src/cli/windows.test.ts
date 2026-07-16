import test from "node:test";
import assert from "node:assert/strict";
import type { EngineEvent, RunRecord } from "@notion-tmux/shared";
import { WindowTracker } from "./windows.js";

function stage(partial: Partial<RunRecord>): EngineEvent {
  return {
    event: "run.stageChanged",
    payload: {
      runId: "r1",
      projectId: "p1",
      projectKey: "PROJ",
      pageId: "pg1",
      stage: "running_agent",
      message: "",
      ...partial,
    },
  };
}

test("opens exactly one window per runId even across many stage events", () => {
  const t = new WindowTracker();
  const first = t.onEvent(stage({ logPath: "logs/a.log", ticketRef: "PROJ-12" }));
  const second = t.onEvent(stage({ logPath: "logs/a.log", ticketRef: "PROJ-12" }));
  const opens = [...first, ...second].filter((a) => a.kind === "open");
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0], {
    kind: "open",
    runId: "r1",
    name: "PROJ-12",
    logPath: "logs/a.log",
  });
});

test("does not open a window until a logPath exists", () => {
  const t = new WindowTracker();
  const actions = t.onEvent(stage({ logPath: undefined }));
  assert.equal(actions.filter((a) => a.kind === "open").length, 0);
});

test("falls back to projectKey when ticketRef is absent", () => {
  const t = new WindowTracker();
  const [open] = t
    .onEvent(stage({ logPath: "logs/a.log", ticketRef: undefined }))
    .filter((a) => a.kind === "open");
  assert.equal(open.kind === "open" && open.name, "PROJ");
});

test("emits a status line with the PR url on completion", () => {
  const t = new WindowTracker();
  const actions = t.onEvent({
    event: "run.completed",
    payload: {
      runId: "r1",
      projectId: "p1",
      projectKey: "PROJ",
      pageId: "pg1",
      stage: "completed",
      message: "done",
      ticketRef: "PROJ-12",
      prUrl: "https://gh/pr/1",
    },
  });
  assert.deepEqual(actions, [
    { kind: "status", text: "done PROJ-12 → https://gh/pr/1" },
  ]);
});
