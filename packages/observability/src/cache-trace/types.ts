// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace event v1 schema — closed-union stages + Zod envelope.
 *
 * The cache-trace is a per-session JSONL sidecar capturing
 * cache-relevant lifecycle stages for a single agent turn. Each event is
 * one JSONL line; the file is bounded (`maxFileBytes`) and the writer
 * gracefully degrades on write failures (the queued writer chassis).
 *
 * Closed enum invariant: `CACHE_TRACE_STAGES` is a literal `as const`
 * tuple so consumers can enumerate it at test time and the Zod schema's
 * `stage` field rejects unknown stages at parse time.
 *
 * Design properties of this schema:
 *   - `traceSchema: "comis-cache-trace"` + `schemaVersion: 1` — explicit
 *     parser fence; downstream replay/diff tooling can reject foreign
 *     artifacts.
 *   - Full 64-char `messagesDigest` + `systemDigest` via
 *     `stableStringify` (`shared/stable-stringify.ts`).
 *   - Per-stage events emitted at lifecycle boundaries — not a single
 *     point at the LLM call.
 *   - `cacheReadInputTokens` + `cacheCreationInputTokens` attached to
 *     `session:after` via the EventBus bridge subscription (the values
 *     do not physically exist before `observability:token_usage` fires —
 *     pi-event-bridge.ts:993-1021).
 *
 * @module
 */

import { z } from "zod";

/**
 * Closed enum of cache-trace stages.
 *
 * Order: lifecycle-relevant (session.* → prompt → model → context → tool
 * → session.after → control-plane sentinel).
 * The stage tuple is append-only: new stages are added at the end; existing entries and their order never change.
 *
 * The trailing `cache_trace.write_failures` is a control-plane sentinel
 * (not an application stage) emitted by the runtime on first queued
 * writer rejection (inline) AND by `flushAndClose` (summary) when the
 * underlying queued writer reports per-line append failures. Mirrors
 * trajectory's `trace.truncated` + `trace.write_failures` precedent
 * (both inside `TRAJECTORY_EVENT_TYPES`).
 *
 * Per-stage inline `// emitted by …` comments document the producer
 * call site for each stage. Adding a new stage requires (1) appending
 * to this literal, (2) writing the producer wiring, and (3) updating
 * the inline comment with the producer location — the comments are
 * load-bearing documentation for the architecture tests (see
 * `cache-trace-stages-known.test.ts`) that walk `recordStage(<literal>, …)`
 * call sites and enforce the closed union.
 */
export const CACHE_TRACE_STAGES = [
  "session:start",   // emitted by event-bus-bridge from session:started
  "session:end",     // emitted by event-bus-bridge from session:ended
  "prompt:before",   // emitted by event-bus-bridge from prompt:submitted (digest-cache pre-state read)
  "prompt:after",    // emitted by event-bus-bridge from prompt:submitted (digest-cache post-state read)
  "model:before",    // emitted by buildCacheTraceWrapper just before stream-fn delegation (stream-fn-wrapper.ts)
  "model:after",     // emitted by buildCacheTraceWrapper post-call (stream-fn-wrapper.ts)
  "stream:context",  // emitted by buildCacheTraceWrapper pre-call (stream-fn-wrapper.ts)
  "tool:before",     // emitted by event-bus-bridge from tool:started
  "tool:after",      // emitted by event-bus-bridge from tool:executed
  "session:after",   // emitted by pi-executor at turn end + terminal emit in flushAndClose
  "cache_trace.write_failures",  // control-plane sentinel — inline + flushAndClose summary
] as const;

/** Closed string union of cache-trace stage names. */
export type CacheTraceStage = (typeof CACHE_TRACE_STAGES)[number];

/**
 * Cache-trace event — one record per JSONL line.
 *
 * Required envelope fields: `traceSchema`, `schemaVersion`, `stage`,
 * `ts`, `seq`, `agentId`, `sessionId`, `traceId`. `traceId` is the
 * canonical correlation key (the canonical correlation triple) — every
 * cache-trace event ships with one so downstream
 * replay/diff/analysis tools can join across multiple JSONL streams
 * (trajectory, cache-trace, audit log) by traceId.
 *
 * The 5 optional envelope fields (`runId`, `sessionKey`, `tenantId`,
 * `workspaceDir`, `modelApi`) complete the envelope conformance contract
 * — present when the executor passes them through, omitted otherwise.
 * Each is `string | undefined` except `modelApi` which is
 * `string | null | undefined` (the design explicitly allows null for
 * the "no model API discriminator" case).
 *
 * The token-attribution fields (`cacheReadInputTokens`,
 * `cacheCreationInputTokens`) attach to `session:after` (aggregated
 * across the session via the EventBus bridge) AND to `model:after`
 * (per-call snapshot from the StreamFn return value).
 *
 * `data` carries control-plane sentinel data (used by
 * `cache_trace.write_failures` to surface queued-writer rejection
 * metadata). Application stages do not populate `data`.
 */
export const CacheTraceEventSchema = z.object({
  traceSchema: z.literal("comis-cache-trace"),
  schemaVersion: z.literal(1),
  stage: z.enum(CACHE_TRACE_STAGES),
  ts: z.string(), // ISO-8601
  seq: z.number().int().nonnegative(),
  agentId: z.string(),
  sessionId: z.string(),
  // The canonical correlation key — required. Auto-derived from the
  // AsyncLocalStorage RequestContext when present, falling back to
  // sessionId.
  traceId: z.string(),
  // Envelope fields — optional; the executor wires what's reachable.
  runId: z.string().optional(),
  sessionKey: z.string().optional(),
  tenantId: z.string().optional(),
  workspaceDir: z.string().optional(),
  modelApi: z.string().nullable().optional(),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  // Message / system payloads (gated by includeMessages / includeSystem).
  messages: z.array(z.unknown()).optional(),
  messageCount: z.number().int().nonnegative().optional(),
  messageRoles: z.array(z.string()).optional(),
  // A SMALL assembled-array shape descriptor — per-message
  // block-kind counts + a `hasToolResult` flag + tool_use/tool_result
  // id-pairing summary. It lets a test assert tool_use<->tool_result pairing
  // + array growth WITHOUT shipping the full `messages` array, so it is
  // present even when includeMessages is OFF. Counts/flags + opaque
  // toolCallId strings ONLY — never block bodies — so it stays well under the
  // 32 KB bound and rides sanitizeForPersistence unchanged (it is NOT added
  // to the exempt set). The permanent provider-boundary regression gate
  // asserts against this (see provider-boundary-harness.test.ts).
  //
  // The `toolUseIds` / `toolResultIds` arrays are a SAMPLE
  // (capped at MAX_SAMPLED_IDS, below the 64-item array bound) so the limiter
  // never replaces them with an opaque sentinel on large tool fan-outs. The
  // authoritative pairing/growth signal lives in the integer count fields
  // (`toolUseCount` / `toolResultCount` / `pairedToolResultCount`), which
  // cannot vanish under the bound; `idsTruncated` flags when the arrays are a
  // partial sample.
  assembledShape: z
    .object({
      totalCount: z.number().int().nonnegative(),
      blockKindCounts: z.record(z.string(), z.number().int().nonnegative()),
      hasToolResult: z.boolean(),
      toolUseIds: z.array(z.string()),
      toolResultIds: z.array(z.string()),
      toolUseCount: z.number().int().nonnegative(),
      toolResultCount: z.number().int().nonnegative(),
      pairedToolResultCount: z.number().int().nonnegative(),
      idsTruncated: z.boolean(),
    })
    .optional(),
  messageFingerprints: z.array(z.string()).optional(),
  messagesDigest: z.string().optional(),
  system: z.unknown().optional(),
  systemDigest: z.string().optional(),
  // Token attribution. `session:after` aggregates across the session via
  // the EventBus bridge stash; `model:after` carries the per-call snapshot
  // from the StreamFn return value's usage block.
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  // Sentinel data (cache_trace.write_failures only).
  data: z.unknown().optional(),
});

/** Inferred event type — kept in sync with the schema via the test invariant. */
export type CacheTraceEvent = z.infer<typeof CacheTraceEventSchema>;
