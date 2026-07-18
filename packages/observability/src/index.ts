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
  PayloadBoundsOverrides,
} from "./shared/bounded-payload.js";

export {
  sanitizeDiagnosticPayload,
  isCredentialFieldName,
  CREDENTIAL_KEYS,
} from "./shared/sanitize-diagnostic-payload.js";

export {
  resolveContainedPath,
  resolveContainedPathOrThrow,
  safeTrajectorySessionFileName,
  resolveSafeOpenFlags,
  PathEscapeError,
} from "./shared/path-guards.js";

export { safeJsonStringify } from "./shared/safe-json-stringify.js";

// Canonical (digest-stable) JSON serializer — sorts object keys at every depth so
// two semantically-equal inputs hash identically. Consumers that key a digest on a
// structured value (e.g. the content-free orchestrate replay params-digest) use it
// so both the recording and the matching side compute the same bytes.
export { stableStringify } from "./shared/stable-stringify.js";

// File-snapshot helper — sha256 + POSIX stat in one pass. Used by the
// daemon's read-side audit producer (`readConfigFileObservation`) and
// any other consumer that needs the file-state block.
export { readFileSnapshot } from "./shared/file-snapshot.js";
export type { FileSnapshot } from "./shared/file-snapshot.js";

// Symlink-safe file primitives. The three error sentinels and the option /
// success / error type aliases form the public contract that downstream
// writers (queued-file-writer, config-audit/append, config-audit/scrub) all
// rely on at their try-catch boundaries. Out-of-package consumers should
// `import { appendRegularFile } from "@comis/observability"`.
//
// `ensureContainedDir` is the third public helper — it owns the
// `mkdir + lstat-gated chmod` pattern that the migration sweep routes
// 10 sibling writers through.
export {
  appendRegularFile,
  readRegularFile,
  writeRegularFile,
  ensureContainedDir,
  SymlinkParentRejected,
  PathEscapesConfinementError,
  FileSizeLimitExceeded,
} from "./shared/fs-safe.js";
export type {
  AppendRegularFileOptions,
  AppendRegularFileSuccess,
  AppendRegularFileError,
  ReadRegularFileOptions,
  ReadRegularFileSuccess,
  ReadRegularFileError,
  WriteRegularFileOptions,
  WriteRegularFileSuccess,
  WriteRegularFileError,
  EnsureContainedDirOptions,
  EnsureContainedDirSuccess,
  EnsureContainedDirError,
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

// Bundle-time value-shape redactors.
// Distinct from Pino-level patterns above — different sentinel shape
// (`<REDACTED:type>` vs edge-keeping masks) and different consumer
// (bundle export pipeline vs live log scrubbing).
export {
  redactEventForExport,
  redactString,
  walkAndRedactStrings,
  getValueShapePatterns,
  substitutePathsInString,
} from "./redact/value-shapes.js";
export type { ValueShapePattern, RedactionOpts } from "./redact/value-shapes.js";

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
export { TrajectoryResumeError } from "./trajectory/persisted-state.js";
export type { TrajectoryResumeFailureKind } from "./trajectory/persisted-state.js";

export {
  attachTrajectoryToEventBus,
  TRAJECTORY_BRIDGE_MAPPING,
} from "./trajectory/event-bus-bridge.js";
export type { TrajectoryBridgedEventName } from "./trajectory/event-bus-bridge.js";

export { createSessionTrajectoryHandleRegistry } from "./trajectory/session-registry.js";
export type {
  SessionTrajectoryHandleRegistry,
  SessionTrajectoryFilter,
} from "./trajectory/session-registry.js";

export { buildTraceMetadata } from "./trajectory/metadata.js";
export type { TraceMetadataParams, TraceMetadataPayload } from "./trajectory/metadata.js";

export { buildTraceArtifacts } from "./trajectory/artifacts.js";
export type { TraceArtifactsRunState, TraceArtifactsPayload } from "./trajectory/artifacts.js";

// ---------------------------------------------------------------------------
// Trajectory bundle export.
// ---------------------------------------------------------------------------

export {
  buildTranscriptEvents,
  sortTrajectoryEvents,
  readSessionBranch,
  MAX_TRAJECTORY_RUNTIME_EVENTS,
  MAX_TRAJECTORY_TOTAL_EVENTS,
  MAX_TRAJECTORY_SESSION_FILE_BYTES,
  MAX_TRAJECTORY_WARNING_ROWS,
} from "./trajectory/export.js";
export type {
  TrajectoryBundleManifest,
  TrajectoryBundleWarning,
  TranscriptEventBase,
  TranscriptSourceEntry,
  ReadSessionBranchResult,
} from "./trajectory/export.js";

// exportTrajectoryBundle lives in bundle-exporter.ts to avoid
// a circular import (bundle-exporter.ts → export.ts; export.ts must not
// re-export bundle-exporter.ts or madge flags a circular .d.ts dependency).
export { exportTrajectoryBundle } from "./trajectory/bundle-exporter.js";
export type {
  ExportTrajectoryBundleParams,
  ExportTrajectoryBundleError,
  ExportTrajectoryBundleSuccess,
} from "./trajectory/bundle-exporter.js";

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

export {
  attachCacheTraceToEventBus,
  CACHE_TRACE_BRIDGE_MAPPING,
} from "./cache-trace/event-bus-bridge.js";
export type { CacheTraceBridgedEventName } from "./cache-trace/event-bus-bridge.js";

// ---------------------------------------------------------------------------
// Recall-trace surface.
// ---------------------------------------------------------------------------
//
// A daemon-wide JSONL recorder — ONE rich record per recall — and its
// schema-versioned closed-union envelope. A near-verbatim sibling of the
// cache-trace surface, but with NO opt-in raw-content slot: every payload is
// routed through sanitizeForPersistence (the redaction chokepoint). Consumed by
// @comis/agent's createMemoryRecall and the daemon's recall-trace
// admin RPC. Stays a leaf — imports only @comis/core + in-package
// substrate.

export {
  RECALL_RERANK_OUTCOMES,
  RECALL_INCLUDE_REASONS,
  RECALL_DEGRADATION_KINDS,
  RecallTraceEventSchema,
} from "./recall-trace/types.js";
export type {
  RecallTraceEvent,
  RecallRerankOutcome,
  RecallIncludeReason,
  RecallDegradationKind,
} from "./recall-trace/types.js";

export { resolveRecallTraceFilePath } from "./recall-trace/paths.js";
export type { ResolveRecallTraceFilePathInput } from "./recall-trace/paths.js";

export { createRecallTrace } from "./recall-trace/runtime.js";
export type { RecallTrace, RecallTraceInit } from "./recall-trace/runtime.js";

// ---------------------------------------------------------------------------
// Recall-counters surface.
// ---------------------------------------------------------------------------
//
// A lightweight in-process counter registry (a process-lifetime gauge that
// resets on restart) for lane usage, rerank-fallback rate, consolidation
// throughput, and recall hit-rate. Fed by a daemon-wired `memory:*` bus
// subscriber and read by `comis memory stats`. Pure — no clock, no
// I/O, no module-global state; stays a leaf.

export { createRecallCounters } from "./recall-counters/registry.js";
export type {
  RecallCounters,
  RecallCountersSnapshot,
  RecalledCounterInput,
  RerankedCounterInput,
  ConsolidatedCounterInput,
} from "./recall-counters/types.js";

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
  ensureConfigAuditParentDir,
  rotateConfigAuditLogIfNeeded,
} from "./config-audit/append.js";
export type {
  ConfigWriteAuditRecordBase,
  CreateBaseParams,
  FinalizeParams,
  AppendConfigAuditParams,
} from "./config-audit/append.js";

// config.observe writer — read-side counterpart to the write-side
// helpers above. The daemon's bootstrap config-read path dispatches
// into `appendConfigObserveAuditRecord` so each resolved configPath
// produces one `event: "config.observe"` JSONL record on every boot.
export {
  createConfigObserveAuditRecord,
  appendConfigObserveAuditRecord,
} from "./config-audit/append-observe.js";
export type {
  CreateObserveRecordParams,
  AppendObserveRecordParams,
  AppendObserveResult,
  ObserveObservation,
  ObserveRecovery,
} from "./config-audit/append-observe.js";

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

// ---------------------------------------------------------------------------
// Session-index surface.
// ---------------------------------------------------------------------------
//
// Append-only `session-index.YYYY-MM-DD.jsonl` writer via QueuedFileWriter.
// Three discriminated-union event types: session_started, turn_completed,
// session_ended. Emit sites in @comis/agent (pi-event-bridge, comis-session-manager).

export { appendSessionIndexEntry } from "./session-index/index.js";
export type {
  SessionIndexEvent,
  SessionStartedEvent,
  TurnCompletedEvent,
  SessionEndedEvent,
} from "./session-index/index.js";

// ---------------------------------------------------------------------------
// Rotation surface.
// ---------------------------------------------------------------------------
//
// Cross-stream log rotation policy helper + startup sweep.
// The rotation module depends only on @comis/core and Node builtins —
// no circular deps introduced.

export {
  applyRotationPolicy,
  type RotationPolicy,
  type ApplyRotationDeps,
  type ApplyRotationInput,
  type ApplyRotationResult,
} from "./rotation/policy.js";

export {
  sweepRotatedFiles,
  ROTATION_STREAM_PATTERNS,
  type SweepDeps,
} from "./rotation/sweep.js";

// ---------------------------------------------------------------------------
// Health aggregator surface.
// ---------------------------------------------------------------------------
//
// Sliding-window in-process rate aggregator. Subscribes to health/safety
// events on the typed EventBus, classifies each by errorKind, and emits
// `health:budget_exceeded` ONCE per window cross. No external dependencies;
// imports only @comis/core (no @comis/infra to avoid cycles).

export { createHealthAggregator } from "./health-aggregator/aggregator.js";
export type {
  AlertBudgetPolicy,
  AlertBudgetThreshold,
  BudgetExceededPayload,
} from "./health-aggregator/types.js";
export {
  SYNTHETIC_ERROR_KIND_MAP,
  TYPED_ERROR_KIND_EVENTS,
  resolveErrorKind,
} from "./health-aggregator/error-kind-map.js";

// ---------------------------------------------------------------------------
// Activity substrate surface.
// ---------------------------------------------------------------------------
//
// The canonical, redacted `ActivityEvent` source behind the core
// `ActivityStreamPort`. The daemon composition root
// constructs `createActivityStream(...)` in setup-observability.ts and injects
// the returned `ActivityStream` as the orchestrator-facing port. Imports only
// @comis/core (the boundary the guard test locks — observability never
// imports @comis/channels).

export { createActivityStream } from "./activity/activity-stream.js";
export type {
  ActivityStream,
  CreateActivityStreamDeps,
  ActivityToolMetadata,
  ActivityCounters,
} from "./activity/activity-stream.js";

// The pure, one-pass, idempotent activity-label display-shortener. Consumes
// already-redacted / already-path-compacted strings from redactValue — it
// shortens URLs, ISO timestamps, and long mcp_ tool names only, never
// re-redacting or re-compacting paths.
export { compressLabel } from "./activity/label-compressor.js";

// Deterministic shell command summarizer. Pure, self-redacting (redactValue at
// shell-label-parser.ts:53), length-capped at 120. Consumed by the exec/process
// builtin tools' transform hook — the top-level barrel re-export keeps the
// import path flat: `import { parseShellCommand } from "@comis/observability"`.
export { parseShellCommand } from "./activity/shell-label-parser.js";

// SEP plan-stream — derives PlanUpdate events from sep:plan_extracted + the
// live ExecutionPlanPort. Consumed by the daemon composition root
// (setup-channels-runtime.ts) to wire the chat ActivityTurnCoordinator with a
// per-agent plan-state subscription.
export { createPlanStream } from "./activity/plan-stream.js";
export type {
  CreatePlanStreamDeps,
  PlanEntry,
  PlanStream,
  PlanUpdate,
} from "./activity/plan-stream.js";

// ---------------------------------------------------------------------------
// Pipeline-authoring gate surface.
// ---------------------------------------------------------------------------
//
// The pre-committed, PURE, deterministic decision rule:
// `pipelineAuthoringGate(aggregate) -> { buildAuthor, reason }`.
// This package is the SINGLE SOURCE of `PipelineAuthoringAggregate` — the
// daemon's system-findings reducer imports the type from here, and the daemon's
// system-health assembler surfaces the verdict on the SystemHealthReport. Pure
// (no I/O, no clock, no globals) — a leaf consumer like the rest of the package.
export {
  pipelineAuthoringGate,
  MIN_SMALL_TIER_SAMPLE,
  MATERIAL_GAP_PP,
} from "./pipeline-authoring-gate.js";
export type {
  PipelineAuthoringAggregate,
  PipelineAuthoringVerdict,
} from "./pipeline-authoring-gate.js";
