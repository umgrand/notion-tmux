import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "@notion-tmux/shared";

export class RunHistory {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "history.jsonl");
  }

  append(record: RunRecord): void {
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  load(limit = 100): RunRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunRecord];
        } catch {
          return [];
        }
      });
  }
}
