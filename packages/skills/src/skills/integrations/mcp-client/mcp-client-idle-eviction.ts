// SPDX-License-Identifier: Apache-2.0
/**
 * Per-server idle eviction.
 *
 * Schedules a per-server `systemSetTimeout` that fires `evictIdleServer`
 * when no successful tool call has reset the timer for `config.idleTtlMs`
 * milliseconds. Default `idleTtlMs: 0` → ticker is NOT started (opt-in
 * semantics, mirroring the keepalive ticker's `0`-disables convention).
 *
 * **Critical divergence from disconnectServer (the load-bearing point):**
 * `evictIdleServer` mirrors `disconnectServer`'s teardown (abort reconnect
 * controller, close client, stop keepalive ticker, clear/delete the call
 * queue, delete the connection) but pointedly does NOT add the server name
 * to `state.userDisconnectedFlags` AND does NOT delete `state.serverConfigs`.
 * `disconnectServer` (mcp-client-connect.ts) does both. The flag would
 * suppress auto-reconnect at mcp-client-reconnect.ts:136-138; retaining the
 * stored config lets the lazy-reconnect branch in mcp-client-call.ts read it
 * and call `reconnectServer`, producing the spec's "next callTool reconnects
 * transparently" UX.
 *
 * @module
 */

import { systemClearTimeout, systemNowMs, systemSetTimeout } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpServerConfig,
} from "./mcp-client-types.js";
import { stopKeepaliveTicker } from "./mcp-client-keepalive.js";

/**
 * Start the idle-eviction ticker for a freshly-connected server. Called from
 * connectServer immediately after startKeepaliveTicker.
 *
 * Resolution: per-server `config.idleTtlMs` (no global default — eviction is
 * opt-in per server). `0` (or undefined) is a NO-OP: the ticker is never
 * scheduled and `resetIdleActivity` becomes inert for this server.
 */
export function startIdleTicker(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  config: McpServerConfig,
): void {
  const ttl = config.idleTtlMs ?? 0;
  if (ttl === 0) return; // Disabled (default; opt-in per server)
  // Seed last-activity to "now" so the first eviction fires ttl ms after connect.
  state.lastActivityMs.set(config.name, systemNowMs());
  scheduleNextEviction(state, deps, config.name, ttl);
}

/**
 * Stop the idle ticker. Called from disconnectServer (after stopKeepaliveTicker)
 * AND from evictIdleServer itself. Clears the pending timer handle and drops
 * the last-activity bookkeeping so a future reconnect starts clean.
 */
export function stopIdleTicker(state: McpClientManagerState, name: string): void {
  const handle = state.idleEvictionTimers.get(name);
  if (handle !== undefined) {
    systemClearTimeout(handle);
    state.idleEvictionTimers.delete(name);
  }
  state.lastActivityMs.delete(name);
}

/**
 * Record activity for a server. Called from mcp-client-call.ts on the success
 * path. Only refreshes the timestamp when a timer is armed (i.e. idleTtlMs > 0
 * for this server) — otherwise inert. Does NOT reschedule: the self-rescheduling
 * timer re-reads lastActivityMs on each fire and pushes the deadline forward.
 */
export function resetIdleActivity(state: McpClientManagerState, name: string): void {
  if (!state.idleEvictionTimers.has(name)) return;
  state.lastActivityMs.set(name, systemNowMs());
}

/**
 * Schedule (or reschedule) the single-fire eviction timer. On fire it compares
 * elapsed idle time against the FULL TTL: evict when idle long enough,
 * otherwise reschedule for the remaining window (so activity since the last
 * schedule transparently defers eviction).
 *
 * `originalTtl` is the configured idleTtlMs and is threaded UNCHANGED
 * through every reschedule — the eviction always fires at last-activity +
 * idleTtlMs. `remainingMs` is only the timer delay for the NEXT fire
 * (defaults to `originalTtl` on the first call). Pre-fix the reschedule passed
 * `ttl - idleFor` as the new `ttl`, which shrank the comparison threshold on
 * every activity bounce — bursty servers drifted toward premature eviction
 * (and ever-shorter poll intervals).
 */
function scheduleNextEviction(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
  originalTtl: number,
  remainingMs?: number,
): void {
  // Clear any prior pending timer for safety (idempotent reschedule).
  const prior = state.idleEvictionTimers.get(name);
  if (prior !== undefined) systemClearTimeout(prior);

  const delay = remainingMs ?? originalTtl;
  const handle = systemSetTimeout(() => {
    const lastActivity = state.lastActivityMs.get(name);
    const conn = state.connections.get(name);
    if (lastActivity === undefined || !conn || conn.status !== "connected") {
      // Server already gone (disconnected / errored / reconnecting). Nothing to do.
      state.idleEvictionTimers.delete(name);
      return;
    }
    const idleFor = systemNowMs() - lastActivity;
    if (idleFor >= originalTtl) {
      // Never tear down a connection with an outstanding tool call.
      // The success path resets lastActivityMs, but a call that is in-flight
      // (or queued) when the timer fires has not reached that reset yet — an
      // in-flight callTool IS activity. Treat a non-empty call queue as a
      // deferral signal and reschedule a fresh full window rather than
      // evicting mid-flight (which would race callTool's queue.add /
      // generation-capture and surface a misleading error to the caller).
      const queue = state.callQueues.get(name);
      if (queue && (queue.pending > 0 || queue.size > 0)) {
        scheduleNextEviction(state, deps, name, originalTtl);
        return;
      }
      void evictIdleServer(state, deps, name);
      return;
    }
    // Activity since last schedule → reschedule for the remaining window
    // measured against the ORIGINAL TTL (deadline = lastActivity + originalTtl).
    scheduleNextEviction(state, deps, name, originalTtl, originalTtl - idleFor);
  }, delay);
  // No .unref() here: daemon shutdown routes through disconnectAllServers →
  // disconnectServer → stopIdleTicker, which clears the handle deterministically.
  state.idleEvictionTimers.set(name, handle);
}

/**
 * Tear down an idle server. Mirrors disconnectServer's teardown EXCEPT for two
 * load-bearing omissions (see module docblock): it does NOT mutate
 * userDisconnectedFlags and does NOT delete serverConfigs.
 */
async function evictIdleServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
): Promise<void> {
  const { logger } = deps;
  // Idle eviction is normal scheduled behavior, not an error condition.
  // errorKind (and hint) belong on WARN/ERROR logs only —
  // attaching them to this INFO line misleads observability tooling that
  // filters on errorKind. The serverName alone is sufficient for correlation.
  logger.info({ serverName: name }, "MCP server idle eviction");

  // Abort any in-flight reconnection (mirrors disconnectServer).
  const ac = state.reconnectionAbortControllers.get(name);
  if (ac) {
    ac.abort();
    state.reconnectionAbortControllers.delete(name);
  }

  // Close the transport. Errors during close are non-fatal — log and continue.
  const conn = state.connections.get(name);
  if (conn?.client && conn.status === "connected") {
    try {
      await conn.client.close();
    } catch (error: unknown) {
      logger.warn(
        {
          serverName: name,
          err: error instanceof Error ? error.message : String(error),
          hint: "Idle eviction close failed; teardown continues",
          errorKind: "dependency" as const,
        },
        "MCP idle-eviction client.close() failed",
      );
    }
  }

  // Stop the keepalive ticker BEFORE deleting the queue (mirrors disconnectServer:
  // the ticker must not fire one last queue.add against a queue we are deleting).
  stopKeepaliveTicker(state, name);

  // Clear + delete the call queue.
  const queue = state.callQueues.get(name);
  if (queue) {
    queue.clear();
    state.callQueues.delete(name);
  }

  // Tear down the dedicated keepalive queue alongside the
  // call queue (only populated when primary concurrency > 1). Mirrors
  // disconnectServer so the queue cannot leak across reconnect generations.
  const keepaliveQueue = state.keepaliveQueues.get(name);
  if (keepaliveQueue) {
    keepaliveQueue.clear();
    state.keepaliveQueues.delete(name);
  }

  // Stop our own idle ticker (clears handle + lastActivity).
  stopIdleTicker(state, name);

  // Delete the connection.
  state.connections.delete(name);

  // **CRITICAL (divergence 1):** do NOT call state.userDisconnectedFlags.add(name).
  // disconnectServer (mcp-client-connect.ts:264) adds it unconditionally, which
  // suppresses auto-reconnect at mcp-client-reconnect.ts:136-138. Idle eviction
  // must leave auto-reconnect enabled.

  // **CRITICAL (divergence 2):** do NOT call state.serverConfigs.delete(name).
  // disconnectServer (mcp-client-connect.ts:298) deletes it; the lazy-reconnect
  // branch in mcp-client-call.ts reads serverConfigs to reconnect transparently.
  // generations is preserved too (disconnectServer keeps it as well).
}
