// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioural contract for the per-tenant summarizer spend cap + circuit breaker.
 *
 * Pins the behaviour the wiring site depends on:
 *   - per-tenant breaker opens after N consecutive failures and BYPASSES the inner
 *     LLM call (degrade = throw → the leaf/condense ladder floors to truncation-only;
 *     it does NOT retry the inner fn when open — a retry would defeat the breaker),
 *   - a per-tenant rolling-window token tracker refuses an over-cap tenant,
 *   - an under-cap tenant admits + records actual usage + success,
 *   - TWO-TENANT ISOLATION: tenant A degrading never affects tenant B,
 *   - a thrown inner call records a breaker failure for that tenant,
 *   - usage that aged past the rolling hour window no longer counts toward the cap.
 *
 * All time is driven by `createFakeClock` (no raw Date/timer — the globals gate).
 * Token counts are deterministic via the injected `estimateInputTokens` /
 * `estimateOutputTokens` fns (production wires the `estimateMessageTokens` heuristic).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { CircuitBreakerConfig } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type {
  LeafSummarizer,
  LeafSummarizeOptions,
} from "../context-engine/lcd-leaf-summarizer.js";
import { createSummarizerSpendBreaker } from "./summarizer-spend-breaker.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const breakerConfig: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 5_000,
  halfOpenTimeoutMs: 2_000,
};

/** A single neutral message; token counts come from the injected estimators, not this shape. */
function makeMessages(): AgentMessage[] {
  return [{ role: "user", content: "hello", timestamp: 0 } as unknown as AgentMessage];
}

const opts: LeafSummarizeOptions = { reserveTokens: 100 };

/**
 * Build the SUT with sane test defaults. Each test overrides what it needs.
 * `estimateInputTokens` / `estimateOutputTokens` are constants so spend is deterministic.
 */
function makeBreaker(
  overrides: {
    maxTokensPerTenantPerHour?: number;
    maxTokensPerTenantPerDay?: number;
    estimateInputTokens?: number;
    estimateOutputTokens?: number;
    initialMs?: number;
  } = {},
) {
  const clock = createFakeClock(overrides.initialMs ?? 1_000_000);
  const wrap = createSummarizerSpendBreaker({
    breakerConfig,
    spendConfig: {
      maxTokensPerTenantPerHour: overrides.maxTokensPerTenantPerHour ?? 1_000_000,
      maxTokensPerTenantPerDay: overrides.maxTokensPerTenantPerDay ?? 10_000_000,
    },
    clock,
    estimateInputTokens: () => overrides.estimateInputTokens ?? 100,
    estimateOutputTokens: () => overrides.estimateOutputTokens ?? 50,
  });
  return { wrap, clock };
}

describe("createSummarizerSpendBreaker", () => {
  it("opens a tenant breaker after failureThreshold failures and then bypasses the inner summarizer", async () => {
    const { wrap } = makeBreaker();
    const inner = vi.fn<LeafSummarizer>().mockRejectedValue(new Error("inner LLM failure"));
    const gated = wrap.gate("tenant-a", inner);

    // Drive failureThreshold consecutive failures (each rejects, recording a failure).
    for (let i = 0; i < breakerConfig.failureThreshold; i++) {
      await expect(gated(makeMessages(), opts)).rejects.toThrow();
    }
    const callsAfterThreshold = inner.mock.calls.length;
    expect(callsAfterThreshold).toBe(breakerConfig.failureThreshold);

    // The next call must DEGRADE (throw) WITHOUT invoking the inner fn — no retry when open.
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner.mock.calls.length).toBe(callsAfterThreshold);
  });

  it("keeps a tenant breaker open and bypassing for the full resetTimeoutMs window", async () => {
    const { wrap, clock } = makeBreaker();
    const inner = vi.fn<LeafSummarizer>().mockRejectedValue(new Error("inner LLM failure"));
    const gated = wrap.gate("tenant-a", inner);

    for (let i = 0; i < breakerConfig.failureThreshold; i++) {
      await expect(gated(makeMessages(), opts)).rejects.toThrow();
    }
    const callsWhenOpen = inner.mock.calls.length;

    // Just before resetTimeoutMs the breaker is still open → bypass, inner not called.
    clock.advance(breakerConfig.resetTimeoutMs - 1);
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner.mock.calls.length).toBe(callsWhenOpen);
  });

  it("bypasses the inner summarizer for a tenant that is over its hourly token cap", async () => {
    // Cap = 120; each successful call records 100 + 50 = 150 tokens → over after one call.
    const { wrap } = makeBreaker({
      maxTokensPerTenantPerHour: 120,
      estimateInputTokens: 100,
      estimateOutputTokens: 50,
    });
    const inner = vi.fn<LeafSummarizer>().mockResolvedValue("a summary");
    const gated = wrap.gate("tenant-a", inner);

    // First call is admitted (est 100 ≤ cap 120) and records 150 (> cap) actual usage.
    await expect(gated(makeMessages(), opts)).resolves.toBe("a summary");
    expect(inner).toHaveBeenCalledTimes(1);

    // Next call: tenant is now over the hourly cap → DEGRADE without calling inner.
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("calls the inner summarizer for a tenant under its token cap and records actual usage and success", async () => {
    const { wrap } = makeBreaker({
      maxTokensPerTenantPerHour: 1_000_000,
      estimateInputTokens: 100,
      estimateOutputTokens: 50,
    });
    const inner = vi.fn<LeafSummarizer>().mockResolvedValue("the summary text");
    const gated = wrap.gate("tenant-a", inner);

    await expect(gated(makeMessages(), opts)).resolves.toBe("the summary text");
    expect(inner).toHaveBeenCalledTimes(1);

    // A successful call records usage; the tenant stays closed + under cap, so a second
    // call still goes through (proves success was recorded, not a failure, and spend is tracked).
    await expect(gated(makeMessages(), opts)).resolves.toBe("the summary text");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("isolates tenants so tenant-a opening its breaker does not degrade tenant-b", async () => {
    const { wrap } = makeBreaker();
    const innerA = vi.fn<LeafSummarizer>().mockRejectedValue(new Error("A inner failure"));
    const innerB = vi.fn<LeafSummarizer>().mockResolvedValue("B summary");
    const gatedA = wrap.gate("tenant-a", innerA);
    const gatedB = wrap.gate("tenant-b", innerB);

    // Open tenant-a's breaker.
    for (let i = 0; i < breakerConfig.failureThreshold; i++) {
      await expect(gatedA(makeMessages(), opts)).rejects.toThrow();
    }
    await expect(gatedA(makeMessages(), opts)).rejects.toThrow(); // A is bypassed (open)

    // Tenant-b is unaffected — its breaker is closed → inner IS called and it resolves.
    await expect(gatedB(makeMessages(), opts)).resolves.toBe("B summary");
    expect(innerB).toHaveBeenCalledTimes(1);
  });

  it("isolates tenants so tenant-a hitting its token cap does not degrade tenant-b", async () => {
    const { wrap } = makeBreaker({
      maxTokensPerTenantPerHour: 120,
      estimateInputTokens: 100,
      estimateOutputTokens: 50,
    });
    const innerA = vi.fn<LeafSummarizer>().mockResolvedValue("A summary");
    const innerB = vi.fn<LeafSummarizer>().mockResolvedValue("B summary");
    const gatedA = wrap.gate("tenant-a", innerA);
    const gatedB = wrap.gate("tenant-b", innerB);

    // Push tenant-a over its hourly cap.
    await expect(gatedA(makeMessages(), opts)).resolves.toBe("A summary");
    await expect(gatedA(makeMessages(), opts)).rejects.toThrow(); // A over cap → bypass

    // Tenant-b's spend window is independent → inner IS called and resolves.
    await expect(gatedB(makeMessages(), opts)).resolves.toBe("B summary");
    expect(innerB).toHaveBeenCalledTimes(1);
  });

  it("records a breaker failure for the tenant when the inner summarizer throws", async () => {
    const { wrap } = makeBreaker();
    const inner = vi.fn<LeafSummarizer>().mockRejectedValue(new Error("inner failure"));
    const gated = wrap.gate("tenant-a", inner);

    // Below threshold: each throw records a failure but the breaker stays closed,
    // so the inner fn keeps being called (proves failures accrue, not bypassed yet).
    for (let i = 0; i < breakerConfig.failureThreshold - 1; i++) {
      await expect(gated(makeMessages(), opts)).rejects.toThrow();
    }
    expect(inner.mock.calls.length).toBe(breakerConfig.failureThreshold - 1);

    // The threshold-th throw opens the breaker (inner still called this time)...
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner.mock.calls.length).toBe(breakerConfig.failureThreshold);

    // ...and the very next call is bypassed — proving the failures were recorded.
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner.mock.calls.length).toBe(breakerConfig.failureThreshold);
  });

  it("drops token usage that aged past the rolling hour window so a fresh spend is admitted", async () => {
    const { wrap, clock } = makeBreaker({
      maxTokensPerTenantPerHour: 200,
      estimateInputTokens: 100,
      estimateOutputTokens: 50,
    });
    const inner = vi.fn<LeafSummarizer>().mockResolvedValue("a summary");
    const gated = wrap.gate("tenant-a", inner);

    // First call records 150 tokens (near the 200 cap).
    await expect(gated(makeMessages(), opts)).resolves.toBe("a summary");
    expect(inner).toHaveBeenCalledTimes(1);

    // Immediately, a second call would push 150 + 150 = 300 > 200 → bypassed.
    await expect(gated(makeMessages(), opts)).rejects.toThrow();
    expect(inner).toHaveBeenCalledTimes(1);

    // Advance past the rolling hour window; the aged 150 tokens drop out of the window,
    // so a fresh call (est 100 ≤ 200) is admitted again.
    clock.advance(ONE_HOUR_MS + 1);
    await expect(gated(makeMessages(), opts)).resolves.toBe("a summary");
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
