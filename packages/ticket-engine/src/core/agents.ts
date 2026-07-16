import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId, AgentSafety } from "@notion-tmux/shared";

const execFileAsync = promisify(execFile);

export interface DetectResult {
  found: boolean;
  bin?: string;
  version?: string;
  authenticated?: boolean;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  bins: string[];
  safety: AgentSafety;
  verified: boolean;
  scrubEnv: string[];
  buildArgs(prompt: string, opts: { allowlist?: string[]; model?: string }): string[];
  checkAuth(): Promise<boolean>;
}

const has = (...parts: string[]) => fs.existsSync(path.join(os.homedir(), ...parts));
const hasEnv = (...keys: string[]) => keys.some((key) => Boolean(process.env[key]?.trim()));

async function keychainHas(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("security", ["find-generic-password", "-s", service], { timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    bins: ["claude"],
    safety: "allowlist",
    verified: true,
    scrubEnv: [
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_SCOPES",
      "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
      "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_EXECPATH",
    ],
    buildArgs: (prompt, { allowlist, model }) => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      ...(model ? ["--model", model] : []),
      ...(allowlist?.length ? ["--allowedTools", allowlist.join(",")] : []),
    ],
    checkAuth: async () =>
      has(".claude", ".credentials.json") ||
      hasEnv("ANTHROPIC_API_KEY") ||
      (await keychainHas("Claude Code-credentials")),
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    bins: ["codex"],
    safety: "auto-approve",
    verified: false,
    scrubEnv: [],
    buildArgs: (prompt, { model }) => [
      "exec",
      "--full-auto",
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    checkAuth: async () => has(".codex", "auth.json") || hasEnv("OPENAI_API_KEY"),
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini CLI",
    bins: ["gemini"],
    safety: "yolo",
    verified: false,
    scrubEnv: [],
    buildArgs: (prompt) => ["-p", prompt, "--yolo"],
    checkAuth: async () => has(".gemini") || hasEnv("GEMINI_API_KEY", "GOOGLE_API_KEY"),
  },
  aider: {
    id: "aider",
    displayName: "Aider",
    bins: ["aider"],
    safety: "auto-approve",
    verified: false,
    scrubEnv: [],
    buildArgs: (prompt) => ["--message", prompt, "--yes", "--no-stream"],
    checkAuth: async () => hasEnv("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY"),
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor CLI",
    bins: ["cursor-agent"],
    safety: "auto-approve",
    verified: false,
    scrubEnv: [],
    buildArgs: (prompt) => ["-p", prompt],
    checkAuth: async () => true,
  },
};

export interface AuthVerification {
  ok: boolean;
  detail: string;
}

/**
 * Actually exercise the agent's credentials with a tiny headless prompt, using
 * the same scrubbed environment a real run uses. This is the only honest way to
 * know auth works — a keychain entry can exist while the credential is unusable
 * headless (e.g. a per-session gateway token), which `checkAuth` can't detect.
 */
export function verifyAgentAuth(
  id: AgentId,
  bin: string,
  timeoutMs = 30_000,
): Promise<AuthVerification> {
  const adapter = adapters[id];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NOTION_TOKEN;
  for (const key of adapter.scrubEnv) delete env[key];
  const args = adapter.buildArgs("Reply with exactly: OK", { allowlist: [] });

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: AuthVerification) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, detail: `auth check timed out after ${timeoutMs / 1_000}s` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, detail: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const tail = output.trim().split("\n").slice(-3).join(" ").slice(-200);
      if (code === 0) {
        finish({ ok: true, detail: "live auth check passed" });
      } else if (/401|unauthor|authenticate|not logged in|invalid.*credential/i.test(output)) {
        finish({ ok: false, detail: `auth failed: ${tail || "401"}` });
      } else {
        finish({ ok: false, detail: `exited ${code ?? "?"}: ${tail || "no output"}` });
      }
    });
  });
}

export async function detectAgent(id: AgentId): Promise<DetectResult> {
  const adapter = adapters[id];
  for (const bin of adapter.bins) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["--version"], { timeout: 5_000 });
      return {
        found: true,
        bin,
        version: `${stdout}${stderr}`.trim().split("\n")[0],
        authenticated: await adapter.checkAuth(),
      };
    } catch {
      // Continue through candidate binaries.
    }
  }
  return { found: false, authenticated: false };
}
