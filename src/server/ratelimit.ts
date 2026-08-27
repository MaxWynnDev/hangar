// Rate limiting.
//
// In-memory and per-process, which is honest about what it is: a self-hosted
// Hangar is one process, so a per-process counter IS the global counter. If you
// run several behind a load balancer, this becomes "per limit per instance" and
// you want a shared store. That is written here rather than discovered later.
//
// What it is actually for: the dispatch endpoint starts a real agent session
// with real cost. Everything else is cheap, and the limits reflect that.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Sweep occasionally so an install with churn does not grow this forever. */
let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

export const LIMITS = {
  /** Starting an agent session costs real money and real compute. */
  dispatch: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** Ordinary chatter. Generous: this exists to stop loops, not people. */
  post: { limit: 120, windowMs: 60 * 1000 },
  /** Anything else authenticated. */
  general: { limit: 600, windowMs: 60 * 1000 },
  /** Sign-in attempts, keyed by address. */
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
} as const;

/** Test seam. Never called by the server. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
