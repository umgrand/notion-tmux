import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentId, AutomationProject, RunRecord, RunStage } from "@notion-tmux/shared";
import { adapters, detectAgent } from "./agents.js";
import { NotionGateway, type Ticket } from "./notion.js";

export class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "CancelledError";
  }
}

interface RunnerOptions {
  dataDir: string;
  defaultAgent: AgentId;
  defaultTimeoutMin: number;
  notion: NotionGateway;
  onStage(record: RunRecord): void;
  onLog(runId: string, message: string): void;
}

interface RunRequest {
  record: RunRecord;
  project: AutomationProject;
  force: boolean;
  signal: AbortSignal;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execText(
  file: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        env: options.env,
        maxBuffer: 1 << 24,
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function execTail(error: unknown): string {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(error)).trim().slice(-500);
}

function branchFor(project: AutomationProject, ref: string): string {
  const slug = ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${project.branchPrefix}/${slug}`;
}

/** The tools the live-thread SDK session auto-approves without a permission prompt. */
const STANDARD_ALLOWLIST = [
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
];

/** Result of preparing a ticket worktree for a live thread (no agent run yet). */
export interface PreparedThread {
  ticket: Ticket;
  branch: string;
  worktree: string;
  prompt: string;
  allowedTools: string[];
}

function buildPrompt(project: AutomationProject, ticket: Ticket, body: string): string {
  const verifyLine = project.verifyCommands.length
    ? `- Run ${project.verifyCommands.map((command) => `\`${command}\``).join(" and ")} and fix anything you broke.`
    : "";
  return [
    `You are an autonomous developer working ticket ${ticket.ref} in the ${project.key} repo.`,
    "",
    `Title: ${ticket.name}`,
    ticket.type ? `Type: ${ticket.type}` : "",
    ticket.priority ? `Priority: ${ticket.priority}` : "",
    ticket.area.length ? `Area: ${ticket.area.join(", ")}` : "",
    ticket.summary ? `Summary: ${ticket.summary}` : "",
    "",
    body ? `Ticket details:\n${body}` : "",
    "",
    "Instructions:",
    "- Read CLAUDE.md / AGENTS.md if present and follow all repo conventions.",
    "- Implement this ticket fully on the current branch.",
    "- Keep the change scoped to the ticket. Do not touch unrelated files.",
    verifyLine,
    "- Commit your work with a clear message. Do not add a Co-Authored-By trailer.",
    "- Do not push, open a PR, or switch branches. The harness does that.",
  ]
    .filter(Boolean)
    .join("\n");
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

export class TicketRunner {
  private readonly locksDir: string;
  private readonly logsDir: string;
  private readonly worktreesDir: string;

  constructor(private readonly options: RunnerOptions) {
    this.locksDir = path.join(options.dataDir, "locks");
    this.logsDir = path.join(options.dataDir, "logs");
    this.worktreesDir = path.join(options.dataDir, "worktrees");
    for (const directory of [this.locksDir, this.logsDir, this.worktreesDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  async run(request: RunRequest): Promise<RunRecord> {
    const { record, project, force, signal } = request;
    const lock = this.acquireLock(record.pageId, project);
    if (!lock) throw new Error("Ticket is already locked by another run");

    let ticket: Ticket | null = null;
    let claimed = false;
    let worktree: string | null = null;
    let logPath: string | undefined;
    let branch = "";

    try {
      this.stage(record, "claiming", "Reading ticket and checking status");
      ticket = await this.options.notion.getTicket(record.pageId, project);
      record.ticketRef = ticket.ref;
      record.ticketName = ticket.name;
      if (ticket.status !== project.triggerStatus && !force) {
        throw new Error(`Ticket status "${ticket.status}" does not match "${project.triggerStatus}"`);
      }

      const agentId = project.agent ?? this.options.defaultAgent;
      const adapter = adapters[agentId];
      const detected = await detectAgent(agentId);
      if (!detected.found || !detected.bin) {
        throw new Error(`${adapter.displayName} is not installed or not available on PATH`);
      }

      await this.options.notion.setStatus(record.pageId, project, project.workingStatus);
      claimed = true;
      assertNotCancelled(signal);

      branch = branchFor(project, ticket.ref);
      const safeBranch = branch.replace(/\//g, "-");
      worktree = path.join(this.worktreesDir, project.key, safeBranch);
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      logPath = path.join(this.logsDir, `${project.key}-${safeBranch}-${Date.now()}.log`);
      record.logPath = path.relative(this.options.dataDir, logPath);

      this.stage(record, "preparing_worktree", `Creating ${branch}`);
      await this.git(["fetch", "origin", project.baseBranch], project.repoRoot, signal);
      await this.removeWorktree(project.repoRoot, worktree, signal);
      await this.removeLocalBranch(project, branch, signal);
      await this.git(
        ["worktree", "add", "-b", branch, worktree, `origin/${project.baseBranch}`],
        project.repoRoot,
        signal,
      );

      const body = await this.options.notion.getTicketBody(record.pageId);
      this.stage(record, "running_agent", `Running ${adapter.displayName}`);
      await this.runAgent({
        adapter,
        bin: detected.bin,
        project,
        prompt: buildPrompt(project, ticket, body),
        cwd: worktree,
        logPath,
        runId: record.runId,
        signal,
      });

      const dirty = (await this.git(["status", "--porcelain"], worktree, signal)).trim();
      if (dirty) {
        await this.git(["add", "-A"], worktree, signal);
        await this.git(["commit", "-m", `${ticket.ref}: ${ticket.name}`], worktree, signal);
      }
      const ahead = Number(
        (await this.git(["rev-list", "--count", `origin/${project.baseBranch}..HEAD`], worktree, signal)).trim(),
      );
      if (ahead === 0) throw new Error("Agent produced no commits; there is nothing to open as a PR");

      this.stage(record, "verifying", "Running verification commands");
      for (const command of project.verifyCommands) {
        const result = await execText("/bin/bash", ["-lc", command], { cwd: worktree, signal });
        fs.appendFileSync(logPath, `\n$ ${command}\n${result.stdout}${result.stderr}\n`);
      }

      this.stage(record, "pushing", `Pushing ${branch}`);
      await this.git(["push", "-u", "origin", branch], worktree, signal);

      this.stage(record, "creating_pr", "Creating draft pull request");
      const prBody =
        `Automated implementation of Notion ticket **${ticket.ref} - ${ticket.name}**.\n\n` +
        (ticket.summary ? `${ticket.summary}\n\n` : "") +
        "Opened as a draft by notion-tmux. Review before merging.";
      const pr = await execText(
        "gh",
        [
          "pr",
          "create",
          "--draft",
          "--base",
          project.baseBranch,
          "--head",
          branch,
          "--title",
          `${ticket.ref}: ${ticket.name}`,
          "--body",
          prBody,
        ],
        { cwd: worktree, signal },
      );
      record.prUrl = pr.stdout.trim();

      this.stage(record, "updating_notion", "Writing the pull request back to Notion");
      await this.options.notion.setPrUrl(record.pageId, project, record.prUrl);
      await this.options.notion.addComment(record.pageId, `Draft PR opened by notion-tmux: ${record.prUrl}`);
      await this.options.notion.setStatus(record.pageId, project, project.reviewStatus);
      return record;
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError || (error as any)?.name === "AbortError") {
        if (claimed) {
          await this.options.notion
            .addComment(record.pageId, "notion-tmux run cancelled before a pull request was opened.")
            .catch(() => undefined);
        }
        throw new CancelledError();
      }
      if (ticket && claimed) {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.notion
          .setStatus(record.pageId, project, project.blockedStatus)
          .catch(() => undefined);
        await this.options.notion
          .addComment(
            record.pageId,
            `notion-tmux pickup failed: ${message}${record.logPath ? `\nLog: ${record.logPath}` : ""}`,
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.stage(record, "cleaning_up", "Cleaning up worktree and lock");
      if (worktree) await this.removeWorktree(project.repoRoot, worktree).catch(() => undefined);
      this.releaseLock(record.pageId);
    }
  }

  // ---- Live-thread flow (interactive streaming session) -------------------
  // Splits the old one-shot run() into discrete steps the engine drives around
  // a SessionManager: prepare → (stream) → commit → (review) → createPr → archive.

  /** Claim the ticket, build its worktree on bot/<ref>, and assemble the prompt. */
  async prepareThread(request: RunRequest): Promise<PreparedThread> {
    const { record, project, force, signal } = request;
    this.stage(record, "claiming", "Reading ticket and checking status");
    const ticket = await this.options.notion.getTicket(record.pageId, project);
    record.ticketRef = ticket.ref;
    record.ticketName = ticket.name;
    if (ticket.status !== project.triggerStatus && !force) {
      throw new Error(`Ticket status "${ticket.status}" does not match "${project.triggerStatus}"`);
    }

    const agentId = project.agent ?? this.options.defaultAgent;
    const adapter = adapters[agentId];
    const detected = await detectAgent(agentId);
    if (!detected.found || !detected.bin) {
      throw new Error(`${adapter.displayName} is not installed or not available on PATH`);
    }

    await this.options.notion.setStatus(record.pageId, project, project.workingStatus);
    assertNotCancelled(signal);

    const branch = branchFor(project, ticket.ref);
    const safeBranch = branch.replace(/\//g, "-");
    const worktree = path.join(this.worktreesDir, project.key, safeBranch);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });

    this.stage(record, "preparing_worktree", `Creating ${branch}`);
    await this.git(["fetch", "origin", project.baseBranch], project.repoRoot, signal);
    await this.removeWorktree(project.repoRoot, worktree, signal);
    await this.removeLocalBranch(project, branch, signal);
    await this.git(
      ["worktree", "add", "-b", branch, worktree, `origin/${project.baseBranch}`],
      project.repoRoot,
      signal,
    );

    const body = await this.options.notion.getTicketBody(record.pageId);
    return {
      ticket,
      branch,
      worktree,
      prompt: buildPrompt(project, ticket, body),
      allowedTools: [...STANDARD_ALLOWLIST, ...project.allowedBash],
    };
  }

  /** Stage and commit whatever the session changed; report if there's anything to review. */
  async commitWork(worktree: string, baseBranch: string, ticket: Ticket): Promise<{ committed: boolean }> {
    const dirty = (await this.git(["status", "--porcelain"], worktree)).trim();
    if (dirty) {
      await this.git(["add", "-A"], worktree);
      await this.git(["commit", "-m", `${ticket.ref}: ${ticket.name}`], worktree);
    }
    const ahead = Number(
      (await this.git(["rev-list", "--count", `origin/${baseBranch}..HEAD`], worktree)).trim(),
    );
    return { committed: ahead > 0 };
  }

  /** Push the branch and open a ready (non-draft) PR. Returns its URL. */
  async openPullRequest(input: {
    project: AutomationProject;
    worktree: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<string> {
    await this.git(["push", "-u", "origin", input.branch], input.worktree);
    const pr = await execText(
      "gh",
      ["pr", "create", "--base", input.project.baseBranch, "--head", input.branch, "--title", input.title, "--body", input.body],
      { cwd: input.worktree },
    );
    return pr.stdout.trim();
  }

  /** Watch CI, then squash-merge on green. The engine — never the agent — owns this. */
  async mergeWhenGreen(input: { worktree: string; branch: string }): Promise<{ merged: boolean; detail: string }> {
    try {
      await execText("gh", ["pr", "checks", input.branch, "--watch", "--fail-fast"], { cwd: input.worktree });
    } catch (error) {
      return { merged: false, detail: `Checks failed: ${execTail(error)}` };
    }
    try {
      await execText("gh", ["pr", "merge", input.branch, "--squash", "--delete-branch"], { cwd: input.worktree });
      return { merged: true, detail: "Merged" };
    } catch (error) {
      return { merged: false, detail: `Not mergeable: ${execTail(error)}` };
    }
  }

  /** Delete the worktree and its local branch (archive cleanup). */
  async archiveThread(project: AutomationProject, worktree: string, branch: string): Promise<void> {
    await this.removeWorktree(project.repoRoot, worktree).catch(() => undefined);
    await this.removeLocalBranch(project, branch).catch(() => undefined);
  }

  private stage(record: RunRecord, stage: RunStage, message: string): void {
    record.stage = stage;
    record.message = message;
    this.options.onStage({ ...record });
  }

  private async git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    return (await execText("git", args, { cwd, signal })).stdout;
  }

  private async removeWorktree(repoRoot: string, worktree: string, signal?: AbortSignal): Promise<void> {
    if (!fs.existsSync(worktree)) return;
    await this.git(["worktree", "remove", "--force", worktree], repoRoot, signal);
  }

  private async removeLocalBranch(
    project: AutomationProject,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!branch.startsWith(`${project.branchPrefix}/`)) {
      throw new Error(`Refusing to delete branch outside prefix "${project.branchPrefix}/"`);
    }
    const exists = await this.git(["branch", "--list", branch], project.repoRoot, signal);
    if (!exists.trim()) return;
    const worktrees = await this.git(["worktree", "list", "--porcelain"], project.repoRoot, signal);
    if (worktrees.includes(`branch refs/heads/${branch}`)) {
      throw new Error(`Branch ${branch} is checked out in another worktree`);
    }
    await this.git(["branch", "-D", branch], project.repoRoot, signal);
  }

  private runAgent(input: {
    adapter: (typeof adapters)[keyof typeof adapters];
    bin: string;
    project: AutomationProject;
    prompt: string;
    cwd: string;
    logPath: string;
    runId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const allowlist = [
      "Edit",
      "Write",
      "Read",
      "Grep",
      "Glob",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      ...input.project.allowedBash,
    ];
    const env = { ...process.env };
    delete env.NOTION_TOKEN;
    for (const key of input.adapter.scrubEnv) delete env[key];
    const args = input.adapter.buildArgs(input.prompt, {
      allowlist,
      model: input.project.model,
    });
    const timeoutMs =
      (input.project.timeoutMin ?? this.options.defaultTimeoutMin) * 60_000;

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(input.logPath, { flags: "a", mode: 0o600 });
      let child: ChildProcess;
      try {
        child = spawn(input.bin, args, {
          cwd: input.cwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        output.end();
        reject(error);
        return;
      }

      const emitChunk = (chunk: Buffer) => {
        output.write(chunk);
        const message = chunk.toString("utf8").trim();
        if (message) this.options.onLog(input.runId, message.slice(-2_000));
      };
      child.stdout?.on("data", emitChunk);
      child.stderr?.on("data", emitChunk);

      const kill = () => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const onAbort = () => kill();
      input.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(kill, timeoutMs);

      child.once("error", (error) => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        output.end();
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        output.end();
        if (input.signal.aborted) reject(new CancelledError());
        else if (code === 0) resolve();
        else reject(new Error(`Agent exited with code ${code ?? "unknown"}`));
      });
    });
  }

  private acquireLock(pageId: string, project: AutomationProject): boolean {
    const lock = this.lockPath(pageId);
    try {
      fs.writeFileSync(lock, String(Date.now()), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        const timeout = (project.timeoutMin ?? this.options.defaultTimeoutMin) * 60_000;
        if (age > timeout * 2) {
          fs.rmSync(lock);
          fs.writeFileSync(lock, String(Date.now()), { flag: "wx", mode: 0o600 });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
  }

  private releaseLock(pageId: string): void {
    try {
      fs.rmSync(this.lockPath(pageId));
    } catch {
      // Already removed.
    }
  }

  private lockPath(pageId: string): string {
    return path.join(this.locksDir, `${pageId.replace(/[^a-z0-9]/gi, "")}.lock`);
  }
}

export const runnerInternals = { branchFor, buildPrompt };
