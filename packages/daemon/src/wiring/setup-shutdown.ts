/**
 * Shutdown setup: graceful shutdown with ordered teardown sequence.
 * Extracted from daemon.ts step 8 to isolate shutdown registration and
 * signal handlers from the main wiring sequence.
 * @module
 */

import type { AppContainer, ApprovalGate, SecretStorePort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { GatewayServerHandle } from "@comis/gateway";
import type { HeartbeatRunner, CronScheduler, WakeCoalescer, PerAgentHeartbeatRunner } from "@comis/scheduler";
import type { BrowserService, MediaTempManager } from "@comis/skills";
import type { SessionResetScheduler } from "@comis/agent";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ProcessMonitor } from "../process/process-monitor.js";
import { registerGracefulShutdown, type ShutdownHandle } from "../process/graceful-shutdown.js";
import type { RestartContinuationTracker } from "./restart-continuation.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for shutdown setup. */
export interface ShutdownDeps {
  /** Root logger for shutdown progress messages. */
  logger: ComisLogger;
  /** Module-bound logger for daemon lifecycle events. */
  daemonLogger: ComisLogger;
  /** System resource monitoring (CPU, memory, event loop). */
  processMonitor: ProcessMonitor;
  /** Bootstrap output (shutdown method). */
  container: AppContainer;
  /** Override process.exit for testability. */
  exitFn: (code: number) => void;
  /** Factory function for graceful shutdown (from DaemonOverrides pattern). */
  _registerGracefulShutdown: typeof registerGracefulShutdown;
  /** In-flight gateway executions for shutdown observability. */
  activeExecutions?: Map<string, { agentId: string; startedAt: number }>;
  /** Graph coordinator for DAG execution cleanup (optional). */
  graphCoordinator?: { shutdown: () => Promise<void> };
  /** Sub-agent runner with shutdown/drain method. */
  subAgentRunner: { shutdown: () => Promise<void> };
  /** Per-agent cron schedulers. */
  cronSchedulers: Map<string, CronScheduler>;
  /** Per-agent session reset schedulers. */
  resetSchedulers: Map<string, SessionResetScheduler>;
  /** Per-agent browser automation services. */
  browserServices: Map<string, BrowserService>;
  /** Channel lifecycle manager (optional). */
  channelManager?: { stopAll: () => Promise<void> };
  /** Heartbeat runner for periodic health checks (optional). */
  heartbeatRunner?: HeartbeatRunner;
  /** Per-agent heartbeat runner for shutdown cleanup */
  perAgentRunner?: PerAgentHeartbeatRunner;
  /** Wake coalescer for timer cleanup on shutdown */
  wakeCoalescer?: WakeCoalescer;
  /** Gateway HTTP/WebSocket server handle (optional). */
  gatewayHandle?: GatewayServerHandle;
  /** Token usage tracker for shutdown cost summary. */
  tokenTracker: TokenTracker;
  /** Daemon startup timestamp for uptime calculation. */
  startupTimestamp: number;
  /** Diagnostic event collector. */
  diagnosticCollector: DiagnosticCollector;
  /** Per-channel activity tracking. */
  channelActivityTracker: ChannelActivityTracker;
  /** End-to-end message delivery tracing. */
  deliveryTracer: DeliveryTracer;
  /** Media temp directory manager for cleanup stop (optional). */
  mediaTempManager?: MediaTempManager;
  /** Background embedding indexing promise (optional). */
  backgroundIndexingPromise?: Promise<unknown>;
  /** Raw database handle for close. */
  db: { close: () => void };
  /** Coordinated embedding dispose callback: L1 -> L2 flush -> provider dispose */
  disposeEmbedding?: () => Promise<void>;
  /** Per-agent skill watcher handles for shutdown cleanup. */
  skillWatcherHandles?: Map<string, { close: () => Promise<void> }>;
  /** Approval gate for cleanup of pending timers */
  approvalGate?: ApprovalGate;
  /** SQLite secret store handle for shutdown (optional). */
  secretStore?: SecretStorePort;
  /** Audit event aggregator for clearing pending dedup timers (optional). */
  auditAggregator?: { destroy: () => void };
  /** Injection rate limiter for clearing timers on shutdown (optional). */
  injectionRateLimiter?: { destroy: () => void };
  /** Periodic lock cleanup timer (from setupAgents). */
  lockCleanupTimer?: ReturnType<typeof setInterval>;
  /** Data directory for restart continuation file (optional). */
  dataDir?: string;
  /** Restart continuation tracker for capturing active sessions before shutdown (optional). */
  continuationTracker?: RestartContinuationTracker;
  /** Lifecycle reactors for cleanup on shutdown */
  lifecycleReactors?: Array<{ destroy: () => void }>;
  /** Observability persistence write buffers for shutdown drain */
  obsPersistence?: { drainAll(): void; snapshotTimer: ReturnType<typeof setInterval> };
  /** Context pipeline collector for shutdown cleanup */
  contextPipelineCollector?: { dispose(): void };
  /** Gemini CachedContent lifecycle manager for shutdown disposal. */
  geminiCacheManager?: import("@comis/agent").GeminiCacheManager;
}

/** All services produced by the shutdown setup phase. */
export interface ShutdownResult {
  /** Graceful shutdown orchestrator. */
  shutdownHandle: ShutdownHandle;
}

// ---------------------------------------------------------------------------
// Per-step timeout helper (quick-164)
// ---------------------------------------------------------------------------

/** Per-step timeout budget (5s). The outer 30s hard timeout in graceful-shutdown.ts remains unchanged. */
export const STEP_TIMEOUT_MS = 5_000;

async function withStepTimeout(
  fn: () => void | Promise<void>,
  component: string,
  logger: ComisLogger,
): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Shutdown step "${component}" timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn(
      {
        component,
        timeoutMs: STEP_TIMEOUT_MS,
        err: err instanceof Error ? err : String(err),
        hint: `Shutdown step "${component}" hung or failed; continuing with remaining steps`,
        errorKind: "timeout" as const,
      },
      "Shutdown step timed out or failed, continuing",
    );
  }
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Register graceful shutdown with ordered teardown sequence, SIGUSR2 restart
 * handler, and unhandledRejection safety net.
 * @param deps - Shutdown dependencies (all services to tear down)
 */
export function setupShutdown(deps: ShutdownDeps): ShutdownResult {
  const {
    logger,
    daemonLogger,
    processMonitor,
    container,
    exitFn,
    _registerGracefulShutdown,
    tokenTracker,
    startupTimestamp,
    activeExecutions,
    graphCoordinator,
    subAgentRunner,
    cronSchedulers,
    resetSchedulers,
    browserServices,
    channelManager,
    heartbeatRunner,
    perAgentRunner,
    wakeCoalescer,
    gatewayHandle,
    diagnosticCollector,
    channelActivityTracker,
    deliveryTracer,
    mediaTempManager,
    backgroundIndexingPromise,
    db,
    disposeEmbedding,
    skillWatcherHandles,
    approvalGate,
    secretStore,
    auditAggregator,
    injectionRateLimiter,
    lockCleanupTimer,
    dataDir,
    continuationTracker,
    lifecycleReactors,
    obsPersistence,
    geminiCacheManager,
  } = deps;

  const shutdownHandle = _registerGracefulShutdown({
    logger,
    processMonitor,
    container,
    exit: exitFn,
    onShutdown: async () => {
      let shutdownOrder = 0;

      // Daemon session cost summary
      const allUsage = tokenTracker.getAll();
      const totalCostUsd = allUsage.reduce((sum, e) => sum + e.cost.total, 0);
      const totalTokens = allUsage.reduce((sum, e) => sum + e.tokens.total, 0);
      daemonLogger.info({
        totalExecutions: allUsage.length,
        totalCostUsd,
        totalTokens,
        uptimeMs: Date.now() - startupTimestamp,
      }, "Daemon session summary");

      // Log in-flight gateway executions (channel adapter and sub-agent paths are future work)
      if (activeExecutions?.size && activeExecutions.size > 0) {
        logger.warn({
          activeCount: activeExecutions.size,
          executions: Array.from(activeExecutions.values()).map(e => ({
            agentId: e.agentId,
            elapsedMs: Date.now() - e.startedAt,
          })),
          hint: "These executions will be interrupted by shutdown",
          errorKind: "internal" as const,
        }, "Interrupting in-flight agent executions");
      }

      // -----------------------------------------------------------------------
      // Gateway stop FIRST -- prevent new HTTP/WS connections while tearing down
      // -----------------------------------------------------------------------
      if (gatewayHandle) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await gatewayHandle.stop();
          daemonLogger.info({ component: "gateway", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "gateway", daemonLogger);
      }

      // Shutdown graph coordinator -- before subAgentRunner so coordinator
      // unsubscribes from events and cancels graphs before runner stops
      if (graphCoordinator) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await graphCoordinator.shutdown();
          daemonLogger.info({ component: "graph-coordinator", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "graph-coordinator", daemonLogger);
      }

      // Drain active sub-agent runs before stopping other services
      {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await subAgentRunner.shutdown();
          daemonLogger.info({ component: "sub-agent-runner", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "sub-agent-runner", daemonLogger);
      }

      // Clear periodic lock cleanup timer
      if (lockCleanupTimer) {
        await withStepTimeout(() => {
          clearInterval(lockCleanupTimer);
          daemonLogger.info({ component: "lock-cleanup-timer", shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "lock-cleanup-timer", daemonLogger);
      }

      // Serialize and dispose approval gate
      if (approvalGate) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          // Serialize pending approvals for restart restoration
          if (dataDir) {
            const serialized = approvalGate.serializePending();
            if (serialized.length > 0) {
              writeFileSync(
                join(dataDir, "restart-approvals.json"),
                JSON.stringify(serialized, null, 2),
                "utf-8",
              );
              daemonLogger.info(
                { component: "approval-gate", count: serialized.length, shutdownOrder },
                "Pending approvals serialized for restart",
              );
            }
          }
          // Serialize approval cache for restart
          if (dataDir) {
            const cachedApprovals = approvalGate.serializeApprovalCache();
            if (cachedApprovals.length > 0) {
              writeFileSync(
                join(dataDir, "restart-approval-cache.json"),
                JSON.stringify(cachedApprovals, null, 2),
                "utf-8",
              );
              daemonLogger.info(
                { component: "approval-gate", count: cachedApprovals.length, shutdownOrder },
                "Approval cache serialized for restart",
              );
            }
          }
          approvalGate.dispose();
          daemonLogger.info({ component: "approval-gate", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "approval-gate", daemonLogger);
      }

      // Stop skill file watchers
      if (skillWatcherHandles) {
        for (const [agentId, handle] of skillWatcherHandles) {
          const stopMs = Date.now();
          await withStepTimeout(async () => {
            await handle.close();
            daemonLogger.info({ component: "skill-watcher", agentId, durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
          }, "skill-watcher", daemonLogger);
        }
      }

      for (const [agentId, scheduler] of cronSchedulers) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          scheduler.stop();
          daemonLogger.info({ component: "cron-scheduler", agentId, durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "cron-scheduler", daemonLogger);
      }
      // Stop reset schedulers
      for (const [agentId, scheduler] of resetSchedulers) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          scheduler.stop();
          daemonLogger.info({ component: "session-reset-scheduler", agentId, durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "session-reset-scheduler", daemonLogger);
      }
      // Stop browser services (Chrome processes)
      for (const [agentId, service] of browserServices) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await service.stop();
          daemonLogger.info({ component: "browser-service", agentId, durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "browser-service", daemonLogger);
      }
      // Capture active sessions for restart continuation (before adapters stop)
      if (continuationTracker && dataDir) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          const captured = continuationTracker.capture(
            join(dataDir, "restart-continuations.json"),
            5 * 60_000, // sessions active in last 5 minutes
          );
          if (captured > 0) {
            daemonLogger.info({ component: "restart-continuation", captured, durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Active sessions captured for restart");
          }
        }, "restart-continuation", daemonLogger);
      }

      // Destroy lifecycle reactors before stopping adapters
      if (lifecycleReactors && lifecycleReactors.length > 0) {
        await withStepTimeout(() => {
          for (const reactor of lifecycleReactors) {
            reactor.destroy();
          }
          daemonLogger.info({ component: "lifecycle-reactors", count: lifecycleReactors.length, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "lifecycle-reactors", daemonLogger);
      }

      // Stop channel adapters
      if (channelManager) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await channelManager.stopAll();
          daemonLogger.info({ component: "channel-manager", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "channel-manager", daemonLogger);
      }
      if (heartbeatRunner) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          heartbeatRunner.stop();
          daemonLogger.info({ component: "heartbeat-runner", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "heartbeat-runner", daemonLogger);
      }
      if (perAgentRunner) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          perAgentRunner.stop();
          daemonLogger.info({ component: "per-agent-heartbeat-runner", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "per-agent-heartbeat-runner", daemonLogger);
      }
      if (wakeCoalescer) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          wakeCoalescer.shutdown();
          daemonLogger.info({ component: "wake-coalescer", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "wake-coalescer", daemonLogger);
      }
      // Dispose all active Gemini caches on shutdown
      if (geminiCacheManager) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await geminiCacheManager.disposeAll();
          daemonLogger.info({ component: "gemini-cache", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "gemini-cache", daemonLogger);
      }
      if (mediaTempManager) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          mediaTempManager.stopCleanupInterval();
          daemonLogger.info({ component: "media-temp-manager", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "media-temp-manager", daemonLogger);
      }
      // Drain observability write buffers BEFORE collector dispose and db.close
      if (obsPersistence) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          clearInterval(obsPersistence.snapshotTimer);
          obsPersistence.drainAll();
          daemonLogger.info({ component: "obs-persistence", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "obs-persistence", daemonLogger);
      }
      // Dispose observability modules (remove EventBus subscriptions)
      {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          deps.contextPipelineCollector?.dispose();
          diagnosticCollector.dispose();
          channelActivityTracker.dispose();
          deliveryTracer.dispose();
          daemonLogger.info({ component: "observability", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "observability", daemonLogger);
      }
      // Wait for background embedding indexing to finish (with timeout -- has its own 5s race)
      if (backgroundIndexingPromise) {
        await Promise.race([
          backgroundIndexingPromise,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      // Dispose embedding cache chain (L1 -> L2 flush -> provider dispose) -- after indexing finishes, before db.close
      if (disposeEmbedding) {
        const stopMs = Date.now();
        await withStepTimeout(async () => {
          await disposeEmbedding();
          daemonLogger.info({ component: "embedding-cache", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "embedding-cache", daemonLogger);
      }
      // Destroy audit aggregator timers
      if (auditAggregator) {
        await withStepTimeout(() => {
          auditAggregator.destroy();
          daemonLogger.info({ component: "audit-aggregator", shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "audit-aggregator", daemonLogger);
      }
      // Destroy injection rate limiter timers
      if (injectionRateLimiter) {
        await withStepTimeout(() => {
          injectionRateLimiter.destroy();
          daemonLogger.info({ component: "injection-rate-limiter", shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "injection-rate-limiter", daemonLogger);
      }
      // Close secret store database
      if (secretStore) {
        const stopMs = Date.now();
        await withStepTimeout(() => {
          secretStore.close();
          daemonLogger.info({ component: "secret-store", durationMs: Date.now() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "secret-store", daemonLogger);
      }
      // Context pipeline collector dispose (already disposed above via observability block;
      // kept as explicit step for documentation; the ?. guard makes double-call safe)

      // DB close is ALWAYS last -- no withStepTimeout (must complete or the outer 30s hard timeout handles it)
      {
        const stopMs = Date.now();
        db.close();
        daemonLogger.info({ component: "memory-database", durationMs: Date.now() - stopMs, shutdownOrder: shutdownOrder + 1 }, "Component stopped");
      }
    },
  });

  // 8.5. Register SIGUSR2 handler for graceful restart
  process.on("SIGUSR2", () => {
    daemonLogger.info("SIGUSR2 received, initiating restart");
    void shutdownHandle.trigger("SIGUSR2");
  });

  // 8.6. Safety net: catch unhandled promise rejections (non-fatal)
  process.on("unhandledRejection", (reason) => {
    daemonLogger.error(
      { err: reason instanceof Error ? reason : String(reason), hint: "Check stack trace for origin of unhandled promise", errorKind: "internal" as const },
      "Unhandled promise rejection (non-fatal)",
    );
  });

  // 8.7. Safety net for uncaught exceptions -- route through Pino instead of raw stderr.
  // Note: node-llama-cpp native module warnings write directly to stderr and cannot be
  // captured by this handler. Those are a known limitation of native module stderr output.
  process.on("uncaughtException", (err) => {
    daemonLogger.error(
      { err, hint: "Check stack trace for origin of uncaught exception", errorKind: "internal" as const },
      "Uncaught exception (non-fatal)",
    );
  });

  return { shutdownHandle };
}
