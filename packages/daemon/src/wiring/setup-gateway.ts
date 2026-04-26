// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway setup: RPC bridge (deferred dispatch), RPC adapter wiring, dynamic
 * method registration, webhook mounting, OpenAI-compatible route mounting,
 * and gateway server creation/start.
 * Extracted from daemon.ts to isolate the single
 * largest inline block from the main wiring sequence. Covers the full
 * gateway lifecycle from RPC bridge creation through server start.
 * @module
 */

import type { NormalizedMessage, SessionKey, MemoryEntry, AppContainer, AppConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { CommandHandlerDeps, CommandDirectives, AgentExecutor, CostTracker } from "@comis/agent";
import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue, createSessionStore } from "@comis/memory";
import type { RpcCall } from "@comis/skills";
import { registerRpcMethods } from "./setup-gateway-rpc.js";
import { mountGatewayRoutes } from "./setup-gateway-routes.js";

import {
  formatSessionKey,
  runWithContext,
  safePath,
  createDeliveryOrigin,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { readFileSync, existsSync } from "node:fs";
import {
  parseSlashCommand,
  createCommandHandler,
  createGreetingGenerator,
  type GreetingGenerator,
} from "@comis/agent";
import {
  createGatewayServer,
  createDynamicMethodRouter,
  createRpcAdapters,
  createTokenStore,
  WsConnectionManager,
  type GatewayServerHandle,
  type RpcAdapterDeps,
} from "@comis/gateway";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcDispatchDeps } from "../rpc/rpc-dispatch.js";
import { createRpcDispatch, classifyRpcError } from "../rpc/rpc-dispatch.js";

// ===========================================================================
// Execution-request log redaction helper
// ===========================================================================

/**
 * Build the structured log fields for the gateway "Agent execution requested"
 * INFO line. Replaces the previous behavior of logging the first 200 chars
 * of the raw user message, which violated AGENTS.md §2.2 (no message bodies
 * in logs at any level). Emits message length plus a short SHA-256 prefix
 * for correlation, never the body itself.
 *
 * @param input.agentId       Resolved agent ID (already trust-derived).
 * @param input.message       Raw user message (may be empty / undefined).
 * @param input.connectionId  Optional WebSocket connection ID.
 * @returns Object suitable for `logger.info(obj, "Agent execution requested")`.
 */
export function buildExecutionRequestedLogFields(input: {
  agentId: string;
  message: string | undefined;
  connectionId: string | undefined;
}): {
  agentId: string;
  messageLen: number;
  messageHash?: string;
  connectionId?: string;
} {
  const raw = input.message ?? "";
  const fields: {
    agentId: string;
    messageLen: number;
    messageHash?: string;
    connectionId?: string;
  } = {
    agentId: input.agentId,
    messageLen: raw.length,
  };
  if (raw.length > 0) {
    fields.messageHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  }
  if (input.connectionId !== undefined) {
    fields.connectionId = input.connectionId;
  }
  return fields;
}

// ===========================================================================
// RPC Bridge (deferred dispatch wiring)
// ===========================================================================

/** All services produced by the RPC bridge setup phase. */
export interface RpcBridgeResult {
  /** The rpcCall function usable immediately (delegates to inner dispatch once wired). */
  rpcCall: RpcCall;
  /** Call after setupMonitoring to wire the real dispatch with all deps including heartbeatRunner. */
  wireDispatch: (deps: RpcDispatchDeps) => void;
}

/**
 * Create the rpcCall wrapper and deferred dispatch mechanism.
 * The returned rpcCall can be passed to setupTools immediately. After
 * setupMonitoring resolves the heartbeatRunner TDZ, call wireDispatch()
 * with the full RpcDispatchDeps to wire the real dispatch function.
 * @param deps.gatewayLogger - Logger for RPC call tracing
 * @returns rpcCall function and wireDispatch callback
 */
export function setupRpcBridge(deps: {
  gatewayLogger: ComisLogger;
}): RpcBridgeResult {
  const { gatewayLogger } = deps;

  // Deferred inner dispatch -- assigned by wireDispatch() after all deps are ready
  let rpcCallInner: RpcCall;

  const rpcCall: RpcCall = async (method, params) => {
    const rpcStartMs = Date.now();
    try {
      return await rpcCallInner(method, params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const classified = classifyRpcError(errMsg);
      gatewayLogger.debug({
        method,
        err: errMsg,
        durationMs: Date.now() - rpcStartMs,
        hint: classified.hint,
        errorKind: classified.errorKind,
      }, "[rpcCall] failed");
      throw err;
    }
  };

  const wireDispatch = (dispatchDeps: RpcDispatchDeps): void => {
    rpcCallInner = createRpcDispatch(dispatchDeps);
  };

  return { rpcCall, wireDispatch };
}

// ---------------------------------------------------------------------------
// Attachment marker extraction from pi-agent JSONL sessions
// ---------------------------------------------------------------------------

interface AttachmentMarker {
  content: string;
  timestamp: number;
}

/**
 * Read the pi-agent JSONL session file and extract gateway attachment markers.
 * Returns `<!-- attachment:... -->` content strings for each successful
 * `message.attach` tool call targeting the gateway channel type.
 */
function extractAttachmentMarkers(
  workspaceDir: string | undefined,
  agentId: string,
  channelId: string,
  logger: { debug(obj: Record<string, unknown>, msg: string): void },
): AttachmentMarker[] {
  if (!workspaceDir) return [];
  const jsonlPath = join(workspaceDir, "sessions", agentId, channelId, "default.jsonl");
  if (!existsSync(jsonlPath)) return [];

  try {
    const raw = readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Collect attachment tool calls (toolCall blocks with name "message", action "attach")
    const attachCalls = new Map<string, { type: string; mimeType: string; fileName: string; caption: string }>();
    const attachResults = new Map<string, string>(); // toolCallId → mediaId

    for (const obj of parsed) {
      if (obj.type !== "message") continue;
      const msg = obj.message;
      if (!msg) continue;

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block.type === "toolCall" || block.type === "tool_use") && block.name === "message") {
            const args = block.arguments ?? block.input;
            if (args?.action === "attach" && args?.channel_type === "gateway") {
              attachCalls.set(block.id, {
                type: (args.attachment_type as string) ?? "file",
                mimeType: (args.mime_type as string) ?? "application/octet-stream",
                fileName: (args.file_name as string) ?? "attachment",
                caption: (args.caption as string) ?? "",
              });
            }
          }
        }
      }

      if (msg.role === "toolResult" || msg.role === "tool") {
        const toolId = msg.toolCallId ?? msg.tool_use_id;
        if (toolId && attachCalls.has(toolId)) {
          let resultText = "";
          if (typeof msg.content === "string") resultText = msg.content;
          else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && typeof part.text === "string") resultText += part.text;
            }
          }
          try {
            const result = JSON.parse(resultText);
            if (typeof result.messageId === "string") {
              attachResults.set(toolId, result.messageId);
            }
          } catch { /* skip */ }
        }
      }
    }

    // Build markers for resolved attachments
    const markers: AttachmentMarker[] = [];
    for (const [toolId, mediaId] of attachResults) {
      const att = attachCalls.get(toolId)!;
      const url = `/media/${mediaId}`;
      const json = JSON.stringify({ url, type: att.type, mimeType: att.mimeType, fileName: att.fileName });
      const marker = att.caption
        ? `${att.caption}\n\n<!-- attachment:${json} -->`
        : `<!-- attachment:${json} -->`;
      markers.push({ content: marker, timestamp: Date.now() });
    }

    if (markers.length > 0) {
      logger.debug({ agentId, channelId, count: markers.length }, "Extracted attachment markers from JSONL session");
    }
    return markers;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trust level derivation
// ---------------------------------------------------------------------------

/**
 * Derive user trust level from token scopes.
 * Admin scope or wildcard grants admin trust. All others default to user
 * (fail-closed). This matches the checkScope wildcard behavior in token-auth.ts.
 */
export function deriveTrustLevel(scopes: readonly string[] | undefined): "admin" | "user" {
  if (scopes?.includes("admin") || scopes?.includes("*")) return "admin";
  return "user";
}

// ---------------------------------------------------------------------------
// /config chat command handler
// ---------------------------------------------------------------------------

/**
 * Handle /config chat command via RPC dispatch.
 * Supports: show [section], set <path> <value>, history
 */
export async function handleConfigChatCommand(
  args: string[],
  rpcCall: RpcCall,
  scopes?: readonly string[],
): Promise<{ handled: boolean; response?: string }> {
  const subcommand = args[0] ?? "show";

  try {
    // Trust gate: config read operations require admin trust
    if (subcommand === "show" || subcommand === "history") {
      const trustLevel = deriveTrustLevel(scopes);
      if (trustLevel !== "admin") {
        return {
          handled: true,
          response: "Config read requires admin trust. Your token does not have admin scope.",
        };
      }
    }

    if (subcommand === "show") {
      const section = args[1];
      const result = await rpcCall("config.read", { section }) as Record<string, unknown>;
      if (section) {
        // Format single section as key: value pairs
        const lines = [`**Config: ${section}**`, ""];
        for (const [key, value] of Object.entries(result)) {
          const display = typeof value === "object" ? JSON.stringify(value) : String(value);
          lines.push(`${key}: ${display}`);
        }
        return { handled: true, response: lines.join("\n") };
      }
      // Full config: list sections with key counts
      const config = result.config as Record<string, unknown>;
      const sections = result.sections as string[];
      const lines = ["**Config Sections**", ""];
      for (const sec of sections) {
        const sectionData = config[sec];
        const keyCount = sectionData && typeof sectionData === "object" ? Object.keys(sectionData).length : 0;
        lines.push(`${sec} (${keyCount} keys)`);
      }
      return { handled: true, response: lines.join("\n") };
    }

    if (subcommand === "set") {
      // Trust gate: only admin trust can modify config
      const trustLevel = deriveTrustLevel(scopes);
      if (trustLevel !== "admin") {
        return { handled: true, response: "Config modification requires admin trust. Your token does not have admin scope." };
      }

      const path = args[1];
      const rawValue = args.slice(2).join(" ");
      if (!path || !rawValue) {
        return { handled: true, response: "Usage: /config set <section.key> <value>" };
      }
      const dotIdx = path.indexOf(".");
      if (dotIdx === -1) {
        return { handled: true, response: "Path must include section.key (e.g., agent.budget.maxTokens)" };
      }
      const section = path.slice(0, dotIdx);
      const key = path.slice(dotIdx + 1);
      let value: unknown;
      try { value = JSON.parse(rawValue); } catch { value = rawValue; }

      const patchResult = await rpcCall("config.patch", { section, key, value, _trustLevel: trustLevel }) as Record<string, unknown>;
      if (patchResult.patched) {
        return { handled: true, response: `Config updated: ${path} = ${JSON.stringify(value)}. Daemon is restarting.` };
      }
      return { handled: true, response: "Config update failed" };
    }

    if (subcommand === "history") {
      const result = await rpcCall("config.history", { limit: 5 }) as { entries: Array<{ sha: string; date: string; message: string }>; error?: string };
      if (result.error) {
        return { handled: true, response: result.error };
      }
      if (!result.entries || result.entries.length === 0) {
        return { handled: true, response: "No config history found" };
      }
      const lines = ["**Config History**", ""];
      for (const entry of result.entries) {
        const sha = entry.sha.slice(0, 7);
        const date = new Date(entry.date).toLocaleString();
        lines.push(`${sha} | ${date} | ${entry.message}`);
      }
      return { handled: true, response: lines.join("\n") };
    }

    return { handled: true, response: `Unknown config subcommand: ${subcommand}. Available: show, set, history` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handled: true, response: `Config command failed: ${msg}` };
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
  assembleToolsForAgent: (agentId: string, options?: import("./setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
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
  /** Pre-resolved gateway tokens with secrets (config -> env -> auto-generated). */
  resolvedTokens: Array<{ id: string; secret: string; scopes: string[] }>;
  /** Set of suspended agent IDs for REST API status reporting. */
  suspendedAgents?: ReadonlySet<string>;
}

/** All services produced by the gateway setup phase. */
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
// Setup function
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
  let greetingGenerator: GreetingGenerator | undefined;
  const defaultConfig = agents[defaultAgentId];
  if (defaultConfig) {
    const greetingApiKey = container.secretManager.get(`${defaultConfig.provider.toUpperCase()}_API_KEY`) ?? "";
    if (greetingApiKey) {
      greetingGenerator = createGreetingGenerator({
        provider: defaultConfig.provider,
        modelId: defaultConfig.model,
        apiKey: greetingApiKey,
        timeoutMs: 5000,
      });
    }
  }

  // Create RPC adapter deps wired to real memory and agent services.
  const rpcAdapterDeps: RpcAdapterDeps = {
    isValidAgentId: (agentId: string) => !!agents[agentId],
    executeAgent: async (params) => {
      // Resolve agent ID from params or default
      const requestedAgentId = (params as Record<string, unknown>).agentId as string | undefined ?? defaultAgentId;
      // Fall back to default agent if the requested agent is unknown (getExecutor also falls back)
      const execAgentId = agents[requestedAgentId] ? requestedAgentId : defaultAgentId;
      const connectionId = (params as Record<string, unknown>).connectionId as string | undefined;

      // Derive trust level from token scopes.
      // Admin scope or wildcard -> admin trust; otherwise -> user trust (fail-closed).
      const trustLevel = deriveTrustLevel(params.scopes);
      gatewayLogger.debug(
        { scopes: params.scopes, trustLevel, agentId: execAgentId },
        "Trust level derived from token scopes"
      );
      gatewayLogger.info(
        buildExecutionRequestedLogFields({
          agentId: execAgentId,
          message: params.message,
          connectionId,
        }),
        "Agent execution requested",
      );

      // Link understanding preprocessing: enrich message text with fetched URL content
      const enrichedText = await preprocessMessageText(params.message);

      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: params.sessionKey?.channelId ?? "gateway",
        channelType: "gateway",
        senderId: params.sessionKey?.peerId ?? "rpc-client",
        text: enrichedText,
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      };
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: params.sessionKey?.userId ?? "rpc-client",
        channelId: params.sessionKey?.channelId ?? "gateway",
      };

      // Wrap in runWithContext so traceId propagates to all downstream logs
      return runWithContext({
        traceId: randomUUID(),
        tenantId: sk.tenantId,
        userId: sk.userId,
        sessionKey: formatSessionKey(sk),
        startedAt: Date.now(),
        trustLevel,
        deliveryOrigin: createDeliveryOrigin({
          channelType: "gateway",
          channelId: sk.channelId,
          userId: sk.userId,
          tenantId: sk.tenantId,
        }),
      }, async () => {
      // Assemble per-agent tools via three-tier pipeline (builtin + platform + skills)
      const tools = await assembleToolsForAgent(execAgentId);
      gatewayLogger.debug({ agentId: execAgentId, toolCount: tools.length, ...(connectionId && { connectionId }) }, "Tools assembled for agent");
      const execStartMs = Date.now();
      const execKey = msg.id;
      activeExecutions.set(execKey, { agentId: execAgentId, startedAt: execStartMs });
      let result;
      try {
      result = await getExecutor(execAgentId).execute(msg, sk, tools, params.onDelta, execAgentId, params.directives as CommandDirectives | undefined);
      } finally {
        activeExecutions.delete(execKey);
      }
      gatewayLogger.debug({
        agentId: execAgentId,
        durationMs: Date.now() - execStartMs,
        tokensIn: result.tokensUsed.input,
        tokensOut: result.tokensUsed.output,
        tokensTotal: result.tokensUsed.total,
        finishReason: result.finishReason,
        responseLen: result.response?.length ?? 0,
        toolCalls: result.stepsExecuted,
        llmCalls: result.llmCalls,
        sessionKey: formatSessionKey(sk),
        estimatedCostUsd: result.cost.total,
        ...(connectionId && { connectionId }),
      }, "Agent execution complete");

      // Bridge session history: persist conversation turn to SQLite sessionStore
      // so that session.history RPC and REST /chat/history can read it.
      // Also extract gateway attachment tool calls from the JSONL session so
      // that images/files persist across page navigations.
      try {
        const existingSession = sessionStore.load(sk);
        const messages: unknown[] = existingSession?.messages ?? [];
        messages.push({ role: "user", content: msg.text, timestamp: msg.timestamp });

        // Extract attachment markers from JSONL session (if available)
        const attachmentMarkers = extractAttachmentMarkers(
          workspaceDirs.get(execAgentId),
          execAgentId,
          sk.channelId,
          gatewayLogger,
        );

        // Deduplicate: only insert markers whose /media/ URL is not already in existing messages
        const existingText = messages.map((m) => (m as Record<string, unknown>).content ?? "").join("\n");
        for (const marker of attachmentMarkers) {
          // Extract the /media/... URL from the marker to check for duplicates
          const urlMatch = marker.content.match(/\/media\/[^"]+/);
          if (urlMatch && (existingText as string).includes(urlMatch[0])) continue;
          messages.push({ role: "assistant", content: marker.content, timestamp: marker.timestamp });
        }

        if (result.response) {
          messages.push({ role: "assistant", content: result.response, timestamp: Date.now() });
        }
        sessionStore.save(sk, messages);
        gatewayLogger.debug(
          { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length, attachments: attachmentMarkers.length },
          "Session history bridged to SQLite store",
        );
      } catch {
        // Session history bridging is non-fatal
      }

      // Token usage now captured by tokenTracker's bus subscription (quick-138):
      // PiEventBridge emits observability:token_usage at turn_end -> tokenTracker
      // bus handler stores it. No direct record() call needed here.

      // Conversation memory persistence now handled by PiExecutor

      // Emit message events for activity tracking (REST/WebSocket parity with channels)
      container.eventBus.emit("message:received", { message: msg, sessionKey: sk });
      if (result.response) {
        container.eventBus.emit("message:sent", {
          channelId: sk.channelId,
          messageId: randomUUID(),
          content: result.response,
        });
      }

      return {
        response: result.response,
        tokensUsed: result.tokensUsed,
        finishReason: result.finishReason,
        sessionKey: params.sessionKey?.channelId ?? "gateway",
      };
      });
    },
    searchMemory: async (params) => {
      const results = await memoryApi.search(params.query, {
        limit: params.limit,
        tenantId: params.tenantId ?? container.config.tenantId,
      });
      return {
        results: results.map((r) => ({
          id: r.entry.id,
          content: r.entry.content,
          memoryType: (r.entry as MemoryEntry & { memoryType?: string }).memoryType ?? "semantic",
          trustLevel: r.entry.trustLevel,
          score: r.score ?? 0,
          createdAt: r.entry.createdAt,
        })),
      };
    },
    inspectMemory: async (params) => {
      if (params.id) {
        const entries = memoryApi.inspect({ limit: 1 });
        const entry = entries.find((e) => e.id === params.id);
        return {
          entry: entry
            ? {
                id: entry.id,
                content: entry.content,
                trustLevel: entry.trustLevel,
                createdAt: entry.createdAt,
              }
            : undefined,
        };
      }
      const stats = memoryApi.stats(params.tenantId ?? container.config.tenantId);
      return { stats: stats as unknown as Record<string, unknown> };
    },
    getConfig: async (params) => {
      // Return sanitized config (no secrets)
      const section = params?.section;
      if (section && section in container.config) {
        return { [section]: container.config[section as keyof typeof container.config] };
      }
      return {
        tenantId: container.config.tenantId,
        logLevel: container.config.logLevel,
        gateway: { enabled: gwConfig.enabled, host: gwConfig.host, port: gwConfig.port },
      };
    },
    getSessionHistory: async (params) => {
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: "rpc-client",
        channelId: params.channelId ?? "gateway",
      };
      const data = sessionStore.load(sk);
      if (!data) {
        return { messages: [] };
      }
      // Extract user/assistant messages from pi-agent-core format
      const messages: Array<{ role: string; content: string; timestamp: number }> = [];
      for (const msg of data.messages) {
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;
        if (role !== "user" && role !== "assistant") continue;
        // Extract text content from content array or string
        let text = "";
        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const part of m.content as Array<Record<string, unknown>>) {
            if (part.type === "text" && typeof part.text === "string") {
              text += part.text;
            }
          }
        }
        if (text) {
          messages.push({
            role,
            content: text,
            timestamp: (m.timestamp as number) ?? data.updatedAt,
          });
        }
      }
      return { messages };
    },
    setConfig: async (params) => {
      // Forward to config.patch RPC handler (handles validation, rate limiting, persistence)
      const result = await rpcCall("config.patch", {
        section: params.section,
        key: params.key,
        value: params.value,
        _trustLevel: "admin",
      }) as Record<string, unknown>;
      return { ok: result.ok !== false, previous: result.previous as unknown };
    },
    handleSlashCommand: async (params) => {
      const execAgentId = params.agentId ?? defaultAgentId;
      const execAgentConfig = agents[execAgentId] ?? agents[defaultAgentId];
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: params.sessionKey?.userId ?? "rpc-client",
        channelId: params.sessionKey?.channelId ?? "gateway",
      };

      const parsed = parseSlashCommand(params.message);
      if (!parsed.found) return { handled: false };

      // Handle /config command
      if (parsed.command === "config") {
        return handleConfigChatCommand(parsed.args, rpcCall, params.scopes);
      }

      // getAvailableThinkingLevels is intentionally not provided here: at RPC gateway
      // time no AgentSession exists yet (created inside executor). Command-handler falls
      // back to hardcoded set for pre-session validation. SDK-native clamping happens
      // post-session via session.setThinkingLevel() in the executor.
      const cmdDeps: CommandHandlerDeps = {
        getSessionInfo: (key) => {
          const adapter = piSessionAdapters?.get(execAgentId);
          if (adapter) {
            const stats = adapter.getSessionStats(key);
            return {
              messageCount: stats?.messageCount ?? 0,
              createdAt: stats?.createdAt,
              tokensUsed: stats?.tokens,
            };
          }
          return { messageCount: 0 };
        },
        getAgentConfig: () => ({
          name: execAgentConfig?.name ?? "Unknown",
          model: execAgentConfig?.model ?? "unknown",
          provider: execAgentConfig?.provider ?? "unknown",
          maxSteps: execAgentConfig?.maxSteps ?? 10,
        }),
        destroySession: (key) => {
          const adapter = piSessionAdapters?.get(execAgentId);
          if (adapter) {
            suppressError(adapter.destroySession(key), "fire-and-forget session destroy");
            container.eventBus.emit("session:expired", { sessionKey: key, reason: "gateway-reset" });
            return;
          }
        },
        getAvailableModels: () => [],
        getUsageBreakdown: () => {
          const tracker = costTrackers.get(execAgentId) ?? costTrackers.get(defaultAgentId);
          return tracker?.getByProvider() ?? [];
        },
        getSessionCost: (key) => {
          const tracker = costTrackers.get(execAgentId) ?? costTrackers.get(defaultAgentId);
          return tracker?.getBySession(formatSessionKey(key)) ?? { totalTokens: 0, totalCost: 0 };
        },
        getBootstrapInfo: () => {
          const wsDir = workspaceDirs.get(execAgentId);
          if (!wsDir) return [];
          const NAMES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
          const results: Array<{ name: string; sizeChars: number }> = [];
          for (const name of NAMES) {
            try {
              const filePath = safePath(wsDir, name);
              const content = readFileSync(filePath, "utf-8");
              results.push({ name, sizeChars: content.length });
            } catch { /* file missing, skip */ }
          }
          return results;
        },
        getToolInfo: () => {
          // Tool schemas are assembled async; not available synchronously here.
          // Return empty — /context will show "Tool schemas: Not available".
          return [];
        },
        getSDKSessionStats: (key) => {
          const adapter = piSessionAdapters?.get(execAgentId);
          if (!adapter) return undefined;
          const stats = adapter.getSessionStats(key);
          if (!stats) return undefined;
          return {
            userMessages: stats.userMessages ?? 0,
            assistantMessages: stats.assistantMessages ?? 0,
            toolCalls: stats.toolCalls ?? 0,
            toolResults: stats.toolResults ?? 0,
            totalMessages: stats.messageCount,
            tokens: {
              input: stats.tokens?.input ?? 0,
              output: stats.tokens?.output ?? 0,
              cacheRead: stats.tokens?.cacheRead ?? 0,
              cacheWrite: stats.tokens?.cacheWrite ?? 0,
              total: stats.tokens?.total ?? 0,
            },
            cost: stats.cost ?? 0,
          };
        },
         
        getContextUsage: (_key) => {
          // Context usage requires a live AgentSession which isn't available
          // outside execution. Return undefined -- /status will show "N/A".
          // During execution, live context usage is tracked by the PiEventBridge
          // context guard. Between executions, showing N/A
          // is acceptable since context is only meaningful during active sessions.
          return undefined;
        },
        getBudgetInfo: () => {
          // Budget config stores token limits, not dollar amounts.
          // Return undefined until we have token-to-cost estimation wiring.
          // Future: convert via cost-per-token rates from provider config.
          return undefined;
        },
      };

      const handler = createCommandHandler(cmdDeps);
      const result = handler.handle(parsed, sk);

      // If session reset command succeeded, try LLM greeting
      if (result.handled && (parsed.command === "new" || parsed.command === "reset") && greetingGenerator) {
        const greetingAgentConfig = agents[params.agentId ?? defaultAgentId] ?? agents[defaultAgentId];
        const greetingResult = await greetingGenerator.generate(greetingAgentConfig?.name ?? "Comis");
        if (greetingResult.ok) {
          return { handled: true, response: greetingResult.value };
        }
        // Fallback to static string on LLM failure
      }

      return { handled: result.handled, response: result.response, directives: result.directives as Record<string, unknown> | undefined };
    },
    logger: gatewayLogger,
  };

  const dynamicRouter = createDynamicMethodRouter(createRpcAdapters(rpcAdapterDeps), gatewayLogger);

  // Register all RPC methods as gateway-to-rpcCall passthroughs.
  // All business logic is in domain handler modules (rpc/*.ts) via rpc-dispatch.
  // skill/audio/config/ping handlers extracted to domain modules.
  registerRpcMethods({
    dynamicRouter,
    container,
    configPaths,
    rpcCall,
  });

  const rpcServer = dynamicRouter.server;

  // Resolve web dist path relative to daemon package
  // setup-gateway.ts is in wiring/ subdir, so go up 3 levels: wiring/ -> src/ -> daemon/ -> web/dist
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDistPath = resolve(__dirname, "../../../web/dist");
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

  const gatewayHandle = _createGatewayServer({
    config: gwConfig,
    logger: gatewayLogger,
    tokenStore,
    rpcServer,
    wsConnections,
    ...(webDeps && { webDeps }),
    fingerprint: {
      instanceId,
      startedAt: new Date(startupStartMs).toISOString(),
    },
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
  });

  await gatewayHandle.start();
  gatewayLogger.debug({ host: gwConfig.host, port: gwConfig.port }, "Gateway server started");

  return { gatewayHandle, activeExecutions, getActiveConnectionCount: () => wsConnections.size, wsConnections };
}
