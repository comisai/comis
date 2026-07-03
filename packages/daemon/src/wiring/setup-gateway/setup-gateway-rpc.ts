// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway RPC bridge + adapter wiring.
 * Hosts setupRpcBridge (deferred dispatch), buildRpcAdapterDeps (the 7-method
 * adapter struct consumed by createDynamicMethodRouter), extractAttachmentMarkers
 * (gateway JSONL → conversation history bridging), and buildDynamicRouterAndRegister.
 * @module
 */

import type { NormalizedMessage, SessionKey, MemoryEntry, AppContainer, AppConfig } from "@comis/core";
import {
  formatSessionKey,
  runWithContext,
  safePath,
  createDeliveryOrigin,
  systemNowMs,
} from "@comis/core";
import { existsSync, readFileSync } from "node:fs";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, CostTracker, GreetingGenerator } from "@comis/agent";
import { parseSlashCommand } from "@comis/orchestrator";
import type { CommandDirectives } from "@comis/orchestrator";
import type { MemoryApi, SqliteMemoryAdapter, createSessionStore } from "@comis/memory";
import type { RpcCall } from "@comis/skills/platform-tools";
import {
  createDynamicMethodRouter,
  createRpcAdapters,
  type RpcAdapterDeps,
} from "@comis/gateway";
import { randomUUID } from "node:crypto";
import type { ApiDispatchDeps } from "../../api/rpc-dispatch.js";
import { createRpcDispatch, classifyRpcError } from "../../api/rpc-dispatch.js";
import { registerRpcMethods } from "../setup-gateway-api.js";
import { agentSummaries, channelSummaries } from "./non-secret-projections.js";
import {
  buildExecutionRequestedLogFields,
  buildSlashCommandDeps,
  createCommandHandler,
  deriveTrustLevel,
  detectGreetingTrigger,
  handleConfigChatCommand,
  resolveExecAgentId,
} from "./setup-gateway-admin.js";

/**
 * Non-secret section allowlist for the `getConfig` RPC (a security
 * sign-off). Exactly the scalar/projected fields the safe default object
 * emits — sections carrying credentials (`agents` auth/model profiles,
 * `security.secrets`, `channels` tokens, `providers` keys, raw `gateway.tokens`)
 * are intentionally absent and never returned verbatim.
 */
const NON_SECRET_SECTIONS = ["tenantId", "logLevel", "gateway"] as const;
type NonSecretSection = (typeof NON_SECRET_SECTIONS)[number];

// RPC Bridge (deferred dispatch wiring) ----------------------------------

/** All services produced by the RPC bridge setup. */
export interface RpcBridgeResult {
  /** rpcCall — delegates to inner dispatch once wired. */
  rpcCall: RpcCall;
  /** Call after setupMonitoring to wire the real dispatch (heartbeatRunner TDZ resolution). */
  wireDispatch: (deps: ApiDispatchDeps) => void;
}

/**
 * Create the rpcCall wrapper and deferred dispatch mechanism. The returned
 * rpcCall is usable immediately; call wireDispatch() after setupMonitoring
 * resolves the heartbeatRunner TDZ to wire the real dispatch.
 */
export function setupRpcBridge(deps: {
  gatewayLogger: ComisLogger;
}): RpcBridgeResult {
  const { gatewayLogger } = deps;

  // Deferred inner dispatch -- assigned by wireDispatch() after all deps are ready
  let rpcCallInner: RpcCall;

  const rpcCall: RpcCall = async (method, params) => {
    const rpcStartMs = systemNowMs();
    try {
      return await rpcCallInner(method, params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Pass the error OBJECT (not err.message) so classifyRpcError's typed-refusal recognition resolves (OBS-RPC-REFUSAL-CLASS).
      const classified = classifyRpcError(err);
      gatewayLogger.debug({
        method,
        err: errMsg,
        durationMs: systemNowMs() - rpcStartMs,
        hint: classified.hint,
        errorKind: classified.errorKind,
      }, "[rpcCall] failed");
      throw err;
    }
  };

  const wireDispatch = (dispatchDeps: ApiDispatchDeps): void => {
    rpcCallInner = createRpcDispatch(dispatchDeps);
  };

  return { rpcCall, wireDispatch };
}

// Attachment marker extraction from pi-agent JSONL sessions ----------------

interface AttachmentMarker {
  content: string;
  timestamp: number;
}

/**
 * Read the pi-agent JSONL session file and extract gateway attachment markers.
 * Returns `<!-- attachment:... -->` content strings for each successful
 * `message.attach` tool call targeting the gateway channel type.
 */
export function extractAttachmentMarkers(
  workspaceDir: string | undefined,
  agentId: string,
  channelId: string,
  logger: { debug(obj: Record<string, unknown>, msg: string): void },
): AttachmentMarker[] {
  if (!workspaceDir) return [];
  const jsonlPath = safePath(workspaceDir, "sessions", agentId, channelId, "default.jsonl");
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

          // Result format: "Attachment delivered (mediaId: <uuid>)" or similar.
          // Extract mediaId from the text. Match either "mediaId: xxx" or a bare UUID
          // followed by ")" — covers both legacy and current formats.
          const mediaIdMatch = resultText.match(/mediaId[:\s]+([a-f0-9-]+)/i) ??
            resultText.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
          if (mediaIdMatch) attachResults.set(toolId, mediaIdMatch[1]);
        }
      }
    }

    // Build markers: for each successful attach, emit a `<!-- attachment:url -->` line
    const markers: AttachmentMarker[] = [];
    for (const [toolId, info] of attachCalls) {
      const mediaId = attachResults.get(toolId);
      if (!mediaId) continue;
      const url = `/media/${mediaId}`;
      const fileNameAttr = info.fileName ? ` fileName="${info.fileName.replace(/"/g, "\\\"")}"` : "";
      const captionAttr = info.caption ? ` caption="${info.caption.replace(/"/g, "\\\"")}"` : "";
      markers.push({
        content: `<!-- attachment:type="${info.type}" mimeType="${info.mimeType}" url="${url}"${fileNameAttr}${captionAttr} -->`,
        timestamp: systemNowMs(),
      });
    }
    logger.debug({ agentId, channelId, markerCount: markers.length }, "Extracted attachment markers from JSONL");
    return markers;
  } catch {
    return [];
  }
}

// RPC adapter deps builder -------------------------------------------------

/** Inputs the RPC adapter builder needs to wire each callback closure. */
export interface RpcAdapterBuilderDeps {
  container: AppContainer;
  gwConfig: AppConfig["gateway"];
  agents: AppConfig["agents"];
  defaultAgentId: string;
  gatewayLogger: ComisLogger;
  memoryApi: MemoryApi;
  sessionStore: ReturnType<typeof createSessionStore>;
  getExecutor: (agentId: string) => AgentExecutor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  preprocessMessageText: (text: string) => Promise<string>;
  rpcCall: RpcCall;
  costTrackers: Map<string, CostTracker>;
  workspaceDirs: Map<string, string>;
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
  greetingGenerator?: GreetingGenerator;
  /** Active executions map; mutated inside executeAgent + consumed by shutdown observability. */
  activeExecutions: Map<string, { agentId: string; startedAt: number }>;
  /** Unused; preserves GatewayDeps optional surface for consumer parity. */
  _memoryAdapter?: SqliteMemoryAdapter;
  /** Complete three-layer conversation forget for slash /new + /reset
   *  (createConversationReset — live finding 2026-06-11: runtime-only destroy
   *  left the LCD context the DAG re-presented). */
  destroyConversation?: (agentId: string, key: SessionKey) => Promise<unknown>;
}

/**
 * Build the `RpcAdapterDeps` struct consumed by `createRpcAdapters`. The
 * returned object captures all closure-bound deps for the 7 RPC adapter
 * methods (executeAgent / searchMemory / inspectMemory / getConfig /
 * getSessionHistory / setConfig / handleSlashCommand).
 */
export function buildRpcAdapterDeps(deps: RpcAdapterBuilderDeps): RpcAdapterDeps {
  const {
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
    destroyConversation,
    greetingGenerator,
    activeExecutions,
  } = deps;

  return {
    isValidAgentId: (agentId: string) => !!agents[agentId],
    executeAgent: async (params) => {
      // F-1: unknown agentId errors (clientFacing) vs silent paid-default fallback; absent defaults.
      const execAgentId = resolveExecAgentId(agents, (params as Record<string, unknown>).agentId as string | undefined, defaultAgentId);
      const connectionId = (params as Record<string, unknown>).connectionId as string | undefined;

      // Trust level from token scopes: admin/wildcard → admin, else user (fail-closed).
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
        timestamp: systemNowMs(),
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
        startedAt: systemNowMs(),
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
      const execStartMs = systemNowMs();
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
        durationMs: systemNowMs() - execStartMs,
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

      // Bridge session history to SQLite (session.history RPC + /chat/history REST)
      // and extract gateway attachment tool calls from the JSONL session so
      // images/files persist across page navigations. Non-fatal on failure.
      try {
        const existingSession = sessionStore.load(sk);
        const messages: unknown[] = existingSession?.messages ?? [];
        messages.push({ role: "user", content: msg.text, timestamp: msg.timestamp });
        const attachmentMarkers = extractAttachmentMarkers(
          workspaceDirs.get(execAgentId),
          execAgentId,
          sk.channelId,
          gatewayLogger,
        );
        // Deduplicate against existing /media/ URLs in session history
        const existingText = messages.map((m) => (m as Record<string, unknown>).content ?? "").join("\n");
        for (const marker of attachmentMarkers) {
          const urlMatch = marker.content.match(/\/media\/[^"]+/);
          if (urlMatch && (existingText as string).includes(urlMatch[0])) continue;
          messages.push({ role: "assistant", content: marker.content, timestamp: marker.timestamp });
        }
        if (result.response) {
          messages.push({ role: "assistant", content: result.response, timestamp: systemNowMs() });
        }
        sessionStore.save(sk, messages);
        gatewayLogger.debug(
          { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length, attachments: attachmentMarkers.length },
          "Session history bridged to SQLite store",
        );
      } catch {
        // Session history bridging is non-fatal
      }

      // Token usage captured via PiEventBridge observability:token_usage → tokenTracker bus.
      // Conversation memory persistence handled by PiExecutor.
      // Emit message events for activity tracking (REST/WebSocket parity with channels).
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
      // A non-secret section ALLOWLIST is enforced.
      // The prior top-level-key passthrough returned ANY requested section
      // verbatim — including `agents` (per-provider auth/model profiles) and
      // `security.secrets` — a real secret-egress path. Only the
      // exact fields the safe default object already emits are returnable, and
      // each is projected the SAME way the default does (gateway → {enabled,
      // host,port}, NOT the raw object, which carries bearer `tokens`). A
      // non-allowlisted section falls through to the safe default object —
      // the prior verbatim-passthrough path is removed outright, with no
      // opt-out flag preserving the old behaviour (no-BC policy).
      const safeDefault = {
        tenantId: container.config.tenantId,
        logLevel: container.config.logLevel,
        gateway: { enabled: gwConfig.enabled, host: gwConfig.host, port: gwConfig.port },
      };
      // Closed allowlist — extend ONLY with sections proven to carry no secrets.
      const section = params?.section;
      if (section !== undefined && NON_SECRET_SECTIONS.includes(section as NonSecretSection)) {
        // Project each allowlisted section exactly as the safe default does
        // (closed union → exhaustive switch, no dynamic key indexing).
        switch (section as NonSecretSection) {
          case "tenantId":
            return { tenantId: safeDefault.tenantId };
          case "logLevel":
            return { logLevel: safeDefault.logLevel };
          case "gateway":
            return { gateway: safeDefault.gateway };
        }
      }
      // Non-allowlisted (incl. agents/security/channels/providers) → safe default.
      return safeDefault;
    },
    // Non-secret projections for the dashboard's GET /api/agents and
    // /api/channels — `agents`/`channels` were dropped from getConfig's
    // allowlist, so these (not getConfig) are the REST source. See
    // non-secret-projections.ts: id/name/provider/model + name/enabled only.
    listAgentSummaries: () => agentSummaries(container.config.agents),
    listChannelSummaries: () => channelSummaries(container.config.channels),
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

      // getAvailableThinkingLevels intentionally omitted (no AgentSession at RPC time).
      const cmdDeps = buildSlashCommandDeps({
        execAgentId,
        defaultAgentId,
        execAgentConfig,
        container,
        costTrackers,
        workspaceDirs,
        piSessionAdapters,
        destroyConversation,
      });

      const handler = createCommandHandler(cmdDeps);
      const result = handler.handle(parsed, sk);

      // If session reset command succeeded, try LLM greeting
      if (result.handled && (parsed.command === "new" || parsed.command === "reset") && greetingGenerator) {
        const greetingAgentConfig = agents[params.agentId ?? defaultAgentId] ?? agents[defaultAgentId];
        // Interactivity signal: a concrete channel surface
        // (Discord/Telegram/…) is interactive; the bare "gateway" sentinel
        // (the headless RPC default applied when no channelId is supplied —
        // see `sk` above) marks the non-interactive/onboarding-limited path.
        const interactive = (params.sessionKey?.channelId ?? "gateway") !== "gateway";
        const trigger = detectGreetingTrigger({ agentConfig: greetingAgentConfig, interactive });
        const greetingResult = await greetingGenerator.generate(greetingAgentConfig?.name ?? "Comis", trigger);
        if (greetingResult.ok) {
          return { handled: true, response: greetingResult.value };
        }
        // Fallback to static string on LLM failure
      }

      return { handled: result.handled, response: result.response, directives: result.directives as Record<string, unknown> | undefined };
    },
    logger: gatewayLogger,
  };
}

// Dynamic router construction + RPC method registration -------------------

/**
 * Build the dynamic-method router and register all RPC methods. Returns the
 * router handle for the gateway server.
 */
export function buildDynamicRouterAndRegister(deps: {
  rpcAdapterDeps: RpcAdapterDeps;
  container: AppContainer;
  configPaths: string[];
  rpcCall: RpcCall;
  gatewayLogger: ComisLogger;
}): ReturnType<typeof createDynamicMethodRouter> {
  const { rpcAdapterDeps, container, configPaths, rpcCall, gatewayLogger } = deps;
  const dynamicRouter = createDynamicMethodRouter(createRpcAdapters(rpcAdapterDeps), gatewayLogger);
  // Register all RPC methods as gateway-to-rpcCall passthroughs.
  // All business logic is in domain handler modules (api/*.ts) via rpc-dispatch.
  registerRpcMethods({
    dynamicRouter,
    container,
    configPaths,
    rpcCall,
  });
  return dynamicRouter;
}
