// SPDX-License-Identifier: Apache-2.0
/**
 * Per-server keepalive ticker.
 *
 * Schedules a periodic Client.ping() through the per-server PQueue. On
 * failure, triggers handleDisconnection so the existing reconnect engine
 * recovers. Ping is SKIPPED when the queue has pending items (recent
 * activity is a stronger liveness signal than the keepalive itself).
 *
 * Extracted into its own ~80L file to keep mcp-client-connect.ts under
 * the 800-line file-size cap. Future work may revisit keepalive queue
 * routing for parallel-tool-call mode.
 *
 * @module
 */

import { systemSetInterval, type SystemIntervalHandle } from "@comis/core";
export { stopKeepaliveTicker } from "./mcp-client-ticker.js";
import PQueue from "p-queue";
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
 * @returns void — `0` interval is a NO-OP (explicit semantics: zero disables keepalive).
 */
export function startKeepaliveTicker(state: McpClientManagerState, deps: McpClientManagerDeps, config: McpServerConfig): void {
  const intervalMs = config.keepaliveIntervalMs ?? state.options.keepaliveIntervalMs;
  if (intervalMs === 0) return; // Disabled (interval=0 means no keepalive)
  const handle: SystemIntervalHandle = systemSetInterval(() => maybeEnqueueKeepalivePing(state, deps, config.name), intervalMs);
  handle.unref();
  state.keepaliveTickers.set(config.name, handle);
}

/**
 * Tick callback. Routes a Client.ping() based on the primary call queue's
 * concurrency:
 *
 *  - concurrency === 1 (default/stdio): the ping shares the primary PQueue
 *    (stdio single-pipe serialization) and is SKIPPED when the queue is
 *    busy. Recent tool-call activity is a stronger liveness signal than a
 *    synthetic probe.
 *
 *  - concurrency > 1 (supportsParallelToolCalls): a synthetic ping must not
 *    interleave with real parallel tool calls. The ping is enqueued on a
 *    DEDICATED concurrency-1 queue whose body first awaits the primary
 *    queue's onIdle() (NOT onEmpty — onEmpty resolves while in-flight calls
 *    still run). The dedicated queue is lazily created here and torn down on
 *    disconnect / idle-eviction (mirrors callQueues), so it cannot leak.
 *
 * On ping failure, triggers handleDisconnection(..., "keepalive_failed") in
 * BOTH routes — the existing reconnect engine handles recovery from there.
 */
export function maybeEnqueueKeepalivePing(state: McpClientManagerState, deps: McpClientManagerDeps, serverName: string): void {
  const primary = state.callQueues.get(serverName);
  if (!primary) return; // disconnected race
  const conn = state.connections.get(serverName);
  if (!conn || conn.status !== "connected") return;

  // Capture the generation at tick time. In the concurrency > 1 path the ping
  // body awaits primary.onIdle() before executing, during which a
  // disconnect→reconnect can replace `conn` with a fresh connection (new
  // generation). Re-read state inside doPing and bail if the connection is
  // gone, no longer connected, or its generation changed — otherwise we would
  // ping the stale (closed) client, throw, and call handleDisconnection on the
  // freshly-restored connection, kicking it offline with a spurious
  // keepalive_failed reconnect.
  const capturedGeneration = conn.generation;

  const doPing = async (): Promise<void> => {
    const current = state.connections.get(serverName);
    if (!current || current.status !== "connected" || current.generation !== capturedGeneration) {
      return;
    }
    try {
      await current.client.ping();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(
        { serverName, err: message, hint: "Keepalive ping failed; triggering reconnect", errorKind: "dependency" as const },
        "MCP keepalive ping failed",
      );
      handleDisconnection(state, deps, serverName, "keepalive_failed");
    }
  };

  if (primary.concurrency > 1) {
    // Route through a dedicated cc-1 queue and wait for the primary queue
    // to drain so the ping never interleaves with parallel tool calls.
    let keepalive = state.keepaliveQueues.get(serverName);
    if (!keepalive) {
      keepalive = new PQueue({ concurrency: 1 });
      state.keepaliveQueues.set(serverName, keepalive);
    }
    void keepalive.add(async () => {
      await primary.onIdle();
      await doPing();
    });
    return;
  }

  // Existing concurrency-1 path: skip when busy, share the primary queue.
  if (primary.size > 0 || primary.pending > 0) {
    // Recent activity → connection alive enough; skip tick
    deps.logger.debug?.({ serverName, queueSize: primary.size, queuePending: primary.pending }, "MCP keepalive ping skipped (queue busy)");
    return;
  }
  void primary.add(doPing);
}
