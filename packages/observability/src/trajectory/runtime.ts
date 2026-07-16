// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory runtime recorder.
 *
 * Per-session writer that emits one JSONL line per trajectory event.
 * Composes:
 *
 *   - `sanitizeForPersistence`: credential redaction +
 *     diagnostic-payload sanitizer + bounded-payload limiter.
 *   - `getQueuedFileWriter`: single-promise-chain queued writer
 *     backed by `appendRegularFile` with `O_NOFOLLOW`.
 *   - `safeJsonStringify`: cycle-safe JSON serializer.
 *   - `tryGetContext` (@comis/core): AsyncLocalStorage read for trace
 *     correlation (falls back to `sessionId` when no scope).
 *
 * Three layered budgets:
 *
 *   1. **Per-payload**: `sanitizeForPersistence` clamps any sub-tree
 *      via the 5-sentinel `limitPayloadValue` (string >32 KB, array
 *      >64 items, object >64 keys, depth >6, cyclic ref). The result
 *      is bounded but may still be large in aggregate.
 *
 *   2. **Per-event**: after sanitization, the full event envelope is
 *      JSON-serialized once and the resulting byte count is compared
 *      against `maxRuntimeEventBytes` (default 256 KB). When exceeded
 *      the whole event payload is replaced by a single-key sentinel
 *      `{ truncated: true, originalBytes, limitBytes,
 *      reason: "trajectory-event-size-limit" }` and re-serialized.
 *
 *   3. **Per-file**: the running write counter is compared against
 *      `maxRuntimeFileBytes - sentinelReserveBytes` (default 50 MB
 *      minus 2 KB head-room). Once that's exceeded, subsequent events
 *      increment `droppedEvents` instead of writing. `flushAndClose`
 *      synthesizes one final `trace.truncated` sentinel using the
 *      reserved head-room.
 *
 * Disabled state: when `enabled === false` OR `COMIS_TRAJECTORY=0` the
 * factory returns `ok(null)`. Unsafe persisted state returns an explicit
 * error so callers do not cache an operational failure as disablement.
 *
 * Cross-cutting:
 *   - `randomUUID()` for `entryId` is the standard global; we use the
 *     `node:crypto` import to make the contract explicit.
 *   - `traceId` resolution: try ALS first, fall back to `sessionId`.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

import { systemDateFrom, systemGetEnv, systemNowMs, tryGetContext } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { ok, type Result } from "@comis/shared";

import { getQueuedFileWriter, type QueuedFileWriter } from "../shared/queued-file-writer.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import {
  BOUNDED_PAYLOAD_REASONS,
  type BoundedPayloadReason,
} from "../shared/bounded-payload.js";

import { resolveTrajectoryFilePath } from "./paths.js";
import { writeTrajectoryPointerFileBestEffort } from "./pointer-file.js";
import {
  readPersistedTrajectoryState,
  type TrajectoryResumeError,
} from "./persisted-state.js";
import type {
  TraceTruncatedParams,
  TrajectoryEvent,
  TrajectoryEventType,
  TrajectoryRecorder,
  TrajectoryRecorderInit,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants (defaults — overridable per init)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_SENTINEL_RESERVE_BYTES = 2 * 1024;
const EVENT_SIZE_SENTINEL_REASON = "trajectory-event-size-limit";

/**
 * Soft capture cap.
 *
 * When `recordEvent` would push `writtenBytes` past this threshold the
 * recorder emits `trace.truncated` INLINE (via `emitTruncatedInternal`)
 * with `reason: "trajectory-runtime-file-size-limit"` and sets
 * `state.closed = true`, stopping all further recording. The 50 MB hard
 * cap on the underlying `QueuedFileWriter` chassis remains unchanged as a
 * last-resort safety net.
 *
 * Overridable per-recorder via `budgets.captureMaxBytes` for test isolation.
 */
export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

// Trajectory-specific bounding constants.  The numeric values are
// identical to PAYLOAD_BOUNDS in bounded-payload.ts (which enforces the
// limits numerically via sanitizeForPersistence). These constants are
// used only for the sentinel SHAPE emitted by limitTrajectoryPayloadValue,
// not for re-enforcement of the numeric caps.
const TRAJECTORY_DATA_STRING_LIMIT_CHARS = 32_768;
const TRAJECTORY_DATA_ARRAY_LIMIT_ITEMS = 64;
const TRAJECTORY_DATA_OBJECT_LIMIT_KEYS = 64;
const TRAJECTORY_DATA_MAX_DEPTH = 6;

/**
 * Maximum number of concurrent trajectory writers kept in the module-level
 * registry. When a new distinct file path would push the registry past this
 * limit, the least-recently-used writer is evicted: `flushAndClose()` is
 * called fire-and-forget, then deleted from the map. JavaScript `Map`
 * preserves insertion order, making it a natural LRU structure:
 * move-to-end on access, evict the first (oldest) key.
 *
 * Set to 100 — large enough for typical long-running daemon sessions with
 * many concurrent agent sub-runs, small enough to prevent unbounded growth.
 */
export const MAX_TRAJECTORY_WRITERS = 100;

// Module-level writer registry — keyed by file path. Multiple recorders
// for the same file share one writer (rare, but matches the
// queued-writer chassis contract).
const writerRegistry = new Map<string, QueuedFileWriter>();

// ---------------------------------------------------------------------------
// limitTrajectoryPayloadValue — conversion wrapper
//
// Walks the value graph produced by sanitizeForPersistence and re-maps
// any { __bounded__: "bounded-payload-*" } sentinel records into the
// trajectory-specific { truncated: true, reason: "trajectory-*", ... }
// shape.
//
// DOES NOT touch bounded-payload.ts or combined-walker.ts — those are
// shared by cache-trace, config-audit, and system-prompt-report consumers
// which key on __bounded__ and must keep seeing it.
//
// The function is pure (no I/O, no clock). No cycle guard is needed here
// because sanitizeForPersistence already collapsed all cycles into
// bounded-payload-cycle-detected sentinels, so the graph this function
// receives is acyclic and finite.
// ---------------------------------------------------------------------------

/** Predicate: is `v` a bounded-payload sentinel emitted by sanitizeForPersistence? */
function isBoundedSentinel(v: unknown): v is { __bounded__: BoundedPayloadReason } {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  const reason = obj["__bounded__"];
  if (typeof reason !== "string") return false;
  // Check against the closed union of known reasons.
  return (Object.values(BOUNDED_PAYLOAD_REASONS) as string[]).includes(reason);
}

/**
 * Converts shared `{ __bounded__ }` sentinels in a sanitized payload graph
 * into trajectory-specific `{ truncated: true, reason: "trajectory-*", ... }`
 * sentinels.
 *
 * Recurses into plain objects and arrays for non-sentinel nodes.
 * Exported so it can be unit-tested independently.
 */
export function limitTrajectoryPayloadValue(value: unknown): unknown {
  // Primitives and null pass through unchanged.
  if (value === null || typeof value !== "object") return value;

  // Check for a bounded sentinel first (before recursing into child keys).
  if (isBoundedSentinel(value)) {
    const node = value as {
      __bounded__: BoundedPayloadReason;
      originalBytes?: number;
      originalLength?: number;
      originalKeyCount?: number;
    };
    const reason = node.__bounded__;

    // Exhaustive switch — closed union discriminator.
    switch (reason) {
      case BOUNDED_PAYLOAD_REASONS.fieldSizeLimit:
        return {
          truncated: true,
          reason: "trajectory-field-size-limit",
          ...(node.originalBytes !== undefined
            ? { originalChars: node.originalBytes }
            : {}),
          limitChars: TRAJECTORY_DATA_STRING_LIMIT_CHARS,
        };

      case BOUNDED_PAYLOAD_REASONS.arrayLengthLimit:
        return {
          truncated: true,
          reason: "trajectory-array-length-limit",
          ...(node.originalLength !== undefined
            ? { originalItems: node.originalLength }
            : {}),
          limitItems: TRAJECTORY_DATA_ARRAY_LIMIT_ITEMS,
        };

      case BOUNDED_PAYLOAD_REASONS.objectKeyLimit:
        return {
          truncated: true,
          reason: "trajectory-object-key-limit",
          ...(node.originalKeyCount !== undefined
            ? { originalKeys: node.originalKeyCount }
            : {}),
          limitKeys: TRAJECTORY_DATA_OBJECT_LIMIT_KEYS,
        };

      case BOUNDED_PAYLOAD_REASONS.depthLimit:
        return {
          truncated: true,
          reason: "trajectory-depth-limit",
          limitDepth: TRAJECTORY_DATA_MAX_DEPTH,
        };

      case BOUNDED_PAYLOAD_REASONS.cycleDetected:
        return { truncated: true, reason: "trajectory-circular-reference" };

      default: {
        // Exhaustiveness check — if TypeScript narrows `reason` to `never`
        // here, all cases are handled; a compile error means a new reason
        // was added to BOUNDED_PAYLOAD_REASONS without a matching case.
        const _exhaustive: never = reason;
        // At runtime, return the node unchanged (forward-compatibility).
        return _exhaustive;
      }
    }
  }

  // Recurse into arrays.
  if (Array.isArray(value)) {
    return value.map(limitTrajectoryPayloadValue);
  }

  // Recurse into plain objects.
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = limitTrajectoryPayloadValue(obj[key]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// LRU writer acquisition
//
// Wraps `getQueuedFileWriter` with JS Map insertion-order LRU semantics:
//   - On re-access: delete + re-set (moves key to the end = most-recently-used)
//   - On new acquisition: after registering, evict the oldest keys until
//     writerRegistry.size <= MAX_TRAJECTORY_WRITERS.
//
// Eviction calls flushAndClose() fire-and-forget (the QueuedFileWriter chassis
// serialises writes on a promise chain; any in-flight writes will complete
// before the file is closed). We guard against evicting the path just acquired.
// ---------------------------------------------------------------------------

interface AcquireOpts {
  maxQueuedBytes: number;
  maxFileBytes: number;
  confinedBaseDir?: string;
}

function acquireWriter(filePath: string, opts: AcquireOpts): QueuedFileWriter {
  // Move-to-end on re-access (LRU refresh).
  if (writerRegistry.has(filePath)) {
    const existing = writerRegistry.get(filePath)!;
    writerRegistry.delete(filePath);
    writerRegistry.set(filePath, existing);
  }

  // Register (or re-register refreshed) via the chassis helper.
  const writer = getQueuedFileWriter(writerRegistry, filePath, opts);

  // Evict oldest entries until we are within the cap.
  // Guard: never evict the path we just acquired (it's always at the end
  // after move-to-end + re-set, but check explicitly for the size=1 edge).
  while (writerRegistry.size > MAX_TRAJECTORY_WRITERS) {
    const oldestKey = writerRegistry.keys().next().value;
    if (oldestKey === undefined || oldestKey === filePath) break;
    const evicted = writerRegistry.get(oldestKey);
    writerRegistry.delete(oldestKey);
    if (evicted !== undefined) {
      // Fire-and-forget: in-flight writes are drained by the chassis before close.
      void evicted.flushAndClose();
    }
  }

  return writer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-session trajectory recorder. Intentional disablement is
 * represented by `ok(null)`; persisted-state failures return `err(...)` so
 * callers cannot cache or mistake an operational failure for configuration.
 *
 * The returned recorder is bound to one file path; multiple recorders
 * for the same file (rare) share the underlying queued writer via the
 * module-level registry.
 */
export function createTrajectoryRecorder(
  init: TrajectoryRecorderInit,
): Result<TrajectoryRecorder | null, TrajectoryResumeError> {
  if (init.enabled === false) return ok(null);
  if (isDisabledByEnv()) return ok(null);

  const filePath = resolveTrajectoryFilePath({
    sessionId: init.sessionId,
    ...(init.trajectoryDir !== undefined ? { trajectoryDir: init.trajectoryDir } : {}),
    ...(init.sessionFile !== undefined ? { sessionFile: init.sessionFile } : {}),
    ...(init.workspaceDir !== undefined ? { workspaceDir: init.workspaceDir } : {}),
  });

  // Budget resolution: top-level convenience shortcuts override the
  // budgets cluster which override defaults. The cluster exists so
  // TrajectoryRecorderInit stays under the 12-optional-field cap
  // enforced by the architecture invariant.
  const maxRuntimeEventBytes =
    init.budgets?.maxRuntimeEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxRuntimeFileBytes =
    init.maxRuntimeFileBytes ??
    init.budgets?.maxRuntimeFileBytes ??
    DEFAULT_MAX_FILE_BYTES;
  const sentinelReserveBytes =
    init.budgets?.sentinelReserveBytes ?? DEFAULT_SENTINEL_RESERVE_BYTES;
  const maxQueuedBytes =
    init.budgets?.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const usableFileBytes = Math.max(0, maxRuntimeFileBytes - sentinelReserveBytes);
  // Soft capture cap — per-recorder override (default 10 MB).
  // Must be ≤ usableFileBytes in practice; values larger than the 50 MB
  // hard cap simply mean the hard cap fires first.
  const captureMaxBytes =
    init.budgets?.captureMaxBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES;

  // A daemon restart creates a fresh in-memory registry while retaining the
  // append-only trajectory file. Resume both ordering and capture accounting
  // from disk before acquiring the writer; starting either counter at zero
  // would duplicate seq values and reset the soft file budget.
  const logger: ComisLogger | undefined = init.logger;
  const persistedState = readPersistedTrajectoryState({
    filePath,
    sessionId: init.sessionId,
    maxFileBytes: maxRuntimeFileBytes,
    ...(init.confinedBaseDir !== undefined
      ? { confinedBaseDir: init.confinedBaseDir }
      : {}),
  });
  if (!persistedState.ok) {
    return persistedState;
  }
  if (persistedState.value.malformedRecords > 0) {
    logger?.warn(
      {
        errorKind: "validation" as const,
        trajectoryFile: filePath,
        malformedRecords: persistedState.value.malformedRecords,
        hint: "Inspect the trajectory JSONL for partial or malformed records; valid records will continue from the highest persisted sequence",
      },
      "Trajectory recorder found malformed persisted records while resuming",
    );
  }
  if (persistedState.value.sequenceRegressions > 0) {
    logger?.warn(
      {
        errorKind: "validation" as const,
        trajectoryFile: filePath,
        sequenceRegressions: persistedState.value.sequenceRegressions,
        hint: "Use the highest persisted sequence as the durable high-water mark and inspect readers that sort historical events by seq",
      },
      "Trajectory recorder found non-monotonic persisted sequence values",
    );
  }

  // Acquire writer via LRU-bookkeeping helper. Handles
  // move-to-end on re-access and eviction of oldest writers when the
  // registry would exceed MAX_TRAJECTORY_WRITERS.
  const writer = acquireWriter(filePath, {
    maxQueuedBytes,
    maxFileBytes: maxRuntimeFileBytes,
    // Forward the caller's confinement base (typically
    // `~/.comis/`) so every trajectory-line write asserts the resolved
    // target stays inside the base. Daemon wiring passes this; tests
    // omit it (the option is opt-in for back-compat).
    ...(init.confinedBaseDir !== undefined
      ? { confinedBaseDir: init.confinedBaseDir }
      : {}),
  });

  // Best-effort pointer-file sidecar at `<sessionFile>.trajectory-path.json`.
  // Only emit when the recorder was constructed
  // alongside a per-session JSONL file — the env / cwd fallback paths
  // have no session file to anchor the pointer to. An empty string is one
  // of those fallback cases (paths.ts requires length > 0); guarding on
  // `!== undefined` alone would anchor the pointer at `${cwd}/.trajectory-
  // path.json`. Errors are swallowed by the helper; a missing pointer MUST
  // NOT block trajectory writes.
  if (init.sessionFile !== undefined && init.sessionFile.length > 0) {
    writeTrajectoryPointerFileBestEffort({
      sessionFile: init.sessionFile,
      sessionId: init.sessionId,
      runtimeFile: filePath,
    });
  }

  // Mutable per-recorder state. Each recorder owns its own seq counter
  // and write-byte accumulator (the writer chassis is shared across
  // recorders for the same path, but the seq/byte accounting is local).
  const state = {
    seq: persistedState.value.maxSeq,
    writtenBytes: persistedState.value.writtenBytes,
    droppedEvents: 0,
    droppedEventBytes: 0,
    closed: persistedState.value.softClosed,
    needsLineBreak: persistedState.value.needsLineBreak,
    // Guard: emit the hard-cap WARN at most once per recorder lifetime.
    // Without this flag, every subsequent call to recordEvent after the
    // hard-cap fires would re-emit the WARN.
    hardCapWarnEmitted: false,
  };

  function queueLine(line: string): "queued" | "dropped" {
    const appendLine = state.needsLineBreak ? `\n${line}` : line;
    const result = writer.write(appendLine);
    if (result === "queued") {
      state.needsLineBreak = false;
      state.writtenBytes += Buffer.byteLength(appendLine, "utf8");
    }
    return result;
  }

  function appendBytes(line: string): number {
    return Buffer.byteLength(state.needsLineBreak ? `\n${line}` : line, "utf8");
  }

  // ---------------------------------------------------------------------------
  // Shared internal helper for trace.truncated sentinel emission.
  //
  // Called both by the public `emitTraceTruncated` hook AND by the
  // close-time emit in `flushAndClose`, ensuring identical envelope shape
  // in both code paths. Bypasses the file-cap accounting — the
  // sentinelReserveBytes head-room (default 2 KB) is what makes this safe
  // even when the cap is exhausted.
  // ---------------------------------------------------------------------------
  function emitTruncatedInternal(params: TraceTruncatedParams): "queued" | "dropped" {
    state.seq += 1;
    const sanitized: Record<string, unknown> = {
      reason: params.reason,
      droppedEvents: params.droppedEvents,
    };
    if (params.droppedEventBytes !== undefined) {
      sanitized.droppedEventBytes = params.droppedEventBytes;
    }
    if (params.limitBytes !== undefined) {
      sanitized.limitBytes = params.limitBytes;
    }
    const sentinel = buildEvent({
      type: "trace.truncated",
      init,
      seq: state.seq,
      sanitized,
    });
    const line = encodeLine(sentinel);
    // Bypass file-cap accounting — the sentinelReserveBytes head-room
    // (default 2 KB) is what makes this safe even when the cap is exhausted.
    return queueLine(line);
  }

  const recorder: TrajectoryRecorder = {
    filePath,
    sessionStartedActive: persistedState.value.sessionStartedActive,
    recordEvent(
      type: TrajectoryEventType,
      data?: Record<string, unknown>,
      parentEntryId?: string,
    ): "queued" | "dropped" {
      if (state.closed) return "dropped";

      // 1. Sanitize payload through the canonical pipeline. The
      //    sanitizer preserves top-level object shape (returns either
      //    the bounded object graph or a sentinel-shaped object); the
      //    cast is the type-boundary point.
      const sanitized = sanitizeForPersistence(data) as
        | Record<string, unknown>
        | undefined;

      // 1a. Convert shared __bounded__ sentinels to trajectory-specific
      //     { truncated: true, reason: "trajectory-*" } shape.
      //     limitTrajectoryPayloadValue is a pure walk that only touches
      //     sentinel nodes; plain values pass through unchanged.
      const bounded = limitTrajectoryPayloadValue(sanitized) as
        | Record<string, unknown>
        | undefined;

      // 2. Build the envelope.
      const evt = buildEvent({
        type,
        ...(bounded !== undefined ? { sanitized: bounded } : {}),
        init,
        seq: state.seq + 1,
        ...(parentEntryId !== undefined ? { parentEntryId } : {}),
      });

      // 3. Encode + check per-event byte cap. Replace payload with
      //    sentinel when the envelope exceeds the cap.
      let line = encodeLine(evt);
      const eventBytes = Buffer.byteLength(line, "utf8");
      if (eventBytes > maxRuntimeEventBytes) {
        const replacement = buildEvent({
          type,
          init,
          seq: state.seq + 1,
          sanitized: {
            truncated: true,
            reason: EVENT_SIZE_SENTINEL_REASON,
            originalBytes: eventBytes,
            limitBytes: maxRuntimeEventBytes,
          },
          ...(parentEntryId !== undefined ? { parentEntryId } : {}),
        });
        line = encodeLine(replacement);
      }
      const bytes = appendBytes(line);

      // 4a. Soft capture cap. When writtenBytes would cross
      //     TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES (default 10 MB,
      //     overridable via budgets.captureMaxBytes), emit trace.truncated
      //     INLINE and stop recording. emitTruncatedInternal bypasses the
      //     file-cap accounting via sentinelReserveBytes head-room, so the
      //     sentinel still lands even though state.closed is set.
      if (state.writtenBytes + bytes > captureMaxBytes) {
        state.droppedEvents += 1;
        state.droppedEventBytes += bytes;
        // Emit the inline sentinel before setting closed so emitTruncatedInternal
        // can write to the file (it checks state.closed via emitTraceTruncated).
        emitTruncatedInternal({
          reason: "trajectory-runtime-file-size-limit",
          droppedEvents: state.droppedEvents,
          droppedEventBytes: state.droppedEventBytes,
          limitBytes: captureMaxBytes,
        });
        state.closed = true;
        return "dropped";
      }

      // 4b. Hard-cap safety net (50 MB). Reserve head-room for the final
      //     trace.truncated sentinel via flushAndClose.
      //
      //     Emit a single WARN (errorKind:"resource") the first time the
      //     hard cap fires so operators can observe the breach without
      //     polling droppedEvents(). The guard flag prevents re-emission
      //     on every subsequent dropped event.
      if (state.writtenBytes + bytes > usableFileBytes) {
        state.droppedEvents += 1;
        if (logger !== undefined && !state.hardCapWarnEmitted) {
          state.hardCapWarnEmitted = true;
          logger.warn(
            {
              errorKind: "resource" as const,
              limitBytes: usableFileBytes,
              hint: "Trajectory runtime file hit the hard cap; enable observability.logRotation or raise the diagnostics.trajectory.maxFileBytes budget",
            },
            "Trajectory runtime file hit hard cap; writer halted",
          );
        }
        return "dropped";
      }

      // 5. Hand to the queued writer.
      const result = queueLine(line);
      if (result === "queued") {
        state.seq += 1;
      } else {
        // Backpressure-dropped — the writer's queued-bytes cap was
        // exceeded. Account for trace.truncated emit at close-time.
        state.droppedEvents += 1;
      }
      return result;
    },

    async flush(): Promise<void> {
      await writer.flush();
    },

    async flushAndClose(): Promise<void> {
      // Soft-cap inline close: state.closed may already be true
      // if the soft cap fired inline during recordEvent. In that case we must
      // still flush+close the underlying writer — the sentinel was already
      // written inline, so we skip the droppedEvents branch but DO drain
      // the write queue and close the file handle.
      const alreadyClosed = state.closed;
      if (!alreadyClosed) {
        state.closed = true;
      }
      await writer.flush();

      // Only emit the close-time sentinel when the recorder was NOT
      // already closed by an inline soft-cap event. An inline soft-cap
      // close already emitted trace.truncated; emitting again here would
      // produce a duplicate sentinel and a wrong droppedEvents count.
      if (!alreadyClosed && state.droppedEvents > 0) {
        // Close-time sentinel — delegates to the same codepath as the
        // public hook so behaviour matches. Passes the legacy reason
        // string; does NOT pass droppedEventBytes / limitBytes because
        // the close-time path only has the drop count, not the byte
        // accounting.
        // state.seq is mutated by emitTruncatedInternal (increments by 1)
        // so the subsequent trace.write_failures branch below picks up
        // the bumped value without a separate sentinelSeq variable.
        emitTruncatedInternal({
          reason: "file-or-queue-cap-exceeded",
          droppedEvents: state.droppedEvents,
        });
      }

      // Emit trace.write_failures when the underlying queued writer
      // reports per-line append failures. Mirrors trace.truncated above
      // (same buildEvent + encodeLine + writer.write envelope shape).
      // The sentinel write itself may fail when the underlying failure
      // source is unrecoverable (e.g., symlinked parent for the lifetime
      // of the session); that recursive-failure case is acceptable — the
      // writer's failureCount stays > 0 and the user-visible signal
      // is preserved through the introspection surface even when no
      // sentinel record lands on disk.
      const failureCount = writer.failureCount();
      if (failureCount > 0) {
        state.seq += 1;
        const lastError = writer.lastError();
        const sentinel = buildEvent({
          type: "trace.write_failures",
          init,
          seq: state.seq,
          sanitized: {
            reason: "queued_writer_rejected",
            count: failureCount,
            rejectedBytes: writer.rejectedBytes(),
            lastError: lastError?.message ?? null,
          },
        });
        const line = encodeLine(sentinel);
        queueLine(line);
      }

      await writer.flushAndClose();
    },

    emitTraceTruncated(params: TraceTruncatedParams): "queued" | "dropped" {
      if (state.closed) return "dropped";
      return emitTruncatedInternal(params);
    },

    // Expose the running dropped-event counter so callers
    // at lifecycle-envelope emit sites (pi-event-bridge, comis-session-manager)
    // can detect and log drops instead of silently ignoring the "dropped" signal.
    droppedEvents(): number {
      return state.droppedEvents;
    },
  };

  return ok(recorder);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDisabledByEnv(): boolean {
  // systemGetEnv goes through the sanctioned-root helper in
  // @comis/core/runtime — direct process.env reads inside a leaf
  // module are forbidden by the globals architecture test.
  const raw = systemGetEnv("COMIS_TRAJECTORY");
  if (typeof raw !== "string") return false;
  const norm = raw.trim().toLowerCase();
  return norm === "0" || norm === "false" || norm === "off";
}

interface BuildEventInput {
  readonly type: TrajectoryEventType;
  readonly init: TrajectoryRecorderInit;
  readonly seq: number;
  /**
   * Sanitized payload. The recorder always hands `sanitizeForPersistence`
   * output through here; `sanitizeForPersistence` returns object-shaped
   * values (or undefined when input was undefined), matching the envelope
   * `data?: Record<string, unknown>` contract.
   */
  readonly sanitized?: Record<string, unknown>;
  readonly parentEntryId?: string;
}

function buildEvent(input: BuildEventInput): TrajectoryEvent {
  const traceId = resolveTraceId(input.init.sessionId);
  const envelope: Mutable<TrajectoryEvent> = {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    // Live recorder emits — `source` is a single-member union
    // preserved for forward-compatibility of on-disk JSONL artifacts.
    source: "runtime",
    type: input.type,
    // systemDateFrom + systemNowMs goes through the sanctioned-root
    // helpers in @comis/core/runtime — direct `new Date(...)` is
    // forbidden by the globals architecture test.
    ts: systemDateFrom(systemNowMs()).toISOString(),
    seq: input.seq,
    agentId: input.init.agentId,
    sessionId: input.init.sessionId,
    traceId,
    entryId: randomUUID(),
  };
  // Conditional spread for genuinely-optional envelope fields so they
  // don't serialize as `undefined` when omitted. Matches the convention
  // already used for tenantId/sessionKey/runId.
  if (input.init.tenantId !== undefined) envelope.tenantId = input.init.tenantId;
  if (input.init.sessionKey !== undefined) envelope.sessionKey = input.init.sessionKey;
  if (input.init.runId !== undefined) envelope.runId = input.init.runId;
  if (input.init.workspaceDir !== undefined) envelope.workspaceDir = input.init.workspaceDir;
  // provider/modelId/modelApi live in the `model` cluster on
  // TrajectoryRecorderInit (see types.ts) so the interface stays under
  // the ≤12-optional-fields architecture invariant. Lift each onto the
  // envelope when defined.
  if (input.init.model?.provider !== undefined) {
    envelope.provider = input.init.model.provider;
  }
  if (input.init.model?.modelId !== undefined) {
    envelope.modelId = input.init.model.modelId;
  }
  if (input.init.model?.modelApi !== undefined) {
    envelope.modelApi = input.init.model.modelApi;
  }
  if (input.parentEntryId !== undefined) envelope.parentEntryId = input.parentEntryId;
  if (input.sanitized !== undefined) envelope.data = input.sanitized;
  return envelope as TrajectoryEvent;
}

function resolveTraceId(sessionId: string): string {
  const ctx = tryGetContext();
  if (ctx !== undefined && typeof ctx.traceId === "string" && ctx.traceId.length > 0) {
    return ctx.traceId;
  }
  return sessionId;
}

function encodeLine(evt: TrajectoryEvent): string {
  return `${safeJsonStringify(evt)}\n`;
}

/** Internal alias to allow mutating a readonly-typed envelope under construction. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
