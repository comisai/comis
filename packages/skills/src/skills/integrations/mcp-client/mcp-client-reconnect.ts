// SPDX-License-Identifier: Apache-2.0
/**
 * Reconnection engine for the MCP client.
 *
 * Owns the auto-reconnect lifecycle: handleDisconnection (entry point
 * called by transport/client lifecycle callbacks + by callTool on
 * session-expiry detection), reconnectionLoop (the fire-and-forget
 * backoff loop), calculateBackoff (jittered exponential), and the
 * shared wireClientLifecycleCallbacks helper used by both
 * connectServer and reconnectionLoop.
 *
 * Uses the state-first protocol shared with the pi-executor and
 * telegram-adapter modules.
 *
 * Kept in its own file to hold mcp-client-connect.ts under the 500-line
 * per-leaf cap; reconnection is a self-contained engine whose only
 * external entry point is handleDisconnection.
 *
 * @module
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withTimeout } from "@comis/shared";
import {
  systemClearTimeout,
  systemNowMs,
  systemScheduleTimeout,
  systemSetTimeout,
} from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpToolDefinition,
} from "./mcp-client-types.js";
import {
  createClient,
  createTransport,
  extractServerMetadata,
  wireStderrCapture,
} from "./mcp-client-discover.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { stopKeepaliveTicker } from "./mcp-client-ticker.js";
import { startKeepaliveTicker } from "./mcp-client-keepalive.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ERRORS_BEFORE_RECONNECT = 3;

// ---------------------------------------------------------------------------
// Self-heal predicate
// ---------------------------------------------------------------------------

/**
 * Returns true if the error is the SDK's internal SSE GET-stream self-heal
 * churn (streamableHttp.js:233 — `"SSE stream disconnected: ${error}"`). The
 * SDK fires this via onerror while simultaneously calling _scheduleReconnection
 * internally. Comis must NOT double-count these as connection errors.
 *
 * Intentionally NARROW — matches only the `"SSE stream disconnected:"` prefix.
 * These messages do NOT match and always escalate:
 *   - "Maximum reconnection attempts (N) exceeded." (streamableHttp.js:143)
 *   - "MCP error <code>: <message>"               (McpError, types.js:2032)
 *   - "Failed to reconnect SSE stream: ..."        (streamableHttp.js:152)
 */
function isSelfHealedTransientError(error: Error): boolean {
  return error.message.startsWith("SSE stream disconnected:");
}

// ---------------------------------------------------------------------------
// Lifecycle callback wiring (shared by connectServer + reconnectionLoop)
// ---------------------------------------------------------------------------

/**
 * Wire the MCP SDK Client's onclose/onerror callbacks to feed the
 * reconnect engine. Absorbs transient errors below
 * MAX_ERRORS_BEFORE_RECONNECT; threshold trip triggers handleDisconnection
 * with reason "client_error" (or "client_closed" on a clean close).
 *
 * Exported because connectServer (mcp-client-connect.ts) wires this on
 * the initial connect; reconnectionLoop wires it on each successful
 * reconnect.
 */
export function wireClientLifecycleCallbacks(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  client: Client,
  serverName: string,
): void {
  const { logger } = deps;
  // Capture generation at wire time so stale callbacks from superseded
  // connections early-return without corrupting the live connection's state.
  const wiredGeneration = state.generations.get(serverName) ?? 0;

  client.onclose = () => {
    // Generation guard — stale close callbacks are silenced.
    if ((state.generations.get(serverName) ?? 0) !== wiredGeneration) return;
    state.consecutiveErrors.set(serverName, 0);
    handleDisconnection(state, deps, serverName, "client_closed");
  };

  client.onerror = (error: Error) => {
    // Generation guard — stale error callbacks are silenced.
    if ((state.generations.get(serverName) ?? 0) !== wiredGeneration) return;
    // Absorb SDK SSE self-heal churn — do not count, do not reconnect.
    if (isSelfHealedTransientError(error)) {
      logger.debug?.({ serverName, err: error.message }, "MCP SSE self-heal churn (suppressed)");
      return;
    }
    const count = (state.consecutiveErrors.get(serverName) ?? 0) + 1;
    state.consecutiveErrors.set(serverName, count);
    if (count >= MAX_ERRORS_BEFORE_RECONNECT) {
      logger.warn(
        { serverName, err: error.message, consecutiveErrors: count, hint: "MCP client reported repeated errors; reconnection will be attempted", errorKind: "dependency" as const },
        "MCP client error",
      );
      state.consecutiveErrors.set(serverName, 0);
      handleDisconnection(state, deps, serverName, "client_error");
    } else {
      logger.debug?.(
        { serverName, err: error.message, consecutiveErrors: count, threshold: MAX_ERRORS_BEFORE_RECONNECT },
        "MCP client transient error (absorbing)",
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Backoff calculation helper (uses state.options.reconnectOpts)
// ---------------------------------------------------------------------------

function calculateBackoff(state: McpClientManagerState, attempt: number): number {
  const reconnectOpts = state.options.reconnectOpts;
  const delay = Math.min(
    reconnectOpts.initialDelayMs * Math.pow(reconnectOpts.growFactor, attempt),
    reconnectOpts.maxDelayMs,
  );
  // Add 10-30% jitter
  const jitter = delay * (0.1 + Math.random() * 0.2);
  return Math.round(delay + jitter);
}

// ---------------------------------------------------------------------------
// Reconnection handler (state-first; exported for callTool session-expiry)
// ---------------------------------------------------------------------------

/**
 * Handle a transport- or client-level disconnection. Skips reconnection
 * for user-initiated disconnects (userDisconnectedFlags); otherwise
 * starts a fresh reconnectionLoop with a new AbortController and updates
 * the connection's status to "reconnecting".
 *
 * Exported because mcp-client-call.ts triggers it on session-expiry
 * errors during callTool.
 */
export function handleDisconnection(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
  reason: "transport_closed" | "transport_error" | "client_closed" | "client_error" | "keepalive_failed",
): void {
  // Emit disconnected event
  deps.eventBus?.emit("mcp:server:disconnected", {
    serverName,
    reason,
    timestamp: systemNowMs(),
  });

  // If user explicitly disconnected, skip reconnection
  if (state.userDisconnectedFlags.has(serverName)) {
    return;
  }

  // If already reconnecting, skip (prevents duplicate loops)
  const currentConn = state.connections.get(serverName);
  if (currentConn?.status === "reconnecting") {
    return;
  }

  // Abort any previous reconnection for this server
  const existingAc = state.reconnectionAbortControllers.get(serverName);
  if (existingAc) {
    existingAc.abort();
    state.reconnectionAbortControllers.delete(serverName);
  }

  const ac = new AbortController();
  state.reconnectionAbortControllers.set(serverName, ac);

  // Update status to reconnecting
  if (currentConn) {
    state.connections.set(serverName, {
      ...currentConn,
      status: "reconnecting",
      reconnectAttempt: 0,
    });
  }

  // Fire-and-forget reconnection loop (errors handled internally)
  void reconnectionLoop(state, deps, serverName, ac.signal);
}

async function reconnectionLoop(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
  signal: AbortSignal,
): Promise<void> {
  const { logger } = deps;
  const config = state.serverConfigs.get(serverName);
  if (!config) return;

  const reconnectOpts = state.options.reconnectOpts;
  let lastError = "";
  const startTime = systemNowMs();

  logger.info(
    { serverName, maxAttempts: reconnectOpts.maxAttempts },
    "MCP server reconnect started",
  );

  for (let attempt = 0; attempt < reconnectOpts.maxAttempts; attempt++) {
    if (signal.aborted) return;

    const delayMs = calculateBackoff(state, attempt);

    // Emit reconnecting event
    deps.eventBus?.emit("mcp:server:reconnecting", {
      serverName,
      attempt: attempt + 1,
      maxAttempts: reconnectOpts.maxAttempts,
      nextDelayMs: delayMs,
      timestamp: systemNowMs(),
    });

    // Update attempt counter on connection
    const conn = state.connections.get(serverName);
    if (conn) {
      state.connections.set(serverName, {
        ...conn,
        reconnectAttempt: attempt + 1,
      });
    }

    // Wait for backoff delay (abort-aware)
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = systemSetTimeout(resolve, delayMs);
      const onAbort = () => { systemClearTimeout(timer); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (signal.aborted) return;

    try {
      // Increment generation FIRST so the prior client's lifecycle callbacks
      // (wiredGeneration captures the OLD generation) see a mismatch and early-return,
      // preventing a duplicate reconnect loop from being triggered by the close below.
      state.generations.set(serverName, (state.generations.get(serverName) ?? 0) + 1);

      // Stop the old keepalive ticker and close the prior client before
      // creating a new transport — prevents orphaned SSE streams and duplicate tickers.
      stopKeepaliveTicker(state, serverName);
      const priorConn = state.connections.get(serverName);
      if (priorConn?.client) {
        try { await priorConn.client.close(); } catch { /* already broken — ignore */ }
      }

      // Create new transport and client (logger threaded for the prlimit-skip
      // WARN; reconnect re-spawns the child each attempt so the same WARN-once
      // gate in mcp-client-discover.ts applies across all reconnect attempts
      // in the same daemon process).
      const transport = createTransport(config, logger);
      // Wire stderr capture for stdio re-spawns
      wireStderrCapture(state, deps, config, transport);
      const client = createClient(state, deps, serverName);

      await withTimeout(
        client.connect(transport),
        state.options.connectTimeoutMs,
        systemScheduleTimeout,
        `MCP server "${serverName}" reconnect`,
      );

      // Discover tools
      const listResult = await withTimeout(
        client.listTools(),
        state.options.connectTimeoutMs,
        systemScheduleTimeout,
        `MCP server "${serverName}" listTools`,
      );
      const tools: McpToolDefinition[] = listResult.tools.map((tool) => ({
        name: tool.name,
        qualifiedName: qualifyToolName(serverName, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      // Wire lifecycle callbacks for reconnection
      wireClientLifecycleCallbacks(state, deps, client, serverName);

      // Restart the keepalive ticker for the new connection so the
      // transport-aware interval beats the idle window after auto-reconnect.
      // The static import of startKeepaliveTicker is safe because mcp-client-keepalive.ts
      // no longer imports from mcp-client-reconnect.ts — handleDisconnection is
      // threaded in as the `onFailure` callback instead, breaking the former
      // keepalive ↔ reconnect source cycle.
      startKeepaliveTicker(state, deps, config, (srvName) => handleDisconnection(state, deps, srvName, "keepalive_failed"));

      // Fetch server metadata
      const metadata = extractServerMetadata(client);

      if (metadata.instructions) {
        logger.debug?.({ serverName, instructionChars: metadata.instructions.length }, "MCP server provided instructions");
      }

      // Atomically update connection
      const newConnection: McpConnection = {
        name: serverName,
        client,
        status: "connected",
        tools,
        lastHealthCheck: systemNowMs(),
        reconnectAttempt: 0,
        maxReconnectAttempts: reconnectOpts.maxAttempts,
        generation: state.generations.get(serverName) ?? 0,
        instructions: metadata.instructions,
        capabilities: metadata.capabilities,
        serverInfo: metadata.serverInfo,
      };
      state.connections.set(serverName, newConnection);

      // Reset the circuit breaker on every successful reconnect. Per-generation
      // lifecycle -- breaker state does NOT survive across reconnect (enforced
      // by architecture test
      // test/architecture/mcp-circuit-breaker-reset-on-reconnect.test.ts).
      state.circuitBreakers.set(serverName, { status: "closed", failureCount: 0 });

      // Emit reconnected event
      deps.eventBus?.emit("mcp:server:reconnected", {
        serverName,
        attempt: attempt + 1,
        toolCount: tools.length,
        durationMs: systemNowMs() - startTime,
        timestamp: systemNowMs(),
      });

      logger.info(
        { serverName, attempt: attempt + 1, toolCount: tools.length, generation: state.generations.get(serverName) },
        "MCP server reconnected",
      );

      // Clean up abort controller
      state.reconnectionAbortControllers.delete(serverName);
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn(
        { serverName, attempt: attempt + 1, err: lastError, hint: "Retry scheduled; check MCP server logs", errorKind: "dependency" as const },
        "MCP reconnection attempt failed",
      );
    }
  }

  // All attempts exhausted
  const truncatedError = lastError.length > 500 ? lastError.slice(0, 500) : lastError;
  const conn = state.connections.get(serverName);
  if (conn) {
    state.connections.set(serverName, {
      ...conn,
      status: "error",
      reconnectAttempt: 0,
      error: truncatedError,
    });
  }

  deps.eventBus?.emit("mcp:server:reconnect_failed", {
    serverName,
    attempts: reconnectOpts.maxAttempts,
    lastError: truncatedError,
    timestamp: systemNowMs(),
  });

  logger.error(
    { serverName, attempts: reconnectOpts.maxAttempts, err: truncatedError, hint: "MCP server reconnection exhausted; manual intervention may be needed", errorKind: "dependency" as const },
    "MCP server reconnection failed",
  );

  state.reconnectionAbortControllers.delete(serverName);
}
