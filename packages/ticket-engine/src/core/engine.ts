import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  AgentId,
  DoctorCheck,
  DoctorReport,
  EngineEvent,
  EngineSnapshot,
  FlintAutomationConfig,
  ModelOption,
  NotionDatabaseSummary,
  NotionDatabaseInspection,
  RepositoryInspection,
  RunRecord,
  ThreadItem,
  ThreadSummary,
  ThreadTombstone,
} from "@notion-tmux/shared";
import { parseAutomationConfig } from "@notion-tmux/shared";
import { detectAgent, verifyAgentAuth, adapters } from "./agents.js";
import { RunHistory } from "./history.js";
import { NotionGateway, pageIdFromArg } from "./notion.js";
import { RunPool } from "./queue.js";
import { CancelledError, TicketRunner } from "./runner.js";
import { SessionManager, listModelsForAgent } from "./sessions.js";
import { ThreadStore, type PersistedThread } from "./threads.js";
import type { Ticket } from "./notion.js";
import type { AutomationProject } from "@notion-tmux/shared";

interface EngineJob {
  record: RunRecord;
  projectId: string;
  force: boolean;
}

/** Per-thread git context the engine needs to commit / PR / archive a session. */
interface ThreadContext {
  project: AutomationProject;
  ticket: Ticket;
  pageId: string;
  worktree: string;
  branch: string;
  baseBranch: string;
}

export interface TicketEngineOptions {
  config: FlintAutomationConfig;
  notionToken: string;
  dataDir: string;
  emit(event: EngineEvent): void;
}

function commandVersion(file: string, args = ["--version"]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8_000 }, (error, stdout, stderr) => {
      resolve(error ? null : `${stdout}${stderr}`.trim().split("\n")[0]);
    });
  });
}

export class TicketEngine {
  private readonly config: FlintAutomationConfig;
  private readonly notion: NotionGateway;
  private readonly history: RunHistory;
  private readonly automationDir: string;
  private readonly runner: TicketRunner;
  private readonly pool: RunPool<EngineJob>;
  private readonly sessions: SessionManager;
  private readonly threadStore: ThreadStore;
  private readonly threadContexts = new Map<string, ThreadContext>();
  private state: EngineSnapshot;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pollingProjects = new Set<string>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly modelCache = new Map<AgentId, ModelOption[]>();
  /** Scrubbed environment (no NOTION_TOKEN, no adapter-specific nested-session
   * vars) shared by every subprocess/SDK call the engine makes on the agent's
   * behalf, including model discovery. */
  private readonly agentEnv: NodeJS.ProcessEnv;

  constructor(private readonly options: TicketEngineOptions) {
    this.config = parseAutomationConfig(options.config);
    if (!options.notionToken.trim()) throw new Error("Notion token is required");
    this.automationDir = path.join(options.dataDir, "automation");
    fs.mkdirSync(this.automationDir, { recursive: true });
    this.notion = new NotionGateway(options.notionToken);
    this.history = new RunHistory(this.automationDir);
    this.state = {
      state: "stopped",
      initialized: true,
      polling: false,
      queueLength: 0,
      activeRuns: [],
      activeRun: null,
      recentRuns: this.history.load(),
    };
    this.runner = new TicketRunner({
      dataDir: this.automationDir,
      defaultAgent: this.config.defaultAgent,
      defaultTimeoutMin: this.config.defaultTimeoutMin,
      notion: this.notion,
      onStage: (record) => {
        this.state.activeRuns = this.state.activeRuns.map((run) =>
          run.runId === record.runId ? record : run,
        );
        this.state.activeRun = this.state.activeRuns[0] ?? null;
        this.emit({ event: "run.stageChanged", payload: record });
        this.emitState();
      },
      onLog: (runId, message) =>
        this.emit({
          event: "run.log",
          payload: { runId, at: new Date().toISOString(), message },
        }),
    });
    this.pool = new RunPool((job) => this.execute(job), {
      // Bounded concurrent pool of live ticket sessions (Figma 4-36).
      maxConcurrent: this.config.maxConcurrency,
      // Serialize the fetch + worktree-add critical section per repository;
      // the agent sessions themselves run fully parallel in distinct worktrees.
      groupOf: (job) => this.project(job.projectId).repoRoot,
    });
    this.threadStore = new ThreadStore(this.automationDir);
    const scrub = new Set(adapters[this.config.defaultAgent].scrubEnv);
    const agentEnv: NodeJS.ProcessEnv = { ...process.env };
    delete agentEnv.NOTION_TOKEN;
    for (const key of scrub) delete agentEnv[key];
    this.agentEnv = agentEnv;
    this.sessions = new SessionManager({
      env: agentEnv,
      emit: (event) => this.onThreadEvent(event),
      onTurnEnd: (summary) => this.commitThreadTurn(summary),
    });
  }

  async start(): Promise<EngineSnapshot> {
    if (this.state.state === "running") return this.status();
    this.state.state = "running";
    this.state.polling = true;
    this.emitState();
    await Promise.all(this.config.projects.map((project) => this.pollProject(project.id)));
    for (const project of this.config.projects) {
      this.timers.set(
        project.id,
        setInterval(
          () => void this.pollProject(project.id),
          project.pollIntervalSec * 1_000,
        ),
      );
    }
    return this.status();
  }

  async stop(options: { cancelActiveRun?: boolean } = {}): Promise<EngineSnapshot> {
    this.state.state = "stopping";
    this.state.polling = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.pool.clear();
    if (options.cancelActiveRun) {
      for (const controller of this.activeControllers.values()) controller.abort();
    }
    await this.pool.whenIdle();
    this.state.state = "stopped";
    this.state.queueLength = 0;
    this.emitState();
    return this.status();
  }

  status(): EngineSnapshot {
    return structuredClone(this.state);
  }

  async runOnce(projectId: string, pageIdOrUrl: string, force = false): Promise<string> {
    const project = this.project(projectId);
    const record = this.newRecord(project.id, project.key, pageIdFromArg(pageIdOrUrl));
    this.enqueue(record, force);
    return record.runId;
  }

  cancelRun(runId: string): boolean {
    const controller = this.activeControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // ---- Live ticket threads -------------------------------------------------

  threadList(): ThreadSummary[] {
    const live = this.sessions.list();
    const known = new Set(live.map((thread) => thread.threadId));
    // Threads persisted from a previous run that aren't in memory this session.
    const persisted = this.threadStore
      .liveThreads()
      .filter((thread) => !known.has(thread.threadId));
    return [...live, ...persisted];
  }

  threadSend(threadId: string, text: string): boolean {
    return this.sessions.send(threadId, text);
  }

  threadStop(threadId: string): Promise<boolean> {
    return this.sessions.stop(threadId);
  }

  threadSetBypass(threadId: string, on: boolean): boolean {
    return this.sessions.setBypass(threadId, on);
  }

  threadResolvePermission(threadId: string, toolUseId: string, allow: boolean): boolean {
    return this.sessions.resolvePermission(threadId, toolUseId, allow);
  }

  async threadGetMessages(threadId: string): Promise<ThreadItem[]> {
    return this.sessions.getItems(threadId);
  }

  /** Engine authors the PR text and owns the gh steps + merge (Option B). */
  async threadCreatePr(threadId: string): Promise<string> {
    const ctx = this.threadContexts.get(threadId);
    if (!ctx) throw new Error("Unknown thread");
    await this.runner.commitWork(ctx.worktree, ctx.baseBranch, ctx.ticket);
    const title = `${ctx.ticket.ref}: ${ctx.ticket.name}`;
    const body =
      `Implements Notion ticket **${ctx.ticket.ref} — ${ctx.ticket.name}**.\n\n` +
      (ctx.ticket.summary ? `${ctx.ticket.summary}\n\n` : "") +
      "Opened by notion-tmux from a live thread.";
    const url = await this.runner.openPullRequest({
      project: ctx.project,
      worktree: ctx.worktree,
      branch: ctx.branch,
      title,
      body,
    });
    this.sessions.setPrUrl(threadId, url);
    await this.notion.setPrUrl(ctx.pageId, ctx.project, url).catch(() => undefined);
    await this.notion.addComment(ctx.pageId, `PR opened by notion-tmux: ${url}`).catch(() => undefined);
    void this.pollAndMerge(threadId, ctx);
    return url;
  }

  async threadArchive(threadId: string): Promise<boolean> {
    const ctx = this.threadContexts.get(threadId);
    const summary = this.sessions.summaryOf(threadId) ??
      this.threadStore.liveThreads().find((thread) => thread.threadId === threadId);
    this.sessions.remove(threadId);
    if (ctx) {
      await this.runner.archiveThread(ctx.project, ctx.worktree, ctx.branch).catch(() => undefined);
      this.threadContexts.delete(threadId);
    }
    const tombstone: ThreadTombstone | undefined = summary
      ? {
          ticketRef: summary.ticketRef,
          projectKey: summary.projectKey,
          prUrl: summary.prUrl,
          outcome: summary.prUrl ? "merged" : "archived",
          at: new Date().toISOString(),
        }
      : undefined;
    this.threadStore.remove(threadId, tombstone);
    this.emit({ event: "thread.removed", payload: { threadId, tombstone } });
    return true;
  }

  private async pollAndMerge(threadId: string, ctx: ThreadContext): Promise<void> {
    const result = await this.runner.mergeWhenGreen({ worktree: ctx.worktree, branch: ctx.branch });
    this.emit({
      event: "thread.item",
      payload: {
        id: crypto.randomUUID(),
        threadId,
        kind: "activity",
        tool: result.merged ? "merge" : "ci",
        detail: result.detail,
        at: new Date().toISOString(),
      },
    });
    if (result.merged) {
      await this.notion
        .addComment(ctx.pageId, `Merged via notion-tmux: ${this.sessions.summaryOf(threadId)?.prUrl ?? ""}`)
        .catch(() => undefined);
      await this.notion
        .setStatus(ctx.pageId, ctx.project, ctx.project.reviewStatus)
        .catch(() => undefined);
    }
  }

  /** Commit whatever the session changed at a turn boundary (the Done hinge). */
  private async commitThreadTurn(summary: ThreadSummary): Promise<{ committed: boolean }> {
    const ctx = this.threadContexts.get(summary.threadId);
    if (!ctx) return { committed: false };
    try {
      return await this.runner.commitWork(ctx.worktree, ctx.baseBranch, ctx.ticket);
    } catch {
      return { committed: false };
    }
  }

  /** Persist thread index changes, then forward the event to the host. */
  private onThreadEvent(event: EngineEvent): void {
    if (event.event === "thread.created" || event.event === "thread.updated") {
      const ctx = this.threadContexts.get(event.payload.threadId);
      if (ctx) {
        const persisted: PersistedThread = {
          ...event.payload,
          worktreePath: ctx.worktree,
          branch: ctx.branch,
          baseBranch: ctx.baseBranch,
        };
        this.threadStore.upsert(persisted);
      }
    }
    this.emit(event);
  }

  private hasThreadForPage(pageId: string): boolean {
    for (const ctx of this.threadContexts.values()) {
      if (ctx.pageId === pageId) return true;
    }
    return false;
  }

  listDatabases(): Promise<NotionDatabaseSummary[]> {
    return this.notion.listDatabases();
  }

  /** Models offered in the UI's pickers for a given agent. Cached per agent. */
  async listModels(agentId: AgentId): Promise<ModelOption[]> {
    const cached = this.modelCache.get(agentId);
    if (cached) return cached;
    // Discovery may spawn the Claude SDK/CLI (claude path) regardless of which
    // agent is the default, so claude's scrub list must always apply on top of
    // agentEnv (which only scrubbed the default agent's vars) — otherwise
    // CLAUDE_CODE_* nested-session vars leak in when defaultAgent !== claude.
    // Harmless for the Codex file-read path.
    const env: NodeJS.ProcessEnv = { ...this.agentEnv };
    for (const key of adapters.claude.scrubEnv) delete env[key];
    const models = await listModelsForAgent(agentId, this.automationDir, env);
    if (models.length) this.modelCache.set(agentId, models);
    return models;
  }

  inspectDatabase(databaseId: string): Promise<NotionDatabaseInspection> {
    return this.notion.inspectDatabase(databaseId);
  }

  async inspectRepository(repoRoot: string): Promise<RepositoryInspection> {
    if (!fs.existsSync(repoRoot)) throw new Error(`Repository does not exist: ${repoRoot}`);
    let baseBranch = "main";
    const originHead = await commandVersion("git", [
      "-C",
      repoRoot,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (originHead?.includes("/")) baseBranch = originHead.split("/").pop() || baseBranch;

    const verifyCommands: string[] = [];
    let packageManager: string | undefined;
    const packagePath = path.join(repoRoot, "package.json");
    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      packageManager = fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(repoRoot, "yarn.lock"))
          ? "yarn"
          : fs.existsSync(path.join(repoRoot, "bun.lockb"))
            ? "bun"
            : "npm";
      const prefix = packageManager === "npm" ? "npm run" : packageManager;
      for (const script of ["lint", "test", "build"]) {
        if (pkg.scripts?.[script]) verifyCommands.push(`${prefix} ${script}`);
      }
    } else if (fs.existsSync(path.join(repoRoot, "pubspec.yaml"))) {
      verifyCommands.push("flutter analyze", "flutter test");
    } else if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
      verifyCommands.push("cargo test");
    } else if (fs.existsSync(path.join(repoRoot, "Makefile"))) {
      verifyCommands.push("make test");
    }
    return { baseBranch, verifyCommands, packageManager };
  }

  readRunLog(runId: string): string {
    const record =
      this.state.activeRuns.find((candidate) => candidate.runId === runId) ??
      this.state.recentRuns.find((candidate) => candidate.runId === runId);
    if (!record?.logPath) throw new Error("This run has no log file");
    const root = path.resolve(this.automationDir);
    const logPath = path.resolve(root, record.logPath);
    if (!logPath.startsWith(`${root}${path.sep}`)) throw new Error("Invalid run log path");
    if (!fs.existsSync(logPath)) throw new Error("Run log file no longer exists");
    return fs.readFileSync(logPath, "utf8").slice(-200_000);
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
      id: "node",
      label: "Node.js",
      status: nodeMajor >= 20 ? "ok" : "error",
      detail: process.version,
    });
    for (const binary of ["git", "gh"]) {
      const version = await commandVersion(binary);
      checks.push({
        id: binary,
        label: binary,
        status: version ? "ok" : "error",
        detail: version ?? `${binary} not found on PATH`,
      });
    }
    const ghAuth = await commandVersion("gh", ["auth", "status"]);
    checks.push({
      id: "gh-auth",
      label: "GitHub authentication",
      status: ghAuth ? "ok" : "error",
      detail: ghAuth ? "Authenticated" : "Run gh auth login",
    });
    try {
      checks.push({
        id: "notion",
        label: "Notion",
        status: "ok",
        detail: await this.notion.validate(),
      });
    } catch (error) {
      checks.push({
        id: "notion",
        label: "Notion",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    for (const project of this.config.projects) {
      const isRepo =
        fs.existsSync(project.repoRoot) &&
        (fs.existsSync(path.join(project.repoRoot, ".git")) ||
          Boolean(await commandVersion("git", ["-C", project.repoRoot, "rev-parse", "--git-dir"])));
      checks.push({
        id: `repo:${project.id}`,
        label: `${project.key} repository`,
        status: isRepo ? "ok" : "error",
        detail: isRepo ? project.repoRoot : `Invalid Git repository: ${project.repoRoot}`,
      });
    }
    const requiredAgents = new Set([
      this.config.defaultAgent,
      ...this.config.projects.flatMap((project) => (project.agent ? [project.agent] : [])),
    ]);
    for (const id of requiredAgents) {
      const result = await detectAgent(id);
      if (!result.found || !result.bin) {
        checks.push({
          id: `agent:${id}`,
          label: adapters[id].displayName,
          status: "error",
          detail: "Not found on PATH",
        });
        continue;
      }
      // Live auth ping — a present credential can still be unusable headless.
      const auth = await verifyAgentAuth(id, result.bin);
      checks.push({
        id: `agent:${id}`,
        label: adapters[id].displayName,
        status: auth.ok ? "ok" : "error",
        detail: `${result.version ?? "Installed"}; ${auth.detail}; ${adapters[id].safety}${adapters[id].verified ? "" : "; flags unverified"}`,
      });
    }
    return { ok: checks.every((check) => check.status !== "error"), checks };
  }

  private async pollProject(projectId: string): Promise<void> {
    if (this.pollingProjects.has(projectId) || this.state.state !== "running") return;
    const project = this.project(projectId);
    this.pollingProjects.add(projectId);
    let queued = 0;
    try {
      for (const ticket of await this.notion.queryTrigger(project)) {
        const record = this.newRecord(project.id, project.key, ticket.pageId);
        record.ticketRef = ticket.ref;
        record.ticketName = ticket.name;
        if (this.enqueue(record, false)) queued++;
      }
      this.emit({
        event: "project.pollCompleted",
        payload: { projectId: project.id, queued, at: new Date().toISOString() },
      });
    } catch (error) {
      this.emit({
        event: "project.pollCompleted",
        payload: {
          projectId: project.id,
          queued,
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
      });
    } finally {
      this.pollingProjects.delete(projectId);
    }
  }

  private enqueue(record: RunRecord, force: boolean): boolean {
    // Never open a second thread for a ticket that already has a live session.
    if (this.hasThreadForPage(record.pageId)) return false;
    const queued = this.pool.enqueue(record.pageId, {
      record,
      projectId: record.projectId,
      force,
    });
    if (queued) {
      this.state.queueLength = this.pool.length;
      this.emit({ event: "run.queued", payload: record });
      this.emitState();
    }
    return queued;
  }

  private async execute(job: EngineJob): Promise<void> {
    const project = this.project(job.projectId);
    const record = job.record;
    record.startedAt = new Date().toISOString();
    record.message = "Run started";
    const controller = new AbortController();
    this.activeControllers.set(record.runId, controller);
    this.state.activeRuns = [...this.state.activeRuns, record];
    this.state.activeRun = this.state.activeRuns[0] ?? null;
    this.state.queueLength = this.pool.length;
    this.emit({ event: "run.started", payload: { ...record } });
    this.emitState();
    try {
      // Prepare the worktree (the per-repo serialized critical section), then
      // hand off to a streaming session. The pool slot is held only until the
      // autonomous first turn settles (committed → Done), not for the thread's life.
      const prepared = await this.runner.prepareThread({
        record,
        project,
        force: job.force,
        signal: controller.signal,
      });
      const threadId = this.sessions.start({
        threadId: record.runId,
        ticketRef: prepared.ticket.ref,
        ticketName: prepared.ticket.name,
        projectId: project.id,
        projectKey: project.key,
        pageId: record.pageId,
        worktreePath: prepared.worktree,
        branch: prepared.branch,
        baseBranch: project.baseBranch,
        prompt: prepared.prompt,
        allowedTools: prepared.allowedTools,
        attended: job.force,
        model: project.model,
        agentTeam: project.agentTeam,
        tiers: project.tiers,
      });
      this.threadContexts.set(threadId, {
        project,
        ticket: prepared.ticket,
        pageId: record.pageId,
        worktree: prepared.worktree,
        branch: prepared.branch,
        baseBranch: project.baseBranch,
      });
      record.stage = "running_agent";
      record.message = "Live thread running";
      this.options.emit({ event: "run.stageChanged", payload: { ...record } });
      await this.sessions.whenSettled(threadId);
      this.finish(record, "completed", "Committed; awaiting review in thread", "run.completed");
    } catch (error) {
      if (error instanceof CancelledError) {
        this.finish(record, "cancelled", "Run cancelled", "run.cancelled");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.notion
          .setStatus(record.pageId, project, project.blockedStatus)
          .catch(() => undefined);
        this.finish(record, "failed", message, "run.failed");
      }
    } finally {
      this.activeControllers.delete(record.runId);
      this.state.activeRuns = this.state.activeRuns.filter((run) => run.runId !== record.runId);
      this.state.activeRun = this.state.activeRuns[0] ?? null;
      this.state.queueLength = this.pool.length;
      this.emitState();
    }
  }

  private finish(
    record: RunRecord,
    stage: "completed" | "failed" | "cancelled",
    message: string,
    event: "run.completed" | "run.failed" | "run.cancelled",
  ): void {
    record.stage = stage;
    record.message = message;
    record.finishedAt = new Date().toISOString();
    this.history.append(record);
    this.state.recentRuns = [structuredClone(record), ...this.state.recentRuns].slice(0, 100);
    this.emit({ event, payload: structuredClone(record) });
  }

  private newRecord(projectId: string, projectKey: string, pageId: string): RunRecord {
    return {
      runId: crypto.randomUUID(),
      projectId,
      projectKey,
      pageId,
      stage: "queued",
      message: "Waiting to run",
    };
  }

  private project(id: string) {
    const project = this.config.projects.find((candidate) => candidate.id === id || candidate.key === id);
    if (!project) throw new Error(`Unknown automation project "${id}"`);
    return project;
  }

  private emit(event: EngineEvent): void {
    this.options.emit(event);
  }

  private emitState(): void {
    this.emit({ event: "engine.stateChanged", payload: this.status() });
  }
}
