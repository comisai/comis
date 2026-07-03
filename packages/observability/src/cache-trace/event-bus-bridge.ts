// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace EventBus bridge.
 *
 * Subscribes to the typed `EventBus` and translates each mapped event
 * into a `trace.recordStage(<stage>, <payload>)` call. The bridge
 * collapses N call-site instrumentations into one subscription per
 * session (mirrors `trajectory/event-bus-bridge.ts`).
 *
 * Subscriptions (per call to `attachCacheTraceToEventBus`):
 *
 *   1. `observability:token_usage` — side-effect handler that stashes
 *      `cacheReadTokens` + `cacheWriteTokens` onto the recorder via
 *      `trace.setLatestTokenUsage`. The next `recordStage("session:after", …)`
 *      consumes the stash. The bridge does NOT translate this event to a
 *      cache-trace stage (it is not in `CACHE_TRACE_BRIDGE_MAPPING`).
 *
 *   2. `prompt:submitted` — TWIN EMIT. Captures the prior digest-cache
 *      state, emits `recordStage("prompt:before", <prior-digests>)`,
 *      updates the bridge state with the new digests, then emits
 *      `recordStage("prompt:after", <new-digests>)`. The pair documents
 *      a cache transition for downstream replay/diff tools.
 *
 *   3. Mapping-table-driven (`CACHE_TRACE_BRIDGE_MAPPING`):
 *      - `session:started` → `recordStage("session:start", …)`
 *      - `session:ended`   → `recordStage("session:end", …)`
 *      - `tool:started`    → `recordStage("tool:before", …)`
 *      - `tool:executed`   → `recordStage("tool:after", …)`
 *
 * EXCLUDED from the mapping table (handled out-of-band):
 *   - `stream:context`, `model:before`, `model:after` — emitted directly
 *     by `buildCacheTraceWrapper` (the model context is already in scope
 *     inside the StreamFn wrapper; an EventBus round-trip would add no
 *     information).
 *   - `cache_trace.write_failures` — control-plane sentinel emitted by
 *     the runtime's `recordStage` closure (inline) plus the
 *     `flushAndClose` summary. Never bridged.
 *   - `session:after` — emitted by the pi-executor turn-end path plus the
 *     terminal emit in `flushAndClose`. The bridge stashes token totals
 *     for that emit via the token-stash side-effect handler.
 *
 * @module
 */

import type { EventMap, TypedEventBus } from "@comis/core";

import type { CacheTrace } from "./runtime.js";
import type { CacheTraceStage } from "./types.js";

// ---------------------------------------------------------------------------
// Mapping table (EventName → CacheTraceStage)
// ---------------------------------------------------------------------------

/**
 * Bridge mapping table — keys are `EventMap` event names that the bridge
 * translates 1:1 into cache-trace stages. The architecture test
 * (`cache-trace-stages-known.test.ts`) walks this table plus the direct
 * `recordStage` call sites to verify every application stage in
 * `CACHE_TRACE_STAGES` has at least one producer.
 *
 * Adding a new bridge entry must be paired with an entry in
 * `translateBridgedPayload` (TypeScript's exhaustive-switch will flag a
 * missing case).
 *
 * `prompt:submitted` is NOT in this table because it maps to TWO
 * stages (`prompt:before` + `prompt:after`); the twin-emit logic is
 * hard-coded in the bridge handler.
 *
 * `observability:token_usage` is NOT in this table because it is a
 * side-effect handler (token-stash), not a 1:1 stage producer.
 */
export const CACHE_TRACE_BRIDGE_MAPPING = {
  "session:started": "session:start",
  "session:ended": "session:end",
  "tool:started": "tool:before",
  "tool:executed": "tool:after",
} as const satisfies Record<string, CacheTraceStage>;

/** Closed string union of every EventBus event name the mapping covers. */
export type CacheTraceBridgedEventName = keyof typeof CACHE_TRACE_BRIDGE_MAPPING;

// ---------------------------------------------------------------------------
// Per-attach state
// ---------------------------------------------------------------------------

/**
 * Per-attach digest cache. The latest prompt digests propagate across
 * stages within a session so non-prompt stages can carry the current
 * digest fingerprint for correlation.
 *
 * Updated only by the `prompt:submitted` handler; read (best-effort) by
 * the mapping-table translators. Digest fields are omitted from emitted
 * payloads when state values are undefined (first stages of a session,
 * before any `prompt:submitted` has fired).
 */
interface BridgeState {
  latestMessagesDigest: string | undefined;
  latestSystemDigest: string | undefined;
}

// ---------------------------------------------------------------------------
// Payload translators
// ---------------------------------------------------------------------------

/**
 * Translate a bridged EventBus payload to the cache-trace `recordStage`
 * payload. Splats in the latest digests from `state` so downstream
 * consumers can correlate non-prompt stages to the active prompt cache.
 */
function translateBridgedPayload(
  eventName: CacheTraceBridgedEventName,
  rawPayload: unknown,
  state: BridgeState,
): Record<string, unknown> {
  const payload = rawPayload as Record<string, unknown>;
  const digestSplat: Record<string, unknown> = {};
  if (state.latestMessagesDigest !== undefined) {
    digestSplat.messagesDigest = state.latestMessagesDigest;
  }
  if (state.latestSystemDigest !== undefined) {
    digestSplat.systemDigest = state.latestSystemDigest;
  }

  switch (eventName) {
    case "session:started":
      return {
        ...digestSplat,
        channelType: payload.channelType,
        channelId: payload.channelId,
        ...(payload.accountId !== undefined ? { accountId: payload.accountId } : {}),
      };

    case "session:ended":
      return {
        ...digestSplat,
        ...(payload.totalTurns !== undefined ? { totalTurns: payload.totalTurns } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.exitReason !== undefined ? { exitReason: payload.exitReason } : {}),
      };

    case "tool:started":
      return {
        ...digestSplat,
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        ...(payload.description !== undefined ? { description: payload.description } : {}),
      };

    case "tool:executed":
      return {
        ...digestSplat,
        toolName: payload.toolName,
        ...(payload.toolCallId !== undefined ? { toolCallId: payload.toolCallId } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.success !== undefined ? { success: payload.success } : {}),
        ...(payload.errorKind !== undefined ? { errorKind: payload.errorKind } : {}),
        // Provenance forwarding — the flight-recorder reads these fields.
        // matchedToken is already sanitized+bounded at the emit (pi-event-bridge),
        // so every field is forwarded verbatim here.
        ...(payload.classifiedFailureBy !== undefined ? { classifiedFailureBy: payload.classifiedFailureBy } : {}),
        ...(payload.transportOk !== undefined ? { transportOk: payload.transportOk } : {}),
        ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
        ...(payload.matchedRule !== undefined ? { matchedRule: payload.matchedRule } : {}),
        ...(payload.matchedToken !== undefined ? { matchedToken: payload.matchedToken } : {}),
        ...(payload.resultBytes !== undefined ? { resultBytes: payload.resultBytes } : {}),
        ...(payload.resultDigest !== undefined ? { resultDigest: payload.resultDigest } : {}),
      };

    default: {
      // Exhaustiveness — every CacheTraceBridgedEventName must have a case.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/**
 * Subscribe a cache-trace recorder to the EventBus. Returns a single
 * `unsubscribe()` function that removes every registered handler.
 *
 * Per-session lifecycle: `pi-executor` calls this once after the
 * recorder is constructed; the returned `unsubscribe` runs in the
 * `try/finally` covering the runner block (mirrors trajectory's
 * teardown at pi-executor.ts).
 */
export function attachCacheTraceToEventBus(
  trace: CacheTrace,
  bus: TypedEventBus,
): () => void {
  const state: BridgeState = {
    latestMessagesDigest: undefined,
    latestSystemDigest: undefined,
  };

  // Subscription bag for the unsubscribe sweep. Each entry is a typed
  // event name + the `unknown`-typed handler that was registered.
  const subscriptions: Array<{
    eventName: keyof EventMap;
    handler: (payload: unknown) => void;
  }> = [];

  // 1. Side-effect-only token-stash handler (preserved from the
  //    pre-Plan-48 single-event behavior).
  const tokenUsageHandler = (payload: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void => {
    const next: { cacheReadTokens?: number; cacheWriteTokens?: number } = {};
    if (typeof payload.cacheReadTokens === "number") {
      next.cacheReadTokens = payload.cacheReadTokens;
    }
    if (typeof payload.cacheWriteTokens === "number") {
      next.cacheWriteTokens = payload.cacheWriteTokens;
    }
    trace.setLatestTokenUsage(next);
  };
  bus.on(
    "observability:token_usage",
    tokenUsageHandler as (payload: EventMap["observability:token_usage"]) => void,
  );
  subscriptions.push({
    eventName: "observability:token_usage",
    handler: tokenUsageHandler as (payload: unknown) => void,
  });

  // 2. Twin-emit handler for `prompt:submitted`. Reads the current
  //    digest cache, emits prompt:before with the PRIOR digests, then
  //    updates the cache and emits prompt:after with the NEW digests.
  const promptHandler = (payload: EventMap["prompt:submitted"]): void => {
    // Snapshot prior digests BEFORE the update.
    const priorMessagesDigest = state.latestMessagesDigest;
    const priorSystemDigest = state.latestSystemDigest;

    const beforePayload: Record<string, unknown> = {
      messageCount: payload.messageCount,
    };
    if (priorMessagesDigest !== undefined) {
      beforePayload.messagesDigest = priorMessagesDigest;
    }
    if (priorSystemDigest !== undefined) {
      beforePayload.systemDigest = priorSystemDigest;
    }
    trace.recordStage("prompt:before", beforePayload);

    // Update the digest cache with the new payload's digests.
    state.latestMessagesDigest = payload.messagesDigest;
    state.latestSystemDigest = payload.systemDigest;

    // Emit prompt:after with the NEW digests.
    trace.recordStage("prompt:after", {
      messageCount: payload.messageCount,
      messagesDigest: payload.messagesDigest,
      systemDigest: payload.systemDigest,
    });
  };
  bus.on("prompt:submitted", promptHandler);
  subscriptions.push({
    eventName: "prompt:submitted",
    handler: promptHandler as (payload: unknown) => void,
  });

  // 3. Mapping-table-driven subscriptions. One subscription per entry;
  //    each handler runs the payload through `translateBridgedPayload`
  //    and emits the mapped stage.
  for (const eventName of Object.keys(CACHE_TRACE_BRIDGE_MAPPING) as Array<CacheTraceBridgedEventName>) {
    const stage = CACHE_TRACE_BRIDGE_MAPPING[eventName];
    const handler = (payload: unknown): void => {
      const translated = translateBridgedPayload(eventName, payload, state);
      trace.recordStage(stage, translated);
    };
    bus.on(
      eventName as keyof EventMap,
      handler as (payload: EventMap[keyof EventMap]) => void,
    );
    subscriptions.push({ eventName: eventName as keyof EventMap, handler });
  }

  return function unsubscribe(): void {
    for (const sub of subscriptions) {
      bus.off(
        sub.eventName,
        sub.handler as (payload: EventMap[keyof EventMap]) => void,
      );
    }
    subscriptions.length = 0;
  };
}
