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
 * Comis improvements over the legacy 16-char-digest cache-trace-writer
 * (which lived in `packages/agent/src/executor/stream-wrappers`):
 *   - `traceSchema: "comis-cache-trace"` + `schemaVersion: 1` — explicit
 *     parser fence; downstream replay/diff tooling can reject foreign
 *     artifacts.
 *   - Full 64-char `messagesDigest` + `systemDigest` via
 *     `stableStringify` (`shared/stable-stringify.ts`) instead of the
 *     legacy 16-char truncated SHA-256.
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
 * → session.after → control-plane sentinel). Append-only — insertion
 * order is part of the SemVer contract for v1.
 *
 * The trailing `cache_trace.write_failures` is a control-plane sentinel
 * (not an application stage) emitted only by `flushAndClose` when the
 * underlying queued writer reports per-line append failures. Mirrors
 * trajectory's `trace.truncated` + `trace.write_failures` precedent
 * (both inside `TRAJECTORY_EVENT_TYPES`).
 */
export const CACHE_TRACE_STAGES = [
  "session:start",
  "session:end",
  "prompt:before",
  "prompt:after",
  "model:before",
  "model:after",
  "stream:context",
  "tool:before",
  "tool:after",
  "session:after",
  // Control-plane sentinel: queued writer rejected lines at flushAndClose.
  "cache_trace.write_failures",
] as const;

/** Closed string union of cache-trace stage names. */
export type CacheTraceStage = (typeof CACHE_TRACE_STAGES)[number];

/**
 * Cache-trace event — one record per JSONL line.
 *
 * Required envelope fields: `traceSchema`, `schemaVersion`, `stage`,
 * `ts`, `seq`, `agentId`, `sessionId`. Optional metadata fields cover
 * the per-stage payload variants (most stages carry a subset).
 *
 * The token-attribution fields (`cacheReadInputTokens`,
 * `cacheCreationInputTokens`) are physically only available on
 * `session:after` stages — the values come from the
 * `observability:token_usage` event payload which fires *after* the
 * model response. Earlier stages omit them.
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
  provider: z.string().optional(),
  modelId: z.string().optional(),
  // Message / system payloads (gated by includeMessages / includeSystem).
  messages: z.array(z.unknown()).optional(),
  messageCount: z.number().int().nonnegative().optional(),
  messageRoles: z.array(z.string()).optional(),
  messageFingerprints: z.array(z.string()).optional(),
  messagesDigest: z.string().optional(),
  system: z.unknown().optional(),
  systemDigest: z.string().optional(),
  // Token attribution (attached to session:after only).
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  // Sentinel data (cache_trace.write_failures only).
  data: z.unknown().optional(),
});

/** Inferred event type — kept in sync with the schema via the test invariant. */
export type CacheTraceEvent = z.infer<typeof CacheTraceEventSchema>;
