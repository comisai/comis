// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory event v1 schema — closed type union + payload shape.
 *
 * Design §6.2. The trajectory is a per-session JSONL sidecar capturing
 * the model-visible state changes for a single agent run. Each event is
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
 * Comis improvements over the OpenClaw original (design §6.2):
 *   - `agentId`, `tenantId`, `entryId`, `parentEntryId` — multi-tenant
 *     correlation across artifacts (cache-trace, system-prompt-report,
 *     config-audit) within the same session.
 *   - `traceSchema: "comis-trajectory"` + `schemaVersion: 1` — explicit
 *     schema fence so downstream parsers can reject foreign artifacts.
 *
 * @module
 */

/**
 * Closed enum of trajectory event types (18 total).
 *
 * Order is deliberate (life-cycle: session.* → prompt → model → tool →
 * skill → memory → delivery → control-plane sentinel). Append-only —
 * insertion order is part of the SemVer contract for v1.
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

  // Control-plane sentinel: writer ran out of room mid-stream.
  "trace.truncated",
] as const;

/** Closed union of trajectory event type strings. */
export type TrajectoryEventType = (typeof TRAJECTORY_EVENT_TYPES)[number];

/**
 * Trajectory event — one record per JSONL line.
 *
 * - `traceSchema` + `schemaVersion`: parser fence (v1 is the only
 *   currently-shipped schema).
 * - `traceId`: AsyncLocalStorage trace ID; falls back to `sessionId`
 *   when no trace is in flight (e.g., startup-time emit).
 * - `entryId` / `parentEntryId`: per-event UUIDs for graph correlation
 *   across artifacts. `parentEntryId` is set when an event derives
 *   from a parent (e.g., `tool.result.parentEntryId === tool.call.entryId`).
 * - `seq`: monotonic per-file counter (1-indexed). Consumers can
 *   detect dropped lines by gap detection.
 * - `data`: typed payload (after `sanitizeForPersistence` from 45-02).
 */
export interface TrajectoryEvent {
  readonly traceSchema: "comis-trajectory";
  readonly schemaVersion: 1;
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
  readonly entryId: string;
  readonly parentEntryId?: string;

  // Payload — passed through `sanitizeForPersistence` (45-02) before write.
  readonly data: unknown;
}

/**
 * Recorder construction inputs.
 *
 * `sessionFile` is the per-session JSONL pointer (when available); the
 * trajectory file lives alongside it (`<sessionFile>.trajectory.jsonl`).
 * When `sessionFile` is missing the recorder falls back to
 * `${COMIS_TRAJECTORY_DIR ?? cwd}/<safeSessionId>.trajectory.jsonl`.
 *
 * The optional budgets default to the design §6 invariants:
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
  /** Provider id (e.g., "anthropic"). Optional metadata for trajectory consumers. */
  readonly provider?: string;
  /** Model id (e.g., "claude-sonnet-4-20250514"). Optional metadata for trajectory consumers. */
  readonly modelId?: string;

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
   * `data` is passed through `sanitizeForPersistence` (45-02) before
   * write. When `data` exceeds `maxRuntimeEventBytes` after sanitization
   * the entire event is replaced with a single-key sentinel record.
   *
   * Returns "queued" on accept, "dropped" when the per-writer queue cap
   * would be exceeded (operator-tunable backpressure).
   */
  recordEvent(type: TrajectoryEventType, data: unknown, parentEntryId?: string): "queued" | "dropped";

  /** Await the queue tail. */
  flush(): Promise<void>;

  /**
   * Await the queue tail, emit the `trace.truncated` sentinel if any
   * events were dropped during this recorder's lifetime, and remove
   * the writer from the registry.
   */
  flushAndClose(): Promise<void>;
}
