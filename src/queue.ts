import { log, errorMessage } from './log.js';

/**
 * Serial work queue. Immich's webhook action expects a prompt response, and
 * transcoding a 4K clip takes minutes, so the handler enqueues and returns
 * immediately. Deduplicating by key stops a retried webhook from grading the
 * same asset twice.
 */
export class Queue {
  private readonly pending: { key: string; task: () => Promise<void> }[] = [];
  private readonly known = new Set<string>();
  private active = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly concurrency: number) {}

  get size(): number {
    return this.pending.length + this.active;
  }

  /** Returns false when the key is already queued or running. */
  add(key: string, task: () => Promise<void>): boolean {
    if (this.known.has(key)) {
      log.debug('already queued, ignoring', { key });
      return false;
    }
    this.known.add(key);
    this.pending.push({ key, task });
    queueMicrotask(() => this.drain());
    return true;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;
      this.active++;
      void item
        .task()
        .catch((error) => log.error('job failed', { key: item.key, error: errorMessage(error) }))
        .finally(() => {
          this.active--;
          this.known.delete(item.key);
          if (this.size === 0) {
            for (const waiter of this.idleWaiters.splice(0)) waiter();
          }
          this.drain();
        });
    }
  }

  /** Resolves once nothing is queued or running. */
  async onIdle(): Promise<void> {
    if (this.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
