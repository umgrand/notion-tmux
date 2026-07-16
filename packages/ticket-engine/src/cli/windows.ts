import type { EngineEvent, RunRecord } from "@notion-tmux/shared";

export type WindowAction =
  | { kind: "open"; runId: string; name: string; logPath: string }
  | { kind: "status"; text: string };

/**
 * Pure translation of engine events into terminal-side actions: at most one
 * tmux window per run (keyed by runId, gated on a log file existing), plus
 * human-readable status lines for pickup and terminal outcomes. No side
 * effects, so it is exhaustively unit-testable.
 */
export class WindowTracker {
  private readonly opened = new Set<string>();

  onEvent(event: EngineEvent): WindowAction[] {
    switch (event.event) {
      case "run.started":
      case "run.stageChanged": {
        const r = event.payload;
        if (!r.logPath || this.opened.has(r.runId)) return [];
        this.opened.add(r.runId);
        const name = nameOf(r);
        return [
          { kind: "open", runId: r.runId, name, logPath: r.logPath },
          { kind: "status", text: `picked up ${name} → window opened` },
        ];
      }
      case "run.completed":
        return [{ kind: "status", text: outcome("done", event.payload) }];
      case "run.failed":
        return [{ kind: "status", text: outcome("failed", event.payload) }];
      case "run.cancelled":
        return [{ kind: "status", text: outcome("cancelled", event.payload) }];
      default:
        return [];
    }
  }
}

function nameOf(r: RunRecord): string {
  return r.ticketRef ?? r.projectKey;
}

function outcome(word: string, r: RunRecord): string {
  return `${word} ${nameOf(r)}${r.prUrl ? ` → ${r.prUrl}` : ""}`;
}
