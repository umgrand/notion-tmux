import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { AutomationProject, FlintAutomationConfig } from "@notion-tmux/shared";
import { parseAutomationConfig } from "@notion-tmux/shared";

interface LegacyLoad {
  config: FlintAutomationConfig;
  notionToken: string;
  dataDir: string;
}

export function loadLegacyConfig(root = process.cwd()): LegacyLoad {
  const envPath = path.join(root, ".env");
  const projectsPath = path.join(root, "projects.json");
  if (!fs.existsSync(envPath)) throw new Error(`Missing ${envPath}`);
  if (!fs.existsSync(projectsPath)) throw new Error(`Missing ${projectsPath}`);
  const env = dotenv.parse(fs.readFileSync(envPath));
  const parsed = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
  const projects = (parsed.projects ?? parsed).map((raw: any): AutomationProject => ({
    id: raw.key,
    key: raw.key,
    databaseId: raw.databaseId,
    dataSourceId: raw.dataSourceId,
    repoRoot: raw.repoRoot,
    baseBranch: raw.baseBranch ?? "main",
    branchPrefix: raw.branchPrefix ?? "bot",
    statusProperty: raw.statusProperty ?? "Status",
    triggerStatus: raw.trigger ?? "Ready for Dev",
    workingStatus: raw.working ?? "In Progress",
    reviewStatus: raw.review ?? "In Review",
    blockedStatus: raw.blocked ?? "Blocked",
    prProperty: raw.prProperty ?? "PR",
    ticketIdProperty: raw.ticketIdProperty ?? "Ticket ID",
    verifyCommands: raw.verify ?? [],
    allowedBash: raw.allowedBash ?? [],
    pollIntervalSec: raw.pollIntervalSec ?? Number(env.POLL_INTERVAL_SEC || 30),
    timeoutMin: raw.timeoutMin,
    agent: raw.agent,
    agentTeam: raw.agentTeam ?? false,
  }));
  return {
    config: parseAutomationConfig({
      version: 1,
      enabled: true,
      pollIntervalSec: Number(env.POLL_INTERVAL_SEC || 30),
      defaultAgent: env.DEFAULT_AGENT || "claude",
      defaultTimeoutMin: Number(env.AGENT_TIMEOUT_MIN || 20),
      projects,
    }),
    notionToken: env.NOTION_TOKEN ?? "",
    dataDir: path.join(root, ".notion-tmux-engine"),
  };
}
