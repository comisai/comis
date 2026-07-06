// SPDX-License-Identifier: Apache-2.0
/**
 * mcp-client public types + closure-state interface.
 *
 * The canonical public-API contract is preserved byte-identical so the
 * @comis/skills barrel re-exports stay byte-identical.
 *
 * Defines the closure-state shape (McpClientManagerState) used by the
 * state-first protocol across the mcp-client leaves.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SystemIntervalHandle, SystemTimeoutHandle, TypedEventBus } from "@comis/core";
import type PQueue from "p-queue";

import type { RefreshResult } from "./oauth/refresh-deduper.js";
import type { TokenStore } from "./oauth/token-store.js";
import type { ResolveDiscoveryArgs } from "./oauth/discovery.js";

// ---------------------------------------------------------------------------
// Qualified name helpers (pure; co-located with types to break no-cycles)
// ---------------------------------------------------------------------------
//
// qualifyToolName + parseQualifiedName live here (instead of in the call
// leaf where they were originally placed) to break a no-cycles
// regression: callTool imports handleDisconnection from
// mcp-client-reconnect.ts, which in turn must qualify tool names —
// putting the qualify helpers in call.ts would close a 3-way cycle
// (call -> reconnect -> discover -> call). Hosting them in types.ts
// (the leaf with zero internal sibling imports) keeps the dependency
// graph acyclic.

const MCP_PREFIX = "mcp:";

/** Build a qualified tool name: "mcp:{server}/{tool}". */
export function qualifyToolName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${serverName}/${toolName}`;
}

/** Parse a qualified name into server and tool parts. Returns undefined on invalid format. */
export function parseQualifiedName(
  qualifiedName: string,
): { serverName: string; toolName: string } | undefined {
  if (!qualifiedName.startsWith(MCP_PREFIX)) return undefined;
  const rest = qualifiedName.slice(MCP_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 1 || slashIdx === rest.length - 1) return undefined;
  return {
    serverName: rest.slice(0, slashIdx),
    toolName: rest.slice(slashIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for a single MCP server connection. */
// @optional-field-count: User-facing MCP server config. Each optional captures a real operator override across sub-systems — base transport (command, args, url, env, cwd, headers, maxConcurrency), safety/OSV/rlimits (safetyAllowedEnvKeys, osvCheckEnabled, osvCacheTtlMs, rlimits), reliability (keepaliveIntervalMs, circuitBreakerThreshold, circuitBreakerCooldownMs), tool-filtering/idle/utility (toolAllowlist, toolBlocklist, idleTtlMs, enableResources, enablePrompts), and concurrency (supportsParallelToolCalls). Splitting into per-subsystem sub-objects would force every connect path + persistence/audit hook to walk nested groups while gaining no type safety (all use the same `??`/`=== true` global-default fallback). The interface fits the single-sub-object pattern used by all other MCP transports; only the optional count grew over time.
export interface McpServerConfig {
  /** Unique name identifying this server. */
  readonly name: string;
  /** Transport protocol: stdio (local process), sse (legacy SSE), or http (Streamable HTTP). */
  readonly transport: "stdio" | "sse" | "http";
  /** Executable command for stdio transport. */
  readonly command?: string;
  /** Command-line arguments for stdio transport. */
  readonly args?: string[];
  /** Server URL for remote transports (sse, http). */
  readonly url?: string;
  /** Environment variables to pass to the stdio process (e.g. API keys). */
  readonly env?: Record<string, string>;
  /** Working directory for stdio transport. Overrides the default workspace CWD. */
  readonly cwd?: string;
  /** Whether the server is enabled. */
  readonly enabled: boolean;
  /** Custom HTTP headers for remote transports. Plumbed to requestInit.headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Maximum concurrent tool calls. Undefined = transport-based default. */
  readonly maxConcurrency?: number;
  /**
   * Operator-extension allowlist for the stdio child env scrub. Copied verbatim
   * from `config.integrations.mcp.safetyAllowedEnvKeys` by the daemon RPC
   * handler (`mcp-handlers.ts:McpConnect`); the field is additive over the
   * built-in `MCP_STDIO_BUILTIN_ENV_ALLOWLIST` and only applies to the stdio
   * transport. Undefined ⇒ built-in allowlist only.
   */
  readonly safetyAllowedEnvKeys?: readonly string[];
  /**
   * OSV malware check toggle. Copied from
   * `config.integrations.mcp.osvCheckEnabled` (schema field, default `true`)
   * by the daemon RPC handler. Set `false` in air-gapped deployments to skip
   * the pre-spawn api.osv.dev check entirely. Undefined ⇒ default `true`
   * applies at the call site.
   */
  readonly osvCheckEnabled?: boolean;
  /**
   * OSV cache TTL (ms). Copied from `config.integrations.mcp.osvCacheTtlMs`
   * (schema field, default 86_400_000 = 24h) by the daemon RPC handler.
   * Undefined ⇒ caller falls back to the 24h default at the call site.
   */
  readonly osvCacheTtlMs?: number;
  /**
   * Per-server stdio rlimits override. Copied from the persisted
   * `McpServerEntrySchema.rlimits` (schema field) by the daemon RPC handler.
   * Applied via `prlimit(1)` wrap on Linux when set; partial overrides accepted
   * (`{ cpu: 600 }` emits only `--cpu=600`). When unset → NO prlimit wrap
   * (existing env-only wrap retained). On macOS dev (prlimit absent) → WARN
   * once per daemon process + skip. Only applies to the stdio transport.
   * See mcp-client-discover.ts:wrapStdioCommand.
   */
  readonly rlimits?: {
    readonly as?: number;
    readonly nofile?: number;
    readonly cpu?: number;
  };
  /**
   * Per-server keepalive ping interval (ms). `0` disables the keepalive
   * ticker for this server (use for chatty servers that already receive
   * frequent tool calls).
   *
   * Resolution chain (outermost wins):
   *   `config.keepaliveIntervalMs` (per-server RPC param or persisted entry)
   *   ?? `globalKeepaliveIntervalMs` (integrations.mcp.keepaliveIntervalMs)
   *   ?? `resolveDefaultKeepaliveIntervalMs(transport)` (30 000 ms http/sse,
   *      180 000 ms stdio).
   *
   * Use `??` (nullish coalescing), NOT `||`, so `0` is preserved as "disabled".
   */
  readonly keepaliveIntervalMs?: number;
  /**
   * Per-server override of mcp.circuitBreakerThreshold. Setting `1` effectively
   * disables the breaker (opens on first failure but cooldown still applies).
   * Undefined ⇒ global default applies.
   */
  readonly circuitBreakerThreshold?: number;
  /**
   * Per-server override of mcp.circuitBreakerCooldownMs. Cooldown between
   * open → half-open transitions. Undefined ⇒ global default.
   */
  readonly circuitBreakerCooldownMs?: number;
  /** Per-server tool allowlist. Read by setup-tools.ts's serverFiltersFn
   *  closure; applied at mcp-tool-bridge.ts only. */
  readonly toolAllowlist?: readonly string[];
  /** Per-server tool blocklist. Read by setup-tools.ts's serverFiltersFn
   *  closure; applied at mcp-tool-bridge.ts only. */
  readonly toolBlocklist?: readonly string[];
  /** Per-server idle eviction TTL (ms). 0 ⇒ disabled (opt-in). Consumed by
   *  mcp-client-idle-eviction.ts. */
  readonly idleTtlMs?: number;
  /** Opt-out for resources utility tools. undefined ⇒ auto-register if
   *  capabilities.resources present. */
  readonly enableResources?: boolean;
  /** Opt-out for prompts utility tools. undefined ⇒ auto-register if
   *  capabilities.prompts present. */
  readonly enablePrompts?: boolean;
  /** Opt-in parallel tool calls. true + transport "stdio" ⇒ per-server PQueue
   *  concurrency = maxConcurrency ?? 4; undefined/false ⇒ stdio stays
   *  serialized (1). No-op for sse/http (already 4). Read at PQueue
   *  construction (mcp-client-connect.ts). */
  readonly supportsParallelToolCalls?: boolean;
  /** Per-server authentication scheme. "oauth" wires the OAuthClientProvider
   *  adapter onto the transport (mcp-client-discover.ts); "bearer"/"none"/
   *  undefined leave the existing header/no-auth behaviour. Sourced from the
   *  persisted McpServerEntry and threaded through both daemon runtime-config
   *  sites + buildPersistedMcpEntry. */
  readonly auth?: "none" | "bearer" | "oauth";
  /** OAuth provider hints for an `auth:"oauth"` server. authorizationEndpoint =
   *  discovery fallback; scope = requested OAuth scope; stripeAccount =
   *  Stripe-Account header value. */
  readonly oauth?: {
    readonly authorizationEndpoint?: string;
    readonly scope?: string;
    readonly stripeAccount?: string;
  };
  /**
   * RUNTIME-ONLY OAuthClientProvider adapter. Constructed in connectServer from
   * the token store keyed by `name` and threaded onto the runtime config so the
   * PURE `createTransport` helper can attach it to the sse/http transport when
   * `auth === "oauth"`. NOT persisted — deliberately absent from
   * `buildPersistedMcpEntry` (it is a live object graph holding the token store
   * + deduper, not serializable config). Undefined ⇒ no authProvider attached
   * (the SDK runs without OAuth, surfacing needs_oauth_login on a 401).
   */
  readonly oauthProvider?: OAuthClientProvider;
  /** RUNTIME-ONLY FetchLike wrapping the redirect-policy fetch with the
   *  deduped-refresh 401 path (oauth/deduped-fetch.ts). Built by
   *  prepareOAuthProvider for auth:"oauth" + the OAuth seam; createTransport
   *  installs it as the SSE/HTTP transport's fetch. NOT persisted. Undefined ⇒
   *  bare redirect-policy fetch (SDK's own auth() handles 401 without dedup). */
  readonly oauthFetch?: FetchLike;
}

/** Connection status for an MCP server. */
export type McpConnectionStatus = "connected" | "disconnected" | "connecting" | "reconnecting" | "error";

/**
 * Per-server circuit breaker state.
 *
 * Discriminated union — `status` is the closed string-literal discriminator;
 * exhaustive switch sites must include `const _exhaustive: never = state.status`
 * default branches (exhaustive union handling).
 *
 * Lifecycle:
 *   closed --(failureCount ≥ threshold)--> open
 *   open --(now - openedAtMs ≥ cooldownMs)--> half-open
 *   half-open --(probe call success)--> closed
 *   half-open --(probe call failure)--> open (reset openedAtMs)
 *   * --(reconnect success)--> closed (per-generation reset)
 */
export type CircuitState =
  | { readonly status: "closed"; readonly failureCount: number }
  | { readonly status: "open"; readonly failureCount: number; readonly openedAtMs: number; readonly reason?: "auth" }
  | { readonly status: "half-open"; readonly failureCount: number };

/** Configuration for automatic reconnection behavior. */
export interface McpReconnectOptions {
  /** Maximum number of reconnection attempts (default: 5). */
  readonly maxAttempts: number;
  /** Initial backoff delay in milliseconds (default: 1000). */
  readonly initialDelayMs: number;
  /** Maximum backoff delay in milliseconds (default: 30000). */
  readonly maxDelayMs: number;
  /** Backoff growth factor (default: 2). */
  readonly growFactor: number;
}

/** A live connection to an MCP server. */
export interface McpConnection {
  /** Server name matching McpServerConfig.name. */
  readonly name: string;
  /** The underlying MCP SDK client instance. */
  readonly client: Client;
  /** Current connection status. */
  readonly status: McpConnectionStatus;
  /** Tools discovered from this server. */
  readonly tools: McpToolDefinition[];
  /** Timestamp of last successful health check (ms since epoch). */
  readonly lastHealthCheck: number;
  /** Current reconnection attempt number (0 when not reconnecting). */
  readonly reconnectAttempt: number;
  /** Maximum reconnection attempts configured. */
  readonly maxReconnectAttempts: number;
  /** Last error message, if status is "error" or "reconnecting". */
  readonly error?: string;
  /** Server-provided instructions (from client.getInstructions() after connect). */
  readonly instructions?: string;
  /** Server capabilities object (from client.getServerCapabilities() after connect). */
  readonly capabilities?: Record<string, unknown>;
  /** Server info object (from client.getServerVersion() after connect). */
  readonly serverInfo?: { name: string; version: string };
  /** Connection generation counter -- increments on each reconnection. */
  readonly generation: number;
  /**
   * Mirror of the per-server config opt-out for the resources utility tools.
   * Populated from McpServerConfig.enableResources at connect time so the
   * platform-tool registry's capability-gate predicate can honor the opt-out
   * WITHOUT a separate config lookup (the manager surfaces only runtime
   * connections). undefined ⇒ auto-register when capabilities.resources is
   * present; false ⇒ suppress.
   */
  readonly enableResources?: boolean;
  /**
   * Mirror of the per-server config opt-out for the prompts utility tools.
   * Populated from McpServerConfig.enablePrompts at connect time. Same
   * semantics as enableResources but for capabilities.prompts.
   */
  readonly enablePrompts?: boolean;
}

/** A tool definition discovered from an MCP server. */
export interface McpToolDefinition {
  /** Original tool name as reported by the server. */
  readonly name: string;
  /** Qualified name: "mcp:{serverName}/{toolName}" to avoid collisions. */
  readonly qualifiedName: string;
  /** Human-readable description, if provided. */
  readonly description?: string;
  /** JSON Schema describing input parameters. */
  readonly inputSchema: Record<string, unknown>;
}

/** Result of calling an MCP tool. */
export interface McpToolCallResult {
  /** Content items returned by the tool. */
  readonly content: McpToolCallContent[];
  /** Whether the tool call resulted in an error. */
  readonly isError: boolean;
}

/** A content item from an MCP tool call result. */
export interface McpToolCallContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** Dependencies for the MCP client manager. */
export interface McpClientManagerDeps {
  readonly logger: {
    info(msg: string, ...args: unknown[]): void;
    info(obj: Record<string, unknown>, msg: string): void;
    warn(msg: string, ...args: unknown[]): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(msg: string, ...args: unknown[]): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug?(msg: string, ...args: unknown[]): void;
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Interval for health checks in milliseconds. 0 disables health checks. */
  readonly healthCheckIntervalMs?: number;
  /** Timeout for connect + listTools in milliseconds (default: 30000). */
  readonly connectTimeoutMs?: number;
  /** Timeout for individual callTool invocations in milliseconds (default: 60000). */
  readonly callToolTimeoutMs?: number;
  /** Optional EventBus for emitting connection lifecycle events. */
  readonly eventBus?: TypedEventBus;
  /** Reconnection options (default: 5 attempts, 1s-30s backoff). */
  readonly reconnectOptions?: Partial<McpReconnectOptions>;
  /** Default max concurrent tool calls for stdio servers (default: 1). */
  readonly stdioDefaultConcurrency?: number;
  /** Default max concurrent tool calls for HTTP/SSE servers (default: 4). */
  readonly httpDefaultConcurrency?: number;
  /** Default circuit breaker failure threshold. Resolved at factory construction. */
  readonly circuitBreakerThreshold?: number;
  /** Default circuit breaker cooldown (ms). Resolved at factory construction. */
  readonly circuitBreakerCooldownMs?: number;
  /**
   * OAuth integration seam. When present, connectServer constructs an
   * OAuthClientProvider adapter for `auth:"oauth"` servers (token store +
   * deduper), runs the discovery pre-flight, and threads the provider onto
   * the runtime config so createTransport attaches it. When ABSENT, an
   * `auth:"oauth"` server still connects (the SDK runs without a provider) and
   * a 401 still surfaces needs_oauth_login — the adapter is simply not wired.
   * Injected by the daemon composition root (production) or a test.
   */
  readonly oauthDeps?: McpOAuthDeps;
}

/**
 * OAuth integration dependencies. A thin seam so the skills package owns no
 * `~/.comis` path policy or redirect-fetch construction at import time — the
 * daemon composition root supplies these, tests inject mocks.
 */
export interface McpOAuthDeps {
  /**
   * Lazily build the shared disk-backed token store. Called once per connect
   * for an `auth:"oauth"` server. Implementations SHOULD return a process-wide
   * singleton (the chokidar watch + cache are per-store) rather than a fresh
   * store each call.
   */
  readonly createTokenStore: () => TokenStore;
  /**
   * OAuth metadata discovery cascade. Resolves + persists `<server>.meta.json`;
   * throws an actionable `errorKind:"config"` error on total cascade failure.
   * Signature matches `resolveDiscovery`.
   */
  readonly resolveDiscovery: (args: ResolveDiscoveryArgs) => Promise<OAuthDiscoveryState>;
  /**
   * Browser-launch side-effect (`open`). NOT imported in skills/daemon (it is a
   * cli/agent/comis dep) — injected here. connectServer NEVER calls it (the
   * connect path surfaces needs_oauth_login; the operator-initiated oauth_login
   * RPC owns the launch). Held so the adapter + future login wiring share one
   * injection point. Optional: a headless deployment may omit it.
   */
  readonly openUrl?: (url: string) => void | Promise<void>;
}

/** MCP Client Manager: manages connections to MCP servers and their tools. */
export interface McpClientManager {
  /** Connect to an MCP server and discover its tools. */
  connect(config: McpServerConfig): Promise<Result<McpConnection, Error>>;
  /** Disconnect a named server. */
  disconnect(name: string): Promise<void>;
  /** Disconnect all servers. */
  disconnectAll(): Promise<void>;
  /** Get a connection by server name. */
  getConnection(name: string): McpConnection | undefined;
  /** Get all active connections. */
  getAllConnections(): McpConnection[];
  /** Get all tools from all connected servers. */
  getTools(): McpToolDefinition[];
  /** Call a tool by its qualified name ("mcp:{server}/{tool}"). */
  callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<Result<McpToolCallResult, Error>>;
  /** Reconnect a named server using its stored config. */
  reconnect(name: string): Promise<Result<McpConnection, Error>>;
}

// ---------------------------------------------------------------------------
// Closure-state interface
// ---------------------------------------------------------------------------

/**
 * Resolved options shape — defaults applied at factory construction.
 *
 * The factory body resolves all McpClientManagerDeps defaults (connect
 * timeout, callTool timeout, concurrency caps, reconnect options) ONCE
 * at construction time. Helpers read these via state.options instead of
 * re-resolving deps.* each call (matches pre-split behavior).
 */
export interface McpClientManagerOptions {
  readonly connectTimeoutMs: number;
  readonly callToolTimeoutMs: number;
  readonly stdioDefaultConcurrency: number;
  readonly httpDefaultConcurrency: number;
  readonly reconnectOpts: McpReconnectOptions;
  /** Global default consecutive failure threshold before breaker opens. Per-server override on McpServerConfig. */
  readonly circuitBreakerThreshold: number;
  /** Global default cooldown (ms) between open → half-open transitions. Per-server override on McpServerConfig. */
  readonly circuitBreakerCooldownMs: number;
}

/**
 * Closure-captured state shape for the mcp-client manager. The
 * createMcpClientManager factory closure body is split into per-concern
 * leaves; each leaf takes `state: McpClientManagerState` as its first
 * parameter (state-first protocol).
 *
 * @internal — not exported from the package barrel; only consumed by
 * sibling leaves within mcp-client/.
 */
export interface McpClientManagerState {
  /** server-name -> live connection (mutated by connect/disconnect/reconnect/handleDisconnection/reconnectionLoop/callTool). */
  readonly connections: Map<string, McpConnection>;
  /** server-name -> AbortController for in-flight reconnection loops. */
  readonly reconnectionAbortControllers: Map<string, AbortController>;
  /** server-name set marking user-initiated disconnects (suppresses auto-reconnect). */
  readonly userDisconnectedFlags: Set<string>;
  /** server-name -> original McpServerConfig (needed to re-create transport on reconnect). */
  readonly serverConfigs: Map<string, McpServerConfig>;
  /** server-name -> generation counter (increments on each reconnect; used for stale-call detection). */
  readonly generations: Map<string, number>;
  /** server-name -> PQueue serializing tool calls to respect server concurrency limits. */
  readonly callQueues: Map<string, PQueue>;
  /**
   * server-name -> dedicated concurrency-1 keepalive queue, used ONLY when the
   * primary call queue concurrency > 1 (supportsParallelToolCalls mode). The
   * ping body awaits the primary queue's onIdle() before pinging, so a
   * synthetic keepalive can never interleave with parallel tool calls. Lazily
   * created in maybeEnqueueKeepalivePing; torn down (clear + delete) on
   * disconnect and idle-eviction alongside callQueues so it cannot leak across
   * reconnect generations. When primary concurrency === 1 (default/stdio) this
   * map is never populated — the ping shares the primary queue.
   */
  readonly keepaliveQueues: Map<string, PQueue>;
  /** server-name -> consecutive onerror count (absorbed below threshold, triggers reconnect at threshold). */
  readonly consecutiveErrors: Map<string, number>;
  /**
   * server-name -> last-captured stdio stderr buffer (bounded). Written by
   * `wireStderrCapture` as the child emits stderr; read by the connect catch so a
   * stdio "Connection closed" failure surfaces the child's OWN error text (the
   * "why it died") in the returned error + error-state entry, instead of the
   * opaque SDK message alone. Cleared at the start of each connect attempt.
   */
  readonly lastStderr: Map<string, string>;
  /**
   * server-name -> systemSetInterval handle for the keepalive ticker (started
   * on connect, stopped on disconnect).
   *
   * With concurrency === 1 the ticker shares the per-server PQueue with tool
   * calls (stdio single-pipe serialization). With concurrency > 1 the ping
   * routes through the dedicated cc-1 `keepaliveQueues` entry above and waits
   * for primary.onIdle(), so it never interleaves with parallel tool calls.
   * See mcp-client-keepalive.ts.
   */
  readonly keepaliveTickers: Map<string, SystemIntervalHandle>;
  /**
   * server-name -> circuit breaker state. Per-generation — reset to
   * { status: "closed", failureCount: 0 } in reconnectionLoop's success block
   * (mcp-client-reconnect.ts:274).
   */
  readonly circuitBreakers: Map<string, CircuitState>;
  /**
   * server-name -> idle eviction timer handle. Started on connect when
   * idleTtlMs > 0; cleared on disconnect/evict.
   */
  readonly idleEvictionTimers: Map<string, SystemTimeoutHandle>;
  /**
   * server-name -> last successful-call timestamp (ms). resetIdleActivity
   * updates it; the timer compares against it on fire.
   */
  readonly lastActivityMs: Map<string, number>;
  /**
   * expired-access-token -> in-flight refresh shared future (401 dedup; 5s
   * straggler cache). The dedup state lives on the manager — NOT module scope
   * — so concurrent 401s for the same token coalesce into exactly one
   * `refresh_token` POST. Keyed by the EXPIRED access token; an entry is
   * retained for the straggler-cache TTL after it resolves and evicted
   * immediately on a refresh failure (no poisoned future). Managed by
   * `oauth/refresh-deduper.ts`.
   */
  readonly inflightRefreshes: Map<string, Promise<RefreshResult>>;
  /** Resolved options (timeouts, defaults, reconnect opts) computed once at construction time. */
  readonly options: McpClientManagerOptions;
}
