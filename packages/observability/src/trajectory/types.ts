// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory event v1 schema — closed type union + payload shape.
 *
 * The trajectory is a per-session JSONL sidecar capturing the
 * model-visible state changes for a single agent run. Each event is
 * one JSONL line; the file is bounded (`maxRuntimeFileBytes`) and the
 * payload is bounded per-event (`maxRuntimeEventBytes`) — see
 * `runtime.ts` for the runtime contract.
 *
 * Closed enum invariant: `TRAJECTORY_EVENT_TYPES` is a literal `as const`
 * tuple so consumers can enumerate it at test time. The architecture
 * test `trajectory-event-types-known.test.ts` walks every
 * `eventBus.emit(...)` site and asserts each emitted name is either:
 *   1. mapped through `TRAJECTORY_BRIDGE_MAPPING` to one of these
 *      `TrajectoryEventType` values, or
 *   2. explicitly listed in the `EVENTS_NOT_TRAJECTORY_MAPPED`
 *      allowlist.
 *
 * Comis improvements over the OpenClaw original:
 *   - `agentId`, `tenantId`, `entryId`, `parentEntryId` — multi-tenant
 *     correlation across artifacts (cache-trace, system-prompt-report,
 *     config-audit) within the same session.
 *   - `traceSchema: "comis-trajectory"` + `schemaVersion: 1` — explicit
 *     schema fence so downstream parsers can reject foreign artifacts.
 *
 * @module
 */

/**
 * Closed enum of trajectory event types (20 total).
 *
 * Order is deliberate (life-cycle: session.* → prompt → model → tool →
 * skill → memory → delivery → lifecycle envelopes → control-plane sentinel).
 * Append-only — insertion order is part of the SemVer contract for v1.
 */
export const TRAJECTORY_EVENT_TYPES = [
  // Session lifecycle (one start + one end per agent run).
  "session.started",
  "session.ended",

  // Context compilation outcome (one per turn; not always present).
  "context.compiled",

  // Prompt-submission boundary (one per turn before model call).
  "prompt.submitted",

  // Model results / fallbacks / cooldown.
  "model.completed",
  "model.fallback_attempt",
  "model.fallback_exhausted",
  "model.auth_cooldown",

  // Tool lifecycle.
  "tool.call",
  "tool.result",
  "tool.timeout",
  "tool.policy_filtered",

  // Skill invocation observability.
  "skill.prompt_loaded",
  "skill.prompt_invoked",

  // Memory injection observability.
  "memory.injected",

  // Delivery queue lifecycle.
  "delivery.queued",
  "delivery.dispatched",

  // Lifecycle envelopes (D4 / LIFE-01 + LIFE-02). Direct-emit by the
  // agent executor — NOT via the EventBus bridge. See design §6.2
  // Appendix B "(NEW D4) direct". Added Plan 01-01 (TRACE-02).
  "trace.metadata",
  "trace.artifacts",

  // Control-plane sentinel: writer ran out of room mid-stream.
  "trace.truncated",
  // Control-plane sentinel: queued writer rejected one or more lines
  // (e.g., symlinked parent, ENOSPC). Emitted at flushAndClose when
  // QueuedFileWriter.failureCount() > 0.
  "trace.write_failures",
] as const;

/** Closed union of trajectory event type strings. */
export type TrajectoryEventType = (typeof TRAJECTORY_EVENT_TYPES)[number];

/**
 * Trajectory event source (design §6.2).
 *
 * - `"runtime"`    — emitted live by `createTrajectoryRecorder` during agent execution
 *                   (the only producer this phase ships; runtime recorder pins this value).
 * - `"transcript"` — emitted by the bundle exporter when merging session JSONL transcript
 *                   entries with runtime events (Phase 4 D5).
 * - `"export"`     — emitted by the bundle exporter for synthesized records (Phase 4 D5).
 *
 * Declaration widened in Plan 01-01 (TRACE-02); producers for transcript/export
 * land in Phase 4. On-disk JSONL files written before this widening lack ambient
 * "transcript"/"export" values — readers tolerate the narrower set per §6.4 additive
 * schema policy.
 */
export type TrajectoryEventSource = "runtime" | "transcript" | "export";

/**
 * Trajectory event — one record per JSONL line.
 *
 * - `traceSchema` + `schemaVersion`: parser fence (v1 is the only
 *   currently-shipped schema).
 * - `source`: who produced this event (`"runtime"` for live recorder emits).
 * - `traceId`: AsyncLocalStorage trace ID; falls back to `sessionId`
 *   when no trace is in flight (e.g., startup-time emit).
 * - `entryId` / `parentEntryId`: per-event UUIDs for graph correlation
 *   across artifacts. `parentEntryId` is set when an event derives
 *   from a parent (e.g., `tool.result.parentEntryId === tool.call.entryId`).
 * - `seq`: monotonic per-file counter (1-indexed) — per-session monotonic
 *   across all turns in the session (does NOT reset between turns).
 * - `provider` / `modelId` / `modelApi` / `workspaceDir`: optional envelope-level
 *   metadata copied from `TrajectoryRecorderInit` when defined.
 * - `data`: typed payload (after `sanitizeForPersistence`).
 *
 * Envelope-vs-data discipline (design §6.2): `traceId`, `agentId`, `sessionId`,
 * `sessionKey` are envelope-only — they MUST NOT be duplicated into `data`.
 */
export interface TrajectoryEvent {
  readonly traceSchema: "comis-trajectory";
  readonly schemaVersion: 1;
  readonly source: TrajectoryEventSource;
  readonly type: TrajectoryEventType;
  readonly ts: string;
  readonly seq: number;

  // Correlation IDs.
  readonly agentId: string;
  readonly tenantId?: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly traceId: string;
  readonly runId?: string;
  readonly workspaceDir?: string;

  // Model metadata (lifted from TrajectoryRecorderInit when defined).
  readonly provider?: string;
  readonly modelId?: string;
  readonly modelApi?: string | null;

  readonly entryId: string;
  /** Parent event ID for DAG reconstruction (design §6.1 / O2).
   *  Forward-declared in Phase 1; populated by Phase 4 session-DAG writer.
   *  `null` distinguishes "explicit root" from "missing". */
  readonly parentEntryId?: string | null;

  /** Source-relative monotonic position (design §6.1). Used by the bundle
   *  exporter as a tiebreak when merging runtime + transcript events with
   *  identical `ts`. Forward-declared in Phase 1; populated by Phase 4
   *  (bundle export) and downstream readers. */
  readonly sourceSeq?: number;

  // Payload — passed through `sanitizeForPersistence` before write.
  // Shape is intentionally `Record<string, unknown>` (matches design §6.2);
  // `sanitizeForPersistence` always returns an object-shaped value.
  readonly data?: Record<string, unknown>;
}

/**
 * Recorder construction inputs.
 *
 * `sessionFile` is the per-session JSONL pointer (when available); the
 * trajectory file lives alongside it (`<sessionFile>.trajectory.jsonl`).
 * When `sessionFile` is missing the recorder falls back to
 * `${COMIS_TRAJECTORY_DIR ?? cwd}/<safeSessionId>.trajectory.jsonl`.
 *
 * The optional budgets default to:
 *   - `maxRuntimeEventBytes = 256 * 1024`
 *   - `maxRuntimeFileBytes = 50 * 1024 * 1024`
 *   - `maxQueuedBytes = 4 * 1024 * 1024`
 *   - `sentinelReserveBytes = 2 * 1024` (head-room reserved inside the
 *     file budget for the `trace.truncated` sentinel emit).
 *
 * `enabled = false` causes `createTrajectoryRecorder` to return `null`
 * (no-op contract; consumers null-check). The env override
 * `COMIS_TRAJECTORY=0` short-circuits the same way.
 */
/**
 * Optional byte-budget overrides clustered into a single `budgets` field.
 * Cluster (rule of three) keeps `TrajectoryRecorderInit`'s optional
 * field count ≤12 (architecture invariant — see
 * test/architecture/optional-field-bloat.test.ts). Operators usually
 * only override `maxFileBytes` via `diagnostics.trajectory.maxFileBytes`;
 * the remaining fields are tuning knobs for tests and edge cases.
 */
export interface TrajectoryRecorderBudgets {
  /** Per-event byte cap. Default 256 KB. */
  readonly maxRuntimeEventBytes?: number;
  /** Per-file byte cap. Default 50 MB. */
  readonly maxRuntimeFileBytes?: number;
  /** Per-writer queued byte cap. Default 4 MB. */
  readonly maxQueuedBytes?: number;
  /** Head-room reserved inside file cap for trace.truncated emit. Default 2 KB. */
  readonly sentinelReserveBytes?: number;
  /**
   * Soft capture cap: recording stops inline (trace.truncated emitted) when
   * writtenBytes would cross this threshold. Default TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES
   * (10 MB). Overridable per-recorder for tests. Must be ≤ maxRuntimeFileBytes.
   */
  readonly captureMaxBytes?: number;
}

export interface TrajectoryRecorderInit {
  /** Multi-tenant agent identifier. Required. */
  readonly agentId: string;
  /** Tenant ID for multi-tenant deployments. Optional (defaults to "default" in payload). */
  readonly tenantId?: string;
  /** Session identifier — used as the sessionId field on every event. */
  readonly sessionId: string;
  /** Formatted session key (joins tenant/user/channel). Optional surface for trajectory consumers. */
  readonly sessionKey?: string;
  /** Per-run identifier (one per execute() invocation). Optional. */
  readonly runId?: string;
  /** Path to the session JSONL file. Trajectory lives alongside as <sessionFile>.trajectory.jsonl. */
  readonly sessionFile?: string;
  /** Agent workspace directory — used as last-resort base for path resolution. */
  readonly workspaceDir?: string;
  /**
   * Model-metadata cluster (provider id + model id + model API). Adding
   * `modelApi` (design §6.2 deviation B) at the top level would push
   * TrajectoryRecorderInit past the ≤12-optional-fields architecture
   * invariant — clustering the three model identifiers into one
   * optional field collapses three slots into one. Resolver in
   * `runtime.ts` reads `init.model?.provider`, `init.model?.modelId`,
   * `init.model?.modelApi` and lifts each onto the trajectory envelope
   * when defined.
   */
  readonly model?: {
    /** Provider id (e.g., "anthropic"). */
    readonly provider?: string;
    /** Model id (e.g., "claude-sonnet-4-20250514"). */
    readonly modelId?: string;
    /** Model API (e.g., "messages", "responses"). `null` permitted per design §6.2. */
    readonly modelApi?: string | null;
  };

  /** Override for the trajectory base directory (precedes COMIS_TRAJECTORY_DIR). */
  readonly trajectoryDir?: string;

  // Convenience top-level overrides (forwarded to budgets when set):
  /** Per-file byte cap shortcut. Forwarded to budgets.maxRuntimeFileBytes. */
  readonly maxRuntimeFileBytes?: number;

  /** Cluster of optional byte budgets — see TrajectoryRecorderBudgets. */
  readonly budgets?: TrajectoryRecorderBudgets;

  /**
   * Enable/disable. Default true. When false `createTrajectoryRecorder`
   * returns null (no-op contract). Env `COMIS_TRAJECTORY=0` also
   * short-circuits to null.
   */
  readonly enabled?: boolean;

  /**
   * Opt-in real-path confinement base forwarded to the underlying
   * queued writer (and from there to `appendRegularFile`). Production
   * callers (daemon trajectory wiring) pass
   * `path.join(os.homedir(), ".comis")` so an ancestor-symlink escape
   * is rejected before the open() call. Tests omit it (default
   * `undefined`) to keep tmp-dir paths legal.
   */
  readonly confinedBaseDir?: string;
}

/**
 * Parameters for the public `trace.truncated` emit hook.
 *
 * Used by:
 *   - Internal close-time sentinel emit in `flushAndClose` (passes
 *     `reason: "file-or-queue-cap-exceeded"`).
 *   - Phase 2 D7 bounded-payload writer (passes reasons like
 *     `"trajectory-runtime-file-size-limit"`).
 *
 * @see design §5 D4 / D7
 */
export interface TraceTruncatedParams {
  /** Human-readable reason code. E.g. "file-or-queue-cap-exceeded",
   *  "trajectory-runtime-file-size-limit", "trajectory-event-byte-limit". */
  readonly reason: string;
  /** Running total of dropped events at the time of the call. */
  readonly droppedEvents: number;
  /** Total dropped bytes (cumulative). Omitted when not yet tracked. */
  readonly droppedEventBytes?: number;
  /** The file or event limit that was hit, in bytes. Omitted when not applicable. */
  readonly limitBytes?: number;
}

/**
 * Writer interface returned by `createTrajectoryRecorder`. A no-op
 * disabled state is conveyed via a `null` return — consumers null-check
 * once at the construction site.
 *
 * `recordEvent` is fire-and-forget: it returns a Result with `"queued"`
 * or `"dropped"` (the latter when the per-writer queued-bytes cap would
 * be exceeded). The writer does not throw on disk-write failures.
 *
 * `flush` awaits the underlying queue tail. `flushAndClose` additionally
 * emits the `trace.truncated` sentinel if any events were dropped, then
 * closes the writer.
 */
export interface TrajectoryRecorder {
  /** Resolved on-disk path of the trajectory file. */
  readonly filePath: string;

  /**
   * Enqueue one event. `type` must be a closed-union TrajectoryEventType.
   * `data` is passed through `sanitizeForPersistence` before write.
   * When `data` exceeds `maxRuntimeEventBytes` after sanitization the
   * entire event is replaced with a single-key sentinel record.
   *
   * `data` is typed `Record<string, unknown> | undefined` to match the
   * design §6.2 contract. Pass `undefined` (or omit) when there is no
   * payload — bridge translators that intentionally produce no
   * correlation data still hand back an object so consumers can grep
   * by key.
   *
   * Returns "queued" on accept, "dropped" when the per-writer queue cap
   * would be exceeded (operator-tunable backpressure).
   */
  recordEvent(
    type: TrajectoryEventType,
    data?: Record<string, unknown>,
    parentEntryId?: string,
  ): "queued" | "dropped";

  /** Await the queue tail. */
  flush(): Promise<void>;

  /**
   * Await the queue tail, emit the `trace.truncated` sentinel if any
   * events were dropped during this recorder's lifetime, and remove
   * the writer from the registry.
   */
  flushAndClose(): Promise<void>;

  /**
   * Emit a `trace.truncated` event with operator-supplied reason and
   * bound metadata. Used by D7 (Phase 2) to signal bound-exhaustion
   * at any write-time location, NOT only at close.
   *
   * The internal close-time sentinel emit in flushAndClose calls the
   * SAME codepath with reason `"file-or-queue-cap-exceeded"`.
   *
   * Returns "queued" on accept, "dropped" when the per-writer queue
   * cap is exceeded.
   */
  emitTraceTruncated(params: TraceTruncatedParams): "queued" | "dropped";

  /**
   * Returns the running count of events dropped by this recorder (both
   * soft-cap and hard-cap drops). Observable counter for WR-04: callers
   * at lifecycle-envelope emit sites can read this to detect silent drops.
   *
   * Incremented on each call to `recordEvent` that returns `"dropped"`.
   */
  droppedEvents(): number;
}
