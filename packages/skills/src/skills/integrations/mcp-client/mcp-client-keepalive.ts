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
import { createRefreshDeduper, type RefreshDeduper } from "./oauth/refresh-deduper.js";

// ---------------------------------------------------------------------------
// Transport-aware keepalive defaults (MCPX-02 single source of truth)
// ---------------------------------------------------------------------------

/** Default keepalive interval for http/sse/streamable-http transports (beats ~60s idle window). */
export const KEEPALIVE_INTERVAL_HTTP_SSE_MS = 30_000;

/** Default keepalive interval for stdio transports (unchanged; stdio has no idle-close). */
export const KEEPALIVE_INTERVAL_STDIO_MS = 180_000;

/**
 * Pre-expiry buffer for proactive OAuth token refresh (R6 #2).
 * When a token's remaining lifetime (expires_in) is within this threshold,
 * the keepalive tick refreshes it proactively so the next tool call does not 401.
 * 5 minutes: ensures at least one keepalive tick fires within the window
 * for both http (30s interval) and stdio (180s interval) transports.
 */
export const PRE_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** PRE_EXPIRY_BUFFER_MS expressed in seconds — matches TokenStore.tokens().expires_in unit. */
const PRE_EXPIRY_BUFFER_SEC = PRE_EXPIRY_BUFFER_MS / 1000;

/**
 * Resolve the default keepalive interval for a given transport type.
 *
 * This is the single source of truth for keepalive defaults (MCPX-02):
 *   - stdio: 180 000 ms (no idle window; unchanged from previous global default)
 *   - http / sse / streamable-http: 30 000 ms (beats the ~60s server-side idle close)
 *
 * Per-server `config.keepaliveIntervalMs` always takes precedence over this default
 * (via the nullish coalescing in startKeepaliveTicker).
 *
 * @param transport - The McpServerConfig transport type string.
 */
export function resolveDefaultKeepaliveIntervalMs(transport: McpServerConfig["transport"]): number {
  return transport === "stdio" ? KEEPALIVE_INTERVAL_STDIO_MS : KEEPALIVE_INTERVAL_HTTP_SSE_MS;
}

/**
 * Start the keepalive ticker for a freshly-connected server. Called from
 * connectServer immediately after state.callQueues.set(...). The ticker
 * is .unref()'d so SIGTERM teardown is not blocked.
 *
 * Resolution at this call site: `config.keepaliveIntervalMs` ??
 * resolveDefaultKeepaliveIntervalMs(config.transport).
 *
 * The upstream callers (mcp-handlers.ts mcp.connect, setup-mcp.ts) apply the
 * full three-tier chain before populating config.keepaliveIntervalMs:
 *   per-server RPC param ?? persisted per-server entry ?? global
 *   integrations.mcp.keepaliveIntervalMs. The result lands in
 *   config.keepaliveIntervalMs before startKeepaliveTicker is called, so
 *   this function only needs to resolve the final transport-aware default.
 * Uses `??` (NOT `||`) so an operator can set `0` to disable per-server.
 *
 * @param onFailure - Optional callback invoked when a keepalive ping fails. Callers
 *   supply `(name) => handleDisconnection(state, deps, name, "keepalive_failed")` so
 *   this module does not import mcp-client-reconnect.ts (which would create a
 *   keepalive ↔ reconnect source cycle detected by no-cycles.test.ts). When omitted
 *   (tests that exercise registration without testing failure paths) the failure
 *   callback is a silent no-op.
 * @returns void — `0` interval is a NO-OP (explicit semantics: zero disables keepalive).
 */
export function startKeepaliveTicker(state: McpClientManagerState, deps: McpClientManagerDeps, config: McpServerConfig, onFailure?: (serverName: string) => void): void {
  // Per-server override wins; fall back to transport-aware default (MCPX-02 single source).
  const intervalMs = config.keepaliveIntervalMs ?? resolveDefaultKeepaliveIntervalMs(config.transport);
  if (intervalMs === 0) return; // Disabled (interval=0 means no keepalive)
  const handle: SystemIntervalHandle = systemSetInterval(() => maybeEnqueueKeepalivePing(state, deps, config.name, onFailure), intervalMs);
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
 * On ping failure, invokes `onFailure(serverName)` in BOTH routes — the
 * reconnect engine handles recovery from there. When `onFailure` is
 * undefined (test-only call sites that don't test the failure path) the
 * failure is a silent no-op.
 *
 * Deadlock-free proactive refresh (CR-01):
 * The near-expiry check and `await dedupedRefresh(...)` run inside
 * `primary.add(refreshAndPing)` but the deduper's internal critical section
 * uses a DEDICATED per-tick cc-1 queue (not the primary queue) so there is no
 * nested `primary.add` inside a running `primary.add`. This preserves the
 * single-queue atomicity contract for the dedup map check+set while
 * eliminating the deadlock. The dedup guarantee is provided by `inflightRefreshes`
 * (shared across proactive + 401 paths); the per-tick queue merely prevents
 * two concurrent ticks from double-refreshing via the same accessToken key.
 *
 * @param deduper - TEST SEAM (D-TS-01, Option A). When provided (tests), the
 *   proactive-refresh path uses the injected deduper's dedupedRefresh as the spy.
 *   When omitted (all production call sites — startKeepaliveTicker stays 4-arg),
 *   the deduper is reconstructed in-place from state.inflightRefreshes + a fresh
 *   per-tick cc-1 queue (D-02-revised: uses a dedicated queue, not primary, to
 *   prevent the concurrency-1 deadlock; inflightRefreshes still coalesces with the
 *   401 path). Do NOT thread this param through startKeepaliveTicker.
 */
export function maybeEnqueueKeepalivePing(state: McpClientManagerState, deps: McpClientManagerDeps, serverName: string, onFailure?: (serverName: string) => void, deduper?: RefreshDeduper): void {
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

  // WR-02: obtain the token store ONCE per tick at the top level (before doPing),
  // not inside the queue body — createTokenStore() is a singleton factory; calling it
  // per queue-execution would invoke per-tick ensureContainedDir syscalls and violate
  // the singleton contract. The result is closed over by doPing and doProactiveRefresh.
  const serverConfig = state.serverConfigs.get(serverName);
  const oauthDeps = deps.oauthDeps;
  const tokenStore =
    serverConfig?.auth === "oauth" && oauthDeps !== undefined
      ? oauthDeps.createTokenStore()
      : undefined;

  /**
   * R6 #2 — Proactive pre-expiry OAuth token refresh (CR-01 deadlock-free).
   *
   * MUST run inside the primary queue slot (or the keepalive queue slot) but
   * the deduper's internal critical-section queue MUST NOT be the same as the
   * primary queue — that would nest `primary.add(criticalSection)` inside a
   * running `primary.add(doPing)` body → deadlock on concurrency-1.
   *
   * Fix: the deduper receives a fresh per-tick cc-1 queue (not primary).
   * The dedup guarantee is unchanged — `inflightRefreshes` (shared map on state)
   * still coalesces concurrent proactive + 401 refreshes for the same access
   * token. The cc-1 queue merely serializes the has()/get()/set() critical
   * section; it does not need to be the same object as primary to preserve
   * the dedup invariant.
   *
   * Failure degrades safely (WARN + continue to ping) — never throws.
   */
  const doProactiveRefreshIfNeeded = async (): Promise<void> => {
    if (tokenStore === undefined) return;

    const stored = await tokenStore.tokens(serverName);
    // WR-03: tokens() always sets expires_in; the !== undefined guard is technically
    // dead code but kept for TypeScript narrowing (SDK type is number | undefined).
    if (
      stored === undefined ||
      stored.refresh_token === undefined ||
      stored.expires_in === undefined ||
      stored.expires_in > PRE_EXPIRY_BUFFER_SEC
    ) {
      return;
    }

    // Parallel-load discovery + clientInfo — both are needed for the refresh.
    const [discovery, clientInfo] = await Promise.all([
      tokenStore.discoveryState(serverName),
      tokenStore.clientInformation(serverName),
    ]);
    if (discovery === undefined || clientInfo === undefined) return;

    // D-TS-01: injected deduper (tests) ?? in-place reconstruction (production, D-02-revised).
    // CR-01 key: the production deduper uses a fresh per-tick cc-1 queue (NOT primary).
    // inflightRefreshes is still shared so proactive + 401 refreshes coalesce on the
    // same map — the dedup guarantee is preserved regardless of the queue object used
    // for the map check+set critical section.
    const tickQueue = new PQueue({ concurrency: 1 });
    const activeDeduper = deduper ?? createRefreshDeduper({
      inflightRefreshes: state.inflightRefreshes,
      queue: tickQueue as unknown as Parameters<typeof createRefreshDeduper>[0]["queue"],
      tokenStore,
      logger: deps.logger,
    });

    // WR-01: Forward addClientAuthentication from the per-server oauth config
    // (stripeAccount → Stripe-Account header), mirroring what the on-401 path
    // (deduped-fetch.ts) already does so connected-account refreshes carry
    // the required header on the proactive path too.
    const stripeAccount = serverConfig?.oauth?.stripeAccount;
    const addClientAuthentication =
      stripeAccount !== undefined
        ? (headers: Headers): void => {
            // SECURITY: the account id is a non-secret connected-account label;
            // safe as a header. Never logged.
            headers.set("Stripe-Account", stripeAccount);
          }
        : undefined;

    try {
      await activeDeduper.dedupedRefresh({
        serverName,
        authServerUrl: discovery.authorizationServerUrl,
        accessToken: stored.access_token,
        refreshToken: stored.refresh_token,
        ...(discovery.authorizationServerMetadata !== undefined
          ? { metadata: discovery.authorizationServerMetadata }
          : {}),
        clientInformation: clientInfo,
        ...(addClientAuthentication !== undefined ? { addClientAuthentication } : {}),
      });
    } catch (err) {
      deps.logger.warn(
        {
          serverName,
          err: err instanceof Error ? err : new Error(String(err)),
          hint: "Proactive token refresh failed; next tool call will handle via 401 path",
          errorKind: "auth" as const,
        },
        "MCP keepalive: proactive OAuth refresh failed",
      );
      // Do not rethrow — keepalive must not crash on a refresh failure (T-04-02-01)
    }
  };

  const doPing = async (): Promise<void> => {
    const current = state.connections.get(serverName);
    if (!current || current.status !== "connected" || current.generation !== capturedGeneration) {
      return;
    }

    // R6 #2 — Proactive refresh runs BEFORE the ping (still inside the same
    // primary.add slot). The deduper uses a per-tick cc-1 queue (not primary)
    // so there is no nested primary.add → no deadlock (CR-01).
    await doProactiveRefreshIfNeeded();

    try {
      await current.client.ping();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(
        { serverName, err: message, hint: "Keepalive ping failed; triggering reconnect", errorKind: "dependency" as const },
        "MCP keepalive ping failed",
      );
      onFailure?.(serverName);
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
