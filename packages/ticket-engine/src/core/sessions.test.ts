import assert from "node:assert/strict";
import test from "node:test";
import type { EngineEvent } from "@notion-tmux/shared";
import { SessionManager, listSupportedModels, FALLBACK_MODELS, type QueryFn } from "./sessions.js";

interface Harness {
  manager: SessionManager;
  events: EngineEvent[];
  turnEnds: number;
}

/** Build a SessionManager wired to a scripted fake `query`. */
function harness(
  makeQuery: (record: { canUseTool?: unknown; options?: Record<string, unknown> }) => QueryFn,
  committed = true,
): Harness {
  const events: EngineEvent[] = [];
  const record: { canUseTool?: unknown; options?: Record<string, unknown> } = {};
  let turnEnds = 0;
  const manager = new SessionManager({
    emit: (event) => events.push(event),
    env: {},
    onTurnEnd: async () => {
      turnEnds++;
      return { committed };
    },
    queryFn: (params) => {
      record.canUseTool = params.options?.canUseTool;
      record.options = params.options as unknown as Record<string, unknown>;
      return makeQuery(record)(params);
    },
  });
  return { manager, events, get turnEnds() { return turnEnds; } } as Harness;
}

function asyncGen(messages: unknown[], onInput?: (consume: () => Promise<void>) => AsyncGenerator<unknown>) {
  return ((params: { prompt: string | AsyncIterable<unknown> }) => {
    const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* gen(): AsyncGenerator<unknown> {
      await iterator.next(); // initial prompt
      for (const message of messages) yield message;
      if (onInput) {
        const consume = async () => {
          await iterator.next();
        };
        yield* onInput(consume);
      } else {
        await iterator.next(); // drain until outbox closes
      }
    }
    const g = gen();
    return Object.assign(g, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
    });
  }) as unknown as QueryFn;
}

const initMsg = { type: "system", subtype: "init", session_id: "sess-1" };
const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: "sess-1" });
const result = (usage: Record<string, number> = {}) => ({ type: "result", subtype: "success", usage, session_id: "sess-1" });

async function settle(manager: SessionManager, threadId: string): Promise<void> {
  // The SessionManager exposes no span handle; poll the public state instead.
  for (let i = 0; i < 200; i++) {
    const summary = manager.summaryOf(threadId);
    if (summary && ["done", "awaiting", "failed", "stopped"].includes(summary.state)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("session did not settle");
}

test("a single turn streams assistant text, counts tokens, and ends Done", async () => {
  const h = harness(() => asyncGen([initMsg, assistant("Working on it"), result({ input_tokens: 10, output_tokens: 5 })]));
  const threadId = h.manager.start({
    ticketRef: "DH-1", ticketName: "Fix login", projectId: "p", projectKey: "dochub",
    pageId: "page", worktreePath: "/tmp/wt", branch: "bot/dh-1", baseBranch: "main",
    prompt: "do it", allowedTools: ["Edit"],
  });
  await settle(h.manager, threadId);
  const summary = h.manager.summaryOf(threadId)!;
  assert.equal(summary.state, "done");
  assert.equal(summary.sessionId, "sess-1");
  assert.equal(summary.tokens, 15);
  const items = h.manager.getItems(threadId);
  assert.ok(items.some((i) => i.kind === "message" && i.role === "assistant" && i.text === "Working on it"));
  assert.equal(h.turnEnds, 1);
});

test("a message sent mid-run queues and runs at the next boundary (never preempts)", async () => {
  const h = harness(() =>
    asyncGen([initMsg, assistant("turn one"), result()], async function* (consume) {
      await consume(); // pull the queued message
      yield assistant("turn two");
      yield result();
      await consume(); // drain on close
    }),
  );
  const threadId = h.manager.start({
    ticketRef: "DH-2", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page2", worktreePath: "/tmp/wt", branch: "bot/dh-2", baseBranch: "main",
    prompt: "go", allowedTools: [],
  });
  // Synchronously queue while the first turn is still running.
  const queued = h.manager.send(threadId, "also do this");
  assert.equal(queued, true);
  await settle(h.manager, threadId);
  const items = h.manager.getItems(threadId);
  assert.ok(items.some((i) => i.kind === "message" && i.role === "user" && i.text === "also do this"));
  assert.ok(items.filter((i) => i.kind === "message" && i.role === "assistant").length >= 2);
  assert.equal(h.turnEnds, 2);
});

test("unattended permission requests auto-deny and pause the thread", async () => {
  const h = harness((record) =>
    asyncGen([initMsg], async function* () {
      const gate = record.canUseTool as
        | ((t: string, i: Record<string, unknown>, o: { toolUseID: string }) => Promise<{ behavior: string }>)
        | undefined;
      const decision = await gate!("Bash", { command: "rm -rf /" }, { toolUseID: "t1" });
      assert.equal(decision.behavior, "deny");
      yield result();
    }),
  );
  const threadId = h.manager.start({
    ticketRef: "DH-3", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page3", worktreePath: "/tmp/wt", branch: "bot/dh-3", baseBranch: "main",
    prompt: "go", allowedTools: [], attended: false,
  });
  await settle(h.manager, threadId);
  const summary = h.manager.summaryOf(threadId)!;
  assert.match(summary.pausedReason ?? "", /Bash/);
});

test("attended permission requests prompt the thread and resolve on allow", async () => {
  let allowed = false;
  const h = harness((record) =>
    asyncGen([initMsg], async function* () {
      const gate = record.canUseTool as
        | ((t: string, i: Record<string, unknown>, o: { toolUseID: string }) => Promise<{ behavior: string }>)
        | undefined;
      const decision = await gate!("Bash", { command: "ls" }, { toolUseID: "t9" });
      allowed = decision.behavior === "allow";
      yield result();
    }),
  );
  const threadId = h.manager.start({
    ticketRef: "DH-4", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page4", worktreePath: "/tmp/wt", branch: "bot/dh-4", baseBranch: "main",
    prompt: "go", allowedTools: [], attended: true,
  });
  // Wait for the permission event, then allow it.
  for (let i = 0; i < 200 && !h.events.some((e) => e.event === "thread.permission"); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const ok = h.manager.resolvePermission(threadId, "t9", true);
  assert.equal(ok, true);
  await settle(h.manager, threadId);
  assert.equal(allowed, true);
});

test("base model is passed to SDK options; no agents without team", async () => {
  let captured: Record<string, unknown> | undefined;
  const h = harness((record) => {
    const inner = asyncGen([initMsg, result()]);
    return (params) => {
      captured = record.options;
      return inner(params);
    };
  });
  const threadId = h.manager.start({
    ticketRef: "DH-5", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page5", worktreePath: "/tmp/wt", branch: "bot/dh-5", baseBranch: "main",
    prompt: "go", allowedTools: [], model: "claude-sonnet-5",
  });
  await settle(h.manager, threadId);
  assert.equal(captured?.model, "claude-sonnet-5");
  assert.equal(captured?.agents, undefined);
});

test("agent team defines subagents with tier models and orchestrator model override", async () => {
  let captured: Record<string, unknown> | undefined;
  const h = harness((record) => {
    const inner = asyncGen([initMsg, result()]);
    return (params) => {
      captured = record.options;
      return inner(params);
    };
  });
  const threadId = h.manager.start({
    ticketRef: "DH-6", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page6", worktreePath: "/tmp/wt", branch: "bot/dh-6", baseBranch: "main",
    prompt: "go", allowedTools: [],
    model: "claude-sonnet-5",
    agentTeam: true,
    tiers: { strategist: "claude-opus-4-8", orchestrator: "claude-opus-4-8", developer: undefined, checker: "claude-haiku-4-5-20251001" },
  });
  await settle(h.manager, threadId);
  assert.equal(captured?.model, "claude-opus-4-8"); // orchestrator tier wins
  const agents = captured?.agents as Record<string, { model?: string; prompt: string }>;
  assert.ok(agents.strategist && agents.developer && agents.checker);
  assert.equal(agents.strategist.model, "claude-opus-4-8");
  assert.equal(agents.developer.model, undefined); // inherit
  assert.equal(agents.checker.model, "claude-haiku-4-5-20251001");
  const summary = h.manager.summaryOf(threadId)!;
  assert.equal(summary.state, "done");
});

test("agent team appends orchestrator guidance to the initial prompt", async () => {
  // The initial prompt is never appended as a thread item (start() streams it
  // straight into the SDK turn via the outbox generator; see runSpan/userMessage
  // in sessions.ts) so we can't assert on getItems() here as the brief's note
  // anticipated. Instead capture the actual first SDKUserMessage handed to the
  // SDK query — that's the guidance-text-reaches-the-SDK-turn assertion.
  let firstPromptText = "";
  const h = harness(() =>
    ((params: { prompt: string | AsyncIterable<{ message: { content: string } }> }) => {
      const iterator = (
        params.prompt as AsyncIterable<{ message: { content: string } }>
      )[Symbol.asyncIterator]();
      async function* gen(): AsyncGenerator<unknown> {
        const first = await iterator.next();
        firstPromptText = first.value?.message?.content ?? "";
        yield initMsg;
        yield result();
        await iterator.next(); // drain until outbox closes
      }
      const g = gen();
      return Object.assign(g, {
        interrupt: async () => undefined,
        setPermissionMode: async () => undefined,
      });
    }) as unknown as QueryFn,
  );
  const threadId = h.manager.start({
    ticketRef: "DH-7", ticketName: "x", projectId: "p", projectKey: "dochub",
    pageId: "page7", worktreePath: "/tmp/wt", branch: "bot/dh-7", baseBranch: "main",
    prompt: "go", allowedTools: [], agentTeam: true,
  });
  await settle(h.manager, threadId);
  assert.ok(firstPromptText.includes("orchestrator"), `expected guidance in: ${firstPromptText}`);
});

test("listSupportedModels maps SDK models and falls back on error", async () => {
  const fakeQuery = (() => ({
    supportedModels: async () => [
      { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
    ],
    interrupt: async () => undefined,
  })) as unknown as QueryFn;
  const models = await listSupportedModels("/tmp", fakeQuery);
  assert.deepEqual(models, [{ value: "claude-opus-4-8", displayName: "Opus 4.8" }]);

  const broken = (() => ({
    supportedModels: async () => {
      throw new Error("no CLI");
    },
    interrupt: async () => undefined,
  })) as unknown as QueryFn;
  assert.deepEqual(await listSupportedModels("/tmp", broken), FALLBACK_MODELS);

  const empty = (() => ({
    supportedModels: async () => [],
    interrupt: async () => undefined,
  })) as unknown as QueryFn;
  assert.deepEqual(await listSupportedModels("/tmp", empty), FALLBACK_MODELS);
});

test("listSupportedModels threads a scrubbed env into the SDK query options", async () => {
  let seenOptions: Record<string, unknown> | undefined;
  const fakeQuery = ((params: { options?: Record<string, unknown> }) => {
    seenOptions = params.options;
    return {
      supportedModels: async () => [],
      interrupt: async () => undefined,
    };
  }) as unknown as QueryFn;

  const scrubbedEnv = { PATH: "/usr/bin" };
  await listSupportedModels("/tmp", fakeQuery, undefined, scrubbedEnv);
  assert.equal(seenOptions?.env, scrubbedEnv);

  // env is optional: omitting it must not inject an `env` key at all (so the
  // SDK falls back to its own default of inheriting `process.env`).
  await listSupportedModels("/tmp", fakeQuery);
  assert.equal("env" in (seenOptions ?? {}), false);
});

test("listSupportedModels interrupts the hung query on timeout", async () => {
  let interrupted = false;
  const hung = (() => ({
    supportedModels: () => new Promise<never>(() => undefined), // never resolves
    interrupt: async () => {
      interrupted = true;
    },
  })) as unknown as QueryFn;
  const models = await listSupportedModels("/tmp", hung, 10);
  assert.deepEqual(models, FALLBACK_MODELS);
  assert.equal(interrupted, true);
});
