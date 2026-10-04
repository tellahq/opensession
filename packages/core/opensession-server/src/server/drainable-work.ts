/** Tracks scheduled and in-flight work without changing a queue's scheduling.
 * Constructing a tracker has no live effects. drain() observes quiescence,
 * not a snapshot of the queue length; work added while draining is included.
 */
export class DrainableWork {
  private outstanding = 0;
  private waiters = new Set<() => void>();

  private finish(): void {
    if (--this.outstanding !== 0) return;
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiters) resolve();
  }

  /** Run now, retaining synchronous return/throw behavior. */
  run<T>(process: () => T): T {
    this.outstanding++;
    try {
      const result = process();
      if (result instanceof Promise) {
        return result.finally(() => this.finish()) as T;
      }
      this.finish();
      return result;
    } catch (error) {
      this.finish();
      throw error;
    }
  }

  /** Keep the existing one-microtask-per-item delivery order. */
  schedule(process: () => void | Promise<void>): void {
    this.outstanding++;
    queueMicrotask(() => {
      try {
        void this.run(process);
      } finally {
        this.finish();
      }
    });
  }

  /** Resolves only when both scheduled callbacks and in-flight promises end.
   * Producers must be stopped or awaited before drain to exclude future work.
   * Errors remain owned by the caller, not silently swallowed by drain.
   */
  drain(): Promise<void> {
    if (this.outstanding === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}
