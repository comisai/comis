// SPDX-License-Identifier: Apache-2.0
/**
 * Per-server keepalive ticker (Phase 64 RELY-01/02/03).
 *
 * Schedules a periodic Client.ping() through the per-server PQueue. On
 * failure, triggers handleDisconnection so the existing reconnect engine
 * recovers. Ping is SKIPPED when the queue has pending items (recent
 * activity is a stronger liveness signal than the keepalive itself).
 *
 * Extracted into its own ~80L file to keep mcp-client-connect.ts under
 * the 800-line file-size cap. Phase 67 CAP-02 may revisit keepalive
 * queue routing for parallel-tool-call mode; see RESEARCH.md Q1.
 *
 * @module
 */

import { systemSetInterval, systemClearInterval, type SystemIntervalHandle } from "@comis/core";
import type { McpClientManagerDeps, McpClientManagerState, McpServerConfig } from "./mcp-client-types.js";
import { handleDisconnection } from "./mcp-client-reconnect.js";

/**
 * Start the keepalive ticker for a freshly-connected server. Called from
 * connectServer immediately after state.callQueues.set(...). The ticker
 * is .unref()'d so SIGTERM teardown is not blocked.
 *
 * Resolution: per-server `config.keepaliveIntervalMs` overrides global
 * `state.options.keepaliveIntervalMs` via nullish coalescing (`??`, NOT
 * `||`, so the operator can set `0` to disable per-server).
 *
 * @returns void — `0` interval is a NO-OP (RELY-02 explicit semantics).
 */
export function startKeepaliveTicker(state: McpClientManagerState, deps: McpClientManagerDeps, config: McpServerConfig): void {
  const intervalMs = config.keepaliveIntervalMs ?? state.options.keepaliveIntervalMs;
  if (intervalMs === 0) return; // Disabled (RELY-02)
  const handle: SystemIntervalHandle = systemSetInterval(() => maybeEnqueueKeepalivePing(state, deps, config.name), intervalMs);
  handle.unref();
  state.keepaliveTickers.set(config.name, handle);
}

/**
 * Stop the keepalive ticker. Called from disconnectServer BEFORE the
 * call-queue clear so the ticker cannot fire one last `queue.add` against
 * a queue we are about to delete. (Defense in depth: maybeEnqueueKeepalivePing
 * also no-ops when the queue lookup returns undefined.)
 */
export function stopKeepaliveTicker(state: McpClientManagerState, serverName: string): void {
  const handle = state.keepaliveTickers.get(serverName);
  if (handle !== undefined) {
    systemClearInterval(handle);
    state.keepaliveTickers.delete(serverName);
  }
}

/**
 * Tick callback. Enqueues a Client.ping() through the per-server PQueue
 * (RELY-03 — same queue as tool calls; stdio single-pipe serialization).
 * Bails out when the queue is busy: recent activity is stronger than a
 * synthetic probe.
 *
 * On ping failure, triggers handleDisconnection(..., "keepalive_failed")
 * — the existing reconnect engine handles the recovery from there.
 */
function maybeEnqueueKeepalivePing(state: McpClientManagerState, deps: McpClientManagerDeps, serverName: string): void {
  const queue = state.callQueues.get(serverName);
  if (!queue) return; // disconnected race
  if (queue.size > 0 || queue.pending > 0) {
    // Recent activity → connection alive enough; skip tick
    deps.logger.debug?.({ serverName, queueSize: queue.size, queuePending: queue.pending }, "MCP keepalive ping skipped (queue busy)");
    return;
  }
  const conn = state.connections.get(serverName);
  if (!conn || conn.status !== "connected") return;

  void queue.add(async () => {
    try {
      await conn.client.ping();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(
        { serverName, err: message, hint: "Keepalive ping failed; triggering reconnect", errorKind: "dependency" as const },
        "MCP keepalive ping failed",
      );
      handleDisconnection(state, deps, serverName, "keepalive_failed");
    }
  });
}
