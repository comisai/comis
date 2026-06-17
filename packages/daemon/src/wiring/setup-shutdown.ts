// SPDX-License-Identifier: Apache-2.0
/**
 * Shutdown setup: sole owner of the daemon teardown chain. Owns SIGTERM/
 * SIGINT/SIGUSR2 handler registration, the `shuttingDown` re-entrancy
 * guard, the 30s hard timeout, the per-step 5s timeout (`STEP_TIMEOUT_MS`),
 * logger.flush, exit-code dispatch, the `process.on("exit", ...)` safety
 * net, and the ordered teardown of all 30+ subsystems. Inlines the
 * `process/graceful-shutdown.ts` body into this file so the entire chain
 * is legible in one place.
 * @module
 */

import type { AppContainer, ApprovalGate, SecretStorePort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { GatewayServerHandle } from "@comis/gateway";
import type { HeartbeatRunner, CronScheduler, WakeCoalescer, PerAgentHeartbeatRunner } from "@comis/scheduler";
import type { BrowserService, MediaTempManager } from "@comis/skills";
import type { SessionResetScheduler } from "@comis/agent";
import { safePath, systemNowMs, systemSetTimeout, systemClearTimeout, systemClearInterval } from "@comis/core";
import { withStepTimeout } from "./shutdown-step-timeout.js";
import { releaseDataDirLock } from "./data-dir-lock.js";
// Re-export STEP_TIMEOUT_MS so existing imports of it from setup-shutdown.ts continue to work.
export { STEP_TIMEOUT_MS } from "./shutdown-step-timeout.js";
import { writeRegularFile } from "@comis/observability";
import type { ProcessMonitor } from "../process/process-monitor.js";
import type { RestartContinuationTracker } from "./restart-continuation.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Handle for the daemon shutdown orchestrator. `isShuttingDown` exposes
 * the closure-scoped re-entrancy flag. `trigger(signal)` runs the shutdown
 * body programmatically (used by integration tests). `dispose()`
 * removes the SIGTERM/SIGINT listeners (test cleanup).
 */
export interface ShutdownHandle {
  readonly isShuttingDown: boolean;
  trigger(signal: string): Promise<void>;
  dispose(): void;
}

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
  /** Hard-timeout (ms) before shutdown force-exits with code 1. Default 30_000; must be < systemd TimeoutStopSec. */
  timeoutMs?: number;
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
  db: { close: () => void; pragma: (source: string) => unknown };
  /** Coordinated embedding dispose callback: L1 -> L2 flush -> provider dispose */
  disposeEmbedding?: () => Promise<void>;
  disposeReranker?: () => Promise<void>;  // reranker native ctx dispose; undefined when off
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
  /** WR-01 (Phase 199): tear down the reaction/session trajectory maps + the dedicated reaction rate limiter (optional). */
  destroyReactionWiring?: () => void;
  /** Periodic lock cleanup timer (from setupAgents). */
  lockCleanupTimer?: import("@comis/core").TimerHandle;
  /** Data directory for restart continuation file (optional). */
  dataDir?: string;
  /**
   * Boot-resolved data dir (COMIS_DATA_DIR ?? ~/.comis) where the D14 lock
   * was acquired — `dataDir` above is config-resolved and diverges whenever
   * COMIS_DATA_DIR is set; releasing there leaks the real lock. Falls back
   * to `dataDir` when unset.
   */
  lockDataDir?: string;
  /** Restart continuation tracker for capturing active sessions before shutdown (optional). */
  continuationTracker?: RestartContinuationTracker;
  /** Lifecycle reactors for cleanup on shutdown */
  lifecycleReactors?: Array<{ destroy: () => void }>;
  /** Observability persistence write buffers for shutdown drain */ obsPersistence?: { drainAll(): void; snapshotTimer: ReturnType<typeof setInterval> };
  disposeActivityStream?: () => void; // §17.7: drain + unsubscribe ActivityStream
  /** Context pipeline collector for shutdown cleanup */
  contextPipelineCollector?: { dispose(): void };
  /** Gemini CachedContent lifecycle manager for shutdown disposal. */
  geminiCacheManager?: import("@comis/agent").GeminiCacheManager;
  /**
   * Session-scoped trajectory recorder registry. Shutdown drains every
   * open per-session recorder via `closeAll()` — flushes the JSONL tail
   * and writes the `trace.truncated` sentinel for any dropped events.
   * Constructed in setupAgents and surfaced on AgentsResult.
   */
  trajectoryRegistry?: import("@comis/observability").SessionTrajectoryHandleRegistry;
  // ---------------------------------------------------------------------
  // Lifted teardowns
  // Previously these ran via container.eventBus.on("system:shutdown", …)
  // subscribers, but no production emitter existed — they silently
  // no-op'd in production. They are now direct fields invoked by this
  // composition root.
  //
  // 8 production subscribers expand to 9 fields because setup-tools.ts's
  // single closure splits into background-processes + mcp-client-manager.
  // ---------------------------------------------------------------------
  /** Drain per-agent background-process registries (from setupTools). */
  shutdownBackgroundProcesses?: () => Promise<void>;
  /** Disconnect MCP clients. */
  mcpClientManagerDisconnectAll?: () => Promise<void>;
  /** Drain background completion runner. */
  bgCompletionRunnerShutdown?: () => Promise<void>;
  /** Drain the terminal wake-FSM — unsubscribe from the bus + await in-flight woken turns (124-09). */
  terminalWakeShutdown?: () => Promise<void>;
  /** Cleanup proxy typing controllers + sweep timer (from registerProxyTypingListeners). */
  proxyTypingCleanup?: () => void;
  /** Stop the delivery queue (from setupDeliveryQueue). */
  shutdownDeliveryQueue?: () => void;
  /** Stop the background video poller — sweeper interval + in-flight loops (189). */
  shutdownVideoPoller?: () => void;
  /** Stop the delivery mirror (from setupDeliveryMirror). */
  shutdownDeliveryMirror?: () => void;
  /** Stop the output retention housekeeper (from setupOutputRetention). */ outputRetentionShutdown?: () => void;
  /** Stop the channel health monitor (from setupChannelHealthMonitor). */
  stopChannelHealthMonitor?: () => void;
  /** Unsubscribe health budget aggregator. */ unsubscribeHealthAggregator?: () => void;
  /** Stop the credential broker (TCP + unix socket teardown). Only present when executor.broker is configured. */
  brokerStop?: () => Promise<void>;
}

/** All services produced by the shutdown setup phase. */
export interface ShutdownResult {
  /** Graceful shutdown orchestrator. */
  shutdownHandle: ShutdownHandle;
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
    disposeReranker,
    skillWatcherHandles,
    approvalGate,
    secretStore,
    auditAggregator,
    injectionRateLimiter,
    destroyReactionWiring,
    lockCleanupTimer,
    dataDir,
    lockDataDir,
    continuationTracker,
    lifecycleReactors,
    obsPersistence, disposeActivityStream,
    geminiCacheManager,
    trajectoryRegistry,
    // 9 new teardown handles lifted from system:shutdown subscribers.
    shutdownBackgroundProcesses,
    mcpClientManagerDisconnectAll,
    bgCompletionRunnerShutdown,
    terminalWakeShutdown,
    proxyTypingCleanup,
    shutdownDeliveryQueue,
    shutdownVideoPoller,
    shutdownDeliveryMirror,
    outputRetentionShutdown,
    stopChannelHealthMonitor,
    unsubscribeHealthAggregator,
    brokerStop,
  } = deps;

  // Inlined graceful-shutdown body: SIGTERM/
  // SIGINT/SIGUSR2 handler registration, shuttingDown re-entrancy guard,
  // 30s hard timeout, logger.flush, and exit-code dispatch.
  const hardTimeoutMs = deps.timeoutMs ?? 30_000;
  const exitFnLocal = exitFn;
  let shuttingDown = false;

  /** Runs the full teardown body once. Subsequent calls no-op. */
  const onShutdown = async (): Promise<void> => {
      let shutdownOrder = 0;

      // Collapse the repeated guarded sync-teardown shape
      // `if (fn) { stopMs; await withStepTimeout(() => { fn(); log }, name) }` to
      // one call. Behavior-neutral (same sequential order + `++shutdownOrder`
      // numbering + per-step timeout); a no-op when `fn` is undefined.
      const stopSync = async (fn: (() => void) | undefined, component: string): Promise<void> => {
        if (!fn) return;
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          fn();
          daemonLogger.info({ component, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, component, daemonLogger);
      };

      // Daemon session cost summary
      const allUsage = tokenTracker.getAll();
      const totalCostUsd = allUsage.reduce((sum, e) => sum + e.cost.total, 0);
      const totalTokens = allUsage.reduce((sum, e) => sum + e.tokens.total, 0);
      daemonLogger.info({
        totalExecutions: allUsage.length,
        totalCostUsd,
        totalTokens,
        uptimeMs: systemNowMs() - startupTimestamp,
      }, "Daemon session summary");

      // Log in-flight gateway executions (channel adapter and sub-agent paths are future work)
      if (activeExecutions?.size && activeExecutions.size > 0) {
        logger.warn({
          activeCount: activeExecutions.size,
          executions: Array.from(activeExecutions.values()).map(e => ({
            agentId: e.agentId,
            elapsedMs: systemNowMs() - e.startedAt,
          })),
          hint: "These executions will be interrupted by shutdown",
          errorKind: "internal" as const,
        }, "Interrupting in-flight agent executions");
      }

      // -----------------------------------------------------------------------
      // Gateway stop FIRST -- prevent new HTTP/WS connections while tearing down
      // -----------------------------------------------------------------------
      if (gatewayHandle) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await gatewayHandle.stop();
          daemonLogger.info({ component: "gateway", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "gateway", daemonLogger);
      }

      // Shutdown graph coordinator -- before subAgentRunner so coordinator
      // unsubscribes from events and cancels graphs before runner stops
      if (graphCoordinator) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await graphCoordinator.shutdown();
          daemonLogger.info({ component: "graph-coordinator", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "graph-coordinator", daemonLogger);
      }

      // Drain active sub-agent runs before stopping other services
      {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await subAgentRunner.shutdown();
          daemonLogger.info({ component: "sub-agent-runner", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "sub-agent-runner", daemonLogger);
      }

      // Drain background-completion-runner before stopping
      // subsystems it might enqueue into. Previously this ran inside an
      // eventBus.on("system:shutdown", ...) subscriber in daemon.ts that
      // silently no-op'd in production.
      if (bgCompletionRunnerShutdown) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await bgCompletionRunnerShutdown();
          daemonLogger.info({ component: "background-completion-runner", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "background-completion-runner", daemonLogger);
      }

      // Drain the terminal wake-FSM (124-09): unsubscribe from terminal:input_needed +
      // await any in-flight woken turn so no auto-answer/escalation outlives shutdown.
      if (terminalWakeShutdown) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await terminalWakeShutdown();
          daemonLogger.info({ component: "terminal-wake-dispatch", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "terminal-wake-dispatch", daemonLogger);
      }

      // Drain session-scoped trajectory recorders. Each open session's
      // recorder flushes its queue, writes the trace.truncated sentinel
      // when any events were dropped, and unsubscribes from the EventBus.
      // Must run AFTER sub-agent-runner shutdown (no more events landing)
      // and BEFORE the periodic-lock-cleanup teardown (which doesn't
      // touch the trajectory files).
      if (trajectoryRegistry) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await trajectoryRegistry.closeAll();
          daemonLogger.info({ component: "trajectory-registry", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "trajectory-registry", daemonLogger);
      }

      // Clear periodic lock cleanup timer
      if (lockCleanupTimer) {
        await withStepTimeout(() => {
          lockCleanupTimer.cancel();
          daemonLogger.info({ component: "lock-cleanup-timer", shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "lock-cleanup-timer", daemonLogger);
      }

      // Serialize and dispose approval gate
      if (approvalGate) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          // Serialize pending approvals for restart restoration
          if (dataDir) {
            const serialized = approvalGate.serializePending();
            if (serialized.length > 0) {
              // Route through the fs-safe substrate so the
              // restart-approvals hand-off lands at mode `0o600`.
              // Best-effort contract preserved — Result.err is
              // logged + shutdown continues so a write failure does NOT
              // block daemon teardown.
              const result = writeRegularFile({
                path: safePath(dataDir, "restart-approvals.json"),
                content: JSON.stringify(serialized, null, 2),
                confinedBaseDir: dataDir,
              });
              if (!result.ok) {
                daemonLogger.warn(
                  {
                    err: result.error,
                    hint: "Pending approvals serialization rejected by fs-safe substrate; restart will lose pending approvals",
                    errorKind: "resource" as const,
                  },
                  "Pending approvals write failed",
                );
              } else {
                daemonLogger.info(
                  { component: "approval-gate", count: serialized.length, shutdownOrder },
                  "Pending approvals serialized for restart",
                );
              }
            }
          }
          // Serialize approval cache for restart
          if (dataDir) {
            const cachedApprovals = approvalGate.serializeApprovalCache();
            if (cachedApprovals.length > 0) {
              // Same fs-safe routing for the approval-cache
              // sentinel; mode `0o600`, best-effort write contract.
              const result = writeRegularFile({
                path: safePath(dataDir, "restart-approval-cache.json"),
                content: JSON.stringify(cachedApprovals, null, 2),
                confinedBaseDir: dataDir,
              });
              if (!result.ok) {
                daemonLogger.warn(
                  {
                    err: result.error,
                    hint: "Approval cache serialization rejected by fs-safe substrate; restart will lose cached approvals",
                    errorKind: "resource" as const,
                  },
                  "Approval cache write failed",
                );
              } else {
                daemonLogger.info(
                  { component: "approval-gate", count: cachedApprovals.length, shutdownOrder },
                  "Approval cache serialized for restart",
                );
              }
            }
          }
          approvalGate.dispose();
          daemonLogger.info({ component: "approval-gate", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "approval-gate", daemonLogger);
      }

      // Stop skill file watchers
      if (skillWatcherHandles) {
        for (const [agentId, handle] of skillWatcherHandles) {
          const stopMs = systemNowMs();
          await withStepTimeout(async () => {
            await handle.close();
            daemonLogger.info({ component: "skill-watcher", agentId, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
          }, "skill-watcher", daemonLogger);
        }
      }

      for (const [agentId, scheduler] of cronSchedulers) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          scheduler.stop();
          daemonLogger.info({ component: "cron-scheduler", agentId, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "cron-scheduler", daemonLogger);
      }
      // Stop reset schedulers
      for (const [agentId, scheduler] of resetSchedulers) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          scheduler.stop();
          daemonLogger.info({ component: "session-reset-scheduler", agentId, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "session-reset-scheduler", daemonLogger);
      }
      // Stop browser services (Chrome processes)
      for (const [agentId, service] of browserServices) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await service.stop();
          daemonLogger.info({ component: "browser-service", agentId, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "browser-service", daemonLogger);
      }
      // Capture active sessions for restart continuation (before adapters stop)
      if (continuationTracker && dataDir) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          const captured = continuationTracker.capture(
            safePath(dataDir, "restart-continuations.json"),
            5 * 60_000, // sessions active in last 5 minutes
            // Confinement base for the fs-safe substrate.
            dataDir,
            daemonLogger,
          );
          if (captured > 0) {
            daemonLogger.info({ component: "restart-continuation", captured, durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Active sessions captured for restart");
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
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await channelManager.stopAll();
          daemonLogger.info({ component: "channel-manager", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "channel-manager", daemonLogger);
      }
      // Stop proxy typing controllers + sweep timer. Previously
      // hosted in a system:shutdown subscriber inside
      // registerProxyTypingListeners that silently no-op'd in production.
      if (proxyTypingCleanup) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          proxyTypingCleanup();
          daemonLogger.info({ component: "proxy-typing", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "proxy-typing", daemonLogger);
      }
      // Stop the channel health monitor — replaces the
      // system:shutdown subscriber in daemon.ts.
      if (stopChannelHealthMonitor) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          stopChannelHealthMonitor();
          daemonLogger.info({ component: "channel-health-monitor", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "channel-health-monitor", daemonLogger);
      }
      if (unsubscribeHealthAggregator) unsubscribeHealthAggregator(); // health budget aggregator
      if (heartbeatRunner) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          heartbeatRunner.stop();
          daemonLogger.info({ component: "heartbeat-runner", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "heartbeat-runner", daemonLogger);
      }
      if (perAgentRunner) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          perAgentRunner.stop();
          daemonLogger.info({ component: "per-agent-heartbeat-runner", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "per-agent-heartbeat-runner", daemonLogger);
      }
      if (wakeCoalescer) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          wakeCoalescer.shutdown();
          daemonLogger.info({ component: "wake-coalescer", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "wake-coalescer", daemonLogger);
      }
      // Drain the delivery queue, the Phase-189 background video poller, the
      // delivery mirror, and the output retention housekeeper. Each replaces a
      // system:shutdown subscriber previously installed in channels-helpers.ts that
      // silently no-op'd in production. Order is preserved (sequential await).
      await stopSync(shutdownDeliveryQueue, "delivery-queue");
      await stopSync(shutdownVideoPoller, "video-poller"); // 189: sweeper + in-flight loops
      await stopSync(shutdownDeliveryMirror, "delivery-mirror");
      await stopSync(outputRetentionShutdown, "output-retention");
      // Dispose all active Gemini caches on shutdown
      if (geminiCacheManager) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await geminiCacheManager.disposeAll();
          daemonLogger.info({ component: "gemini-cache", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "gemini-cache", daemonLogger);
      }
      await stopSync(mediaTempManager ? () => mediaTempManager.stopCleanupInterval() : undefined, "media-temp-manager");
      // Drain per-agent background-process registries BEFORE stopping the broker.
      // Background exec processes use the broker as their egress proxy (HTTPS_PROXY
      // → broker TCP port). Stopping the broker first would cut their outbound
      // connections mid-execution. Drain first, then close the broker once no live
      // clients remain. Background processes go before obs-persistence because
      // subprocess cleanup may emit observability events into the still-running
      // write buffer.
      if (shutdownBackgroundProcesses) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await shutdownBackgroundProcesses();
          daemonLogger.info({ component: "background-processes", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "background-processes", daemonLogger);
      }
      // Stop credential broker (TCP + unix socket). Runs AFTER
      // shutdownBackgroundProcesses so no live exec processes are proxied through
      // the broker when its sockets are closed.
      if (brokerStop) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await brokerStop();
          daemonLogger.info({ component: "broker", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "broker", daemonLogger);
      }
      if (mcpClientManagerDisconnectAll) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await mcpClientManagerDisconnectAll();
          daemonLogger.info({ component: "mcp-client-manager", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "mcp-client-manager", daemonLogger);
      }
      // Drain observability write buffers BEFORE collector dispose and db.close
      if (obsPersistence) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          systemClearInterval(obsPersistence.snapshotTimer);
          obsPersistence.drainAll();
          daemonLogger.info({ component: "obs-persistence", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "obs-persistence", daemonLogger);
      }
      // Dispose observability modules (remove EventBus subscriptions).
      {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          disposeActivityStream?.(); // drain ActivityStream FIRST
          deps.contextPipelineCollector?.dispose();
          diagnosticCollector.dispose();
          channelActivityTracker.dispose();
          deliveryTracer.dispose();
          daemonLogger.info({ component: "observability", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "observability", daemonLogger);
      }
      // Wait for background embedding indexing to finish (with timeout -- has its own 5s race)
      if (backgroundIndexingPromise) {
        await Promise.race([
          backgroundIndexingPromise,
          new Promise((resolve) => systemSetTimeout(() => resolve(undefined), 5_000)),
        ]);
      }
      // Dispose embedding cache chain (L1 -> L2 flush -> provider dispose) -- after indexing finishes, before db.close
      if (disposeEmbedding) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await disposeEmbedding();
          daemonLogger.info({ component: "embedding-cache", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "embedding-cache", daemonLogger);
      }
      if (disposeReranker) {
        const stopMs = systemNowMs();
        await withStepTimeout(async () => {
          await disposeReranker();  // reranker native context: ranking ctx -> model -> llama
          daemonLogger.info({ component: "reranker", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "reranker", daemonLogger);
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
      // WR-01 (Phase 199): destroy the reaction/session trajectory maps + the
      // dedicated reaction rate limiter (cancels their unref'd TTL timers so they
      // do not accumulate across SIGUSR2 hot-reload cycles).
      if (destroyReactionWiring) {
        await withStepTimeout(() => {
          destroyReactionWiring();
          daemonLogger.info({ component: "reaction-wiring", shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "reaction-wiring", daemonLogger);
      }
      // Close secret store database
      if (secretStore) {
        const stopMs = systemNowMs();
        await withStepTimeout(() => {
          secretStore.close();
          daemonLogger.info({ component: "secret-store", durationMs: systemNowMs() - stopMs, shutdownOrder: ++shutdownOrder }, "Component stopped");
        }, "secret-store", daemonLogger);
      }
      // Context pipeline collector dispose (already disposed above via observability block;
      // kept as explicit step for documentation; the ?. guard makes double-call safe)

      // Release data-dir singleton lock (D14) — after stores close, before
      // db. At the BOOT dataDir (lockDataDir) where acquire happened, NOT the
      // config-resolved dataDir, which diverges under COMIS_DATA_DIR.
      const lockDir = lockDataDir ?? dataDir;
      if (lockDir) { releaseDataDirLock(lockDir); }

      // DB close is ALWAYS last -- no withStepTimeout (must complete or the outer 30s hard timeout handles it)
      {
        const stopMs = systemNowMs();
        try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort flush before close */ }
        db.close();
        daemonLogger.info({ component: "memory-database", durationMs: systemNowMs() - stopMs, shutdownOrder: shutdownOrder + 1 }, "Component stopped");
      }
  };

  // shutdown(signal): re-entry guard, hard-timeout, ordered cleanup, flush, exit dispatch.
  // exitCode set EARLY so a graceful SIGUSR2 restart still exits 42 even if the loop drains during the awaited flush before exitFnLocal() runs (drain bug 2026-06-14; full incident in setup-shutdown.test.ts). SIGUSR2 ⇒ 42; else 0; error/timeout still exitFnLocal(1), which overrides exitCode.
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    process.exitCode = signal === "SIGUSR2" ? 42 : 0;

    logger.info({ signal }, "Graceful shutdown initiated");
    const shutdownStartMs = systemNowMs();

    // Hard timeout: force exit if cleanup hangs
    const timer = systemSetTimeout(() => {
      logger.error({
        timeoutMs: hardTimeoutMs,
        shutdownDurationMs: systemNowMs() - shutdownStartMs,
        hint: "Increase daemon.shutdownTimeoutMs or investigate hung component",
        errorKind: "timeout" as const,
      }, "Shutdown timeout exceeded, forcing exit");
      exitFnLocal(1);
    }, hardTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref(); // don't keep process alive for the timer
    }

    try {
      processMonitor.stop();         // step 1: no new metrics
      await onShutdown();             // step 2: ordered subsystem teardown
      await container.shutdown();     // step 3: config watcher, event bus
    } catch (error) {
      logger.error({ err: error }, "Error during shutdown");
      systemClearTimeout(timer);
      exitFnLocal(1);
      return;
    }

    logger.info({ shutdownDurationMs: systemNowMs() - shutdownStartMs, signal }, "Graceful shutdown complete");

    // Defense-in-depth flush before exit (pino runtime feature; narrow via local shape).
    const flushable = logger as unknown as { flush?: (cb?: () => void) => void };
    if (typeof flushable.flush === "function") {
      await new Promise<void>((resolve) => {
        flushable.flush!(() => resolve());
        systemSetTimeout(() => resolve(), 2_000).unref(); // safety timeout
      });
    }

    systemClearTimeout(timer);
    // Exit code: SIGUSR2 ⇒ 42 (restart hint — systemd Restart=on-failure /
    // docker unless-stopped / pm2 default treat non-zero as crash and
    // restart). SIGTERM/SIGINT ⇒ 0 (operator-initiated stop).
    const isRestartSignal = signal === "SIGUSR2";
    try {
      exitFnLocal(isRestartSignal ? 42 : 0);
    } catch {
      // Test harness's exit() throws "Daemon exit with code N" by design;
      // swallow to avoid a spurious unhandled-rejection log line.
    }
  }

  // Register SIGTERM/SIGINT handlers + the process.on("exit") safety-net
  // log (preserved verbatim).
  const sigterm = (): void => { void shutdown("SIGTERM"); };
  const sigint = (): void => { void shutdown("SIGINT"); };
  const onExit = (code: number): void => {
    if (!shuttingDown) {
      daemonLogger.info({ exitCode: code, hint: "Process exited without graceful shutdown" }, "Daemon process exiting unexpectedly");
    }
  };
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);
  process.on("exit", onExit);

  // dispose() removes SIGTERM/SIGINT only — preserves the original
  // graceful-shutdown.ts contract (the `exit` listener stays because the
  // process is exiting anyway and tests depend on it).
  const shutdownHandle: ShutdownHandle = {
    get isShuttingDown(): boolean { return shuttingDown; },
    trigger: shutdown,
    dispose(): void {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
    },
  };

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
