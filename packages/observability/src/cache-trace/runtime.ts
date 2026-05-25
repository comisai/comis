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
 *   - 50 MB per-file cap (parity with trajectory; the runtime fallback
 *     matches the schema default introduced by CacheTraceConfigSchemaInner.maxFileBytes).
 *     Cache-trace events accumulate across many sessions in one
 *     long-lived file — the cap bounds DoS exposure and is paired with
 *     the proactive inline + summary `cache_trace.write_failures`
 *     sentinel pair.
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

import { systemDateFrom, systemGetEnv, systemNowMs, tryGetContext } from "@comis/core";

import {
  getQueuedFileWriter,
  type QueuedFileWriter,
} from "../shared/queued-file-writer.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import type { PayloadBoundsOverrides } from "../shared/bounded-payload.js";

import { resolveCacheTraceFilePath } from "./paths.js";
import type { CacheTraceEvent, CacheTraceStage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (defaults — overridable per init)
// ---------------------------------------------------------------------------

// Co-located here with sentinel state-machine work to keep all
// runtime.ts edits together: the fallback default is 50 MB so it
// matches the schema default from CacheTraceConfigSchemaInner.maxFileBytes.
// In normal operation the schema default always wins via
// `init.maxFileBytes`; this fallback only applies when callers omit the
// option, but the agreement removes the "where does the actual cap come
// from?" investigation if an operator hits the issue.
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
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
   * Envelope cluster — the 5 contextual fields that ride on every
   * cache-trace event when the executor wires them through. Clustering
   * (rather than 5 top-level optional fields) follows the precedent of
   * `TrajectoryRecorderInit.model` and keeps `CacheTraceInit` under the
   * 12-optional-field architecture threshold (`optional-field-bloat`).
   *
   * Every event of the recorder carries these fields verbatim (the
   * envelope is per-event, not per-stage). `modelApi` is `string | null`
   * because the schema explicitly allows null for the "no API
   * discriminator" case (Anthropic provider without a sub-API split).
   */
  readonly envelope?: {
    readonly runId?: string;
    readonly sessionKey?: string;
    readonly tenantId?: string;
    readonly workspaceDir?: string;
    readonly modelApi?: string | null;
  };
  /**
   * Opt-in real-path confinement base forwarded to the underlying
   * queued writer. Daemon wiring passes `path.join(os.homedir(), ".comis")`
   * so an ancestor-symlink escape is rejected before the open() call.
   * Tests omit it (the option is opt-in for back-compat).
   */
  readonly confinedBaseDir?: string;
  /** Per-file byte cap. Default 50 MB. */
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
  //
  // Sentinel state-machine fields:
  //   - `writeFailureSentinelEmitted`: once-per-session latch for the
  //     inline `cache_trace.write_failures` emit inside recordStage.
  //     The latch flips true on the first detection of
  //     `writer.failureCount() > 0` so subsequent recordStage calls do
  //     NOT re-emit the inline sentinel (the summary sentinel at
  //     flushAndClose carries the final tally).
  //   - `sessionStartedAt`: captured at recorder construction so the
  //     summary sentinel can report `sessionLifetimeMs = systemNowMs() -
  //     state.sessionStartedAt`.
  const state: {
    seq: number;
    closed: boolean;
    latestTokenUsage:
      | { cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    writeFailureSentinelEmitted: boolean;
    sessionStartedAt: number;
  } = {
    seq: 0,
    closed: false,
    latestTokenUsage: undefined,
    writeFailureSentinelEmitted: false,
    sessionStartedAt: systemNowMs(),
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

      // 0. Inline `cache_trace.write_failures` sentinel.
      //    The queued writer surfaces per-line append failures
      //    asynchronously (the failure lands inside the writer's
      //    promise chain, not inside the recordStage call site). We
      //    cannot observe the failure synchronously after writer.write
      //    returns "queued"; instead, on every recordStage call we
      //    check `writer.failureCount()` and — if it's > 0 AND we have
      //    not yet emitted the inline sentinel — emit ONE sentinel
      //    BEFORE processing the new event. The latch
      //    `state.writeFailureSentinelEmitted` collapses subsequent
      //    failure detections into the summary sentinel at
      //    flushAndClose so we never flood the file with
      //    per-failure sentinels.
      //
      //    The emit is best-effort: when the cap is fully exhausted
      //    the sentinel write itself will be rejected by
      //    appendRegularFile. The latch still flips true so we do not
      //    spin-emit on every subsequent recordStage; the summary
      //    sentinel at flushAndClose carries the final tally.
      const writerFailureCount = writer.failureCount();
      if (!state.writeFailureSentinelEmitted && writerFailureCount > 0) {
        state.writeFailureSentinelEmitted = true;
        const inlineSentinel = buildEvent({
          stage: "cache_trace.write_failures",
          seq: state.seq,
          init,
          payload: {},
          extras: {
            data: {
              firstDropAt: systemDateFrom(systemNowMs()).toISOString(),
              droppedEvents: writerFailureCount,
              droppedBytes: writer.rejectedBytes(),
              reason: "queued_writer_rejected",
            },
          },
        });
        const inlineLine = encodeLine(inlineSentinel);
        // Best-effort emit — return value intentionally ignored. When
        // the underlying cap is exhausted, this write fails too;
        // `writer.failureCount()` continues to surface the truth and
        // the summary sentinel at flushAndClose captures the final
        // tally regardless.
        writer.write(inlineLine);
        state.seq += 1;
      }

      // 1. Sanitize the payload through the canonical pipeline.
      //    sanitizeForPersistence applies credential redaction +
      //    diagnostic-payload sanitization + bounded-payload limiter.
      //
      //    Derive per-key exemption overrides from the
      //    operator-set includeSystem / includeMessages flags. When the
      //    operator opts in, the corresponding payload slot can carry
      //    full SDK content even if it exceeds 32 KB (otherwise the
      //    limiter would silently replace it with a sentinel and defeat
      //    the opt-in). Exemption applies to both the string and array
      //    shapes because the wrapper populates `messages` as an array
      //    and `system` as a string OR an array of blocks depending on
      //    provider.
      const exempt = new Set<string>();
      if (init.includeSystem) exempt.add("system");
      if (init.includeMessages) exempt.add("messages");
      const overrides: PayloadBoundsOverrides | undefined =
        exempt.size > 0
          ? { stringFieldExempt: exempt, arrayFieldExempt: exempt }
          : undefined;
      const sanitized = sanitizeForPersistence(payload, overrides) as Record<string, unknown>;

      // 2. Splat token attribution onto `session:after`. Only
      //    session:after carries the token counts via the bus stash
      //    (the values do not physically exist before
      //    observability:token_usage fires). Shared with flushAndClose's
      //    terminal emit via the buildTokenSplat helper.
      const tokenSplat =
        stage === "session:after"
          ? buildTokenSplat(state.latestTokenUsage)
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

      // 1. Drain the latest token-usage stash as the terminal
      //    session:after. The terminal emit is UNCONDITIONAL — the
      //    absence of token data does not skip it. Every session
      //    terminates with exactly one session:after event on disk.
      //    This makes the lifecycle contract explicit and removes the
      //    "did the executor remember to emit session:after?" question
      //    from callers.
      const terminalSplat = buildTokenSplat(state.latestTokenUsage);
      state.latestTokenUsage = undefined;
      const terminalEvent = buildEvent({
        stage: "session:after",
        seq: state.seq,
        init,
        payload: {},
        extras: terminalSplat,
      });
      const terminalLine = encodeLine(terminalEvent);
      const terminalResult = writer.write(terminalLine);
      if (terminalResult === "queued") {
        state.seq += 1;
      }

      // 2. Mark closed AFTER the terminal emit so the idempotent
      //    early-return at the top of the method prevents a second
      //    terminal emit on re-entry.
      state.closed = true;
      await writer.flush();

      // 3. Summary `cache_trace.write_failures`
      //    sentinel. Fires at flushAndClose when the underlying queued
      //    writer reports per-line append failures. Carries the final
      //    tally + session lifetime so post-mortem readers know:
      //      - how many events were dropped (`droppedEvents`)
      //      - cumulative dropped bytes (`totalDroppedBytes`)
      //      - how long the session ran (`sessionLifetimeMs`)
      //      - the last underlying error message (`lastError`)
      //    Field renames vs prior shape:
      //      `count`         → `droppedEvents`         (naming parity
      //                                                 with the inline
      //                                                 sentinel)
      //      `rejectedBytes` → `totalDroppedBytes`     (signals "final
      //                                                 cumulative" vs
      //                                                 the inline
      //                                                 snapshot field
      //                                                 `droppedBytes`)
      //    The rename ships without aliases; no live external consumer
      //    pins the prior field shape.
      //    Two-sentinel-per-cap-hit-session model:
      //      sessions that hit the cap → exactly 1 inline + 1 summary
      //      sessions that never hit the cap → 0 sentinels
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
              droppedEvents: failureCount,
              totalDroppedBytes: writer.rejectedBytes(),
              sessionLifetimeMs: systemNowMs() - state.sessionStartedAt,
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
        state.seq += 1;
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

/**
 * Project a stashed token-usage record onto the cache-trace event
 * extras. Used by both the explicit `recordStage("session:after", …)`
 * call path and the terminal emit in `flushAndClose`. Returns `{}` when
 * the stash is empty — callers can splat the result unconditionally.
 */
function buildTokenSplat(
  latestTokenUsage:
    | { cacheReadTokens?: number; cacheWriteTokens?: number }
    | undefined,
): Record<string, unknown> {
  if (latestTokenUsage === undefined) return {};
  const splat: Record<string, unknown> = {};
  if (latestTokenUsage.cacheReadTokens !== undefined) {
    splat.cacheReadInputTokens = latestTokenUsage.cacheReadTokens;
  }
  if (latestTokenUsage.cacheWriteTokens !== undefined) {
    splat.cacheCreationInputTokens = latestTokenUsage.cacheWriteTokens;
  }
  return splat;
}

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
  // traceId — the canonical correlation key. Auto-derived from
  // the AsyncLocalStorage RequestContext when present, falling back to
  // sessionId. The runtime mirror of trajectory's resolveTraceId.
  const traceId = resolveTraceId(input.init.sessionId);
  const envelope: Record<string, unknown> = {
    traceSchema: "comis-cache-trace",
    schemaVersion: 1,
    stage: input.stage,
    ts,
    seq: input.seq,
    agentId: input.init.agentId,
    sessionId: input.init.sessionId,
    traceId,
  };
  if (input.init.provider !== undefined) envelope.provider = input.init.provider;
  if (input.init.modelId !== undefined) envelope.modelId = input.init.modelId;
  // Envelope cluster fields — lift each from the cluster when defined.
  const env = input.init.envelope;
  if (env?.runId !== undefined) envelope.runId = env.runId;
  if (env?.sessionKey !== undefined) envelope.sessionKey = env.sessionKey;
  if (env?.tenantId !== undefined) envelope.tenantId = env.tenantId;
  if (env?.workspaceDir !== undefined) envelope.workspaceDir = env.workspaceDir;
  if (env?.modelApi !== undefined) envelope.modelApi = env.modelApi;
  for (const [k, v] of Object.entries(input.payload)) {
    if (v !== undefined) envelope[k] = v;
  }
  for (const [k, v] of Object.entries(input.extras)) {
    envelope[k] = v;
  }
  return envelope as CacheTraceEvent;
}

/**
 * Resolve the canonical correlation key for the event envelope.
 *
 * When the AsyncLocalStorage RequestContext is in scope (set by
 * `runWithContext` at channel/gateway/scheduler boundaries), use its
 * `traceId`. Otherwise fall back to `sessionId` so the event always
 * carries a non-empty correlation key. Mirrors trajectory's
 * `resolveTraceId` at `trajectory/runtime.ts:365-371` verbatim.
 */
function resolveTraceId(sessionId: string): string {
  const ctx = tryGetContext();
  if (ctx !== undefined && typeof ctx.traceId === "string" && ctx.traceId.length > 0) {
    return ctx.traceId;
  }
  return sessionId;
}

function encodeLine(evt: CacheTraceEvent): string {
  return `${safeJsonStringify(evt)}\n`;
}
