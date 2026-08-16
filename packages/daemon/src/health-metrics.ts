// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon health-log wiring.
 *
 * Subscribes to the observability metrics tick, maintains the prompt-timeout
 * window, samples durable-store sizes, sweeps stuck sub-agents, and emits the
 * canonical structured health snapshot.
 *
 * @module
 */
import { statSync } from "node:fs";
import type { BootContext } from "./daemon-types.js";
import {
  createSubagentActivityTracker,
  sweepStuckSubAgentRuns,
} from "./wiring/subagent-stuck-sweep.js";
import { systemNowMs } from "@comis/core";

/**
 * Operator guidance for a standing announcement quarantine.
 *
 * Names the file's LIFECYCLE, not just its path: the dead-letter file exists
 * only while the queue is non-empty and is unlinked the moment it drains, so an
 * operator reading this WARN after the fact finds nothing at that path. Without
 * the lifecycle, that absence reads as "the announcement was lost" when the
 * usual cause is the opposite — the entry was dropped because the outward ledger
 * proved the user had already been told.
 */
export const ANNOUNCEMENT_QUARANTINE_HINT =
  "Quarantined background-task announcements are awaiting an operator decision; nothing drains "
  + "them automatically because retrying risks a duplicate delivery. Inspect "
  + "<dataDir>/dead-letters.jsonl and decide whether the user was already informed. That file is "
  + "removed once the queue drains, so if it is absent the quarantine has already resolved — look "
  + "for the matching dead-letter resolution line rather than treating the announcement as lost.";

export function wireHealthLogging(deps: {
  container: BootContext["container"];
  clock: BootContext["clock"];
  daemonLogger: BootContext["daemonLogger"];
  db: BootContext["db"];
  maintenanceTick: BootContext["maintenanceTick"];
  subAgentRunner: NonNullable<BootContext["subAgentRunner"]>;
  promptTimeoutTimestamps: NonNullable<BootContext["promptTimeoutTimestamps"]>;
  activeExecutions: NonNullable<BootContext["activeExecutions"]>;
  getActiveConnectionCount: NonNullable<BootContext["getActiveConnectionCount"]>;
  deadLetterQueue: BootContext["deadLetterQueue"];
  providerHealth: NonNullable<BootContext["providerHealth"]>;
  deliveryQueue: NonNullable<BootContext["deliveryQueue"]>;
}): void {
  const {
    container, clock, daemonLogger, db, maintenanceTick, subAgentRunner,
    promptTimeoutTimestamps, activeExecutions, getActiveConnectionCount,
    deadLetterQueue, providerHealth, deliveryQueue,
  } = deps;
  const subagentActivity = createSubagentActivityTracker(
    container.eventBus,
    () => clock.now(),
  );
  // Last observed quarantine depth — the WARN fires on CHANGE only, so a standing quarantine is
  // announced once rather than every health tick.
  let lastDeadLetterQueueSize = 0;
  let deadLetterReadFailed = false;

  container.eventBus.on("observability:metrics", async (metrics) => {
    const fiveMinAgo = clock.now() - 5 * 60_000;
    while (promptTimeoutTimestamps.length > 0 && promptTimeoutTimestamps[0]! < fiveMinAgo) {
      promptTimeoutTimestamps.shift();
    }
    let memoryDbSizeBytes: number | undefined;
    let memoryDbWalSizeBytes: number | undefined;
    try {
      const dbFilePath = db.name;
      if (dbFilePath) {
        memoryDbSizeBytes = statSync(dbFilePath).size;
        try { memoryDbWalSizeBytes = statSync(dbFilePath + "-wal").size; }
        catch { /* WAL file may not exist */ }
      }
    } catch { /* stat failure must not crash health check */ }
    let unembeddedMemoryCount: number | undefined;
    try {
      unembeddedMemoryCount = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE has_embedding = 0").get() as { n: number } | undefined)?.n;
    } catch { /* count failure must not crash health check */ }
    maintenanceTick();
    const stuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.stuckKillThresholdMs ?? 180_000;
    const graphStuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.graphStuckKillThresholdMs ?? 600_000;
    const allRuns = subAgentRunner.listRuns();
    const runningRuns = allRuns.filter((run) => run.status === "running");
    const now = clock.now();
    subagentActivity.prune(
      new Set(runningRuns.map((run) => run.sessionKey)),
    );
    const sweep = sweepStuckSubAgentRuns({
      runs: runningRuns,
      now,
      stuckKillThresholdMs,
      graphStuckKillThresholdMs,
      lastActivityFor: (key) => subagentActivity.lastActivityFor(key),
    });
    const { activeSubAgentRuns, stuckSubAgentRuns } = sweep;
    let stuckKilledThisTick = 0;
    for (const kill of sweep.kills) {
      const knob = kill.isGraphRun
        ? "security.agentToAgent.subagentContext.graphStuckKillThresholdMs"
        : "security.agentToAgent.subagentContext.stuckKillThresholdMs";
      subAgentRunner.killRun(kill.runId, {
        killedBy: "health_monitor",
        reason: `Stuck sub-agent: no observed progress for ${kill.idleMs}ms (${knob}=${kill.thresholdMs}); force-killed by the daemon health monitor`,
        idleMs: kill.idleMs,
        thresholdMs: kill.thresholdMs,
      });
      stuckKilledThisTick++;
      daemonLogger.warn({
        runId: kill.runId, agentId: kill.agentId, runtimeMs: kill.runtimeMs,
        idleMs: kill.idleMs,
        thresholdMs: kill.thresholdMs, isGraphRun: kill.isGraphRun,
        hint: `Sub-agent produced no tool/LLM progress event for longer than ${knob}; force-killed by health handler. Raise ${knob} if legitimate work pauses longer.`,
        errorKind: "timeout" as const,
      }, "Stuck sub-agent killed by health handler");
    }
    // A quarantined announcement is a STANDING condition, not a transient tick value: it means a
    // background task's outcome is held back because the runtime could not prove whether the user
    // was already told, and nothing drains it automatically (by design — auto-retry risks a duplicate
    // delivery). Live, one sat unnoticed for hours because the only trace was this DEBUG line, so an
    // operator at the default level had no way to know a user's task outcome was in limbo. Promoted
    // to WARN on the non-zero transition only — steady-state re-warning every tick would be noise.
    const durableSize = deadLetterQueue
      ? await deadLetterQueue.durableSize()
      : undefined;
    const deadLetterQueueSize = durableSize?.ok
      ? durableSize.value
      : (deadLetterQueue?.size() ?? 0);
    if (durableSize && !durableSize.ok && !deadLetterReadFailed) {
      daemonLogger.warn({
        deadLetterQueueSize,
        hint: "Restore dead-letter storage access; the health snapshot shows only the in-memory retained count",
        errorKind: "resource" as const,
      }, "Dead-letter health count could not read durable storage");
    }
    deadLetterReadFailed = durableSize !== undefined && !durableSize.ok;
    if (deadLetterQueueSize > 0 && deadLetterQueueSize !== lastDeadLetterQueueSize) {
      daemonLogger.warn({
        deadLetterQueueSize,
        hint: ANNOUNCEMENT_QUARANTINE_HINT,
        errorKind: "internal" as const,
      }, "Announcements quarantined awaiting an operator decision");
      // Also emit it, so the count reaches the system-health view. The WARN
      // alone left this diagnosable only by a daemon.log grep — the exact
      // failure the two-tier triage flow exists to remove.
      container.eventBus.emitSafely("announcement:quarantine_pending", {
        pendingCount: deadLetterQueueSize,
        timestamp: systemNowMs(),
      });
    }
    lastDeadLetterQueueSize = deadLetterQueueSize;

    daemonLogger.debug({
      rssBytes: metrics.rssBytes, heapUsedBytes: metrics.heapUsedBytes,
      heapTotalBytes: metrics.heapTotalBytes, externalBytes: metrics.externalBytes,
      eventLoopP99Ms: Math.round(metrics.eventLoopDelayMs.p99 * 100) / 100,
      activeHandles: metrics.activeHandles, activeConnections: getActiveConnectionCount(),
      activeExecutions: activeExecutions.size, uptimeSeconds: Math.round(metrics.uptimeSeconds),
      activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick,
      deadLetterQueueSize,
      degradedProviders: [...providerHealth.getHealthSummary().entries()]
        .filter(([, v]) => v.degraded).map(([k]) => k),
      promptTimeoutsLast5m: promptTimeoutTimestamps.length,
      ...(memoryDbSizeBytes !== undefined && { memoryDbSizeBytes }),
      ...(memoryDbWalSizeBytes !== undefined && { memoryDbWalSizeBytes }),
      ...(unembeddedMemoryCount !== undefined && { unembeddedMemoryCount }),
      pendingDeliveryCount: await deliveryQueue.pendingEntries().then(r => r.ok ? r.value.length : 0),
    }, "Daemon health");
  });
}
