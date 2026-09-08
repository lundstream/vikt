/**
 * A counter per key, per window.
 *
 * Built for the two public unauthenticated endpoints — the password-reset
 * request and the invite request — which are the only surfaces where an
 * anonymous caller can make the server do work or send mail.
 *
 * **In memory, and that is a stated limitation rather than an oversight.** This
 * app runs as one API process behind nginx; a second instance would each keep
 * their own counters and the effective limit would double. Shared state means
 * Redis, and adding Redis to a self-hosted stack to rate-limit two endpoints is
 * a worse trade than the doubling. If this ever runs more than one instance,
 * this file is the thing to replace, and the comment above the limiter says so.
 *
 * A fixed window rather than a token bucket, because the thing being limited is
 * "how many reset mails can one address provoke in an hour", which is a count
 * over a window in the plainest sense.
 */

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Counts one hit against `key`.
   *
   * `now` is a parameter so a test can watch a window expire without waiting
   * for it. Every clock in this codebase is injected for that reason.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1 };
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.limit - bucket.count };
  }

  /**
   * Drops expired buckets.
   *
   * Without this the map is an unbounded memory leak keyed by attacker-supplied
   * strings, which is a denial of service dressed as a rate limiter. Swept on
   * write rather than on a timer so there is no interval to leak in tests.
   */
  private sweep(now: number): void {
    if (this.buckets.size < 512) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Tests only. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * The limits, named where the reasoning can sit next to them.
 *
 * Per address as well as per IP, because the two protect different things. Per
 * IP stops one machine hammering the endpoint; per address stops a distributed
 * caller using someone else's inbox as a mailbomb target, which no per-IP limit
 * can see.
 */
export const RESET_PER_IP = { limit: 10, windowMs: 60 * 60_000 } as const;
export const RESET_PER_ADDRESS = { limit: 3, windowMs: 60 * 60_000 } as const;
export const INVITE_REQUEST_PER_IP = { limit: 5, windowMs: 60 * 60_000 } as const;

/**
 * Handing out human-check challenges, on its own counter (D112).
 *
 * Separate from the submission limit rather than sharing it, because sharing
 * would mean one honest attempt costs two tokens and "five requests an hour"
 * would quietly become two and a half. Higher, because issuing is cheap for
 * this server and expensive for the caller, which is the whole point of proof
 * of work: a caller that takes thirty challenges has paid for thirty and can
 * still only submit five.
 */
export const INVITE_CHALLENGE_PER_IP = { limit: 30, windowMs: 60 * 60_000 } as const;
