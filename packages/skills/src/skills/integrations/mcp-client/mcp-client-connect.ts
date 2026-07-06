// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * Connection lifecycle helpers.
 *
 * State-first protocol: every helper that touches closure state takes
 * `state: McpClientManagerState` as its first parameter, followed by
 * `deps: McpClientManagerDeps`. Matches the pi-executor and
 * telegram-adapter conventions.
 *
 * Owns: connectServer, disconnectServer, disconnectAllServers,
 * reconnectServer, getConnection, getAllConnections. Tool discovery
 * helpers live in mcp-client-discover.ts; the reconnect engine
 * (handleDisconnection + reconnectionLoop) lives in
 * mcp-client-reconnect.ts.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err, withTimeout } from "@comis/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import PQueue from "p-queue";
import { systemNowMs, systemScheduleTimeout } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import {
  createClient,
  createTransport,
  extractServerMetadata,
  wireStderrCapture,
} from "./mcp-client-discover.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { wireClientLifecycleCallbacks, handleDisconnection } from "./mcp-client-reconnect.js";
import { startKeepaliveTicker, stopKeepaliveTicker } from "./mcp-client-keepalive.js";
import { startIdleTicker, stopIdleTicker } from "./mcp-client-idle-eviction.js";
import {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./mcp-client-osv-check.js";
// The OAuth connect seam lives in a sibling leaf to keep this file under the
// 500-line per-subdirectory cap (prlimit-probe split precedent).
// isNeedsOAuthLoginError is re-exported here so the package barrel
// keeps a stable import path.
import {
  NEEDS_OAUTH_LOGIN,
  tagNeedsOAuthLogin,
  prepareOAuthProvider,
} from "./mcp-client-oauth-connect.js";
export { isNeedsOAuthLoginError } from "./mcp-client-oauth-connect.js";
// Connect-FAILURE classification + recording lives in a sibling leaf to keep this
// file under the 500-line per-subdirectory cap (the OAuth-seam split precedent).
import { recordConnectFailure } from "./mcp-client-connect-classify.js";
export { classifyConnectFailure } from "./mcp-client-connect-classify.js";

// ---------------------------------------------------------------------------
// connect (state-first)
// ---------------------------------------------------------------------------

export async function connectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  config: McpServerConfig,
): Promise<Result<McpConnection, Error>> {
  const { logger } = deps;
  if (!config.enabled) {
    return err(new Error(`MCP server "${config.name}" is disabled`));
  }

  // Clear userDisconnected flag so reconnection works for new connections
  state.userDisconnectedFlags.delete(config.name);

  // Update status to connecting
  const existingConn = state.connections.get(config.name);
  if (existingConn) {
    // Already connected -- disconnect first
    await disconnectServer(state, deps, config.name);
  }

  // Pre-spawn OSV malware check (stdio only) runs OUTSIDE the try block.
  // Previously the check sat inside the try and a malicious-verdict throw fell
  // into the catch — which wrote an error-state McpConnection to
  // `state.connections` with `status: "error"` and the [osv_malware_detected]
  // message. That orphan error entry persisted across the operator's view
  // (mcp.list shows it as an "error"-status server), confusing operators into
  // thinking they could `mcp.reconnect` it. Fix: run the OSV check before the
  // try block so the throw bubbles up cleanly to the caller and
  // `state.connections.get(name)` returns undefined for malicious-package
  // detections.
  if (
    config.transport === "stdio" &&
    config.command &&
    (config.osvCheckEnabled ?? true)
  ) {
    const pkg = extractMcpPackageName(config.command, config.args);
    if (pkg !== null) {
      // Fail-open on OSV API errors is encapsulated inside osvMalwareCheck
      // (logs WARN with errorKind:"network"|"dependency" and returns
      // verdict:"safe"). The only throw path here is verdict==="malicious".
      const osvResult = await osvMalwareCheck(pkg.name, pkg.ecosystem, {
        cacheDir: DEFAULT_OSV_CACHE_DIR,
        ttlMs: config.osvCacheTtlMs ?? 86_400_000,
        logger,
      });
      if (osvResult.verdict === "malicious") {
        // Bracketed [osv_malware_detected] code is LLM-readable for
        // self-correction. Logging at WARN here mirrors the spawn-time
        // error log we used to emit from the catch — keeps the
        // observability surface even though we are no longer routing
        // through the error-state entry.
        const message =
          `[osv_malware_detected] MCP package "${pkg.name}" (ecosystem: ${pkg.ecosystem}) ` +
          `matches OSV malicious-packages advisory: ${osvResult.advisoryIds.join(", ")}. ` +
          `Hint: do NOT install this package; verify the server name with the publisher.`;
        logger.warn(
          {
            serverName: config.name,
            packageName: pkg.name,
            ecosystem: pkg.ecosystem,
            advisoryIds: osvResult.advisoryIds,
            hint: "OSV malicious-package match — connect rejected; no error-state entry created",
            errorKind: "dependency" as const,
          },
          "MCP OSV malware check rejected connect",
        );
        return err(new Error(message));
      }
    } else {
      logger.info(
        {
          serverName: config.name,
          command: config.command,
          hint: "OSV check skipped — no known package manager detected (npx/uvx/pnpm)",
        },
        "MCP OSV malware check skipped (unknown command)",
      );
    }
  }

  // For an auth:"oauth" server with the OAuth seam wired, construct the
  // OAuthClientProvider adapter + run the discovery pre-flight BEFORE the
  // transport is built, then thread the provider onto the runtime config so
  // createTransport attaches it. A discovery cascade failure throws here and is
  // surfaced as a normal connect failure below. The provider is NOT constructed
  // for non-oauth servers or when no oauthDeps seam is injected (the SDK then
  // runs without a provider; a 401 still surfaces needs_oauth_login via the
  // catch below).
  let effectiveConfig = config;
  try {
    if (config.auth === "oauth" && deps.oauthDeps) {
      effectiveConfig = await prepareOAuthProvider(state, deps.oauthDeps, config, logger);
    }
  } catch (discoveryError: unknown) {
    const message = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    state.connections.set(config.name, {
      name: config.name,
      client: null as unknown as Client,
      status: "error",
      tools: [],
      lastHealthCheck: systemNowMs(),
      reconnectAttempt: 0,
      maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
      error: message,
      generation: state.generations.get(config.name) ?? 0,
    });
    logger.error(
      { serverName: config.name, err: message, hint: "OAuth discovery pre-flight failed; verify the server publishes OAuth metadata or set oauth.authorizationEndpoint", errorKind: "config" as const },
      "MCP OAuth discovery pre-flight failed",
    );
    return err(discoveryError instanceof Error ? discoveryError : new Error(message));
  }

  // Clear stderr captured by any PRIOR attempt so a failure below reflects only
  // THIS spawn; stamp a start time for the connected-event durationMs.
  state.lastStderr.delete(config.name);
  const connectStartedMs = systemNowMs();

  try {
    // Create transport (logger threaded for prlimit-skip WARN).
    // For an auth:"oauth" server, effectiveConfig now carries the oauthProvider.
    const transport = createTransport(effectiveConfig, logger);

    // Wire stderr capture for stdio transports (writes the running buffer onto
    // state.lastStderr so the catch below can fold it into a failure).
    wireStderrCapture(state, deps, effectiveConfig, transport);

    // Log transport type at INFO
    if (config.transport === "stdio") {
      logger.info(
        // envKeys (names only — values are resolved secrets) so an env-wiring bug
        // (a credential the child needs but never received) is visible at the
        // spawn line, not inferred from a downstream "Connection closed".
        { serverName: config.name, command: config.command, args: config.args, cwd: config.cwd, envKeys: config.env ? Object.keys(config.env) : undefined },
        "Spawning MCP server process",
      );
    } else if (config.transport === "sse") {
      logger.info(
        { serverName: config.name, url: config.url },
        "Connecting to MCP server via legacy SSE",
      );
    } else if (config.transport === "http") {
      logger.info(
        { serverName: config.name, url: config.url },
        "Connecting to MCP server via Streamable HTTP",
      );
    }

    // Log header names (never values) when headers are present
    if (config.headers && Object.keys(config.headers).length > 0) {
      logger.debug?.({ serverName: config.name, headerKeys: Object.keys(config.headers) }, "Custom headers configured");
    }

    // Create client and connect (with timeout)
    const client = createClient(state, deps, config.name);
    await withTimeout(
      client.connect(transport),
      state.options.connectTimeoutMs,
      systemScheduleTimeout,
      `MCP server "${config.name}" connect`,
    );

    // Wire lifecycle callbacks for reconnection
    wireClientLifecycleCallbacks(state, deps, client, config.name);

    // Store config for reconnection — effectiveConfig so the OAuthClientProvider
    // (runtime-only oauthProvider field) is retained across reconnects.
    state.serverConfigs.set(config.name, effectiveConfig);
    // Initialize generation
    state.generations.set(config.name, state.generations.get(config.name) ?? 0);

    // Extract server metadata
    const metadata = extractServerMetadata(client);

    if (metadata.instructions) {
      logger.debug?.({ serverName: config.name, instructionChars: metadata.instructions.length }, "MCP server provided instructions");
    }

    // Discover tools (with timeout)
    const listResult = await withTimeout(
      client.listTools(),
      state.options.connectTimeoutMs,
      systemScheduleTimeout,
      `MCP server "${config.name}" listTools`,
    );
    const tools: McpToolDefinition[] = listResult.tools.map((tool) => ({
      name: tool.name,
      qualifiedName: qualifyToolName(config.name, tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));

    const connection: McpConnection = {
      name: config.name,
      client,
      status: "connected",
      tools,
      lastHealthCheck: systemNowMs(),
      reconnectAttempt: 0,
      maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
      generation: state.generations.get(config.name) ?? 0,
      instructions: metadata.instructions,
      capabilities: metadata.capabilities,
      serverInfo: metadata.serverInfo,
      // Mirror the per-server resources/prompts opt-out onto the connection so
      // the platform-tool registry's capability-gate predicate honors
      // enableResources/enablePrompts:false without a separate config lookup
      // (the manager surfaces only runtime connections).
      ...(config.enableResources !== undefined && { enableResources: config.enableResources }),
      ...(config.enablePrompts !== undefined && { enablePrompts: config.enablePrompts }),
    };

    state.connections.set(config.name, connection);

    // Create per-server call concurrency queue. Explicit maxConcurrency always
    // wins; else stdio gets 4 only when supportsParallelToolCalls opts in
    // (default stdio stays 1); sse/http keep their transport default (already 4).
    const resolvedConcurrency =
      config.maxConcurrency
      ?? (config.transport === "stdio"
            ? (config.supportsParallelToolCalls === true ? 4 : state.options.stdioDefaultConcurrency)
            : state.options.httpDefaultConcurrency);
    state.callQueues.set(config.name, new PQueue({ concurrency: resolvedConcurrency }));

    // Per-server keepalive ticker. NO-OP when keepaliveIntervalMs === 0
    // (disabled). Routes ping through the same PQueue as tool calls so stdio
    // single-pipe serialization is preserved. The onFailure callback threads
    // handleDisconnection so mcp-client-keepalive.ts need not import it directly
    // (which would create a keepalive ↔ reconnect source cycle).
    startKeepaliveTicker(state, deps, config, (srvName) => handleDisconnection(state, deps, srvName, "keepalive_failed"));

    // Per-server idle eviction ticker. NO-OP when idleTtlMs === 0/undefined
    // (opt-in). Disconnects the transport after idle without setting
    // userDisconnectedFlags, so the next callTool lazily reconnects
    // (see mcp-client-call.ts getOrReconnect).
    startIdleTicker(state, deps, config);

    logger.info(`MCP server "${config.name}" connected: ${tools.length} tool(s) discovered`);

    // Initial-connect success → trajectory (symmetric with mcp:server:reconnected).
    deps.eventBus?.emit("mcp:server:connected", {
      serverName: config.name,
      transport: config.transport,
      toolCount: tools.length,
      durationMs: systemNowMs() - connectStartedMs,
      timestamp: systemNowMs(),
    });

    return ok(connection);
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);

    // The SDK throws UnauthorizedError from client.connect when an auth:"oauth"
    // server has no valid token (or refresh failed). For first-install (no
    // OAuthClientProvider attached), the SDK throws StreamableHTTPError(401, ...)
    // instead. Both must be treated as needs_oauth_login. Do NOT auto-launch a
    // browser daemon-side — return a `needs_oauth_login`-tagged Result so the
    // daemon RPC layer tells the operator to run `comis mcp login <server>`.
    // The error-state connection entry is still recorded so mcp.list surfaces
    // the server's auth-needed state.
    // NOTE: Do NOT inspect www-authenticate headers — the SDK has already
    // consumed and closed the response by the time StreamableHTTPError is thrown.
    const isUnauthorized =
      error instanceof UnauthorizedError ||
      (error instanceof StreamableHTTPError && (error as { code?: unknown }).code === 401);

    if (isUnauthorized) {
      state.connections.set(config.name, {
        name: config.name,
        client: null as unknown as Client,
        status: "error",
        tools: [],
        lastHealthCheck: systemNowMs(),
        reconnectAttempt: 0,
        maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
        error: `${NEEDS_OAUTH_LOGIN}: ${rawMessage}`,
        generation: state.generations.get(config.name) ?? 0,
      });
      logger.warn(
        { serverName: config.name, hint: `OAuth login required — run \`comis mcp login ${config.name}\`; no browser launched (operator-initiated)`, errorKind: "config" as const },
        "MCP server connect requires OAuth login",
      );
      // Initial-connect failure → obs (health_signal + trajectory), like the
      // reconnect_failed sibling — so a failed install is diagnosable via
      // `comis fleet`/`explain`, not only a raw daemon.log grep.
      deps.eventBus?.emit("mcp:server:connect_failed", {
        serverName: config.name,
        transport: config.transport,
        reason: "auth_required",
        timestamp: systemNowMs(),
      });
      return err(tagNeedsOAuthLogin(config.name));
    }

    // Generic failure → the classify sibling folds + SANITIZES the child stderr,
    // writes the error-state entry, logs the ERROR (reason + hint), emits
    // mcp:server:connect_failed, and returns the enriched err.
    return recordConnectFailure(state, deps, config, rawMessage, error);
  }
}

// ---------------------------------------------------------------------------
// disconnect (state-first)
// ---------------------------------------------------------------------------

export async function disconnectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
): Promise<void> {
  const { logger } = deps;
  // Set user-disconnected flag to prevent reconnection
  state.userDisconnectedFlags.add(name);

  // Abort any in-flight reconnection
  const ac = state.reconnectionAbortControllers.get(name);
  if (ac) {
    ac.abort();
    state.reconnectionAbortControllers.delete(name);
  }

  const conn = state.connections.get(name);
  if (!conn) return;

  try {
    if (conn.client && conn.status === "connected") {
      await conn.client.close();
    }
  } catch (error: unknown) {
    logger.warn({ serverName: name, err: error instanceof Error ? error.message : String(error), hint: "MCP server disconnect failed; connection may be stale", errorKind: "dependency" as const }, "MCP server disconnect failed");
  }

  // Stop the keepalive ticker BEFORE tearing down the queue (so the ticker
  // cannot fire one last queue.add against a queue we are about to delete).
  stopKeepaliveTicker(state, name);

  // Stop the idle-eviction ticker alongside keepalive.
  stopIdleTicker(state, name);

  // Clear and remove call queue -- pending .add() callers get no resolution
  // but that's acceptable since the connection is gone anyway
  const callQueue = state.callQueues.get(name);
  if (callQueue) {
    callQueue.clear();
    state.callQueues.delete(name);
  }

  // Tear down the dedicated keepalive queue (only populated when primary
  // concurrency > 1). Mirrors the callQueue teardown so the queue cannot leak
  // across reconnect generations. stopKeepaliveTicker above already prevents
  // the ticker from enqueuing a new ping mid-teardown.
  const keepaliveQueue = state.keepaliveQueues.get(name);
  if (keepaliveQueue) {
    keepaliveQueue.clear();
    state.keepaliveQueues.delete(name);
  }

  state.connections.delete(name);
  state.serverConfigs.delete(name);
  // Keep generations (in case user reconnects later, generation keeps incrementing)
  logger.info(`MCP server "${name}" disconnected`);
}

// ---------------------------------------------------------------------------
// disconnectAll (state-first)
// ---------------------------------------------------------------------------

export async function disconnectAllServers(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
): Promise<void> {
  const names = [...state.connections.keys()];
  for (const name of names) {
    await disconnectServer(state, deps, name);
  }
  // Clear any remaining abort controllers
  for (const [, ac] of state.reconnectionAbortControllers) {
    ac.abort();
  }
  state.reconnectionAbortControllers.clear();
}

// ---------------------------------------------------------------------------
// Connection getters (state-first)
// ---------------------------------------------------------------------------

export function getConnection(
  state: McpClientManagerState,
  name: string,
): McpConnection | undefined {
  return state.connections.get(name);
}

export function getAllConnections(state: McpClientManagerState): McpConnection[] {
  return [...state.connections.values()];
}

// ---------------------------------------------------------------------------
// reconnect (state-first; uses stored config)
// ---------------------------------------------------------------------------

export async function reconnectServer(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  name: string,
): Promise<Result<McpConnection, Error>> {
  const storedConfig = state.serverConfigs.get(name);
  if (!storedConfig) {
    return err(new Error(`MCP server "${name}" has no stored config -- use connect() instead`));
  }
  await disconnectServer(state, deps, name);
  return connectServer(state, deps, storedConfig);
}
