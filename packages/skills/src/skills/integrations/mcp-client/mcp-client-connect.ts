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
import PQueue from "p-queue";
import { systemNowMs, systemScheduleTimeout } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
  McpToolDefinition,
  McpOAuthDeps,
} from "./mcp-client-types.js";
import {
  createClient,
  createTransport,
  extractServerMetadata,
  wireStderrCapture,
} from "./mcp-client-discover.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { wireClientLifecycleCallbacks } from "./mcp-client-reconnect.js";
import { startKeepaliveTicker, stopKeepaliveTicker } from "./mcp-client-keepalive.js";
import { startIdleTicker, stopIdleTicker } from "./mcp-client-idle-eviction.js";
import {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "./mcp-client-osv-check.js";
import { createOAuthClientProvider } from "./oauth/provider.js";
import { createRefreshDeduper } from "./oauth/refresh-deduper.js";

// ---------------------------------------------------------------------------
// OAuth connect seam (Phase 66 OAUTH-11 / 66d)
// ---------------------------------------------------------------------------

/**
 * The `needs_oauth_login` tag. An `auth:"oauth"` server that connects WITHOUT a
 * valid token throws the SDK `UnauthorizedError` from `client.connect`; rather
 * than auto-launching a browser daemon-side (resolved_scope #3 / T-66-22), the
 * connect path returns a tagged `Result.err`. The daemon RPC layer reads the tag
 * to tell the operator to run `comis mcp login <server>` (the explicit,
 * operator-initiated `oauth_login` RPC owns the loopback server + browser dance).
 *
 * The tag is a non-enumerable marker on the Error (matches the codebase's
 * `Object.assign(new Error, { errorKind })` pattern) so the existing
 * `Result<McpConnection, Error>` signature is unchanged.
 */
const NEEDS_OAUTH_LOGIN = "needs_oauth_login" as const;
type NeedsOAuthLoginError = Error & { readonly code: typeof NEEDS_OAUTH_LOGIN };

/** Tag an Error as `needs_oauth_login` (preserves the original message + stack). */
function tagNeedsOAuthLogin(serverName: string): NeedsOAuthLoginError {
  const e = new Error(
    `MCP server "${serverName}" requires OAuth login. ` +
      `Run \`comis mcp login ${serverName}\` to authenticate (no browser was launched).`,
  );
  return Object.assign(e, { code: NEEDS_OAUTH_LOGIN });
}

/** Type guard: did connect surface a `needs_oauth_login` signal (vs a generic failure)? */
export function isNeedsOAuthLoginError(error: unknown): error is NeedsOAuthLoginError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === NEEDS_OAUTH_LOGIN
  );
}

/**
 * Build the OAuthClientProvider adapter for an `auth:"oauth"` server and run the
 * 66b discovery pre-flight (cold-load only). Mutates `config` to carry the
 * provider on the runtime-only `oauthProvider` field so the pure `createTransport`
 * attaches it. Returns the config to connect with (the same object, narrowed).
 *
 * NO browser is launched here. Discovery failure throws an actionable
 * `errorKind:"config"` error (66-P9), surfaced as a normal connect failure.
 */
async function prepareOAuthProvider(
  state: McpClientManagerState,
  oauthDeps: McpOAuthDeps,
  config: McpServerConfig,
  logger: McpClientManagerDeps["logger"],
): Promise<McpServerConfig> {
  const tokenStore = oauthDeps.createTokenStore();
  // The deduper shares the manager's inflightRefreshes map + the per-server call
  // queue as the concurrency-1 critical section (66-04 left this wiring to 66d):
  // a 401 storm for one server coalesces into a single refresh POST (66-P4). The
  // call queue is created at connect (below) but the deduper only touches it on a
  // refresh, by which point the connection — and its queue — exist. The critical
  // section binds a LATE lookup of the live per-server callQueue
  // (state.callQueues) rather than a snapshot; a fresh cc-1 queue is the fallback
  // for the transient pre-connect window. The wrapper also normalises PQueue's
  // `Promise<T | Promise<T>>` return to the deduper's `Promise<T>` contract.
  const fallbackQueue = new PQueue({ concurrency: 1 });
  const criticalSection = {
    add<T>(fn: () => Promise<T> | T): Promise<T> {
      const live = state.callQueues.get(config.name) ?? fallbackQueue;
      return live.add(fn) as Promise<T>;
    },
  };
  const deduper = createRefreshDeduper({
    inflightRefreshes: state.inflightRefreshes,
    queue: criticalSection,
    tokenStore,
    logger,
  });

  const provider = createOAuthClientProvider({
    serverName: config.name,
    oauthConfig: config.oauth ?? {},
    tokenStore,
    deduper,
    logger,
  });

  // Pre-flight discovery (OAUTH-03): only when nothing is persisted. resolveDiscovery
  // is itself a warm-load short-circuit, but checking here avoids constructing the
  // redirect-fetch + a network attempt on the warm path and keeps the "discovery
  // runs once on cold load" contract observable.
  const existingDiscovery = await tokenStore.discoveryState(config.name);
  if (!existingDiscovery && config.url !== undefined) {
    await oauthDeps.resolveDiscovery({
      serverName: config.name,
      serverUrl: config.url,
      ...(config.oauth?.authorizationEndpoint !== undefined
        ? { userAuthorizationEndpoint: config.oauth.authorizationEndpoint }
        : {}),
      tokenStore,
      logger,
    });
  }

  return { ...config, oauthProvider: provider };
}

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

  // Phase 63 SAFETY-05/06 + WR-03: pre-spawn OSV malware check (stdio
  // only) runs OUTSIDE the try block. Pre-fix the check sat inside the
  // try and a malicious-verdict throw fell into the catch — which wrote
  // an error-state McpConnection to `state.connections` with
  // `status: "error"` and the [osv_malware_detected] message. That
  // orphan error entry persisted across the operator's view (mcp.list
  // shows it as an "error"-status server), confusing operators into
  // thinking they could `mcp.reconnect` it. WR-03 fix: run the OSV
  // check before the try block so the throw bubbles up cleanly to the
  // caller and `state.connections.get(name)` returns undefined for
  // malicious-package detections. Per RESEARCH.md §"Pattern 4" +
  // Pitfall 4.
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

  // Phase 66 OAUTH-11 (66d): for an auth:"oauth" server with the OAuth seam
  // wired, construct the OAuthClientProvider adapter + run the discovery
  // pre-flight BEFORE the transport is built, then thread the provider onto the
  // runtime config so createTransport attaches it. A discovery cascade failure
  // (66-P9) throws here and is surfaced as a normal connect failure below. The
  // provider is NOT constructed for non-oauth servers or when no oauthDeps seam
  // is injected (the SDK then runs without a provider; a 401 still surfaces
  // needs_oauth_login via the catch below).
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

  try {
    // Create transport (logger threaded for Phase 63 SAFETY-08 prlimit-skip WARN).
    // For an auth:"oauth" server, effectiveConfig now carries the oauthProvider.
    const transport = createTransport(effectiveConfig, logger);

    // Wire stderr capture for stdio transports
    wireStderrCapture(deps, effectiveConfig, transport);

    // Log transport type at INFO
    if (config.transport === "stdio") {
      logger.info(
        { serverName: config.name, command: config.command, args: config.args, cwd: config.cwd },
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
      // Phase 65 OPUX-10: mirror the per-server resources/prompts opt-out onto
      // the connection so the platform-tool registry's capability-gate
      // predicate honors enableResources/enablePrompts:false without a
      // separate config lookup (the manager surfaces only runtime connections).
      ...(config.enableResources !== undefined && { enableResources: config.enableResources }),
      ...(config.enablePrompts !== undefined && { enablePrompts: config.enablePrompts }),
    };

    state.connections.set(config.name, connection);

    // Create per-server call concurrency queue. CAP-02: explicit maxConcurrency
    // always wins; else stdio gets 4 only when supportsParallelToolCalls opts in
    // (default stdio stays 1); sse/http keep their transport default (already 4).
    const resolvedConcurrency =
      config.maxConcurrency
      ?? (config.transport === "stdio"
            ? (config.supportsParallelToolCalls === true ? 4 : state.options.stdioDefaultConcurrency)
            : state.options.httpDefaultConcurrency);
    state.callQueues.set(config.name, new PQueue({ concurrency: resolvedConcurrency }));

    // Phase 64 RELY-01/02/03: per-server keepalive ticker. NO-OP when
    // keepaliveIntervalMs === 0 (disabled). Routes ping through the same
    // PQueue as tool calls (RELY-03) so stdio single-pipe serialization
    // is preserved.
    startKeepaliveTicker(state, deps, config);

    // Phase 65 OPUX-09: per-server idle eviction ticker. NO-OP when
    // idleTtlMs === 0/undefined (opt-in). Disconnects the transport after
    // idle without setting userDisconnectedFlags, so the next callTool
    // lazily reconnects (see mcp-client-call.ts getOrReconnect).
    startIdleTicker(state, deps, config);

    logger.info(`MCP server "${config.name}" connected: ${tools.length} tool(s) discovered`);

    return ok(connection);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Phase 66 OAUTH-11 (66d / T-66-22): the SDK throws UnauthorizedError from
    // client.connect when an auth:"oauth" server has no valid token (or refresh
    // failed). Do NOT auto-launch a browser daemon-side (resolved_scope #3) —
    // return a `needs_oauth_login`-tagged Result so the daemon RPC layer tells
    // the operator to run `comis mcp login <server>`. The error-state connection
    // entry is still recorded so mcp.list surfaces the server's auth-needed state.
    const isUnauthorized = error instanceof UnauthorizedError;

    // Store error state
    state.connections.set(config.name, {
      name: config.name,
      client: null as unknown as Client,
      status: "error",
      tools: [],
      lastHealthCheck: systemNowMs(),
      reconnectAttempt: 0,
      maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
      error: isUnauthorized ? `${NEEDS_OAUTH_LOGIN}: ${message}` : message,
      generation: state.generations.get(config.name) ?? 0,
    });

    if (isUnauthorized) {
      logger.warn(
        { serverName: config.name, hint: `OAuth login required — run \`comis mcp login ${config.name}\`; no browser launched (operator-initiated)`, errorKind: "config" as const },
        "MCP server connect requires OAuth login",
      );
      return err(tagNeedsOAuthLogin(config.name));
    }

    logger.error({ serverName: config.name, err: message, hint: "Check MCP server configuration and ensure the server process is running", errorKind: "dependency" as const }, "MCP server connection failed");

    return err(error instanceof Error ? error : new Error(message));
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

  // Phase 64 RELY-01: stop the keepalive ticker BEFORE tearing down the
  // queue (so the ticker cannot fire one last queue.add against a queue
  // we are about to delete).
  stopKeepaliveTicker(state, name);

  // Phase 65 OPUX-09: stop the idle-eviction ticker alongside keepalive.
  stopIdleTicker(state, name);

  // Clear and remove call queue -- pending .add() callers get no resolution
  // but that's acceptable since the connection is gone anyway
  const callQueue = state.callQueues.get(name);
  if (callQueue) {
    callQueue.clear();
    state.callQueues.delete(name);
  }

  // Phase 67 CAP-02: tear down the dedicated keepalive queue (only populated
  // when primary concurrency > 1). Mirrors the callQueue teardown so the
  // queue cannot leak across reconnect generations. stopKeepaliveTicker above
  // already prevents the ticker from enqueuing a new ping mid-teardown.
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
