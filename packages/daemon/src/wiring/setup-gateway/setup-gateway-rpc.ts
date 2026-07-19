// SPDX-License-Identifier: Apache-2.0
/** Gateway RPC bridge, adapter wiring, and dynamic router registration. */
import type { NormalizedMessage, SessionKey, MemoryEntry, AppContainer, AppConfig } from "@comis/core";
import {
  createResolvedRequestContext,
  formatSessionKey,
  getOriginalInboundMessages,
  runWithContext,
  createDeliveryOrigin,
  emitObservationalEventSafely,
  createMemoryRecallScope,
  sanitizeLogString,
  systemNowMs,
} from "@comis/core";
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
import { agentSummaries, channelSummaries, safeConfigProjection } from "./non-secret-projections.js";
import {
  buildExecutionRequestedLogFields,
  buildSlashCommandDeps,
  createCommandHandler,
  deriveTrustLevel,
  detectGreetingTrigger,
  handleConfigChatCommand,
  resolveExecAgentId,
} from "./setup-gateway-admin.js";
import { resolveGatewayTurnIdentity } from "./gateway-session-principal.js";
import { persistGatewayInboundMessage, type GatewaySessionAdapter } from "./gateway-inbound-provenance.js";
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
      // Preserve the typed error so refusal classification remains exact.
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
  piSessionAdapters?: Map<string, GatewaySessionAdapter>;
  greetingGenerator?: GreetingGenerator;
  /** Active executions map; mutated inside executeAgent + consumed by shutdown observability. */
  activeExecutions: Map<string, { agentId: string; startedAt: number }>;
  /** Unused; preserves GatewayDeps optional surface for consumer parity. */
  _memoryAdapter?: SqliteMemoryAdapter;
  /** Clear every prompt-bearing conversation layer for slash /new and /reset. */
  destroyConversation?: (scope: import("@comis/core").ConversationScope, key: SessionKey) => Promise<unknown>;
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
      // An absent agent id defaults; an explicit unknown id must surface a client-facing error.
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

      const identity = resolveGatewayTurnIdentity({
        tenantId: container.config.tenantId,
        agentId: execAgentId,
        clientId: params.clientId,
        sessionKey: params.sessionKey,
      });
      if (!identity.ok) {
        gatewayLogger.error({
          agentId: execAgentId,
          hint: "Verify the gateway client and conversation identifiers before retrying",
          errorKind: identity.error.errorKind,
        }, "Gateway RPC identity resolution failed");
        return Promise.reject(identity.error);
      }
      const sk = identity.value.displaySessionKey;
      const conversationScope = identity.value.turnScope.conversation;
      const requestStartedAt = systemNowMs();
      const requestContext = createResolvedRequestContext({
        traceId: randomUUID(),
        tenantId: sk.tenantId,
        userId: sk.userId,
        agentId: execAgentId,
        sessionKey: sk,
        ...(params.clientId && { clientId: params.clientId }),
        startedAt: requestStartedAt,
        trustLevel,
        channelType: "gateway",
        deliveryOrigin: createDeliveryOrigin({
          channelType: "gateway",
          channelId: sk.channelId,
          userId: sk.userId,
          tenantId: sk.tenantId,
        }),
        turnScope: identity.value.turnScope,
      });
      if (!requestContext.ok) {
        gatewayLogger.error({
          agentId: execAgentId,
          hint: "Verify the authenticated gateway session tenant and user identity",
          errorKind: "internal" as const,
        }, "Gateway RPC request context validation failed");
        emitObservationalEventSafely(
          { eventBus: container.eventBus, logger: gatewayLogger }, "system:error",
          { error: requestContext.error, source: "gateway-rpc-context" },
        );
        return Promise.reject(requestContext.error);
      }
      const existingSession = sessionStore.load(conversationScope);
      if (!existingSession.ok) {
        gatewayLogger.error({
          agentId: execAgentId,
          hint: "Inspect session database integrity and retry after storage recovers",
          errorKind: existingSession.error.errorKind,
        }, "Gateway RPC session authority check failed");
        emitObservationalEventSafely(
          { eventBus: container.eventBus, logger: gatewayLogger }, "system:error",
          { error: existingSession.error, source: "gateway-rpc-session-owner" },
        );
        return Promise.reject(existingSession.error);
      }

      return runWithContext(
        requestContext.value,
        async () => {
          const receivedAt = systemNowMs();
          const receivedMessage: NormalizedMessage = {
            id: randomUUID(),
            channelId: sk.channelId,
            channelType: "gateway",
            senderId: params.sessionKey?.peerId ?? "rpc-client",
            text: params.message,
            timestamp: receivedAt,
            attachments: [],
            metadata: params.locale === undefined ? {} : { locale: params.locale },
          };
          const persisted = await persistGatewayInboundMessage({
            agentId: execAgentId,
            defaultAgentId,
            message: receivedMessage,
            sessionKey: sk,
            recordedAt: receivedAt,
            sessionAdapters: piSessionAdapters,
            eventBus: container.eventBus,
            logger: gatewayLogger,
          });
          if (!persisted.ok) return Promise.reject(persisted.error.error);

          // Link understanding preprocessing: enrich message text with fetched URL content.
          const enrichedText = await preprocessMessageText(params.message);
          const msg: NormalizedMessage = {
            ...receivedMessage,
            text: enrichedText,
            originalMessages: getOriginalInboundMessages(receivedMessage),
          };
          // Assemble per-agent tools via three-tier pipeline (builtin + platform + skills)
          const tools = await assembleToolsForAgent(execAgentId);
          gatewayLogger.debug(
            { agentId: execAgentId, toolCount: tools.length, ...(connectionId && { connectionId }) },
            "Tools assembled for agent",
          );
          const userHistoryMessage = { role: "user", content: msg.text, timestamp: msg.timestamp };
          let userHistoryPersisted = false;
          const userHistory = sessionStore.load(conversationScope);
          if (userHistory.ok) {
            const messages: unknown[] = [...(userHistory.value?.messages ?? []), userHistoryMessage];
            const saved = sessionStore.save(conversationScope, messages, {
              ...(userHistory.value?.metadata ?? {}),
              agentId: execAgentId,
              ...(params.clientId !== undefined
                ? { gatewayClientId: params.clientId }
                : {}),
            });
            if (saved.ok) {
              userHistoryPersisted = true;
              gatewayLogger.debug(
                { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length },
                "Gateway user history persisted",
              );
            } else {
              gatewayLogger.warn({
                conversationRef: userHistory.value?.conversationRef,
                step: "gateway-history-user",
                err: sanitizeLogString(saved.error.message),
                hint: "Check SQLite session storage health and available disk space",
                errorKind: saved.error.errorKind,
              }, "Gateway session history persistence failed");
              emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
                error: saved.error,
                source: "gateway-session-history",
              });
            }
          } else {
            gatewayLogger.warn({
              sessionKey: formatSessionKey(sk),
              step: "gateway-history-user",
              hint: "Check SQLite session storage health and available disk space",
              errorKind: userHistory.error.errorKind,
            }, "Gateway session history persistence failed");
            emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
              error: userHistory.error,
              source: "gateway-session-history",
            });
          }
          const execStartMs = systemNowMs();
          const execKey = msg.id;
          activeExecutions.set(execKey, { agentId: execAgentId, startedAt: execStartMs });
          let result;
          try {
            result = await getExecutor(execAgentId).execute(
              msg,
              sk,
              tools,
              params.onDelta,
              execAgentId,
              params.directives as CommandDirectives | undefined,
            );
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

          // Attachment delivery persists its marker during execution. Reloading
          // here preserves the ordered user → attachment → response sequence.
          if (result.response) {
            const responseHistory = sessionStore.load(conversationScope);
            if (responseHistory.ok) {
              const messages: unknown[] = [...(responseHistory.value?.messages ?? [])];
              if (!userHistoryPersisted) {
                const hasUserMessage = messages.some((message) => {
                  const candidate = message as Partial<typeof userHistoryMessage>;
                  return candidate.role === userHistoryMessage.role
                    && candidate.content === userHistoryMessage.content
                    && candidate.timestamp === userHistoryMessage.timestamp;
                });
                if (!hasUserMessage) messages.unshift(userHistoryMessage);
              }
              messages.push({ role: "assistant", content: result.response, timestamp: systemNowMs() });
              const saved = sessionStore.save(conversationScope, messages, {
                ...(responseHistory.value?.metadata ?? {}),
                agentId: execAgentId,
                ...(params.clientId !== undefined
                  ? { gatewayClientId: params.clientId }
                  : {}),
              });
              if (saved.ok) {
                gatewayLogger.debug(
                  { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length },
                  "Gateway response history persisted",
                );
              } else {
                gatewayLogger.warn({
                  conversationRef: responseHistory.value?.conversationRef,
                  step: "gateway-history-response",
                  err: sanitizeLogString(saved.error.message),
                  hint: "Check SQLite session storage health and available disk space",
                  errorKind: saved.error.errorKind,
                }, "Gateway session history persistence failed");
                emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
                  error: saved.error,
                  source: "gateway-session-history",
                });
              }
            } else {
              gatewayLogger.warn({
                sessionKey: formatSessionKey(sk),
                step: "gateway-history-response",
                hint: "Check SQLite session storage health and available disk space",
                errorKind: responseHistory.error.errorKind,
              }, "Gateway session history persistence failed");
              emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
                error: responseHistory.error,
                source: "gateway-session-history",
              });
            }
          }

          // Token usage captured via PiEventBridge observability:token_usage → tokenTracker bus.
          // Conversation memory persistence handled by PiExecutor.
          if (result.response) {
            emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "message:sent", {
              channelType: "gateway",
              channelId: sk.channelId,
              messageId: randomUUID(),
              content: result.response,
              sourceChannelType: msg.channelType,
              sourceChannelId: msg.channelId,
              sourceMessageId: msg.id,
            });
          }

          return {
            response: result.response,
            tokensUsed: result.tokensUsed,
            finishReason: result.finishReason,
            sessionKey: formatSessionKey(sk),
          };
        },
      );
    },
    searchMemory: async (params) => {
      const identity = resolveGatewayTurnIdentity({
        tenantId: params.tenantId,
        agentId: params.agentId,
        sessionKey: { channelId: "memory-search" },
      });
      if (!identity.ok) return Promise.reject(identity.error);
      const scope = createMemoryRecallScope(identity.value.turnScope, true);
      if (!scope.ok) return Promise.reject(scope.error);
      const results = await memoryApi.search(params.query, {
        limit: params.limit,
        scope: scope.value,
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
        const entries = memoryApi.inspect({
          tenantId: params.tenantId,
          agentId: params.agentId,
          limit: 1,
        });
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
      const stats = memoryApi.stats(params.tenantId, params.agentId);
      return { stats: stats as unknown as Record<string, unknown> };
    },
    getConfig: async (params) => safeConfigProjection(container.config, params?.section),
    // Dashboard projections expose only non-secret agent and channel fields.
    listAgentSummaries: () => agentSummaries(container.config.agents),
    listChannelSummaries: () => channelSummaries(container.config.channels),
    getSessionHistory: async (params) => {
      const identity = resolveGatewayTurnIdentity({
        tenantId: container.config.tenantId,
        agentId: defaultAgentId,
        clientId: params.clientId,
        sessionKey: params.channelId === undefined
          ? undefined
          : {
              channelId: params.channelId,
              peerId: params.peerId,
            },
      });
      if (!identity.ok) return Promise.reject(identity.error);
      const loaded = sessionStore.load(identity.value.turnScope.conversation);
      if (!loaded.ok) return Promise.reject(loaded.error);
      const data = loaded.value;
      if (data === undefined) {
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
      const identity = resolveGatewayTurnIdentity({
        tenantId: container.config.tenantId,
        agentId: execAgentId,
        clientId: params.clientId,
        sessionKey: params.sessionKey,
      });
      if (!identity.ok) return Promise.reject(identity.error);
      const sk = identity.value.displaySessionKey;

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
        logger: gatewayLogger,
        conversationScope: identity.value.turnScope.conversation,
        piSessionAdapters,
        destroyConversation,
      });

      const handler = createCommandHandler(cmdDeps);
      const result = handler.handle(parsed, sk);

      // If session reset command succeeded, try LLM greeting
      if (result.handled && (parsed.command === "new" || parsed.command === "reset") && greetingGenerator) {
        const greetingAgentConfig = agents[params.agentId ?? defaultAgentId] ?? agents[defaultAgentId];
        // Concrete channels are interactive; the gateway sentinel is headless.
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
