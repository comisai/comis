// SPDX-License-Identifier: Apache-2.0
/**
 * Rate limiter for image generation -- per-agent hourly budget.
 */
export interface ImageGenRateLimiter {
  /** Try to acquire a generation slot for the given agent. Returns false if over limit. */
  tryAcquire(agentId: string): boolean;
  /** Reset the counter for a specific agent. */
  reset(agentId: string): void;
}

interface AgentBucket {
  count: number;
  windowStart: number;
}

/**
 * Create a per-agent rate limiter for image generation.
 *
 * Uses a simple fixed-window approach: resets the counter after one hour
 * from the first request in the window.
 *
 * @param opts - Configuration with maxPerHour limit and optional clock override
 * @returns ImageGenRateLimiter instance
 */
export function createImageGenRateLimiter(opts: {
  maxPerHour: number;
  nowMs?: () => number;
}): ImageGenRateLimiter {
  const buckets = new Map<string, AgentBucket>();
  const nowMs = opts.nowMs ?? (() => Date.now());
  const windowMs = 3_600_000; // 1 hour

  return {
    tryAcquire(agentId: string): boolean {
      const now = nowMs();
      let bucket = buckets.get(agentId);

      if (!bucket || now - bucket.windowStart >= windowMs) {
        bucket = { count: 0, windowStart: now };
        buckets.set(agentId, bucket);
      }

      if (bucket.count >= opts.maxPerHour) {
        return false;
      }

      bucket.count++;
      return true;
    },

    reset(agentId: string): void {
      buckets.delete(agentId);
    },
  };
}
