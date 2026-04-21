// SPDX-License-Identifier: Apache-2.0
// @comis/daemon/observability - trace logging, token tracking, latency metrics, log level control

import type { EventMap, EventHandler } from "@comis/core";

/** Reference to a registered EventBus handler for cleanup. */
export interface HandlerRef {
  event: keyof EventMap;
  handler: EventHandler<keyof EventMap>;
}

// Trace logger: Pino mixin for AsyncLocalStorage context injection
export { createTracingLogger } from "./trace-logger.js";
export type { TracingLoggerOptions } from "./trace-logger.js";

// Log level manager: per-module runtime log level control
export { createLogLevelManager } from "./log-infra.js";
export type { LogLevelManager } from "./log-infra.js";

// Token tracker: LLM usage with provider/model attribution
export { createTokenTracker } from "./token-tracker.js";
export type { TokenTracker, TokenUsageEntry, TokenAggregation } from "./token-tracker.js";

// Latency recorder: operation timing with percentile statistics
export { createLatencyRecorder } from "./latency-recorder.js";
export type {
  LatencyRecorder,
  LatencyRecord,
  LatencyStats,
  OperationType,
} from "./latency-recorder.js";

// Billing estimator: CostTracker aggregation with time-windowed queries
export { createBillingEstimator } from "./billing-estimator.js";
export type {
  BillingEstimator,
  BillingSnapshot,
  ProviderBilling,
  TokenUsagePoint,
} from "./billing-estimator.js";

// Diagnostic collector: EventBus subscriber with queryable ring buffer
export { createDiagnosticCollector } from "./diagnostic-collector.js";
export type {
  DiagnosticCollector,
  DiagnosticEvent,
  DiagnosticCategory,
} from "./diagnostic-collector.js";

// Channel activity tracker: per-channel last-active timestamps
export { createChannelActivityTracker } from "./channel-activity-tracker.js";
export type { ChannelActivityTracker, ChannelActivity } from "./channel-activity-tracker.js";

// Delivery tracer + context: message delivery context correlation and types
export { createDeliveryTracer } from "./delivery-tracer.js";
export type { DeliveryTracer, DeliveryContext } from "./delivery-tracer.js";

// Log transport: pino multi-target transport factory for file rotation + stdout
// isPm2Managed exported for PM2-aware transport suppression
export { createFileTransport, isPm2Managed } from "./log-infra.js";

// Write buffer + Persistence wiring: batched write buffer, event-to-row mappers,
// and dual-write factory
export {
  createObsWriteBuffer,
  setupObsPersistence,
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
} from "./obs-persistence-wiring.js";
export type {
  ObsWriteBuffer,
  ObsWriteBufferOptions,
  ObsPersistenceDeps,
  ObsPersistenceResult,
} from "./obs-persistence-wiring.js";

// Delivery queue logger: structured logging for queue lifecycle events
export { setupDeliveryQueueLogging } from "./delivery-queue-logger.js";

// Channel health logger: structured logging for health state transitions
export { setupChannelHealthLogging } from "./channel-health-logger.js";
export type { ChannelHealthLoggerDeps } from "./channel-health-logger.js";

// Context pipeline collector: context:pipeline and context:dag_compacted ring buffers
export { createContextPipelineCollector } from "./context-pipeline-collector.js";
export type {
  ContextPipelineCollector,
  PipelineSnapshot,
  DagCompactionSnapshot,
  PipelineQueryOpts,
} from "./context-pipeline-collector.js";
