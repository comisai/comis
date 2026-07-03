// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-trace runtime recorder.
 *
 * A daemon-wide JSONL recorder that emits ONE line per recall via
 * `recordRecall`. A near-verbatim sibling of `createCacheTrace`
 * (`cache-trace/runtime.ts`), simplified to a single method:
 *
 *   - The recall trace is ONE rich record per recall, not a
 *     per-stage stage machine — so there is no `stage` argument, no
 *     token-usage stash, and no `session:after` terminal-emit lifecycle.
 *   - Crucially, the recall trace has NO opt-in raw-content slot (unlike
 *     cache-trace's `includeMessages` / `includeSystem` exemptions). EVERY
 *     payload always goes through full `sanitizeForPersistence` (bound →
 *     sanitize → redact) with NO overrides — this is the chokepoint
 *     proven by the mandatory failing-first redaction test in
 *     runtime.test.ts. A buggy/malicious producer that stuffs a secret, a
 *     password, or an absolute path into the payload has those values
 *     masked (in-text credentials) or dropped (credential-keyed fields)
 *     before they ever reach disk.
 *
 * Shared substrate (reused, NOT rebuilt): the `getQueuedFileWriter`
 * registry (one writer per path, with `maxFileBytes` DoS cap + queued
 * backpressure), `safeJsonStringify` (cycle-safe line encoding), the
 * `resolveRecallTraceFilePath` `~`-expanding resolver, and the
 * `@comis/core/runtime` sanctioned-root time/env helpers (NEVER
 * `Date.now` / `new Date` / `process.env`).
 *
 * Disabled state: `init.enabled === false` OR `COMIS_DISABLE_RECALL_TRACE=1`
 * returns `null` (consumers null-check at the construction site — the
 * "no-op stub" contract is represented as a literal null, exactly like
 * cache-trace).
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

import { resolveRecallTraceFilePath } from "./paths.js";
import type { RecallTraceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Constants (defaults — overridable per init)
// ---------------------------------------------------------------------------

// 50 MB per-file cap (parity with cache-trace). Recall-trace events
// accumulate across many sessions in one long-lived daemon-wide file; the
// cap bounds DoS exposure and pairs with the queued writer's
// backpressure (`dropped`) + `failureCount()`.
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

// Module-level writer registry — keyed by file path. The recall trace is
// daemon-wide, so multiple recorders for the same file share one writer via
// the queued-writer chassis contract.
const writerRegistry = new Map<string, QueuedFileWriter>();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs to `createRecallTrace`. `enabled` is the primary gate;
 * `COMIS_DISABLE_RECALL_TRACE=1` is the secondary env-override escape hatch.
 *
 * `confinedBaseDir` (when set) forwards to the underlying queued writer and
 * from there to `appendRegularFile` — production daemon wiring passes
 * `path.join(os.homedir(), ".comis")` so an ancestor-symlink escape is
 * rejected before the open() call. Tests omit it.
 */
export interface RecallTraceInit {
  /** Master gate. When false, `createRecallTrace` returns null. */
  readonly enabled: boolean;
  /** Full output path. When unset, defaults to ~/.comis/logs/recall-trace.jsonl. */
  readonly filePath?: string;
  /** Opt-in real-path confinement base forwarded to the underlying writer. */
  readonly confinedBaseDir?: string;
  /** Agent identifier — required on every event envelope. */
  readonly agentId: string;
  /** Session identifier — required on every event envelope. */
  readonly sessionId: string;
  /**
   * Envelope cluster — optional contextual fields that ride on every recall
   * event when the agent wires them through. Clustering (rather than top-level
   * optional fields) follows the cache-trace precedent.
   */
  readonly envelope?: {
    readonly sessionKey?: string;
    readonly tenantId?: string;
    readonly runId?: string;
  };
  /** Per-file byte cap. Default 50 MB. */
  readonly maxFileBytes?: number;
  /** Per-writer queued byte cap. Default 4 MB. */
  readonly maxQueuedBytes?: number;
}

/**
 * Public recall-trace recorder interface. `recordRecall` is fire-and-forget;
 * it returns "queued" or "dropped" so the caller can observe backpressure.
 */
export interface RecallTrace {
  /** Resolved on-disk file path. */
  readonly filePath: string;
  /**
   * Enqueue one recall record. The `record` payload is routed through
   * `sanitizeForPersistence` (bound → sanitize → redact) BEFORE the envelope
   * is built and written — the chokepoint.
   */
  recordRecall(record: Record<string, unknown>): "queued" | "dropped";
  /** Await the queue tail. */
  flush(): Promise<void>;
  /**
   * Await the queue tail, emit the `recall_trace.write_failures` sentinel
   * when the underlying writer reports per-line append failures, and remove
   * the writer from the registry.
   */
  flushAndClose(): Promise<void>;
  /** Underlying writer failure count — surfaced for inspection by tests. */
  failureCount(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a daemon-wide recall-trace recorder. Returns `null` when disabled
 * via `init.enabled === false` OR `COMIS_DISABLE_RECALL_TRACE=1` (consumers
 * null-check at the construction site).
 *
 * The returned recorder is bound to one file path; multiple recorders for the
 * same file share the underlying queued writer via the module-level registry.
 */
export function createRecallTrace(init: RecallTraceInit): RecallTrace | null {
  if (init.enabled === false) return null;
  if (isDisabledByEnv()) return null;

  const filePath = resolveRecallTraceFilePath({
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

  // Per-recorder mutable state. The writer chassis is shared across recorders
  // for the same path, but seq accounting is per-recorder.
  //
  // Sentinel state-machine fields (mirror cache-trace/runtime.ts):
  //   - `writeFailureSentinelEmitted`: once-per-recorder latch for the inline
  //     `recall_trace.write_failures` emit inside recordRecall. The latch
  //     flips true on the first detection of `writer.failureCount() > 0` so
  //     subsequent recordRecall calls do NOT re-emit the inline sentinel (the
  //     summary sentinel at flushAndClose carries the final tally).
  //   - `startedAt`: captured at construction so the summary sentinel can
  //     report `lifetimeMs = systemNowMs() - state.startedAt`.
  const state: {
    seq: number;
    closed: boolean;
    writeFailureSentinelEmitted: boolean;
    startedAt: number;
  } = {
    seq: 0,
    closed: false,
    writeFailureSentinelEmitted: false,
    startedAt: systemNowMs(),
  };

  const recorder: RecallTrace = {
    filePath,

    recordRecall(record: Record<string, unknown>): "queued" | "dropped" {
      if (state.closed) return "dropped";

      // 0. Inline `recall_trace.write_failures` sentinel (mirrors
      //    cache-trace/runtime.ts). The queued writer surfaces per-line
      //    append failures asynchronously (inside the writer's promise
      //    chain, not at the recordRecall call site), so on every call we
      //    check `writer.failureCount()` and — if it's > 0 AND we have not
      //    yet emitted the inline sentinel — emit ONE sentinel BEFORE
      //    processing the new event. The latch
      //    `state.writeFailureSentinelEmitted` collapses subsequent failure
      //    detections into the summary sentinel at flushAndClose so we never
      //    flood the file with per-failure sentinels. The emit is
      //    best-effort: when the cap is fully exhausted the sentinel write
      //    itself is rejected; the latch still flips so we do not spin-emit.
      const writerFailureCount = writer.failureCount();
      if (!state.writeFailureSentinelEmitted && writerFailureCount > 0) {
        state.writeFailureSentinelEmitted = true;
        // The sentinel `data` goes through the same
        // sanitizeForPersistence chokepoint as every per-recall record so the
        // "no raw value reaches disk" invariant covers control-plane lines too.
        // (The inline sentinel's current fields are numbers/ISO timestamps, but
        // sanitizing uniformly keeps the invariant enforced by the code rather
        // than by the current field contents — see the summary sentinel below.)
        const inlineData = sanitizeForPersistence({
          firstDropAt: systemDateFrom(systemNowMs()).toISOString(),
          droppedEvents: writerFailureCount,
          droppedBytes: writer.rejectedBytes(),
          reason: "queued_writer_rejected",
        }) as Record<string, unknown>;
        writer.write(encodeSentinel(buildSentinel(init, state.seq, inlineData)));
        state.seq += 1;
      }

      // THE CHOKEPOINT. Route EVERY payload through
      // sanitizeForPersistence (bound → sanitize → redact in one walk). NO
      // overrides — the recall trace has NO opt-in raw-content slot (unlike
      // cache-trace's includeMessages/includeSystem), so nothing is exempt
      // from the 32 KB / 64-item caps or the credential drop/mask. Bounding
      // BEFORE redact prevents a truncated-prefix leak of an oversize
      // credential. Oversize fields become {__bounded__} sentinels (never a
      // silent drop); credential-keyed fields are dropped; in-text secrets
      // are edge-mask redacted.
      const sanitized = sanitizeForPersistence(record) as Record<string, unknown>;

      const event = buildEvent(init, state.seq, sanitized);
      const result = writer.write(encodeLine(event));
      if (result === "queued") {
        state.seq += 1;
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

      // Summary `recall_trace.write_failures` sentinel (mirrors
      // cache-trace/runtime.ts). Fires at flushAndClose when the underlying
      // queued writer reports per-line append failures. Carries the final
      // tally + recorder lifetime so post-mortem readers know how many
      // events were dropped, the cumulative dropped bytes, how long the
      // recorder ran, and the last underlying error.
      // Two-sentinel-per-failing-recorder model:
      //   recorders that hit a write failure → exactly 1 inline + 1 summary
      //   recorders that never fail          → 0 sentinels
      const failureCount = writer.failureCount();
      if (failureCount > 0) {
        const lastError = writer.lastError();
        // Sentinel emit is best-effort — when the underlying failure source
        // is unrecoverable this write fails too; failureCount() continues to
        // surface the truth even when nothing lands.
        //
        // Route the sentinel `data` through sanitizeForPersistence
        // (the SAME chokepoint every per-recall record uses) so the
        // "no raw value reaches disk" invariant holds for control-plane lines
        // too. The raw `lastError.message` for an fs append error is the trace
        // file's own path, and a future error source could embed user/secret
        // text — both are bounded + redacted here before encodeSentinel.
        const summaryData = sanitizeForPersistence({
          reason: "queued_writer_rejected",
          droppedEvents: failureCount,
          totalDroppedBytes: writer.rejectedBytes(),
          lifetimeMs: systemNowMs() - state.startedAt,
          lastError: lastError?.message ?? null,
        }) as Record<string, unknown>;
        writer.write(encodeSentinel(buildSentinel(init, state.seq, summaryData)));
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

function isDisabledByEnv(): boolean {
  // systemGetEnv goes through the sanctioned-root helper in
  // @comis/core/runtime — direct process.env reads inside a leaf module are
  // forbidden by the globals architecture test.
  const raw = systemGetEnv("COMIS_DISABLE_RECALL_TRACE");
  if (typeof raw !== "string") return false;
  const norm = raw.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/**
 * Build the recall-trace envelope around an already-sanitized payload.
 *
 * `systemDateFrom` + `systemNowMs` go through the sanctioned-root helpers in
 * @comis/core/runtime — direct `new Date(...)` is forbidden by the globals
 * architecture test. `traceId` is auto-derived from the AsyncLocalStorage
 * RequestContext when present, falling back to `sessionId`.
 */
function buildEvent(
  init: RecallTraceInit,
  seq: number,
  payload: Record<string, unknown>,
): RecallTraceEvent {
  const ts = systemDateFrom(systemNowMs()).toISOString();
  const traceId = resolveTraceId(init.sessionId);
  // Merge the sanitized payload FIRST, then assign the scope/envelope
  // identifiers LAST so they ALWAYS win. The scope ids (agentId, sessionId,
  // traceId, sessionKey, tenantId, runId) are authoritative — the read-side
  // scope-filter trusts them — so a (buggy/future) producer that places
  // a same-named key in the record must NOT be able to clobber them. The old
  // order (envelope first, payload merged on top) left the invariant enforced
  // only by the current contents of buildRecallRecord rather than by the code.
  const envelope: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) envelope[k] = v;
  }
  envelope.traceSchema = "comis-recall-trace";
  envelope.schemaVersion = 1;
  envelope.ts = ts;
  envelope.seq = seq;
  envelope.agentId = init.agentId;
  envelope.sessionId = init.sessionId;
  envelope.traceId = traceId;
  const env = init.envelope;
  if (env?.sessionKey !== undefined) envelope.sessionKey = env.sessionKey;
  if (env?.tenantId !== undefined) envelope.tenantId = env.tenantId;
  if (env?.runId !== undefined) envelope.runId = env.runId;
  return envelope as RecallTraceEvent;
}

/**
 * Resolve the canonical correlation key for the event envelope. Mirrors
 * cache-trace's `resolveTraceId`: use the RequestContext `traceId` when in
 * scope (set by `runWithContext` at channel/gateway/scheduler boundaries),
 * else fall back to `sessionId`.
 */
function resolveTraceId(sessionId: string): string {
  const ctx = tryGetContext();
  if (ctx !== undefined && typeof ctx.traceId === "string" && ctx.traceId.length > 0) {
    return ctx.traceId;
  }
  return sessionId;
}

function encodeLine(evt: RecallTraceEvent): string {
  return `${safeJsonStringify(evt)}\n`;
}

/**
 * Build the control-plane `recall_trace.write_failures` sentinel envelope.
 *
 * Mirrors cache-trace's `cache_trace.write_failures` sentinel pair (inline +
 * summary). The recall trace has NO `stage` discriminator (it is ONE rich
 * record per recall, not a stage machine), so the sentinel cannot ride the
 * strict `RecallTraceEvent` schema; it is a DISTINCT control-plane line keyed
 * by a `recallTrace: "recall_trace.write_failures"` discriminator. It carries
 * the same correlation envelope (traceSchema/schemaVersion/ts/seq/agentId/
 * sessionId/traceId + the optional cluster) so downstream tooling joins it by
 * `traceId` and rejects foreign artifacts by `traceSchema`.
 *
 * `systemDateFrom` + `systemNowMs` go through the sanctioned-root helpers in
 * @comis/core/runtime — direct `new Date(...)` is forbidden by the globals
 * architecture test.
 */
function buildSentinel(
  init: RecallTraceInit,
  seq: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const ts = systemDateFrom(systemNowMs()).toISOString();
  const traceId = resolveTraceId(init.sessionId);
  const envelope: Record<string, unknown> = {
    traceSchema: "comis-recall-trace",
    schemaVersion: 1,
    recallTrace: "recall_trace.write_failures",
    ts,
    seq,
    agentId: init.agentId,
    sessionId: init.sessionId,
    traceId,
    data,
  };
  const env = init.envelope;
  if (env?.sessionKey !== undefined) envelope.sessionKey = env.sessionKey;
  if (env?.tenantId !== undefined) envelope.tenantId = env.tenantId;
  if (env?.runId !== undefined) envelope.runId = env.runId;
  return envelope;
}

function encodeSentinel(evt: Record<string, unknown>): string {
  return `${safeJsonStringify(evt)}\n`;
}
