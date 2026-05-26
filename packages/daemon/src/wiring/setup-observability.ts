// SPDX-License-Identifier: Apache-2.0
/**
 * Observability subsystem setup: token tracking, latency recording,
 * cost aggregation, diagnostics, billing, channel activity, and
 * delivery tracing.
 * Extracted from daemon.ts steps 4 through 4.5 to isolate
 * cross-agent observability wiring from the main startup sequence.
 * @module
 */

import type { AppContainer } from "@comis/core";
import { systemSetInterval, getToolMetadata } from "@comis/core";
import { createActivityStream, type ActivityStream } from "@comis/observability";
import { createCostTracker, createCacheBreakDiffWriter } from "@comis/agent";
import type { createTokenTracker } from "../observability/token-tracker.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import { createDiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import { createBillingEstimator } from "../observability/billing-estimator.js";
import type { BillingEstimator } from "../observability/billing-estimator.js";
import { createChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import { createDeliveryTracer } from "../observability/delivery-tracer.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the observability setup phase. */
export interface ObservabilityResult {
  tokenTracker: TokenTracker;
  sharedCostTracker: ReturnType<typeof createCostTracker>;
  diagnosticCollector: DiagnosticCollector;
  billingEstimator: BillingEstimator;
  channelActivityTracker: ChannelActivityTracker;
  deliveryTracer: DeliveryTracer;
  /**
   * The canonical redacted `ActivityEvent` source (WIRE-01, §17.7). Subscribes
   * to the EventBus at construction; the daemon injects it as the orchestrator-
   * facing `ActivityStreamPort` (via `ExecutionPipelineDeps.activityStreamPort`)
   * and the ACP renderer hook. It is NEVER imported directly by the orchestrator
   * — the composition root owns this DI seam (the core+observability→channels
   * boundary; TURN-03/§4.7).
   */
  activityStream: ActivityStream;
  /**
   * Drain + unsubscribe hook for {@link activityStream} (WIRE-01/WIRE-05). The
   * shutdown chain calls this to detach every EventBus handler and clear the
   * correlation index so per-turn bounded queues drain and no pending placeholder
   * is orphaned across a restart (T-70-10-03).
   */
  disposeActivityStream: () => void;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full observability subsystem: token tracker, shared cost
 * tracker with event-bus subscription, diagnostic collector, billing
 * estimator, channel activity tracker, and delivery tracer.
 * @param deps.eventBus - Typed event bus from bootstrap container
 * @param deps._createTokenTracker - Factory (overridable for tests)
 */
export function setupObservability(deps: {
  eventBus: AppContainer["eventBus"];
  _createTokenTracker: typeof createTokenTracker;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  /** Data directory for persistent observability files (e.g., cache-break diffs) */
  dataDir?: string;
  /**
   * Bound logger for the ActivityStream (WIRE-01/OBS-02). Injected so the stream
   * never constructs its own logger; when absent the stream is silent. The
   * `ComisLogger` shape is structural — passing the daemon's
   * `logLevelManager.getLogger("activity-stream")` satisfies it.
   */
  activityLogger?: import("@comis/core").ComisLogger;
  /**
   * Operator home directory for the ActivityStream's SEC-02 `$HOME`→`~` path
   * compaction. Read once at this sanctioned composition root and injected; the
   * substrate performs no env reads of its own.
   */
  homeDir?: string;
}): ObservabilityResult {
  const { eventBus, _createTokenTracker } = deps;

  // 4. Create token tracker
  const tokenTracker = _createTokenTracker(eventBus);

  // 4.5. Create observability modules (diagnostic events, billing, channel activity)
  // Shared CostTracker for cross-agent billing aggregation -- subscribes to
  // observability:token_usage events from ALL agents so the BillingEstimator
  // can provide accurate cross-agent billing summaries.
  const sharedCostTracker = createCostTracker();

  eventBus.on("observability:token_usage", (payload) => {
    sharedCostTracker.record(
      payload.agentId,
      payload.channelId,
      payload.executionId,
      {
        input: payload.tokens.prompt,
        output: payload.tokens.completion,
        totalTokens: payload.tokens.total,
        cost: payload.cost,
        provider: payload.provider,
        model: payload.model,
        // operationType flows through bridge's direct costTracker.record() call.
        // This secondary event-bus path defaults to "interactive" until the observability event
        // schema is extended to carry operationType (tracked as future enhancement).
        operationType: "interactive",
      },
    );
  });

  // Log cache break events for operational observability
  if (deps.logger) {
    eventBus.on("observability:cache_break", (payload) => {
      deps.logger!.info(
        {
          provider: payload.provider,
          reason: payload.reason,
          tokenDrop: payload.tokenDrop,
          tokenDropRelative: payload.tokenDropRelative,
          agentId: payload.agentId,
          sessionKey: payload.sessionKey,
          ttlCategory: payload.ttlCategory,
          toolsChanged: payload.toolsChanged.length,
          systemChanged: payload.changes.systemChanged,
          modelChanged: payload.changes.modelChanged,
        },
        "Cache break detected",
      );
    });
  }

  // Persist cache break diagnostics to ~/.comis/cache-breaks/
  if (deps.dataDir && deps.logger) {
    const diffWriter = createCacheBreakDiffWriter({
      outputDir: `${deps.dataDir}/cache-breaks`,
      // Confinement base for the fs-safe substrate — the resolved real
      // path of every diff artifact must stay inside the operator's data
      // root (closes the ancestor-symlink escape).
      dataDir: deps.dataDir,
      logger: deps.logger as { warn: (obj: Record<string, unknown>, msg: string) => void },
    });
    eventBus.on("observability:cache_break", diffWriter);
  }

  // WIRE-01: construct the canonical ActivityStream substrate (70-08). It
  // subscribes to the EventBus immediately (tool:*/model:*/approval:*) and maps
  // each to a redacted ActivityEvent. The bound logger is injected (OBS-02 — no
  // in-module getLogger); `getToolMetadata` (the @comis/core module registry)
  // honors per-tool `suppressActivity`; `homeDir` drives the SEC-02 $HOME→~
  // path compaction (read once here at the sanctioned composition root). The
  // returned port is the orchestrator-facing ActivityStreamPort.
  const activityStream = createActivityStream({
    eventBus,
    logger: deps.activityLogger,
    getToolMetadata,
    homeDir: deps.homeDir,
  });

  const diagnosticCollector = createDiagnosticCollector({
    eventBus,
  });
  const billingEstimator = createBillingEstimator({
    costTracker: sharedCostTracker,
  });
  const channelActivityTracker = createChannelActivityTracker({
    eventBus,
  });
  const deliveryTracer = createDeliveryTracer({
    eventBus,
  });

  // Auto-prune observability data every 30 minutes, keeping last 24 hours.
  // Timer uses .unref() so it does not prevent process exit.
  const PRUNE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  const PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  const pruneTimer = systemSetInterval(() => {
    tokenTracker.prune(PRUNE_MAX_AGE_MS);
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  return {
    tokenTracker,
    sharedCostTracker,
    diagnosticCollector,
    billingEstimator,
    channelActivityTracker,
    deliveryTracer,
    activityStream,
    // WIRE-05 drain hook: dispose() detaches every EventBus handler and clears
    // the correlation index. The shutdown chain invokes this so pending per-turn
    // bounded queues drain and no placeholder is orphaned across restart.
    disposeActivityStream: () => activityStream.dispose(),
  };
}
