import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  query as sdkQuery,
  type AgentDefinition,
  type Options as SdkOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentId,
  EngineEvent,
  ModelOption,
  ModelTiers,
  ThreadItem,
  ThreadState,
  ThreadSummary,
} from "@notion-tmux/shared";

/** The subset of the SDK's `query` we depend on; injectable for tests. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: SdkOptions;
}) => Query;

const DONE = Symbol("outbox-done");

/** A thread item before the manager stamps id/threadId/at. */
type ThreadItemInput =
  | { kind: "message"; role: "assistant" | "user"; text: string; pending?: boolean }
  | { kind: "activity"; tool: string; detail: string };

/** A single-consumer async FIFO. `shift()` resolves with the next value or DONE. */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: ((value: T | typeof DONE) => void)[] = [];
  private closed = false;

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(DONE);
  }

  shift(): Promise<T | typeof DONE> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    if (this.closed) return Promise.resolve(DONE);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export interface StartParams {
  threadId?: string;
  ticketRef: string;
  ticketName: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  prompt: string;
  /** The static tool allowlist for this project (the SDK auto-approves these). */
  allowedTools: string[];
  /** Per-thread permission bypass (sticky). */
  bypass?: boolean;
  /** True when a human kicked this off (manual run); false for the poller. */
  attended?: boolean;
  /** Base model for the session (Claude model alias or full ID). */
  model?: string;
  /** Orchestrator may delegate to a strategist/developer/checker subagent team. */
  agentTeam?: boolean;
  /** Per-role model overrides; unset roles inherit the base model. */
  tiers?: ModelTiers;
}

interface PendingPermission {
  toolUseId: string;
  resolve: (result: PermissionResult) => void;
}

interface ActiveSession {
  threadId: string;
  sessionId?: string;
  ticketRef: string;
  ticketName: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  prompt: string;
  allowedTools: string[];
  model?: string;
  agentTeam: boolean;
  tiers?: ModelTiers;
  state: ThreadState;
  bypass: boolean;
  /** A human is watching: thread opened or a message sent. Gates permissions. */
  attended: boolean;
  tokens: number;
  prUrl?: string;
  pausedReason?: string;
  startedAt: string;
  updatedAt: string;
  items: ThreadItem[];
  handle?: Query;
  outbox?: AsyncQueue<string>;
  pending?: PendingPermission;
  span?: Promise<void>;
}

const TEAM_GUIDANCE = [
  "",
  "Team:",
  "- You are the orchestrator. For complex or multi-part work, delegate: the strategist subagent plans, the developer subagent implements, and the checker subagent reviews the result before you finish.",
  "- For small, obvious changes work alone; do not spawn subagents unnecessarily.",
].join("\n");

function teamAgents(tiers?: ModelTiers): Record<string, AgentDefinition> {
  const model = (tier?: string) => (tier ? { model: tier } : {});
  return {
    strategist: {
      description: "Plans the implementation approach for a ticket before code is written.",
      prompt:
        "You are the strategist. Produce a concise implementation plan: files to touch, approach, risks, test strategy. Do not write code.",
      tools: ["Read", "Grep", "Glob"],
      ...model(tiers?.strategist),
    },
    developer: {
      description: "Implements a planned change in the worktree.",
      prompt:
        "You are the developer. Implement the requested change exactly as planned, following repo conventions. Keep the diff scoped to the task.",
      ...model(tiers?.developer),
    },
    checker: {
      description: "Reviews completed work for correctness and scope before it is committed.",
      prompt:
        "You are the work checker. Review the diff against the ticket: correctness, scope creep, missed requirements, broken tests. Report problems bluntly.",
      tools: ["Read", "Grep", "Glob", "Bash"],
      ...model(tiers?.checker),
    },
  };
}

export interface SessionManagerOptions {
  emit(event: EngineEvent): void;
  /** Scrubbed environment for the agent (no NOTION_TOKEN, no gateway leak). */
  env: NodeJS.ProcessEnv;
  /** Called at each turn boundary so the host can commit / open a PR. */
  onTurnEnd(session: ThreadSummary): Promise<{ committed: boolean } | void>;
  queryFn?: QueryFn;
}

/**
 * Owns the streaming Claude Agent SDK sessions that back live ticket threads.
 * One run = one SDK session = one thread. Knows nothing about git or Notion —
 * the engine wires those via `onTurnEnd` and the archive/createPr flows.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly settleWaiters = new Map<string, (() => void)[]>();
  private readonly query: QueryFn;

  constructor(private readonly options: SessionManagerOptions) {
    this.query = options.queryFn ?? (sdkQuery as unknown as QueryFn);
  }

  start(params: StartParams): string {
    const threadId = params.threadId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const prompt = params.agentTeam ? `${params.prompt}${TEAM_GUIDANCE}` : params.prompt;
    const session: ActiveSession = {
      threadId,
      ticketRef: params.ticketRef,
      ticketName: params.ticketName,
      projectId: params.projectId,
      projectKey: params.projectKey,
      pageId: params.pageId,
      worktreePath: params.worktreePath,
      branch: params.branch,
      baseBranch: params.baseBranch,
      prompt,
      allowedTools: params.allowedTools,
      model: params.agentTeam ? params.tiers?.orchestrator ?? params.model : params.model,
      agentTeam: Boolean(params.agentTeam),
      tiers: params.tiers,
      state: "running",
      bypass: Boolean(params.bypass),
      attended: Boolean(params.attended),
      tokens: 0,
      startedAt: now,
      updatedAt: now,
      items: [],
    };
    this.sessions.set(threadId, session);
    this.options.emit({ event: "thread.created", payload: this.summary(session) });
    session.span = this.runSpan(session, prompt);
    return threadId;
  }

  /** Queue a message. Within a running turn it never preempts; idle → resumes. */
  send(threadId: string, text: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    session.attended = true;
    this.appendItem(session, {
      kind: "message",
      role: "user",
      text,
      pending: session.state === "running",
    });
    if (session.state === "running" && session.outbox) {
      session.outbox.push(text);
    } else {
      session.span = this.runSpan(session, text, true);
    }
    return true;
  }

  async stop(threadId: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    session.outbox?.close();
    try {
      await session.handle?.interrupt();
    } catch {
      // turn may already be ending
    }
    this.setState(session, "stopped");
    return true;
  }

  setBypass(threadId: string, on: boolean): boolean {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    session.bypass = on;
    void session.handle
      ?.setPermissionMode(on ? "bypassPermissions" : "acceptEdits")
      .catch(() => undefined);
    this.emitUpdated(session);
    return true;
  }

  resolvePermission(threadId: string, toolUseId: string, allow: boolean): boolean {
    const session = this.sessions.get(threadId);
    if (!session?.pending || session.pending.toolUseId !== toolUseId) return false;
    const { resolve } = session.pending;
    session.pending = undefined;
    this.options.emit({
      event: "thread.permissionResolved",
      payload: { threadId, toolUseId },
    });
    resolve(
      allow
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: "Denied by reviewer" },
    );
    if (allow && session.state === "awaiting") this.setState(session, "running");
    return true;
  }

  /** Opening a thread marks it attended and returns its rendered items. */
  getItems(threadId: string): ThreadItem[] {
    const session = this.sessions.get(threadId);
    if (!session) return [];
    session.attended = true;
    return session.items;
  }

  list(): ThreadSummary[] {
    return [...this.sessions.values()].map((session) => this.summary(session));
  }

  /** Resolves when the thread first reaches a non-running state (turn settled). */
  whenSettled(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return Promise.resolve();
    if (isSettled(session.state)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.settleWaiters.get(threadId) ?? [];
      waiters.push(resolve);
      this.settleWaiters.set(threadId, waiters);
    });
  }

  summaryOf(threadId: string): ThreadSummary | undefined {
    const session = this.sessions.get(threadId);
    return session ? this.summary(session) : undefined;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  setPrUrl(threadId: string, prUrl: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.prUrl = prUrl;
    this.emitUpdated(session);
  }

  /** Tear down a session (engine handles worktree/branch cleanup separately). */
  remove(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.outbox?.close();
    void session.handle?.interrupt().catch(() => undefined);
    this.sessions.delete(threadId);
  }

  /** Run one streaming span: yields the first prompt, then drains the outbox. */
  private async runSpan(session: ActiveSession, first: string, resume = false): Promise<void> {
    const outbox = new AsyncQueue<string>();
    session.outbox = outbox;
    this.setState(session, "running");

    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield self.userMessage(session, first);
      while (true) {
        const next = await outbox.shift();
        if (next === DONE) return;
        yield self.userMessage(session, next);
      }
    }

    try {
      const handle = this.query({
        prompt: input(),
        options: this.sdkOptions(session, resume),
      });
      session.handle = handle;
      for await (const message of handle) {
        await this.onMessage(session, message, outbox);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.appendItem(session, { kind: "activity", tool: "error", detail });
      this.setState(session, "failed");
    } finally {
      if (session.outbox === outbox) session.outbox = undefined;
      session.handle = undefined;
    }
  }

  private async onMessage(
    session: ActiveSession,
    message: SDKMessage,
    outbox: AsyncQueue<string>,
  ): Promise<void> {
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && message.session_id) {
          session.sessionId = message.session_id;
          this.emitUpdated(session);
        }
        break;
      case "assistant":
        this.ingestAssistant(session, message);
        break;
      case "user":
        this.ingestToolResults(session, message);
        break;
      case "result": {
        session.tokens += usageTokens(message);
        const result = await this.options.onTurnEnd(this.summary(session));
        const committed = Boolean(result && "committed" in result && result.committed);
        // Turn boundary: honour any queued messages, otherwise end the span.
        if (outbox.size === 0) {
          // A pause from an unattended permission denial sticks until the user returns.
          const target = session.pausedReason ? "awaiting" : committed ? "done" : "awaiting";
          this.setState(session, target);
          outbox.close();
        } else {
          this.setState(session, "running");
        }
        break;
      }
      default:
        break;
    }
  }

  private ingestAssistant(session: ActiveSession, message: SDKMessage & { type: "assistant" }): void {
    const content = ((message.message?.content ?? []) as unknown) as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.appendItem(session, { kind: "message", role: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        this.appendItem(session, {
          kind: "activity",
          tool: String(block.name ?? "tool"),
          detail: summarizeInput(block.input),
        });
      }
    }
  }

  private ingestToolResults(session: ActiveSession, message: SDKMessage & { type: "user" }): void {
    const content = (message.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result") {
        const text = extractText(block.content);
        if (text) {
          this.appendItem(session, { kind: "activity", tool: "result", detail: text.slice(0, 400) });
        }
      }
    }
  }

  private sdkOptions(session: ActiveSession, resume: boolean): SdkOptions {
    return {
      cwd: session.worktreePath,
      env: this.options.env,
      settingSources: ["user", "project"], // Gate 2: load installed skills
      skills: "all", // Gate 1 + 2: auto-adds "Skill" to allowedTools
      allowedTools: [...session.allowedTools, "Skill"],
      permissionMode: session.bypass ? "bypassPermissions" : "acceptEdits",
      ...(resume && session.sessionId ? { resume: session.sessionId } : {}),
      ...(session.bypass ? {} : { canUseTool: this.permissionGate(session) }),
      ...(session.model ? { model: session.model } : {}),
      ...(session.agentTeam ? { agents: teamAgents(session.tiers) } : {}),
    };
  }

  /** Attach-aware gate: attended → prompt the thread; unattended → auto-deny. */
  private permissionGate(session: ActiveSession) {
    return (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID: string; title?: string },
    ): Promise<PermissionResult> => {
      if (!session.attended) {
        const reason = `needs permission for ${toolName}`;
        session.pausedReason = reason;
        this.setState(session, "awaiting");
        return Promise.resolve({
          behavior: "deny",
          message: `Paused: ${reason}. Open the thread to allow.`,
        });
      }
      return new Promise((resolve) => {
        session.pending = { toolUseId: options.toolUseID, resolve };
        this.options.emit({
          event: "thread.permission",
          payload: {
            threadId: session.threadId,
            toolUseId: options.toolUseID,
            tool: toolName,
            title: options.title ?? `Allow ${toolName}?`,
            input,
          },
        });
      });
    };
  }

  private userMessage(session: ActiveSession, text: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(session.sessionId ? { session_id: session.sessionId } : {}),
    } as SDKUserMessage;
  }

  private appendItem(session: ActiveSession, item: ThreadItemInput): void {
    const full = {
      id: crypto.randomUUID(),
      threadId: session.threadId,
      at: new Date().toISOString(),
      ...item,
    } as ThreadItem;
    session.items.push(full);
    if (session.items.length > 2000) session.items.shift();
    this.options.emit({ event: "thread.item", payload: full });
  }

  private setState(session: ActiveSession, state: ThreadState): void {
    // The pause reason clears only when the user returns and a new turn starts.
    if (state === "running") session.pausedReason = undefined;
    session.state = state;
    this.emitUpdated(session);
    if (isSettled(state)) {
      const waiters = this.settleWaiters.get(session.threadId);
      if (waiters) {
        this.settleWaiters.delete(session.threadId);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private emitUpdated(session: ActiveSession): void {
    session.updatedAt = new Date().toISOString();
    this.options.emit({ event: "thread.updated", payload: this.summary(session) });
  }

  private summary(session: ActiveSession): ThreadSummary {
    return {
      threadId: session.threadId,
      ticketRef: session.ticketRef,
      ticketName: session.ticketName,
      projectId: session.projectId,
      projectKey: session.projectKey,
      pageId: session.pageId,
      sessionId: session.sessionId,
      state: session.state,
      prUrl: session.prUrl,
      bypass: session.bypass,
      tokens: session.tokens,
      pausedReason: session.pausedReason,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    };
  }
}

function isSettled(state: ThreadState): boolean {
  return state === "done" || state === "awaiting" || state === "failed" || state === "stopped";
}

function usageTokens(message: SDKMessage & { type: "result" }): number {
  const usage = (message as unknown as { usage?: Record<string, number> }).usage;
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  return input + output + cacheRead + cacheCreate;
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 200);
  try {
    const json = JSON.stringify(input);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "",
      )
      .join("")
      .trim();
  }
  return "";
}

export const FALLBACK_MODELS: ModelOption[] = [
  { value: "opus", displayName: "Opus (latest)" },
  { value: "sonnet", displayName: "Sonnet (latest)" },
  { value: "haiku", displayName: "Haiku (latest)" },
];

/**
 * Ask the Claude CLI which models it supports via a throwaway streaming query.
 * Any failure (CLI missing, timeout, old CLI) falls back to static aliases —
 * model selection must never block on discovery.
 */
export async function listSupportedModels(
  cwd: string,
  queryFn?: QueryFn,
  timeoutMs = 15_000,
  env?: NodeJS.ProcessEnv,
): Promise<ModelOption[]> {
  const fn = queryFn ?? (sdkQuery as unknown as QueryFn);
  let timer: NodeJS.Timeout | undefined;
  let handle: Query | undefined;
  try {
    handle = fn({
      prompt: (async function* () {})() as AsyncIterable<SDKUserMessage>,
      options: { cwd, ...(env ? { env } : {}) },
    });
    const models = await Promise.race([
      handle.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedModels timed out")), timeoutMs);
      }),
    ]);
    const mapped = models.map((model) => ({ value: model.value, displayName: model.displayName }));
    // Consumers treat an empty list as "not loaded" and refetch; never emit one.
    return mapped.length ? mapped : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  } finally {
    if (timer) clearTimeout(timer);
    // Interrupt on every path — the timeout case is exactly the hung CLI
    // process this teardown exists to recover from.
    await handle?.interrupt().catch(() => undefined);
  }
}

interface CodexCacheModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
}

/**
 * Read the Codex CLI's on-disk model cache. Codex exposes no discovery API, so
 * the cache it maintains at $CODEX_HOME/models_cache.json is the source of
 * truth for which models the user has installed. Only `visibility: "list"`
 * entries are user-selectable; internal entries (e.g. codex-auto-review) are
 * dropped. Any failure returns [] — model selection must never block on this.
 */
export function listCodexModels(): ModelOption[] {
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const raw = fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    const models: ModelOption[] = [];
    for (const entry of parsed.models as CodexCacheModel[]) {
      if (!entry || entry.visibility !== "list") continue;
      const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
      if (!slug) continue;
      const displayName = typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name
        : slug;
      models.push({ value: slug, displayName });
    }
    return models;
  } catch {
    return [];
  }
}

/**
 * Models offered in the picker for a given agent. Claude discovers via the SDK;
 * Codex reads its local cache; other agents have no discovery source and rely on
 * the picker's free-form "Custom…" entry.
 */
export async function listModelsForAgent(
  agentId: AgentId,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<ModelOption[]> {
  switch (agentId) {
    case "claude":
      return listSupportedModels(cwd, undefined, undefined, env);
    case "codex":
      return listCodexModels();
    default:
      return [];
  }
}
