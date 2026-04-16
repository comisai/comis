/**
 * Per-agent notification rate limiter with rolling hourly window.
 * Enforces maxPerHour limit per agent using a simple window reset strategy.
 * Supports injectable clock for deterministic testing.
 */

export interface RateLimiter {
  /** Returns true if the notification is allowed, false if rate-limited. */
  tryAcquire(agentId: string): boolean;
  /** Reset the counter for a specific agent. */
  reset(agentId: string): void;
}

export function createRateLimiter(opts: {
  maxPerHour: number;
  nowMs?: () => number;
}): RateLimiter {
  const getNow = opts.nowMs ?? Date.now;
  const HOUR_MS = 3_600_000;
  const counters = new Map<string, { count: number; windowStartMs: number }>();

  return {
    tryAcquire(agentId: string): boolean {
      const now = getNow();
      const entry = counters.get(agentId);
      if (!entry || now - entry.windowStartMs >= HOUR_MS) {
        counters.set(agentId, { count: 1, windowStartMs: now });
        return true;
      }
      if (entry.count >= opts.maxPerHour) return false;
      entry.count++;
      return true;
    },
    reset(agentId: string): void {
      counters.delete(agentId);
    },
  };
}
