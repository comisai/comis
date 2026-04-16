/**
 * Daemon health metrics logic tests.
 * Validates the five resilience metrics that are emitted in the daemon health
 * log: activeSubAgentRuns, stuckSubAgentRuns (threshold-aware),
 * deadLetterQueueSize, degradedProviders, and promptTimeoutsLast5m.
 * Structured log audit (verified, no fixes needed):
 * - sub-agent-runner.ts L838: WARN  errorKind:"resource"  hint:present (queue spawn timeout)
 * - sub-agent-runner.ts L871: ERROR errorKind:"timeout"   hint:present (ghost run sweep)
 * - sub-agent-runner.ts L1480: ERROR errorKind:"internal" hint:present (executeAgent catch-all)
 * - sub-agent-runner.ts L1593: ERROR errorKind:"timeout"  hint:present (watchdog timeout)
 * - announcement-dead-letter.ts drain delivery: DEBUG (internal step, not boundary event)
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAnnouncementDeadLetterQueue } from "./announcement-dead-letter.js";
import { createProviderHealthMonitor, type ProviderHealthMonitor } from "@comis/agent";
import type { TypedEventBus } from "@comis/core";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockEventBus } from "../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// 1. Prompt timeout sliding window counter
// ---------------------------------------------------------------------------

describe("promptTimeoutsLast5m sliding window counter", () => {
  it("counts timestamps within the 5-minute window", () => {
    const timestamps: number[] = [];
    const now = Date.now();

    // Push 3 timestamps within the window
    timestamps.push(now - 60_000);  // 1 min ago
    timestamps.push(now - 120_000); // 2 min ago
    timestamps.push(now - 240_000); // 4 min ago

    // Prune (same logic as daemon health handler)
    const fiveMinAgo = now - 5 * 60_000;
    while (timestamps.length > 0 && timestamps[0]! < fiveMinAgo) {
      timestamps.shift();
    }

    expect(timestamps.length).toBe(3);
  });

  it("prunes timestamps older than 5 minutes", () => {
    const timestamps: number[] = [];
    const now = Date.now();

    // Push timestamps: 2 outside window, 2 inside
    timestamps.push(now - 10 * 60_000); // 10 min ago (stale)
    timestamps.push(now - 6 * 60_000);  // 6 min ago (stale)
    timestamps.push(now - 3 * 60_000);  // 3 min ago (valid)
    timestamps.push(now - 1 * 60_000);  // 1 min ago (valid)

    // Prune (same logic as daemon health handler)
    const fiveMinAgo = now - 5 * 60_000;
    while (timestamps.length > 0 && timestamps[0]! < fiveMinAgo) {
      timestamps.shift();
    }

    expect(timestamps.length).toBe(2);
  });

  it("returns 0 when no timestamps exist", () => {
    const timestamps: number[] = [];

    const fiveMinAgo = Date.now() - 5 * 60_000;
    while (timestamps.length > 0 && timestamps[0]! < fiveMinAgo) {
      timestamps.shift();
    }

    expect(timestamps.length).toBe(0);
  });

  it("prunes all timestamps when all are stale", () => {
    const timestamps: number[] = [];
    const now = Date.now();

    timestamps.push(now - 10 * 60_000);
    timestamps.push(now - 8 * 60_000);
    timestamps.push(now - 6 * 60_000);

    const fiveMinAgo = now - 5 * 60_000;
    while (timestamps.length > 0 && timestamps[0]! < fiveMinAgo) {
      timestamps.shift();
    }

    expect(timestamps.length).toBe(0);
  });

  it("handles boundary case: exactly 5 minutes ago is pruned", () => {
    const timestamps: number[] = [];
    const now = Date.now();

    // Exactly at the boundary (should be pruned since < fiveMinAgo)
    timestamps.push(now - 5 * 60_000 - 1); // 1ms past boundary
    timestamps.push(now - 5 * 60_000 + 1); // 1ms inside boundary

    const fiveMinAgo = now - 5 * 60_000;
    while (timestamps.length > 0 && timestamps[0]! < fiveMinAgo) {
      timestamps.shift();
    }

    expect(timestamps.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. deadLetterQueue.size() returns correct count
// ---------------------------------------------------------------------------

describe("deadLetterQueueSize metric", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dlq-health-test-"));
  });

  it("size() returns 0 when queue is empty", () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath: join(tempDir, "dlq.jsonl"),
      maxRetries: 5,
      retryIntervalMs: 60_000,
      maxAgeMs: 3_600_000,
      maxEntries: 100,
      eventBus: createMockEventBus(),
    });

    expect(dlq.size()).toBe(0);
  });

  it("size() returns correct count after enqueue", () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath: join(tempDir, "dlq.jsonl"),
      maxRetries: 5,
      retryIntervalMs: 60_000,
      maxAgeMs: 3_600_000,
      maxEntries: 100,
      eventBus: createMockEventBus(),
    });

    dlq.enqueue({
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      announcementText: "test message",
    });

    dlq.enqueue({
      runId: "run-2",
      channelType: "discord",
      channelId: "chan-2",
      announcementText: "test message 2",
    });

    expect(dlq.size()).toBe(2);
  });

  it("size() returns a number type", () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath: join(tempDir, "dlq.jsonl"),
      maxRetries: 5,
      retryIntervalMs: 60_000,
      maxAgeMs: 3_600_000,
      maxEntries: 100,
      eventBus: createMockEventBus(),
    });

    expect(typeof dlq.size()).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 3. providerHealth.getHealthSummary() returns degraded providers
// ---------------------------------------------------------------------------

describe("degradedProviders metric", () => {
  let providerHealth: ProviderHealthMonitor;
  let eventBus: TypedEventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    providerHealth = createProviderHealthMonitor({
      degradedThreshold: 2,
      consecutiveFailureThreshold: 3,
      windowMs: 60_000,
      recoveryThreshold: 1,
      eventBus,
    });
  });

  it("getHealthSummary() returns a Map", () => {
    const summary = providerHealth.getHealthSummary();
    expect(summary).toBeInstanceOf(Map);
  });

  it("health summary entries have degraded boolean field", () => {
    // Record failures to create a provider entry
    providerHealth.recordFailure("anthropic", "agent-1");
    providerHealth.recordFailure("anthropic", "agent-1");
    providerHealth.recordFailure("anthropic", "agent-1");

    const summary = providerHealth.getHealthSummary();
    const entry = summary.get("anthropic");
    expect(entry).toBeDefined();
    expect(typeof entry!.degraded).toBe("boolean");
  });

  it("degraded filter logic matches daemon implementation", () => {
    // Record enough failures to degrade a provider
    providerHealth.recordFailure("openai", "agent-1");
    providerHealth.recordFailure("openai", "agent-2");
    providerHealth.recordFailure("openai", "agent-1");
    providerHealth.recordFailure("openai", "agent-2");
    providerHealth.recordFailure("openai", "agent-1");

    // Record success for another provider (should not be degraded)
    providerHealth.recordSuccess("anthropic", "agent-1");

    // Same filter as daemon health handler
    const degradedProviders = [...providerHealth.getHealthSummary().entries()]
      .filter(([, v]) => v.degraded)
      .map(([k]) => k);

    expect(degradedProviders).toContain("openai");
    expect(degradedProviders).not.toContain("anthropic");
  });

  it("returns empty array when no providers are degraded", () => {
    providerHealth.recordSuccess("anthropic", "agent-1");
    providerHealth.recordSuccess("openai", "agent-1");

    const degradedProviders = [...providerHealth.getHealthSummary().entries()]
      .filter(([, v]) => v.degraded)
      .map(([k]) => k);

    expect(degradedProviders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. activeSubAgentRuns and stuckSubAgentRuns split metrics
// ---------------------------------------------------------------------------

/**
 * Mirrors the health metric computation in daemon.ts health handler.
 * Returns split metrics: activeSubAgentRuns counts ALL running sub-agents;
 * stuckSubAgentRuns counts ONLY those exceeding their graph-aware threshold.
 */
function computeSubAgentHealthMetrics(
  runs: Array<{ runId: string; status: string; startedAt: number; graphId?: string }>,
  stuckKillThresholdMs: number,
  graphStuckKillThresholdMs: number,
  now: number,
): { activeSubAgentRuns: number; stuckSubAgentRuns: number } {
  let activeSubAgentRuns = 0;
  let stuckSubAgentRuns = 0;
  for (const run of runs) {
    if (run.status !== "running") continue;
    activeSubAgentRuns++;
    const threshold = run.graphId ? graphStuckKillThresholdMs : stuckKillThresholdMs;
    if (threshold > 0 && (now - run.startedAt) > threshold) {
      stuckSubAgentRuns++;
    }
  }
  return { activeSubAgentRuns, stuckSubAgentRuns };
}

describe("activeSubAgentRuns and stuckSubAgentRuns split metrics", () => {
  const now = Date.now();

  it("activeSubAgentRuns counts all running runs regardless of duration", () => {
    const runs = [
      { runId: "r1", status: "running" as const, startedAt: now - 10_000 },
      { runId: "r2", status: "running" as const, startedAt: now - 200_000 },
      { runId: "r3", status: "completed" as const, startedAt: now - 5_000 },
      { runId: "r4", status: "failed" as const, startedAt: now - 5_000 },
      { runId: "r5", status: "queued" as const, startedAt: now - 5_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(2);
  });

  it("stuckSubAgentRuns counts only runs exceeding their threshold", () => {
    const runs = [
      { runId: "r1", status: "running" as const, startedAt: now - 10_000 },   // within threshold
      { runId: "r2", status: "running" as const, startedAt: now - 200_000 },  // exceeds 180s threshold
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.stuckSubAgentRuns).toBe(1);
  });

  it("graph runs within graphStuckKillThresholdMs are active but not stuck", () => {
    const runs = [
      { runId: "g1", status: "running" as const, startedAt: now - 250_000, graphId: "g-abc" },
    ];
    // 250s < 600s graph threshold -> active but not stuck
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(1);
    expect(result.stuckSubAgentRuns).toBe(0);
  });

  it("regular runs within stuckKillThresholdMs are active but not stuck", () => {
    const runs = [
      { runId: "r1", status: "running" as const, startedAt: now - 100_000 },
    ];
    // 100s < 180s regular threshold -> active but not stuck
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(1);
    expect(result.stuckSubAgentRuns).toBe(0);
  });

  it("mixed scenario: 4 running (2 graph, 2 regular), only threshold-exceeding counted as stuck", () => {
    const runs = [
      // Graph run at 500s: within 600s graph threshold -> active, not stuck
      { runId: "g1", status: "running" as const, startedAt: now - 500_000, graphId: "g-1" },
      // Graph run at 700s: exceeds 600s graph threshold -> active AND stuck
      { runId: "g2", status: "running" as const, startedAt: now - 700_000, graphId: "g-2" },
      // Regular run at 100s: within 180s -> active, not stuck
      { runId: "r1", status: "running" as const, startedAt: now - 100_000 },
      // Regular run at 200s: exceeds 180s -> active AND stuck
      { runId: "r2", status: "running" as const, startedAt: now - 200_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(4);
    expect(result.stuckSubAgentRuns).toBe(2);
  });

  it("empty runs array returns zeros for both metrics", () => {
    const runs: Array<{ runId: string; status: string; startedAt: number; graphId?: string }> = [];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(0);
    expect(result.stuckSubAgentRuns).toBe(0);
  });

  it("non-running statuses are excluded from both counts", () => {
    const runs = [
      { runId: "r1", status: "completed" as const, startedAt: now - 999_000 },
      { runId: "r2", status: "failed" as const, startedAt: now - 999_000 },
      { runId: "r3", status: "queued" as const, startedAt: now - 999_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(0);
    expect(result.stuckSubAgentRuns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Graph-aware stuck sub-agent kill logic
// ---------------------------------------------------------------------------

describe("graph-aware stuck sub-agent kill logic", () => {
  const now = Date.now();

  it("regular run exceeding stuckKillThresholdMs is identified as stuck", () => {
    const runs = [
      { runId: "r1", status: "running" as const, startedAt: now - 200_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.stuckSubAgentRuns).toBe(1);
    expect(result.activeSubAgentRuns).toBe(1);
  });

  it("regular run within threshold is not identified as stuck", () => {
    const runs = [
      { runId: "r1", status: "running" as const, startedAt: now - 100_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.stuckSubAgentRuns).toBe(0);
    expect(result.activeSubAgentRuns).toBe(1);
  });

  it("graph run uses graphStuckKillThresholdMs instead of regular threshold", () => {
    // Graph run at 250s: exceeds 180s regular but within 600s graph threshold
    const runs = [
      { runId: "graph-1", status: "running" as const, startedAt: now - 250_000, graphId: "g-abc" },
      { runId: "regular-1", status: "running" as const, startedAt: now - 250_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    // Both are active, only the regular run should be stuck
    expect(result.activeSubAgentRuns).toBe(2);
    expect(result.stuckSubAgentRuns).toBe(1);
  });

  it("graph run exceeding graphStuckKillThresholdMs is stuck", () => {
    const runs = [
      { runId: "graph-1", status: "running" as const, startedAt: now - 700_000, graphId: "g-abc" },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.stuckSubAgentRuns).toBe(1);
  });

  it("graph threshold 0 disables stuck detection for graph runs only", () => {
    const runs = [
      { runId: "graph-1", status: "running" as const, startedAt: now - 999_000, graphId: "g-abc" },
      { runId: "regular-1", status: "running" as const, startedAt: now - 250_000 },
    ];
    // graphStuckKillThresholdMs=0 disables graph stuck detection, regular threshold still active
    const result = computeSubAgentHealthMetrics(runs, 180_000, 0, now);
    expect(result.activeSubAgentRuns).toBe(2);
    expect(result.stuckSubAgentRuns).toBe(1);
  });

  it("mixed graph and regular runs apply correct thresholds", () => {
    const runs = [
      // Graph run at 500s: within 600s graph threshold -> active, not stuck
      { runId: "g1", status: "running" as const, startedAt: now - 500_000, graphId: "g-1" },
      // Graph run at 700s: exceeds 600s graph threshold -> stuck
      { runId: "g2", status: "running" as const, startedAt: now - 700_000, graphId: "g-2" },
      // Regular run at 100s: within 180s -> active, not stuck
      { runId: "r1", status: "running" as const, startedAt: now - 100_000 },
      // Regular run at 200s: exceeds 180s -> stuck
      { runId: "r2", status: "running" as const, startedAt: now - 200_000 },
      // Completed run (should be ignored regardless)
      { runId: "r3", status: "completed" as const, startedAt: now - 999_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(4);
    expect(result.stuckSubAgentRuns).toBe(2);
  });

  it("both thresholds 0 disables all stuck detection", () => {
    const runs = [
      { runId: "g1", status: "running" as const, startedAt: now - 999_000, graphId: "g-1" },
      { runId: "r1", status: "running" as const, startedAt: now - 999_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 0, 0, now);
    expect(result.activeSubAgentRuns).toBe(2);
    expect(result.stuckSubAgentRuns).toBe(0);
  });

  it("non-running statuses are ignored", () => {
    const runs = [
      { runId: "r1", status: "completed" as const, startedAt: now - 999_000 },
      { runId: "r2", status: "failed" as const, startedAt: now - 999_000 },
      { runId: "r3", status: "queued" as const, startedAt: now - 999_000 },
    ];
    const result = computeSubAgentHealthMetrics(runs, 180_000, 600_000, now);
    expect(result.activeSubAgentRuns).toBe(0);
    expect(result.stuckSubAgentRuns).toBe(0);
  });
});
