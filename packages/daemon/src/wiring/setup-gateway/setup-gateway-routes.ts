// SPDX-License-Identifier: Apache-2.0
// @allow-throw: gateway routes wiring re-raise; consumed at daemon.ts bootstrap catch boundary.
/**
 * Gateway HTTP routes + server lifecycle orchestrator.
 *
 * Hosts the top-level `setupGateway` orchestrator that composes the rpc
 * + admin leaves: builds the dynamic router (rpc), wires the gateway
 * server (with optional web dashboard), mounts all HTTP routes via
 * `mountGatewayRoutes` (sibling top-level file), and starts the server.
 *
 * NOTE on naming: this leaf is named `setup-gateway-routes.ts` because the
 * concern is HTTP route binding + server lifecycle. The sibling
 * `packages/daemon/src/wiring/setup-gateway-routes.ts` (one directory up)
 * is the older HTTP-route-implementation helper (`mountGatewayRoutes`) —
 * this leaf imports from it via `../setup-gateway-routes.js`.
 *
 * @module
 */

import type { AppContainer, AppConfig } from "@comis/core";
import { systemDateFrom } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, CostTracker } from "@comis/agent";
import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue, createSessionStore } from "@comis/memory";
import type { RpcCall } from "@comis/skills/platform-tools";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  createGatewayServer,
  createTokenStore,
  WsConnectionManager,
  type GatewayServerHandle,
  type TokenClient,
} from "@comis/gateway";
import type { SessionKey } from "@comis/core";
import { mountGatewayRoutes } from "../setup-gateway-routes.js";
import { buildGreetingGenerator } from "./setup-gateway-admin.js";
import { buildRpcAdapterDeps, buildDynamicRouterAndRegister } from "./setup-gateway-rpc.js";
import { buildMcpServerForClient } from "../../api/mcp-server-handlers.js";

// ---------------------------------------------------------------------------
// MCP server dispatch constants
// ---------------------------------------------------------------------------

/**
 * Default per-MCP-client per-tool minute-bucket rate-limit ceiling.
 * 30 calls/min/tool. Per-client override via
 * `gateway.tokens[].mcpClient.toolRateLimit[toolName]`.
 */
const MCP_DEFAULT_TOOL_RATE_LIMIT = 30;

/**
 * Default page size for `resources/read` session.history snapshots. A single
 * bounded page is returned; sessions exceeding this cap surface the last N
 * CONFIRMED messages. The MCP spec allows resources to change between reads
 * (re-reading may return additional messages as outbound delivery completes)
 * -- the bounded page keeps payloads small.
 */
const MCP_RESOURCE_READ_LIMIT = 1000;

/**
 * Mapping from MCP tool name -> daemon RPC method name. Most tools are
 * 1:1 (the MCP tool name IS the RPC method); a small set of tools that
 * compose multiple RPC methods or use dotted method names need explicit
 * entries. The default branch returns the tool name as-is.
 *
 * The mapping is intentionally permissive (returns the tool name when not
 * mapped) -- the security boundary is enforced UPSTREAM by the
 * mcpExportPolicy classification, the registration filter, and the
 * policy re-check. A typo'd tool name reaches the daemon RPC
 * dispatcher which surfaces a structured "Unknown RPC method" error via
 * the dispatch_error wrapping in the callback.
 */
function mcpToolNameToRpcMethod(toolName: string): string {
  switch (toolName) {
    // memory_search -> memory.search_files (the canonical AgentTool wires
    // this via packages/skills/src/platform-tools/tools/memory-search-tool.ts:53).
    case "memory_search":
      return "memory.search_files";
    case "memory_get":
      return "memory.get_file";
    default:
      return toolName;
  }
}

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for gateway setup. */
export interface GatewayDeps {
  /** Bootstrap output (config, eventBus, secretManager, tenantId). */
  container: AppContainer;
  /** Gateway config section (container.config.gateway). */
  gwConfig: AppConfig["gateway"];
  /** Webhooks config section (container.config.webhooks, optional). */
  webhooksConfig?: AppConfig["webhooks"];
  /** Agent configuration map (container.config.agents). */
  agents: AppConfig["agents"];
  /** Default agent ID for fallback routing. */
  defaultAgentId: string;
  /** Active config file paths for gateway.status RPC. */
  configPaths: string[];
  /** Default config file paths for config.read RPC. */
  defaultConfigPaths: string[];
  /** Gateway-scoped logger. */
  gatewayLogger: ComisLogger;
  /** Embedding queue for async embedding after memory store (optional). */
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  /** Memory adapter for storing conversation turns. */
  memoryAdapter: SqliteMemoryAdapter;
  /** Memory API for search/inspect RPC adapter methods. */
  memoryApi: MemoryApi;
  /** Cached embedding port for OpenAI embeddings route. */
  cachedPort: unknown;
  /** Session store for history/slash command RPC adapter methods. */
  sessionStore: ReturnType<typeof createSessionStore>;
  /** Resolver for per-agent executors. */
  getExecutor: (agentId: string) => AgentExecutor;
  /** Assembles the three-tier tool pipeline for an agent. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  /** Preprocesses message text (link understanding, etc.). */
  preprocessMessageText: (text: string) => Promise<string>;
  /** RPC call dispatcher for session/cron bridge methods. */
  rpcCall: RpcCall;
  /** Per-agent cost trackers for /usage and /status cost wiring. */
  costTrackers: Map<string, CostTracker>;
  /** Per-agent workspace directory paths (for /context bootstrap info). */
  workspaceDirs: Map<string, string>;
  /** Override createGatewayServer from DaemonOverrides pattern. */
  _createGatewayServer: typeof createGatewayServer;
  /** Daemon instance fingerprint -- passed to /health and /api/health so
   *  external clients can confirm which daemon they are reaching when
   *  multiple listeners may be bound to the same local port. */
  instanceId: string;
  /** Daemon startup timestamp (ms since epoch) -- surfaced as ISO on /health. */
  startupStartMs: number;
  /** Per-agent JSONL session adapters for pi-executor /new /reset /status commands. */
  piSessionAdapters?: Map<string, {
    destroySession(key: SessionKey): Promise<void>;
    getSessionStats(key: SessionKey): {
      messageCount: number;
      createdAt?: number;
      tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      cost?: number;
      userMessages?: number;
      assistantMessages?: number;
      toolCalls?: number;
      toolResults?: number;
    } | undefined;
  }>;
  /** Pre-resolved gateway tokens with secrets (config -> env -> auto-generated).
   *  Optional `mcpClient` block survives resolution so the
   *  TokenStore can surface it on verified TokenClient instances. */
  resolvedTokens: Array<{
    id: string;
    secret: string;
    scopes: string[];
    mcpClient?: {
      allowlist: string[];
      sessionAllowlist: string[];
      toolRateLimit: Record<string, number>;
    };
  }>;
  /** Daemon package version (read once from packages/daemon/package.json at
   *  bootstrap). Advertised as MCP `serverInfo.version`. */
  daemonVersion: string;
  /** 154-03: trust-flag-FREE obs.explain assembler closure for the
   *  operator-allowlisted `obs_explain` MCP tool. Built at the composition root
   *  over the obsStore + dataDir; threaded into `buildMcpServerForClient` so the
   *  obs_explain dispatch branch invokes it DIRECTLY under daemon authority
   *  (NOT `daemonRpcForMcpClient` → the admin-gated RPC; NO admin trust). Its
   *  boundary is the per-client `mcpClient.allowlist` + the digest-only report.
   *  Optional — an obsStore-less boot leaves it undefined and the dispatch
   *  branch fails closed with a generic dispatch_error sentinel. */
  obsExplainForMcpClient?: (params: Record<string, unknown>) => Promise<unknown>;
  /** 161-02: trust-flag-FREE obs.fleet.health assembler closure for the
   *  operator-allowlisted `obs_fleet_health` MCP tool — the cross-session fleet
   *  sibling of `obsExplainForMcpClient`. Built at the composition root over the
   *  obsStore + dataDir + boot.clock; threaded into `buildMcpServerForClient` so
   *  the obs_fleet_health dispatch branch invokes it DIRECTLY under daemon
   *  authority (NOT `daemonRpcForMcpClient` → the admin-gated RPC; NO admin
   *  trust). Its boundary is the per-client `mcpClient.allowlist` + the
   *  digest-only report. Optional — an obsStore-less boot leaves it undefined and
   *  the dispatch branch fails closed with a generic dispatch_error sentinel. */
  obsFleetHealthForMcpClient?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Set of suspended agent IDs for REST API status reporting. */
  suspendedAgents?: ReadonlySet<string>;
  /** Interactive-callback wiring (73-10): the single-use email approval-token map
   *  + resolver mounted at `ALL /approve/:token`. Built in the agents phase;
   *  optional (absent when no channels / approvals path). */
  interactiveCallbackWiring?: import("../setup-interactive-callback.js").InteractiveCallbackWiring;
}

/** All services produced by the gateway setup. */
export interface GatewayResult {
  /** Gateway server handle (undefined when gateway is disabled). */
  gatewayHandle?: GatewayServerHandle;
  /** In-flight execution tracker needed by setupShutdown. */
  activeExecutions: Map<string, { agentId: string; startedAt: number }>;
  /** Get the current number of active WebSocket connections. */
  getActiveConnectionCount: () => number;
  /** WebSocket connection manager for sending notifications to clients. */
  wsConnections: WsConnectionManager;
}

// ---------------------------------------------------------------------------
// Setup function (top-level orchestrator)
// ---------------------------------------------------------------------------

/**
 * Set up the gateway server: RPC adapters, dynamic method router, webhooks,
 * OpenAI-compatible routes, and server start.
 * @param deps - Gateway dependencies (all services the gateway block needs)
 * @returns Gateway handle and active execution tracker
 */
export async function setupGateway(deps: GatewayDeps): Promise<GatewayResult> {
  const {
    container,
    gwConfig,
    webhooksConfig,
    agents,
    defaultAgentId,
    configPaths,
    gatewayLogger,
    embeddingQueue: _embeddingQueue,
    memoryAdapter: _memoryAdapter,
    memoryApi,
    cachedPort,
    sessionStore,
    getExecutor,
    assembleToolsForAgent,
    preprocessMessageText,
    rpcCall,
    costTrackers,
    workspaceDirs,
    _createGatewayServer,
    piSessionAdapters,
    instanceId,
    startupStartMs,
  } = deps;

  // Track in-flight gateway executions for shutdown observability
  const activeExecutions = new Map<string, { agentId: string; startedAt: number }>();

  if (!gwConfig.enabled) {
    return { gatewayHandle: undefined, activeExecutions, getActiveConnectionCount: () => 0, wsConnections: new WsConnectionManager() };
  }

  // Use pre-resolved tokens (with secrets from config/env/auto-gen)
  const tokensForStore = deps.resolvedTokens;
  const tokenStore = createTokenStore(tokensForStore);
  const wsConnections = new WsConnectionManager();

  // Create greeting generator for LLM-powered session reset messages
  const greetingGenerator = buildGreetingGenerator({ agents, defaultAgentId, container });

  // Create RPC adapter deps wired to real memory and agent services.
  const rpcAdapterDeps = buildRpcAdapterDeps({
    container,
    gwConfig,
    agents,
    defaultAgentId,
    gatewayLogger,
    memoryApi,
    sessionStore,
    getExecutor,
    assembleToolsForAgent,
    preprocessMessageText,
    rpcCall,
    costTrackers,
    workspaceDirs,
    piSessionAdapters,
    greetingGenerator,
    activeExecutions,
    _memoryAdapter,
  });

  const dynamicRouter = buildDynamicRouterAndRegister({
    rpcAdapterDeps,
    container,
    configPaths,
    rpcCall,
    gatewayLogger,
  });

  const rpcServer = dynamicRouter.server;

  // Resolve web dist path relative to daemon package
  // setup-gateway-routes.ts is in wiring/setup-gateway/ subdir, so go up 4 levels:
  // wiring/setup-gateway/ -> wiring/ -> src/ -> daemon/ -> web/dist
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDistPath = resolve(__dirname, "../../../../web/dist");
  const webEnabled = gwConfig.web.enabled;

  let webDeps: Parameters<typeof _createGatewayServer>[0]["webDeps"] | undefined;
  if (webEnabled) {
    const distExists = existsSync(webDistPath);
    if (distExists) {
      gatewayLogger.info(
        { webEnabled: true, url: `http://${gwConfig.host}:${gwConfig.port}/app/` },
        "Web dashboard mounted",
      );
      webDeps = {
        eventBus: container.eventBus,
        rpcAdapterDeps,
        webDistPath,
        suspendedAgents: deps.suspendedAgents,
      };
    } else {
      gatewayLogger.error(
        {
          hint: "Reinstall comisai or run 'pnpm --filter @comis/web build'. @comis/web dist directory must exist for the dashboard to mount.",
          errorKind: "config" as const,
          webDistPath,
        },
        "gateway.web.enabled=true but @comis/web dist is missing",
      );
      // Still wire /api + SSE + root redirect so users get a structured 404
      // from the SPA fallback rather than a silent "gateway is down" — but
      // omit webDistPath so serveStatic (and its raw Hono warning) never runs.
      webDeps = {
        eventBus: container.eventBus,
        rpcAdapterDeps,
        webDistPath: undefined,
        suspendedAgents: deps.suspendedAgents,
      };
    }
  } else {
    gatewayLogger.debug({ webEnabled: false }, "Web dashboard disabled");
  }

  // Per-client MCP server factory. Built once at gateway-setup time and
  // threaded into createGatewayServer so the Hono app mounts POST /mcp/v1
  // between rate-limit and the notFound catch-all. The factory closes over
  // `daemonVersion` (advertised as serverInfo.version), `gatewayLogger`, the
  // trust-flag-isolated `daemonRpcForMcpClient` indirection, the default tool
  // rate-limit ceiling, and the tool-name-to-RPC-method mapping.
  //
  // SECURITY -- `daemonRpcForMcpClient` is the indirection that NEVER
  // injects `_trustLevel:"admin"`. The composition root wires it to the
  // SAME `rpcCall` the LLM-side uses, but WITHOUT spreading the admin
  // trust flag (compare to setup-gateway-api.ts:80-98 which DOES spread
  // _trustLevel:"admin" for admin-scoped contracts). Even though the
  // mcpExportPolicy classification of all admin tools as `never-export`
  // means admin RPC methods are never registered on the McpServer in the
  // first place, this indirection is the belt-and-suspenders enforcer.
  const daemonRpcForMcpClient = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => rpcCall(method, params);

  const buildMcpServerForClientFactory = (client: TokenClient) =>
    buildMcpServerForClient(
      {
        logger: gatewayLogger,
        daemonVersion: deps.daemonVersion,
        daemonRpcForMcpClient,
        defaultToolRateLimit: MCP_DEFAULT_TOOL_RATE_LIMIT,
        toolNameToRpcMethod: mcpToolNameToRpcMethod,
        resourceReadLimit: MCP_RESOURCE_READ_LIMIT,
        // 154-03: obs_explain runs THIS directly under daemon authority — it is
        // NOT wired to mcpToolNameToRpcMethod / daemonRpcForMcpClient (it has its
        // own dispatch branch). The never-inject-admin indirection above is
        // untouched.
        obsExplainForMcpClient: deps.obsExplainForMcpClient,
        // 161-02: obs_fleet_health — same direct-assembler posture as obs_explain
        // (its own dispatch branch; NOT mcpToolNameToRpcMethod / daemonRpcForMcpClient).
        obsFleetHealthForMcpClient: deps.obsFleetHealthForMcpClient,
      },
      client,
    );

  const gatewayHandle = _createGatewayServer({
    config: gwConfig,
    logger: gatewayLogger,
    tokenStore,
    rpcServer,
    wsConnections,
    ...(webDeps && { webDeps }),
    fingerprint: {
      instanceId,
      startedAt: systemDateFrom(startupStartMs).toISOString(),
    },
    buildMcpServerForClient: buildMcpServerForClientFactory,
  });

  // Mount all HTTP routes (webhooks, media, OpenAI-compatible API)
  mountGatewayRoutes({
    gatewayHandle,
    webhooksConfig,
    container,
    defaultAgentId,
    agents,
    gatewayLogger,
    gwConfig,
    tokenStore,
    getExecutor,
    assembleToolsForAgent,
    preprocessMessageText,
    cachedPort,
    workspaceDirs,
    defaultWorkspaceDir: workspaceDirs.get(defaultAgentId),
    interactiveCallbackWiring: deps.interactiveCallbackWiring,
  });

  await gatewayHandle.start();
  gatewayLogger.debug({ host: gwConfig.host, port: gwConfig.port }, "Gateway server started");

  return { gatewayHandle, activeExecutions, getActiveConnectionCount: () => wsConnections.size, wsConnections };
}
