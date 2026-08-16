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
import type {
  AnnouncementDeadLetterQueuePort,
  ComisLogger,
  TypedEventBus,
} from "@comis/core";
import type { BootContext } from "./daemon-types.js";
import {
  createSubagentActivityTracker,
  sweepStuckSubAgentRuns,
} from "./wiring/subagent-stuck-sweep.js";

/**
 * Operator guidance for a standing announcement quarantine.
 *
 * Routes operators through the content-free control-plane view. Direct JSONL
 * inspection can expose message content and can disagree with the running
 * queue's in-memory authority.
 */
export const ANNOUNCEMENT_QUARANTINE_HINT =
  "Quarantined background-task announcements are awaiting an operator decision; nothing drains "
  + "them automatically because retrying risks a duplicate delivery. Run "
  + "`node packages/cli/dist/cli.js quarantine list` and explicitly release each item after "
  + "deciding whether the user was already informed.";

export function createAnnouncementQuarantineHealthReporter(deps: {
  deadLetterQueue: Pick<AnnouncementDeadLetterQueuePort, "durableSize"> | undefined;
  eventBus: Pick<TypedEventBus, "emitSafely">;
  logger: Pick<ComisLogger, "warn">;
  now(): number;
}): { sample(): Promise<number | undefined> } {
  let lastSize = 0;
  let readFailed = false;
  return {
    async sample(): Promise<number | undefined> {
      const durableSize = deps.deadLetterQueue
        ? await deps.deadLetterQueue.durableSize()
        : undefined;
      if (durableSize === undefined) return 0;
      if (!durableSize.ok) {
        if (!readFailed) {
          deps.logger.warn({
            hint: "Restore dead-letter storage access; the quarantine count is unknown until the durable read succeeds",
            errorKind: "resource" as const,
          }, "Dead-letter health count could not read durable storage");
        }
        readFailed = true;
        deps.eventBus.emitSafely("announcement:quarantine_read_failed", {
          timestamp: deps.now(),
        });
        return undefined;
      }
      readFailed = false;
      if (durableSize.value > 0) {
        if (durableSize.value !== lastSize) {
          deps.logger.warn({
            deadLetterQueueSize: durableSize.value,
            hint: ANNOUNCEMENT_QUARANTINE_HINT,
            errorKind: "internal" as const,
          }, "Announcements quarantined awaiting an operator decision");
        }
        deps.eventBus.emitSafely("announcement:quarantine_pending", {
          pendingCount: durableSize.value,
          timestamp: deps.now(),
        });
      }
      lastSize = durableSize.value;
      return durableSize.value;
    },
  };
}

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
  const quarantineHealth = createAnnouncementQuarantineHealthReporter({
    deadLetterQueue,
    eventBus: container.eventBus,
    logger: daemonLogger,
    now: () => clock.now(),
  });

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
    const deadLetterQueueSize = await quarantineHealth.sample();

    daemonLogger.debug({
      rssBytes: metrics.rssBytes, heapUsedBytes: metrics.heapUsedBytes,
      heapTotalBytes: metrics.heapTotalBytes, externalBytes: metrics.externalBytes,
      eventLoopP99Ms: Math.round(metrics.eventLoopDelayMs.p99 * 100) / 100,
      activeHandles: metrics.activeHandles, activeConnections: getActiveConnectionCount(),
      activeExecutions: activeExecutions.size, uptimeSeconds: Math.round(metrics.uptimeSeconds),
      activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick,
      ...(deadLetterQueueSize === undefined ? {} : { deadLetterQueueSize }),
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
