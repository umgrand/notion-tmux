import fs from "node:fs";
import path from "node:path";
import type { ThreadSummary, ThreadTombstone } from "@notion-tmux/shared";

/** Everything we persist for a live thread so the sidebar repopulates on launch. */
export interface PersistedThread extends ThreadSummary {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

interface ThreadIndexFile {
  version: 1;
  live: PersistedThread[];
  tombstones: ThreadTombstone[];
}

/**
 * The notion-tmux thread index, stored next to automation.json. Holds live thread
 * pointers + archived tombstones — never a transcript (those live in the SDK
 * session and are rendered on demand).
 */
export class ThreadStore {
  private readonly file: string;
  private data: ThreadIndexFile;

  constructor(automationDir: string) {
    this.file = path.join(automationDir, "threads.json");
    this.data = this.read();
  }

  private read(): ThreadIndexFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && raw.version === 1) {
        return {
          version: 1,
          live: Array.isArray(raw.live) ? raw.live : [],
          tombstones: Array.isArray(raw.tombstones) ? raw.tombstones : [],
        };
      }
    } catch {
      // missing or corrupt — start fresh
    }
    return { version: 1, live: [], tombstones: [] };
  }

  private write(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  liveThreads(): PersistedThread[] {
    return this.data.live;
  }

  tombstones(): ThreadTombstone[] {
    return this.data.tombstones;
  }

  upsert(thread: PersistedThread): void {
    const index = this.data.live.findIndex((t) => t.threadId === thread.threadId);
    if (index >= 0) this.data.live[index] = thread;
    else this.data.live.push(thread);
    this.write();
  }

  remove(threadId: string, tombstone?: ThreadTombstone): void {
    this.data.live = this.data.live.filter((t) => t.threadId !== threadId);
    if (tombstone) this.data.tombstones.unshift(tombstone);
    this.data.tombstones = this.data.tombstones.slice(0, 200);
    this.write();
  }
}
