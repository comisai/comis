// SPDX-License-Identifier: Apache-2.0
/**
 * Inline-consumption drain seams.
 *
 * The drain trigger lives at the BRIDGE call site (`tool_execution_end` for
 * `message` send/reply/attach) -- NOT in pi-executor.ts. The helpers in
 * this module are what the bridge invokes:
 *
 *   - markRead(key):     mark inbound messages for the composite key as read.
 *                        Reads tool context via `tryGetContext()` so the
 *                        function does NOT take a passed-in deps object.
 *                        No-op outside an AsyncLocalStorage scope.
 *
 *   - markConsumed(key): mark inbound messages for the composite key as
 *                        consumed by the agent's response. Same context
 *                        contract as markRead.
 *
 *   - drainAt(key):      orchestrator. Runs markRead + markConsumed under
 *                        a per-composite-key single-tick inflight gate
 *                        (`drainInflightByKey: Map<string, Promise<void>>`).
 *                        Concurrent calls for the same composite key
 *                        return immediately; concurrent calls for
 *                        DIFFERENT composite keys (different agentId /
 *                        channelType / channelId) drain independently.
 *                        Failures are non-fatal: suppressError +
 *                        structured WARN log. The drainInflightByKey state
 *                        is owned by the bridge (BridgeMetricsState) so
 *                        the bridge threads it into drainAt at each call
 *                        site.
 *
 * The actual inline-consumption queue does not exist as a concrete data
 * structure today -- this module provides the structural seam. Future
 * work plugs queue/state into `tryGetContext()` so markRead / markConsumed
 * read it without re-threading through every caller. Today the helpers
 * are observability-only stubs that log at DEBUG when context is present
 * and fall through silently when outside any request scope.
 *
 * This module lives in `packages/agent/src/executor/` (not in the bridge)
 * so executor-post-execution.ts can re-export the helpers for source-grep
 * tests, while the bridge imports from here directly. This avoids a
 * circular import (executor-post-execution -> pi-executor -> bridge ->
 * executor-post-execution).
 *
 * @module
 */

import { tryGetContext } from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { suppressError } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Composite drain key uniquely identifies the inline-consumption queue
 * partition for a single (agent, channel, channel-id) triple.
 *
 * Same shape as `BackgroundSessionResolver.ActiveSessionKey` so a single
 * triple is reusable across the bridge / resolver / drain surface.
 */
export interface DrainKey {
  agentId: string;
  channelType: string;
  channelId: string;
}

/**
 * State container for the per-composite-key drain inflight gate.
 *
 * Owned by the bridge (`BridgeMetricsState.drainInflightByKey`) and
 * threaded into `drainAt` at each call site. A `Map` (rather than a single
 * `drainInflight: Promise`) is required so concurrent drains for DIFFERENT
 * composite keys can run independently (multi-agent isolation).
 */
export interface DrainInflightState {
  drainInflightByKey: Map<string, Promise<void>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a composite drain key into a deterministic string used as the
 * inflight-gate Map key. Mirrors the resolver's composite-key shape so the
 * gate keys are interchangeable with resolver keys (no parallel formatting
 * surfaces to drift).
 */
export function formatDrainKey(key: DrainKey): string {
  return `${key.agentId}:${key.channelType}:${key.channelId}`;
}

/**
 * Mark inbound messages for the composite drain key as read.
 *
 * Reads tool context via `tryGetContext()` -- when called outside any
 * AsyncLocalStorage scope (test fixture, sub-agent path), this is a silent
 * no-op. Otherwise emits a DEBUG-level observability log so operators can
 * correlate drain activity with ALS context propagation.
 *
 * @param key - Composite drain key (agentId, channelType, channelId).
 * @param logger - Logger for the (rare) DEBUG observability path.
 */
export function markRead(key: DrainKey, logger: ComisLogger): void {
  const ctx = tryGetContext();
  if (!ctx) {
    // No AsyncLocalStorage scope: markRead is a no-op outside a request-
    // scoped context. The bridge's `drainAt` is invoked from inside the
    // request scope, but tests / sub-agent paths may invoke directly.
    return;
  }
  // Future: read the inline-consumption queue partition for `key` from
  // `ctx` and flip status. Today: structural seam + observability.
  logger.debug(
    {
      submodule: "drain.markRead",
      agentId: key.agentId,
      channelType: key.channelType,
      channelId: key.channelId,
      traceId: ctx.traceId,
    },
    "markRead",
  );
}

/**
 * Mark inbound messages for the composite drain key as consumed.
 *
 * Same context contract as `markRead`. No-op outside AsyncLocalStorage
 * scope.
 *
 * @param key - Composite drain key (agentId, channelType, channelId).
 * @param logger - Logger for the (rare) DEBUG observability path.
 */
export function markConsumed(key: DrainKey, logger: ComisLogger): void {
  const ctx = tryGetContext();
  if (!ctx) {
    return;
  }
  logger.debug(
    {
      submodule: "drain.markConsumed",
      agentId: key.agentId,
      channelType: key.channelType,
      channelId: key.channelId,
      traceId: ctx.traceId,
    },
    "markConsumed",
  );
}

/**
 * Run a single drain pass for the composite key.
 *
 * Calls `markRead` + `markConsumed` sequentially. Both helpers no-op
 * outside an AsyncLocalStorage scope, so this function is safe to invoke
 * from the bridge's event handler without wrapping in `runWithContext`.
 */
async function runOneDrainPass(key: DrainKey, logger: ComisLogger): Promise<void> {
  markRead(key, logger);
  markConsumed(key, logger);
}

/**
 * drainAt: composite-keyed inline-consumption drain with single-tick gate.
 *
 * Invoked by the bridge on `tool_execution_end` for successful
 * `message(send|reply|attach)` calls. Runs `markRead` + `markConsumed`
 * under a per-composite-key inflight gate so:
 *   - Concurrent drains for the SAME composite key return immediately
 *     (lock-safe drain).
 *   - Concurrent drains for DIFFERENT composite keys (different
 *     agentId / channelType / channelId) run independently (multi-agent
 *     isolation).
 *
 * Failures are non-fatal: a per-event `.catch(...)` logs WARN with `hint`
 * + `errorKind`, and the outer `suppressError` ensures the bridge's
 * `tool_execution_end` propagation is never aborted by drain misbehavior.
 *
 * Map-entry cleanup (`.delete(formatted)` in `.finally(...)`) is required
 * to prevent unbounded growth across long-running sessions; the entry is
 * removed within one event-loop tick of the drain promise settling.
 *
 * @param key - Composite drain key (agentId, channelType, channelId).
 * @param state - Bridge-owned inflight-gate Map (drainInflightByKey).
 * @param logger - Logger for the WARN failure log + DEBUG observability.
 */
export function drainAt(
  key: DrainKey,
  state: DrainInflightState,
  logger: ComisLogger,
): void {
  const formatted = formatDrainKey(key);
  if (state.drainInflightByKey.has(formatted)) {
    // Single-tick gate: a drain is already in flight for this composite
    // key; second concurrent call returns immediately.
    return;
  }

  const draining = runOneDrainPass(key, logger)
    .catch((err: unknown) => {
      logger.warn(
        {
          submodule: "drain.drainAt",
          agentId: key.agentId,
          channelType: key.channelType,
          channelId: key.channelId,
          err,
          hint: "drainAt failed; will retry on next tool_execution_end. Investigate when this fires repeatedly without recovery.",
          errorKind: "internal" as ErrorKind,
        },
        "drainAt failed",
      );
    })
    .finally(() => {
      state.drainInflightByKey.delete(formatted);
    });

  state.drainInflightByKey.set(formatted, draining);
  // Belt-and-braces: outer suppressError ensures the bridge's
  // tool_execution_end propagation is NEVER aborted by drain misbehavior
  // (fire-and-forget contract).
  suppressError(draining, "drain at bridge call site (B15)");
}
