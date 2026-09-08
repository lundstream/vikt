/**
 * A queueing rate limiter for outbound calls.
 *
 * Open Food Facts allows 15 requests a minute for product reads and 10 a minute
 * for search, **per IP**. Every call leaves this server from one address, so
 * that budget is shared across every user of the instance — it is not a per-user
 * allowance, and a limiter keyed on the user would not enforce it.
 *
 * It **queues rather than bursts**: a caller waits its turn instead of being
 * rejected, because the alternative is a scanner in a shop that fails when two
 * people happen to log lunch at once. Beyond `maxQueueMs` it gives up so a
 * request cannot hang forever, and the caller degrades to cache-only.
 *
 * Deliberately in-process. There is one API container (D12); a shared limiter
 * across replicas would need Redis, and there are no replicas.
 */

export type RateLimiterOptions = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in ms. Defaults to a minute. */
  windowMs?: number;
  /** How long a caller will wait for a slot before giving up. */
  maxQueueMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export class RateLimitExceeded extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Rate limit reached; a slot opens in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimitExceeded";
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxQueueMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of calls still inside the window, oldest first. */
  private recent: number[] = [];
  /** Serialises waiters so they take slots in order rather than racing. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxQueueMs = options.maxQueueMs ?? 8_000;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Slots free right now. Lets a caller choose cache-only without queueing. */
  available(): number {
    this.forget();
    return Math.max(0, this.limit - this.recent.length);
  }

  /** Milliseconds until the next slot, or 0 if one is free. */
  msUntilSlot(): number {
    this.forget();
    if (this.recent.length < this.limit) return 0;
    const oldest = this.recent[0]!;
    return Math.max(0, oldest + this.windowMs - this.now());
  }

  /**
   * Runs `task` when a slot is free.
   *
   * Waiters are serialised through `tail`, so three callers arriving together
   * take the next three slots in arrival order rather than all waking at once
   * and firing four requests into a limit of one.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const mine = this.tail.then(() => this.acquire());
    // Swallow here so one caller's failure does not poison the chain.
    this.tail = mine.then(
      () => undefined,
      () => undefined,
    );
    await mine;
    return task();
  }

  private async acquire(): Promise<void> {
    const deadline = this.now() + this.maxQueueMs;

    for (;;) {
      const wait = this.msUntilSlot();
      if (wait === 0) {
        this.recent.push(this.now());
        return;
      }
      if (this.now() + wait > deadline) throw new RateLimitExceeded(wait);
      // A few ms of slack so the slot has genuinely expired on wake.
      await this.sleep(wait + 5);
    }
  }

  private forget(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.recent.length > 0 && this.recent[0]! <= cutoff) this.recent.shift();
  }
}
