import assert from "node:assert/strict";
import test from "node:test";
import { parseAutomationConfig } from "@notion-tmux/shared";
import { pageIdFromArg, normalizeNotionId } from "./notion.js";
import { SerialQueue, RunPool } from "./queue.js";
import { runnerInternals } from "./runner.js";

const project = {
  id: "dochub",
  key: "dochub",
  databaseId: "123",
  repoRoot: "/tmp/dochub",
  baseBranch: "main",
  branchPrefix: "bot",
  statusProperty: "Status",
  triggerStatus: "Ready for Dev",
  workingStatus: "In Progress",
  reviewStatus: "In Review",
  blockedStatus: "Blocked",
  prProperty: "PR",
  ticketIdProperty: "Ticket ID",
  verifyCommands: ["npm test"],
  allowedBash: [],
  pollIntervalSec: 30,
  agentTeam: false,
};

test("automation config applies defaults and enforces minimum polling interval", () => {
  const parsed = parseAutomationConfig({
    version: 1,
    enabled: false,
    projects: [project],
  });
  assert.equal(parsed.pollIntervalSec, 30);
  assert.equal(parsed.defaultAgent, "claude");
  assert.equal(parsed.maxConcurrentRuns, 3);
  assert.equal(parsed.projects[0].pollIntervalSec, 30);
  assert.throws(() =>
    parseAutomationConfig({ version: 1, enabled: false, pollIntervalSec: 5, projects: [] }),
  );
  assert.throws(() =>
    parseAutomationConfig({
      version: 1,
      enabled: false,
      projects: [{ ...project, pollIntervalSec: 5 }],
    }),
  );
});

test("Notion page ids are accepted from raw ids and URLs", () => {
  const id = "1234567890abcdef1234567890abcdef";
  assert.equal(pageIdFromArg(id), id);
  assert.equal(pageIdFromArg(`https://notion.so/Ticket-${id}?pvs=4`), id);
  assert.equal(normalizeNotionId("1234-5678"), "12345678");
});

test("serial queue deduplicates pending jobs and preserves order", async () => {
  const seen: number[] = [];
  const queue = new SerialQueue<number>(async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(value);
  });
  assert.equal(queue.enqueue("a", 1), true);
  assert.equal(queue.enqueue("a", 2), false);
  assert.equal(queue.enqueue("b", 3), true);
  await queue.whenIdle();
  assert.deepEqual(seen, [1, 3]);
});

test("run pool runs different groups concurrently but serializes within a group", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const pool = new RunPool<{ id: string; group: string }>(
    async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(job.id);
      active -= 1;
    },
    { maxConcurrent: 4, groupOf: (job) => job.group },
  );
  pool.enqueue("a1", { id: "a1", group: "A" });
  pool.enqueue("a2", { id: "a2", group: "A" });
  pool.enqueue("b1", { id: "b1", group: "B" });
  await pool.whenIdle();
  // A is serialized, B runs alongside it: at most two repos in flight.
  assert.equal(maxActive, 2);
  // Within group A, order is preserved.
  assert.ok(order.indexOf("a1") < order.indexOf("a2"));
  assert.deepEqual([...order].sort(), ["a1", "a2", "b1"]);
});

test("run pool deduplicates by key and respects the concurrency cap", async () => {
  let active = 0;
  let maxActive = 0;
  const pool = new RunPool<number>(
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
    { maxConcurrent: 2, groupOf: (value) => String(value) },
  );
  assert.equal(pool.enqueue("k", 1), true);
  assert.equal(pool.enqueue("k", 1), false);
  for (let i = 0; i < 6; i += 1) pool.enqueue(`g${i}`, i + 10);
  await pool.whenIdle();
  assert.ok(maxActive <= 2);
});

test("branch and prompt generation stay scoped to the ticket", () => {
  assert.equal(runnerInternals.branchFor(project, "DH-123 Fix login"), "bot/dh-123-fix-login");
  const prompt = runnerInternals.buildPrompt(
    project,
    {
      pageId: "page",
      ref: "DH-123",
      name: "Fix login",
      status: "Ready for Dev",
      type: "Bug",
      priority: "High",
      area: ["Auth"],
      summary: "Login fails",
    },
    "Acceptance criteria",
  );
  assert.match(prompt, /DH-123/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Do not push/);
});
