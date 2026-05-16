// SPDX-License-Identifier: Apache-2.0
/**
 * Shutdown-stage helpers for daemon.ts's stageShutdown.
 *
 * Block-moved verbatim from daemon.ts in Phase 43 Wave 8c (FILE-SPLIT-06):
 *   - readDbSizeMetrics (daemon.ts:2251-2266)
 *   - computeAndKillStuckSubAgents (daemon.ts:2273-2305)
 *   - wireHealthLogging (daemon.ts:2307-2351)
 *   - buildStartupBannerManifest (daemon.ts:2359-2387)
 *   - emitStartupBanner (daemon.ts:2389-2430)
 *
 * Each helper is a top-level function (not a closure) — mechanical block-move
 * is safe per RESEARCH §"No-cycles invariant". Consumed by stageShutdown in
 * daemon.ts.
 *
 * @module
 */

import { statSync } from "node:fs";
import { emitDockerRestartPolicyWarn } from "../setup-docker-restart-warn.js";
import { hasAnyOAuthAgent, emitOAuthTlsPreflightWarn } from "../wiring/oauth-preflight.js";
import type { GatewayHandle } from "../daemon-types.js";

/** Read DB file + WAL file sizes (best-effort; returns undefined fields on failure). */
export function readDbSizeMetrics(db: GatewayHandle["db"]): {
  memoryDbSizeBytes?: number;
  memoryDbWalSizeBytes?: number;
} {
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
  return { memoryDbSizeBytes, memoryDbWalSizeBytes };
}

/**
 * Count active sub-agent runs and force-kill any past the threshold-aware cutoff.
 * Graph sub-agents get a longer threshold since they do multi-step analytical work.
 * Returns { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick } counters.
 */
export function computeAndKillStuckSubAgents(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  subAgentRunner: GatewayHandle["subAgentRunner"];
}): { activeSubAgentRuns: number; stuckSubAgentRuns: number; stuckKilledThisTick: number } {
  const { container, daemonLogger, subAgentRunner } = deps;
  const stuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.stuckKillThresholdMs ?? 180_000;
  const graphStuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.graphStuckKillThresholdMs ?? 600_000;
  const allRuns = subAgentRunner.listRuns();
  const now = Date.now();
  let activeSubAgentRuns = 0;
  let stuckSubAgentRuns = 0;
  let stuckKilledThisTick = 0;
  for (const run of allRuns) {
    if (run.status !== "running") continue;
    activeSubAgentRuns++;
    const threshold = run.graphId ? graphStuckKillThresholdMs : stuckKillThresholdMs;
    if (threshold > 0 && (now - run.startedAt) > threshold) stuckSubAgentRuns++;
    if (threshold <= 0) continue;
    if ((now - run.startedAt) <= threshold) continue;
    subAgentRunner.killRun(run.runId);
    stuckKilledThisTick++;
    daemonLogger.warn({
      runId: run.runId, agentId: run.agentId, runtimeMs: now - run.startedAt,
      thresholdMs: threshold, isGraphRun: !!run.graphId,
      hint: run.graphId
        ? "Graph sub-agent exceeded graphStuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.graphStuckKillThresholdMs if needed."
        : "Sub-agent exceeded stuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.stuckKillThresholdMs if needed.",
      errorKind: "timeout" as const,
    }, "Stuck sub-agent killed by health handler");
  }
  return { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick };
}

/**
 * Wire eventBus health subscriptions to structured logger metrics. Lifted from
 * the ~88L block in main() (single largest extraction win for stageShutdown).
 * Reads metrics from the observability event bus, prunes prompt timeouts,
 * computes stuck-sub-agent counters, force-kills sub-agents past threshold,
 * and emits the canonical "Daemon health" DEBUG line.
 */
export function wireHealthLogging(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  db: GatewayHandle["db"];
  maintenanceTick: GatewayHandle["maintenanceTick"];
  subAgentRunner: GatewayHandle["subAgentRunner"];
  promptTimeoutTimestamps: GatewayHandle["promptTimeoutTimestamps"];
  activeExecutions: GatewayHandle["activeExecutions"];
  getActiveConnectionCount: GatewayHandle["getActiveConnectionCount"];
  deadLetterQueue: GatewayHandle["deadLetterQueue"];
  providerHealth: GatewayHandle["providerHealth"];
  deliveryQueue: GatewayHandle["deliveryQueue"];
}): void {
  const {
    container, daemonLogger, db, maintenanceTick, subAgentRunner,
    promptTimeoutTimestamps, activeExecutions, getActiveConnectionCount,
    deadLetterQueue, providerHealth, deliveryQueue,
  } = deps;
  container.eventBus.on("observability:metrics", async (metrics) => {
    // Prune prompt timeout timestamps to 5-minute window
    const fiveMinAgo = Date.now() - 5 * 60_000;
    while (promptTimeoutTimestamps.length > 0 && promptTimeoutTimestamps[0]! < fiveMinAgo) {
      promptTimeoutTimestamps.shift();
    }
    const { memoryDbSizeBytes, memoryDbWalSizeBytes } = readDbSizeMetrics(db);
    maintenanceTick();
    const { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick } =
      computeAndKillStuckSubAgents({ container, daemonLogger, subAgentRunner });
    daemonLogger.debug({
      rssBytes: metrics.rssBytes, heapUsedBytes: metrics.heapUsedBytes,
      heapTotalBytes: metrics.heapTotalBytes, externalBytes: metrics.externalBytes,
      eventLoopP99Ms: Math.round(metrics.eventLoopDelayMs.p99 * 100) / 100,
      activeHandles: metrics.activeHandles, activeConnections: getActiveConnectionCount(),
      activeExecutions: activeExecutions.size, uptimeSeconds: Math.round(metrics.uptimeSeconds),
      activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick,
      deadLetterQueueSize: deadLetterQueue?.size() ?? 0,
      degradedProviders: [...providerHealth.getHealthSummary().entries()]
        .filter(([, v]) => v.degraded).map(([k]) => k),
      promptTimeoutsLast5m: promptTimeoutTimestamps.length,
      ...(memoryDbSizeBytes !== undefined && { memoryDbSizeBytes }),
      ...(memoryDbWalSizeBytes !== undefined && { memoryDbWalSizeBytes }),
      pendingDeliveryCount: await deliveryQueue.pendingEntries().then(r => r.ok ? r.value.length : 0),
    }, "Daemon health");
  });
}

/**
 * Emit startup banner + docker restart-policy warn + OAuth TLS preflight.
 * Lifted from the ~25L block in main(). Emits the canonical
 * "Comis daemon started" INFO line (log line 5 in daemon-lifecycle.test.ts).
 */
/** Build the startup-banner manifest sub-object (secrets/memory/agents/skills/gateway). */
export function buildStartupBannerManifest(deps: {
  container: GatewayHandle["container"];
  agents: GatewayHandle["agentsConfig"];
  db: GatewayHandle["db"];
  secretStore: GatewayHandle["secretStore"];
  cachedPort: GatewayHandle["cachedPort"];
  ttsAdapter: GatewayHandle["ttsAdapter"];
  visionRegistry: GatewayHandle["visionRegistry"];
}): Record<string, unknown> {
  const { container, agents, db, secretStore, cachedPort, ttsAdapter, visionRegistry } = deps;
  const gwConfig = container.config.gateway;
  return {
    secrets: { encrypted: !!secretStore },
    memory: { embedding: !!cachedPort, dbPath: db.name },
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, cfg]) => [id, { model: cfg.model }]),
    ),
    skills: {
      tts: !!ttsAdapter,
      vision: visionRegistry ? [...visionRegistry.keys()] : [],
      linkUnderstanding: container.config.integrations.media.linkUnderstanding.enabled,
    },
    gateway: {
      enabled: gwConfig.enabled,
      port: gwConfig.enabled ? gwConfig.port : undefined,
      tls: !!gwConfig.tls?.certPath,
    },
  };
}

export function emitStartupBanner(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  daemonVersion: GatewayHandle["daemonVersion"];
  agents: GatewayHandle["agentsConfig"];
  adaptersByType: GatewayHandle["adaptersByType"];
  configPaths: GatewayHandle["configPaths"];
  db: GatewayHandle["db"];
  secretStore: GatewayHandle["secretStore"];
  cachedPort: GatewayHandle["cachedPort"];
  ttsAdapter: GatewayHandle["ttsAdapter"];
  visionRegistry: GatewayHandle["visionRegistry"];
  startupStartMs: number;
  instanceId: string;
}): void {
  const {
    container, daemonLogger, daemonVersion, agents, adaptersByType, configPaths,
    db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    startupStartMs, instanceId,
  } = deps;
  const gwConfig = container.config.gateway;
  daemonLogger.info({
    version: daemonVersion, agents: Object.keys(agents),
    channels: Array.from(adaptersByType.keys()),
    port: gwConfig.enabled ? gwConfig.port : undefined, instanceId,
    startupDurationMs: Date.now() - startupStartMs, configPaths, dbPath: db.name,
    logLevel: container.config.logLevel ?? "info", nodeVersion: process.versions.node,
    manifest: buildStartupBannerManifest({
      container, agents, db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    }),
  }, "Comis daemon started");
  // Docker-only: surface restart-policy requirement immediately after the
  // startup banner. No-op outside containers. Wired here so the WARN lands
  // in `docker logs` next to the banner, where operators look first.
  emitDockerRestartPolicyWarn(daemonLogger);
  // Boot-time TLS preflight against auth.openai.com.
  // Fire-and-forget -- daemon is already serving by this point; the WARN
  // is purely advisory. Skipped when no OAuth-using agent is configured.
  if (hasAnyOAuthAgent(container.config.agents)) {
    void emitOAuthTlsPreflightWarn(daemonLogger);
  }
}
