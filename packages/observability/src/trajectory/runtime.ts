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
 * factory returns `null`. Consumers null-check at the construction
 * site — we ship a literal null instead of a stub-shape object.
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

import { getQueuedFileWriter, type QueuedFileWriter } from "../shared/queued-file-writer.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";

import { resolveTrajectoryFilePath } from "./paths.js";
import { writeTrajectoryPointerFileBestEffort } from "./pointer-file.js";
import type {
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

// Module-level writer registry — keyed by file path. Multiple recorders
// for the same file share one writer (rare, but matches the
// queued-writer chassis contract).
const writerRegistry = new Map<string, QueuedFileWriter>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-session trajectory recorder. Returns `null` when
 * disabled via init flag or `COMIS_TRAJECTORY=0` env var (consumers
 * null-check at the construction site).
 *
 * The returned recorder is bound to one file path; multiple recorders
 * for the same file (rare) share the underlying queued writer via the
 * module-level registry.
 */
export function createTrajectoryRecorder(
  init: TrajectoryRecorderInit,
): TrajectoryRecorder | null {
  if (init.enabled === false) return null;
  if (isDisabledByEnv()) return null;

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

  const writer = getQueuedFileWriter(writerRegistry, filePath, {
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

  // Best-effort pointer-file sidecar at `<sessionFile>.trajectory-path.json`
  // (design §6.1 + §2.3). Only emit when the recorder was constructed
  // alongside a per-session JSONL file — the env / cwd fallback paths
  // have no session file to anchor the pointer to. Errors are swallowed
  // by the helper; a missing pointer MUST NOT block trajectory writes.
  if (init.sessionFile !== undefined) {
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
    seq: 0,
    writtenBytes: 0,
    droppedEvents: 0,
    closed: false,
  };

  const recorder: TrajectoryRecorder = {
    filePath,
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

      // 2. Build the envelope.
      const evt = buildEvent({
        type,
        ...(sanitized !== undefined ? { sanitized } : {}),
        init,
        seq: state.seq + 1,
        ...(parentEntryId !== undefined ? { parentEntryId } : {}),
      });

      // 3. Encode + check per-event byte cap. Replace payload with
      //    sentinel when the envelope exceeds the cap.
      let line = encodeLine(evt);
      let bytes = Buffer.byteLength(line, "utf8");
      if (bytes > maxRuntimeEventBytes) {
        const replacement = buildEvent({
          type,
          init,
          seq: state.seq + 1,
          sanitized: {
            truncated: true,
            reason: EVENT_SIZE_SENTINEL_REASON,
            originalBytes: bytes,
            limitBytes: maxRuntimeEventBytes,
          },
          ...(parentEntryId !== undefined ? { parentEntryId } : {}),
        });
        line = encodeLine(replacement);
        bytes = Buffer.byteLength(line, "utf8");
      }

      // 4. Per-file budget. Reserve head-room for the final
      //    trace.truncated sentinel via flushAndClose.
      if (state.writtenBytes + bytes > usableFileBytes) {
        state.droppedEvents += 1;
        return "dropped";
      }

      // 5. Hand to the queued writer.
      const result = writer.write(line);
      if (result === "queued") {
        state.seq += 1;
        state.writtenBytes += bytes;
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
      if (state.closed) return;
      state.closed = true;
      await writer.flush();

      // Local seq bump shared across the two sentinel branches so we
      // never reuse a seq number when both fire in the same close.
      let sentinelSeq = state.seq;

      if (state.droppedEvents > 0) {
        sentinelSeq += 1;
        const sentinel = buildEvent({
          type: "trace.truncated",
          init,
          seq: sentinelSeq,
          sanitized: {
            droppedEvents: state.droppedEvents,
            reason: "file-or-queue-cap-exceeded",
          },
        });
        // Sentinel emit is unconditional — bypasses the file-cap
        // accounting so the operator's bookkeeping is preserved even
        // when the cap is exhausted. The 2 KB reserve makes this safe.
        const line = encodeLine(sentinel);
        writer.write(line);
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
        sentinelSeq += 1;
        const lastError = writer.lastError();
        const sentinel = buildEvent({
          type: "trace.write_failures",
          init,
          seq: sentinelSeq,
          sanitized: {
            reason: "queued_writer_rejected",
            count: failureCount,
            rejectedBytes: writer.rejectedBytes(),
            lastError: lastError?.message ?? null,
          },
        });
        const line = encodeLine(sentinel);
        writer.write(line);
      }

      await writer.flushAndClose();
    },
  };

  return recorder;
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
   * `data?: Record<string, unknown>` contract from design §6.2.
   */
  readonly sanitized?: Record<string, unknown>;
  readonly parentEntryId?: string;
}

function buildEvent(input: BuildEventInput): TrajectoryEvent {
  const traceId = resolveTraceId(input.init.sessionId);
  const envelope: Mutable<TrajectoryEvent> = {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    // All recorder-driven emits are runtime-sourced. The other two
    // values ("transcript", "export") are reserved for future
    // post-processors and are NOT used by the live recorder
    // (design §6.2 + §1.4).
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
  if (input.init.provider !== undefined) envelope.provider = input.init.provider;
  if (input.init.modelId !== undefined) envelope.modelId = input.init.modelId;
  if (input.init.modelApi !== undefined) envelope.modelApi = input.init.modelApi;
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
