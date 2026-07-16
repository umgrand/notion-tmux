export interface QueueJob<T> {
  key: string;
  value: T;
}

export class SerialQueue<T> {
  private readonly queuedKeys = new Set<string>();
  private readonly pending: QueueJob<T>[] = [];
  private draining = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly handler: (job: T) => Promise<void>) {}

  get length(): number {
    return this.pending.length;
  }

  enqueue(key: string, value: T): boolean {
    if (this.queuedKeys.has(key)) return false;
    this.queuedKeys.add(key);
    this.pending.push({ key, value });
    void this.drain();
    return true;
  }

  clear(): void {
    for (const job of this.pending) this.queuedKeys.delete(job.key);
    this.pending.splice(0);
    this.resolveIdleIfNeeded();
  }

  whenIdle(): Promise<void> {
    if (!this.draining && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        try {
          await this.handler(job.value);
        } finally {
          this.queuedKeys.delete(job.key);
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdleIfNeeded();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.draining || this.pending.length > 0) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}

export interface RunPoolOptions<T> {
  /** Maximum jobs running at once across all groups. */
  maxConcurrent: number;
  /** Jobs sharing a group key never run concurrently (e.g. the same repo). */
  groupOf(value: T): string;
}

/**
 * Concurrent work pool with per-group mutual exclusion. Runs up to
 * `maxConcurrent` jobs at once, but never two jobs from the same group
 * simultaneously. Deduplicates by key while a key is pending or running.
 */
export class RunPool<T> {
  private readonly queuedKeys = new Set<string>();
  private readonly pending: QueueJob<T>[] = [];
  private readonly activeGroups = new Set<string>();
  private running = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly handler: (job: T) => Promise<void>,
    private readonly options: RunPoolOptions<T>,
  ) {}

  get length(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.running;
  }

  enqueue(key: string, value: T): boolean {
    if (this.queuedKeys.has(key)) return false;
    this.queuedKeys.add(key);
    this.pending.push({ key, value });
    this.schedule();
    return true;
  }

  clear(): void {
    for (const job of this.pending) this.queuedKeys.delete(job.key);
    this.pending.splice(0);
    this.resolveIdleIfNeeded();
  }

  whenIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private schedule(): void {
    while (this.running < this.options.maxConcurrent) {
      // Pick the first pending job whose group is free; skip blocked groups.
      const index = this.pending.findIndex(
        (job) => !this.activeGroups.has(this.options.groupOf(job.value)),
      );
      if (index === -1) break;
      const [job] = this.pending.splice(index, 1);
      const group = this.options.groupOf(job.value);
      this.activeGroups.add(group);
      this.running += 1;
      void this.execute(job, group);
    }
  }

  private async execute(job: QueueJob<T>, group: string): Promise<void> {
    try {
      await this.handler(job.value);
    } finally {
      this.queuedKeys.delete(job.key);
      this.activeGroups.delete(group);
      this.running -= 1;
      this.schedule();
      this.resolveIdleIfNeeded();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.running > 0 || this.pending.length > 0) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}
