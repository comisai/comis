/**
 * Observability subsystem setup: token tracking, latency recording,
 * cost aggregation, diagnostics, billing, channel activity, and
 * delivery tracing.
 * Extracted from daemon.ts steps 4 through 4.5 to isolate
 * cross-agent observability wiring from the main startup sequence.
 * @module
 */

import type { AppContainer } from "@comis/core";
import { createCostTracker, createCacheBreakDiffWriter } from "@comis/agent";
import type { createTokenTracker } from "../observability/token-tracker.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import type { createLatencyRecorder } from "../observability/latency-recorder.js";
import type { LatencyRecorder } from "../observability/latency-recorder.js";
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
  latencyRecorder: LatencyRecorder;
  sharedCostTracker: ReturnType<typeof createCostTracker>;
  diagnosticCollector: DiagnosticCollector;
  billingEstimator: BillingEstimator;
  channelActivityTracker: ChannelActivityTracker;
  deliveryTracer: DeliveryTracer;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full observability subsystem: token tracker, latency
 * recorder, shared cost tracker with event-bus subscription,
 * diagnostic collector, billing estimator, channel activity tracker,
 * and delivery tracer.
 * @param deps.eventBus - Typed event bus from bootstrap container
 * @param deps._createTokenTracker - Factory (overridable for tests)
 * @param deps._createLatencyRecorder - Factory (overridable for tests)
 */
export function setupObservability(deps: {
  eventBus: AppContainer["eventBus"];
  _createTokenTracker: typeof createTokenTracker;
  _createLatencyRecorder: typeof createLatencyRecorder;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  /** Data directory for persistent observability files (e.g., cache-break diffs) */
  dataDir?: string;
}): ObservabilityResult {
  const { eventBus, _createTokenTracker, _createLatencyRecorder } = deps;

  // 4. Create token tracker and latency recorder
  const tokenTracker = _createTokenTracker(eventBus);
  const latencyRecorder = _createLatencyRecorder(eventBus);

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
      logger: deps.logger as { warn: (obj: Record<string, unknown>, msg: string) => void },
    });
    eventBus.on("observability:cache_break", diffWriter);
  }

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

  const pruneTimer = setInterval(() => {
    tokenTracker.prune(PRUNE_MAX_AGE_MS);
    latencyRecorder.prune(PRUNE_MAX_AGE_MS);
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  return {
    tokenTracker,
    latencyRecorder,
    sharedCostTracker,
    diagnosticCollector,
    billingEstimator,
    channelActivityTracker,
    deliveryTracer,
  };
}
