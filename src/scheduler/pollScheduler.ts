export interface ScheduledTask {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /** fraction of intervalMs added as random jitter (default 0.1) */
  jitterRatio?: number;
  /** per-run timeout; a hung poll must release the queue (default 60s) */
  timeoutMs?: number;
}

interface TaskState extends Required<Pick<ScheduledTask, 'name' | 'intervalMs' | 'run'>> {
  jitterRatio: number;
  timeoutMs: number;
  dueAt: number;
}

/**
 * Unified serialized scheduler for exchange-facing polls: one task runs at a
 * time, recurring due times carry jitter, any 429 applies a global backoff,
 * and a hung task times out rather than wedging the queue.
 */
export class PollScheduler {
  private tasks: TaskState[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private backoffUntil = 0;
  private onError: (task: string, err: unknown) => void;
  private isRateLimited: (err: unknown) => boolean;
  private onRateLimit: (task: string) => void;
  private backoffMs: number;

  constructor(args: {
    onError?: (task: string, err: unknown) => void;
    isRateLimited?: (err: unknown) => boolean;
    onRateLimit?: (task: string) => void;
    backoffMs?: number;
    tickMs?: number;
  } = {}) {
    this.onError = args.onError ?? (() => {});
    this.isRateLimited = args.isRateLimited ?? (() => false);
    this.onRateLimit = args.onRateLimit ?? (() => {});
    this.backoffMs = args.backoffMs ?? 60_000;
    this.timer = setInterval(() => void this.tick(), args.tickMs ?? 250);
    this.timer.unref?.();
  }

  register(task: ScheduledTask): void {
    this.tasks.push({
      name: task.name,
      intervalMs: task.intervalMs,
      run: task.run,
      jitterRatio: task.jitterRatio ?? 0.1,
      timeoutMs: task.timeoutMs ?? 60_000,
      dueAt: Date.now(), // first run as soon as the queue frees up
    });
  }

  /** Force a task due now (e.g. refresh command). */
  requestNow(name: string): void {
    for (const task of this.tasks) if (task.name === name) task.dueAt = Date.now();
  }

  applyBackoff(ms = this.backoffMs): void {
    this.backoffUntil = Math.max(this.backoffUntil, Date.now() + ms);
  }

  get backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    const now = Date.now();
    if (now < this.backoffUntil) return;
    const due = this.tasks.filter(t => t.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!due) return;

    this.running = true;
    try {
      await withTimeout(due.run(), due.timeoutMs, due.name);
    } catch (err) {
      if (this.isRateLimited(err)) {
        this.applyBackoff();
        this.onRateLimit(due.name);
      } else {
        this.onError(due.name, err);
      }
    } finally {
      const jitter = due.intervalMs * due.jitterRatio * Math.random();
      due.dueAt = Date.now() + due.intervalMs + jitter;
      this.running = false;
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`poll task ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      err => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    );
  });
}
