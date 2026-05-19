// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace runtime recorder.
 *
 * Per-session cache-trace writer that emits one JSONL line per
 * cache-relevant stage. Mirrors the trajectory runtime structure
 * (`trajectory/runtime.ts`) with these adaptations:
 *
 *   - Stage-keyed events (closed-union `CacheTraceStage`) instead of
 *     trajectory's `type` field. The schema versioning + envelope shape
 *     (`traceSchema`, `schemaVersion`, `seq`, `ts`, etc.) is identical.
 *   - Single file path (resolved via `resolveCacheTraceFilePath`)
 *     rather than per-session JSONL.
 *   - 10 MB per-file cap (smaller than trajectory's 50 MB because
 *     cache-trace events accumulate across many sessions in one
 *     long-lived file — bounded to limit DoS exposure).
 *   - `setLatestTokenUsage` + `attachToEventBus` (see
 *     `event-bus-bridge.ts`): the EventBus bridge subscribes to
 *     `observability:token_usage` (the only event that physically
 *     carries `cacheReadTokens` + `cacheWriteTokens`) and stashes the
 *     latest values on the recorder. The next `recordStage("session:after",
 *     {...})` reads and attaches them.
 *
 * Disabled state: `init.enabled === false` OR `COMIS_DISABLE_CACHE_TRACE=1`
 * returns `null` (consumers null-check at the construction site —
 * a "no-op stub" contract represented as a literal null).
 *
 * @module
 */

import { systemDateFrom, systemGetEnv, systemNowMs } from "@comis/core";

import {
  getQueuedFileWriter,
  type QueuedFileWriter,
} from "../shared/queued-file-writer.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";

import { resolveCacheTraceFilePath } from "./paths.js";
import type { CacheTraceEvent, CacheTraceStage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (defaults — overridable per init)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

// Module-level writer registry — keyed by file path. Multiple recorders
// for the same file (the typical case — cache-trace is daemon-wide)
// share one writer via the queued-writer chassis contract.
const writerRegistry = new Map<string, QueuedFileWriter>();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs to `createCacheTrace`. The `enabled` flag is the primary gate;
 * `COMIS_DISABLE_CACHE_TRACE=1` is the secondary env-override gate (a
 * one-line operator escape hatch).
 *
 * `confinedBaseDir` (when set) forwards to the underlying queued writer
 * and from there to `appendRegularFile` — production daemon wiring
 * passes `path.join(os.homedir(), ".comis")` so an ancestor-symlink
 * escape is rejected before the open() call.
 */
export interface CacheTraceInit {
  /** Master gate. When false, `createCacheTrace` returns null. */
  readonly enabled: boolean;
  /** Full output path. When unset, defaults to ~/.comis/logs/cache-trace.jsonl. */
  readonly filePath?: string;
  /** PII gate. When false, the wrapper-emitted `messages` field is omitted from the payload. */
  readonly includeMessages: boolean;
  /** Prompt-inclusion gate (currently informational — reserved for future wrapper passes). */
  readonly includePrompt: boolean;
  /** System-prompt inclusion gate. When false, the wrapper omits `system` from the payload. */
  readonly includeSystem: boolean;
  /** Agent identifier — required on every event envelope. */
  readonly agentId: string;
  /** Session identifier — required on every event envelope. */
  readonly sessionId: string;
  /** Provider id (e.g. "anthropic"). Optional metadata for downstream replay tools. */
  readonly provider?: string;
  /** Model id (e.g. "claude-3-opus"). Optional metadata for downstream replay tools. */
  readonly modelId?: string;
  /**
   * Opt-in real-path confinement base forwarded to the underlying
   * queued writer. Daemon wiring passes `path.join(os.homedir(), ".comis")`
   * so an ancestor-symlink escape is rejected before the open() call.
   * Tests omit it (the option is opt-in for back-compat).
   */
  readonly confinedBaseDir?: string;
  /** Per-file byte cap. Default 10 MB. */
  readonly maxFileBytes?: number;
  /** Per-writer queued byte cap. Default 4 MB. */
  readonly maxQueuedBytes?: number;
}

/**
 * Public cache-trace recorder interface. `recordStage` is fire-and-forget;
 * it returns "queued" or "dropped" so the caller can observe backpressure.
 *
 * `setLatestTokenUsage` is wired by the EventBus bridge — every time
 * `observability:token_usage` fires, the bridge stashes the latest values
 * here. The next `recordStage("session:after", {...})` reads and attaches
 * them, then clears the stash.
 */
export interface CacheTrace {
  /** Resolved on-disk file path. */
  readonly filePath: string;
  /** Echoed init flag — used by the wrapper to gate `messages` field emit. */
  readonly includeMessages: boolean;
  /** Echoed init flag — reserved for future wrapper passes. */
  readonly includePrompt: boolean;
  /** Echoed init flag — used by the wrapper to gate `system` field emit. */
  readonly includeSystem: boolean;

  /** Enqueue one stage event. `payload` is sanitized before write. */
  recordStage(stage: CacheTraceStage, payload: Record<string, unknown>): "queued" | "dropped";

  /**
   * Stash the latest token-usage values from the bus bridge. The next
   * `recordStage("session:after", {...})` reads and attaches them.
   */
  setLatestTokenUsage(payload: { cacheReadTokens?: number; cacheWriteTokens?: number }): void;

  /** Await the queue tail. */
  flush(): Promise<void>;

  /**
   * Await the queue tail, emit the `cache_trace.write_failures` sentinel
   * when the underlying writer reports per-line append failures, and
   * remove the writer from the registry.
   */
  flushAndClose(): Promise<void>;

  /** Underlying writer failure count — surfaced for inspection by tests. */
  failureCount(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-session cache-trace recorder. Returns `null` when
 * disabled via `init.enabled === false` OR `COMIS_DISABLE_CACHE_TRACE=1`
 * (consumers null-check at the construction site).
 *
 * The returned recorder is bound to one file path; multiple recorders
 * for the same file share the underlying queued writer via the
 * module-level registry.
 */
export function createCacheTrace(init: CacheTraceInit): CacheTrace | null {
  if (init.enabled === false) return null;
  if (isDisabledByEnv()) return null;

  const filePath = resolveCacheTraceFilePath({
    ...(init.filePath !== undefined ? { filePath: init.filePath } : {}),
    ...(init.confinedBaseDir !== undefined
      ? { confinedBaseDir: init.confinedBaseDir }
      : {}),
  });

  const maxFileBytes = init.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxQueuedBytes = init.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;

  const writer = getQueuedFileWriter(writerRegistry, filePath, {
    maxQueuedBytes,
    maxFileBytes,
    ...(init.confinedBaseDir !== undefined
      ? { confinedBaseDir: init.confinedBaseDir }
      : {}),
  });

  // Per-recorder mutable state. The writer chassis is shared across
  // recorders for the same path, but seq accounting + latest-token-usage
  // is per-recorder (matches trajectory's pattern).
  const state: {
    seq: number;
    closed: boolean;
    latestTokenUsage:
      | { cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
  } = {
    seq: 0,
    closed: false,
    latestTokenUsage: undefined,
  };

  const recorder: CacheTrace = {
    filePath,
    includeMessages: init.includeMessages,
    includePrompt: init.includePrompt,
    includeSystem: init.includeSystem,

    recordStage(
      stage: CacheTraceStage,
      payload: Record<string, unknown>,
    ): "queued" | "dropped" {
      if (state.closed) return "dropped";

      // 1. Sanitize the payload through the canonical pipeline.
      //    sanitizeForPersistence applies credential redaction +
      //    diagnostic-payload sanitization + bounded-payload limiter.
      const sanitized = sanitizeForPersistence(payload) as Record<string, unknown>;

      // 2. Splat token attribution onto `session:after`. Only
      //    session:after carries the token counts (the values do not
      //    physically exist before observability:token_usage fires).
      const tokenSplat =
        stage === "session:after" && state.latestTokenUsage !== undefined
          ? {
              ...(state.latestTokenUsage.cacheReadTokens !== undefined
                ? { cacheReadInputTokens: state.latestTokenUsage.cacheReadTokens }
                : {}),
              ...(state.latestTokenUsage.cacheWriteTokens !== undefined
                ? {
                    cacheCreationInputTokens:
                      state.latestTokenUsage.cacheWriteTokens,
                  }
                : {}),
            }
          : {};

      // Clear stash after consuming (one-shot — the next session:after
      // must come from a fresh bus emit).
      if (stage === "session:after") {
        state.latestTokenUsage = undefined;
      }

      const event = buildEvent({
        stage,
        seq: state.seq,
        init,
        payload: sanitized,
        extras: tokenSplat,
      });

      const line = encodeLine(event);
      const result = writer.write(line);
      if (result === "queued") {
        state.seq += 1;
      }
      return result;
    },

    setLatestTokenUsage(payload): void {
      // Mirror only the two fields the cache-trace cares about. The
      // EventBus payload carries many more — bus-bridge.ts narrows
      // before calling this.
      const next: { cacheReadTokens?: number; cacheWriteTokens?: number } = {};
      if (typeof payload.cacheReadTokens === "number") {
        next.cacheReadTokens = payload.cacheReadTokens;
      }
      if (typeof payload.cacheWriteTokens === "number") {
        next.cacheWriteTokens = payload.cacheWriteTokens;
      }
      state.latestTokenUsage = next;
    },

    async flush(): Promise<void> {
      await writer.flush();
    },

    async flushAndClose(): Promise<void> {
      if (state.closed) return;
      state.closed = true;
      await writer.flush();

      // Emit the cache_trace.write_failures sentinel when the underlying
      // queued writer reports per-line append failures. Mirrors
      // trajectory's trace.write_failures pattern.
      const failureCount = writer.failureCount();
      if (failureCount > 0) {
        const lastError = writer.lastError();
        const sentinel = buildEvent({
          stage: "cache_trace.write_failures",
          seq: state.seq,
          init,
          payload: {},
          extras: {
            data: {
              reason: "queued_writer_rejected",
              count: failureCount,
              rejectedBytes: writer.rejectedBytes(),
              lastError: lastError?.message ?? null,
            },
          },
        });
        const line = encodeLine(sentinel);
        // Sentinel emit is best-effort — when the underlying failure
        // source is unrecoverable (e.g., symlinked parent for the
        // session lifetime) this write will also fail; failureCount
        // continues to surface the truth even when nothing lands.
        writer.write(line);
      }

      await writer.flushAndClose();
    },

    failureCount(): number {
      return writer.failureCount();
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
  const raw = systemGetEnv("COMIS_DISABLE_CACHE_TRACE");
  if (typeof raw !== "string") return false;
  const norm = raw.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

interface BuildEventInput {
  readonly stage: CacheTraceStage;
  readonly seq: number;
  readonly init: CacheTraceInit;
  readonly payload: Record<string, unknown>;
  readonly extras: Record<string, unknown>;
}

function buildEvent(input: BuildEventInput): CacheTraceEvent {
  // systemDateFrom + systemNowMs go through the sanctioned-root helpers
  // in @comis/core/runtime — direct `new Date(...)` is forbidden by the
  // globals architecture test.
  const ts = systemDateFrom(systemNowMs()).toISOString();
  const envelope: Record<string, unknown> = {
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: input.stage,
    ts,
    seq: input.seq,
    agentId: input.init.agentId,
    sessionId: input.init.sessionId,
  };
  if (input.init.provider !== undefined) envelope.provider = input.init.provider;
  if (input.init.modelId !== undefined) envelope.modelId = input.init.modelId;
  for (const [k, v] of Object.entries(input.payload)) {
    if (v !== undefined) envelope[k] = v;
  }
  for (const [k, v] of Object.entries(input.extras)) {
    envelope[k] = v;
  }
  return envelope as CacheTraceEvent;
}

function encodeLine(evt: CacheTraceEvent): string {
  return `${safeJsonStringify(evt)}\n`;
}
