// SPDX-License-Identifier: Apache-2.0
// @comis/observability — Observability substrate barrel.
//
// Public surface:
//
//   - Queued single-promise-chain writer chassis
//   - Payload-bounding limiter + sentinel enum
//   - Diagnostic-payload sanitizer (credential drop, image sha256, cycles)
//   - Path-containment + filename-normalization + safe open() flags
//   - Stable canonical-JSON serializer (digest-stable)
//   - Circular-safe JSON serializer (wraps JSON.stringify)
//   - Edge-keeping mask + PEM-block mask + defaults constants
//   - sha256-prefix opaque-id helper
//   - Chunked bounded regex replace (ReDoS guard)
//   - Default credential pattern set (28 + 4 Comis additions)
//   - Text-level redactor + structured walker + sanitizeForPersistence
//   - Pino redact transport factory
//
// Boundary enforced by test/architecture/observability-package-isolation.test.ts:
// no imports from @comis/agent, @comis/daemon, @comis/cli, @comis/orchestrator.

export {
  getQueuedFileWriter,
} from "./shared/queued-file-writer.js";
export type {
  QueuedFileWriter,
  QueuedFileWriteResult,
  QueuedFileWriterOptions,
} from "./shared/queued-file-writer.js";

export {
  limitPayloadValue,
  PAYLOAD_BOUNDS,
  BOUNDED_PAYLOAD_REASONS,
} from "./shared/bounded-payload.js";
export type {
  BoundedPayloadReason,
  BoundedSentinel,
} from "./shared/bounded-payload.js";

export {
  sanitizeDiagnosticPayload,
  isCredentialFieldName,
} from "./shared/sanitize-diagnostic-payload.js";

export {
  resolveContainedPath,
  resolveContainedPathOrThrow,
  safeTrajectorySessionFileName,
  resolveSafeOpenFlags,
  PathEscapeError,
} from "./shared/path-guards.js";

export { stableStringify } from "./shared/stable-stringify.js";

export { safeJsonStringify } from "./shared/safe-json-stringify.js";

// Symlink-safe file primitives. The three error sentinels and the option /
// success / error type aliases form the public contract that downstream
// writers (queued-file-writer, config-audit/append, config-audit/scrub) all
// rely on at their try-catch boundaries. Out-of-package consumers should
// `import { appendRegularFile } from "@comis/observability"`.
export {
  appendRegularFile,
  writeRegularFile,
  SymlinkParentRejected,
  PathEscapesConfinementError,
  FileSizeLimitExceeded,
} from "./shared/fs-safe.js";
export type {
  AppendRegularFileOptions,
  AppendRegularFileSuccess,
  AppendRegularFileError,
  WriteRegularFileOptions,
  WriteRegularFileSuccess,
  WriteRegularFileError,
} from "./shared/fs-safe.js";

// ---------------------------------------------------------------------------
// Redactor surface.
// ---------------------------------------------------------------------------

export {
  maskToken,
  maskPemBlock,
  REDACT_DEFAULTS,
} from "./redact/edge-keeping.js";
export type { MaskTokenOptions } from "./redact/edge-keeping.js";

export { redactIdentifier } from "./redact/redact-identifier.js";

export { replacePatternBounded } from "./redact/regex-bounded.js";
export type { BoundedReplacer } from "./redact/regex-bounded.js";

export { getDefaultRedactPatterns } from "./redact/patterns.js";
export type { RedactPattern, RedactPatternKind } from "./redact/patterns.js";

export { redactSecretsInText } from "./redact/redact-text.js";

export {
  redactSecrets,
  sanitizeForPersistence,
} from "./redact/redact-secrets.js";

// Pino transport factory: named re-export (NOT default). The default
// export is reserved for the file used as a Pino `target` resolution
// path. Barrel consumers should import via the named symbol.
export { default as pinoRedactTransport } from "./redact/pino-redact-transport.js";

// ---------------------------------------------------------------------------
// Trajectory surface.
// ---------------------------------------------------------------------------

export {
  TRAJECTORY_EVENT_TYPES,
} from "./trajectory/types.js";
export type {
  TrajectoryEvent,
  TrajectoryEventSource,
  TrajectoryEventType,
  TrajectoryRecorder,
  TrajectoryRecorderBudgets,
  TrajectoryRecorderInit,
} from "./trajectory/types.js";

export {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./trajectory/paths.js";

export { writeTrajectoryPointerFileBestEffort } from "./trajectory/pointer-file.js";
export type { WriteTrajectoryPointerFileParams } from "./trajectory/pointer-file.js";

export { createTrajectoryRecorder } from "./trajectory/runtime.js";

export {
  attachTrajectoryToEventBus,
  TRAJECTORY_BRIDGE_MAPPING,
} from "./trajectory/event-bus-bridge.js";
export type { TrajectoryBridgedEventName } from "./trajectory/event-bus-bridge.js";

// ---------------------------------------------------------------------------
// SystemPromptReport surface.
// ---------------------------------------------------------------------------

export { SystemPromptReportSchema } from "./system-prompt-report/types.js";
export type { SystemPromptReport } from "./system-prompt-report/types.js";

export {
  buildSystemPromptReport,
  measureRenderedProjectContextChars,
} from "./system-prompt-report/build.js";
export type {
  BootstrapFileForReport,
  ResolvedToolForReport,
  BuildParamsContext,
} from "./system-prompt-report/build.js";

export { persistSystemPromptReport } from "./system-prompt-report/persist.js";
export type {
  ObservabilityStoreLike,
  SessionStoreReportSink,
  PersistError,
  PersistDeps,
} from "./system-prompt-report/persist.js";

// ---------------------------------------------------------------------------
// Cache-trace surface.
// ---------------------------------------------------------------------------

export { CACHE_TRACE_STAGES, CacheTraceEventSchema } from "./cache-trace/types.js";
export type { CacheTraceEvent, CacheTraceStage } from "./cache-trace/types.js";

export { resolveCacheTraceFilePath } from "./cache-trace/paths.js";
export type { ResolveCacheTraceFilePathInput } from "./cache-trace/paths.js";

export { createCacheTrace } from "./cache-trace/runtime.js";
export type { CacheTrace, CacheTraceInit } from "./cache-trace/runtime.js";

export { buildCacheTraceWrapper } from "./cache-trace/stream-fn-wrapper.js";
export type { StreamFnWrapper as CacheTraceStreamFnWrapper } from "./cache-trace/stream-fn-wrapper.js";

export { attachCacheTraceToEventBus } from "./cache-trace/event-bus-bridge.js";

// ---------------------------------------------------------------------------
// Config-audit surface.
// ---------------------------------------------------------------------------

export {
  ConfigWriteAuditRecordSchema,
  ConfigObserveAuditRecordSchema,
} from "./config-audit/types.js";
export type {
  ConfigWriteAuditRecord,
  ConfigObserveAuditRecord,
  ConfigWriteResult,
  ConfigWriteSource,
  FileStatSnapshot,
  SuspiciousFlag,
} from "./config-audit/types.js";

export {
  redactConfigAuditArgv,
  SECRET_FLAG_NAMES,
  SECRET_FLAG_SUFFIX_PATTERN,
  CONFIG_AUDIT_ARGV_CAP,
} from "./config-audit/argv-redactor.js";

export {
  resolveConfigAuditLogPath,
  CONFIG_AUDIT_LOG_ENV,
} from "./config-audit/log-path.js";
export type { ResolveLogPathDeps } from "./config-audit/log-path.js";

export { detectSuspicious } from "./config-audit/suspicious.js";
export type { SuspiciousInput } from "./config-audit/suspicious.js";

export {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  DEFAULT_ROTATE_AT_BYTES,
  DEFAULT_KEEP_ROTATED,
  ConfigAuditAppendError,
  getDefaultConfigAuditConfinedBase,
} from "./config-audit/append.js";
export type {
  ConfigWriteAuditRecordBase,
  CreateBaseParams,
  FinalizeParams,
  AppendConfigAuditParams,
} from "./config-audit/append.js";

export { scrubConfigAuditLog, ScrubConfigAuditError } from "./config-audit/scrub.js";
export type { ScrubResult, ScrubParams } from "./config-audit/scrub.js";

// ---------------------------------------------------------------------------
// Cache-stats surface.
// ---------------------------------------------------------------------------
//
// Durable warm-cache hit-rate aggregator over the `obs_token_usage`
// SQLite table. The CLI dispatches `obs.cacheStats.window` via this
// surface; the daemon wires its `ObservabilityStore` into the
// `CacheStatsStore` port.
//
// Architecture: the aggregator depends on the port, not on
// `@comis/memory`. The package-isolation invariant
// (`test/architecture/observability-package-isolation.test.ts`) keeps
// `@comis/observability` a leaf consumer.

export { CacheStatsWindowSchema } from "./cache-stats/types.js";
export type {
  CacheStatsWindow,
  CacheStatsBreakdown,
  CacheStatsStore,
} from "./cache-stats/types.js";
export { aggregateCacheStats } from "./cache-stats/aggregator.js";
export { buildCacheStatsRpcHandler } from "./cache-stats/rpc-handler-shape.js";
export type {
  BuildCacheStatsRpcHandlerDeps,
  CacheStatsRpcContract,
} from "./cache-stats/rpc-handler-shape.js";
export { parseSince } from "./cache-stats/parse-since.js";
