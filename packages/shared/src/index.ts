import { z } from "zod";

export const agentIds = ["claude", "codex", "gemini", "aider", "cursor"] as const;
export type AgentId = (typeof agentIds)[number];
export type AgentSafety = "allowlist" | "auto-approve" | "yolo";

export const modelTiersSchema = z.object({
  strategist: z.string().nullish().transform((value) => value ?? undefined),
  orchestrator: z.string().nullish().transform((value) => value ?? undefined),
  developer: z.string().nullish().transform((value) => value ?? undefined),
  checker: z.string().nullish().transform((value) => value ?? undefined),
});

export type ModelTiers = z.infer<typeof modelTiersSchema>;

/** A model choice offered by the UI, sourced from the SDK's supportedModels(). */
export interface ModelOption {
  value: string;
  displayName: string;
}

export const automationProjectSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  databaseId: z.string().min(1),
  dataSourceId: z.string().min(1).nullish().transform((value) => value ?? undefined),
  repoRoot: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  branchPrefix: z.string().min(1).default("bot"),
  statusProperty: z.string().min(1).default("Status"),
  triggerStatus: z.string().min(1).default("Ready for Dev"),
  workingStatus: z.string().min(1).default("In Progress"),
  reviewStatus: z.string().min(1).default("In Review"),
  blockedStatus: z.string().min(1).default("Blocked"),
  prProperty: z.string().min(1).default("PR"),
  ticketIdProperty: z.string().min(1).default("Ticket ID"),
  verifyCommands: z.array(z.string()).default([]),
  allowedBash: z.array(z.string()).default([]),
  pollIntervalSec: z.number().int().min(10).default(30),
  timeoutMin: z.number().positive().nullish().transform((value) => value ?? undefined),
  agent: z.enum(agentIds).nullish().transform((value) => value ?? undefined),
  // Base model for development work (Claude sessions; other agent CLIs ignore it).
  model: z.string().nullish().transform((value) => value ?? undefined),
  // Orchestrator may delegate to a strategist/developer/checker subagent team.
  agentTeam: z.boolean().default(false),
  // Optional per-role model overrides; each defaults to the base model.
  tiers: modelTiersSchema.nullish().transform((value) => value ?? undefined),
});

export type AutomationProject = z.infer<typeof automationProjectSchema>;

export const automationConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  pollIntervalSec: z.number().int().min(10).default(30),
  defaultAgent: z.enum(agentIds).default("claude"),
  defaultTimeoutMin: z.number().positive().default(20),
  // How many tickets may run concurrently across all projects. Runs are still
  // serialized per repository, so this is the cap on distinct repos in flight.
  maxConcurrentRuns: z.number().int().min(1).max(8).default(3),
  // Cap on live ticket threads (streaming SDK sessions) running at once,
  // global across all projects. Different per-ticket worktrees run in parallel;
  // only the git fetch + worktree add critical section serializes per repo.
  maxConcurrency: z.number().int().min(1).max(50).default(10),
  projects: z.array(automationProjectSchema).default([]),
  legacyImport: z
    .object({
      completedAt: z.string(),
      sourcePath: z.string(),
    })
    .optional(),
});

export type FlintAutomationConfig = z.infer<typeof automationConfigSchema>;

export const defaultAutomationConfig = (): FlintAutomationConfig => ({
  version: 1,
  enabled: false,
  pollIntervalSec: 30,
  defaultAgent: "claude",
  defaultTimeoutMin: 20,
  maxConcurrentRuns: 3,
  maxConcurrency: 10,
  projects: [],
});

export type EngineState = "uninitialized" | "stopped" | "running" | "stopping" | "error";
export type RunStage =
  | "queued"
  | "claiming"
  | "preparing_worktree"
  | "running_agent"
  | "verifying"
  | "pushing"
  | "creating_pr"
  | "updating_notion"
  | "cleaning_up"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunRecord {
  runId: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  ticketRef?: string;
  ticketName?: string;
  stage: RunStage;
  startedAt?: string;
  finishedAt?: string;
  message: string;
  prUrl?: string;
  logPath?: string;
}

// ---------------------------------------------------------------------------
// Live ticket threads (interactive streaming SDK sessions; Figma node 4-36)
// ---------------------------------------------------------------------------

export type ThreadState =
  | "pending" // waiting for a concurrency slot
  | "running" // SDK turn active, streaming
  | "awaiting" // turn done, ready for input
  | "stopped" // user hit Stop (interrupt); resumable
  | "done" // committed on bot/<ref>, awaiting review in-thread
  | "failed"; // error; resumable

/** A single rendered row in a thread: a chat message or a collapsible tool activity. */
export type ThreadItem =
  | { id: string; threadId: string; kind: "message"; role: "assistant" | "user"; text: string; at: string; pending?: boolean }
  | { id: string; threadId: string; kind: "activity"; tool: string; detail: string; at: string };

export interface ThreadSummary {
  threadId: string;
  ticketRef: string;
  ticketName: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  sessionId?: string;
  state: ThreadState;
  prUrl?: string;
  /** Per-thread permission bypass (Claude's YOLO). Sticky, red marker in UI. */
  bypass: boolean;
  /** Total tokens consumed by the session so far. */
  tokens: number;
  /** Set while a turn is paused waiting for an unattended permission grant. */
  pausedReason?: string;
  startedAt?: string;
  updatedAt?: string;
}

/** A finished thread, kept only as a history pointer (no transcript). */
export interface ThreadTombstone {
  ticketRef: string;
  projectKey: string;
  prUrl?: string;
  outcome: "merged" | "archived" | "abandoned";
  at: string;
}

/** An attended permission request surfaced to the open thread (Allow / Deny). */
export interface ThreadPermissionRequest {
  threadId: string;
  toolUseId: string;
  tool: string;
  title: string;
  input: Record<string, unknown>;
}

export interface EngineSnapshot {
  state: EngineState;
  initialized: boolean;
  polling: boolean;
  queueLength: number;
  /** All runs currently executing (one per repo, up to maxConcurrentRuns). */
  activeRuns: RunRecord[];
  /** First of activeRuns, kept for convenience / backward compatibility. */
  activeRun: RunRecord | null;
  recentRuns: RunRecord[];
  lastError?: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export type EngineEvent =
  | { event: "engine.stateChanged"; payload: EngineSnapshot }
  | {
      event: "project.pollCompleted";
      payload: { projectId: string; queued: number; at: string; error?: string };
    }
  | {
      event:
        | "run.queued"
        | "run.started"
        | "run.stageChanged"
        | "run.completed"
        | "run.failed"
        | "run.cancelled";
      payload: RunRecord;
    }
  | { event: "run.log"; payload: { runId: string; at: string; message: string } }
  | { event: "thread.created" | "thread.updated"; payload: ThreadSummary }
  | { event: "thread.item"; payload: ThreadItem }
  | { event: "thread.permission"; payload: ThreadPermissionRequest }
  | {
      event: "thread.permissionResolved";
      payload: { threadId: string; toolUseId: string };
    }
  | { event: "thread.removed"; payload: { threadId: string; tombstone?: ThreadTombstone } };

export interface ProtocolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ProtocolRequest {
  id: string;
  type: "request";
  method:
    | "initialize"
    | "start"
    | "stop"
    | "status"
    | "doctor"
    | "runOnce"
    | "cancelRun"
    | "listDatabases"
    | "inspectDatabase"
    | "inspectRepository"
    | "listModels"
    | "readRunLog"
    | "thread.send"
    | "thread.stop"
    | "thread.createPr"
    | "thread.archive"
    | "thread.list"
    | "thread.getMessages"
    | "thread.setBypass"
    | "thread.resolvePermission";
  params?: Record<string, unknown>;
}

export interface ProtocolResponse {
  id: string;
  type: "response";
  result?: unknown;
  error?: ProtocolError;
}

export interface ProtocolEvent {
  type: "event";
  event: EngineEvent["event"];
  payload: EngineEvent["payload"];
}

export type ProtocolMessage = ProtocolRequest | ProtocolResponse | ProtocolEvent;

export interface LegacyImportPreview {
  sourcePath: string;
  config: FlintAutomationConfig;
  hasNotionToken: boolean;
  warnings: string[];
}

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  url?: string;
}

export interface NotionPropertySummary {
  name: string;
  type: string;
  options: string[];
}

export interface NotionDatabaseInspection extends NotionDatabaseSummary {
  properties: NotionPropertySummary[];
}

export interface RepositoryInspection {
  baseBranch: string;
  verifyCommands: string[];
  packageManager?: string;
}

export function parseAutomationConfig(input: unknown): FlintAutomationConfig {
  return automationConfigSchema.parse(input);
}
