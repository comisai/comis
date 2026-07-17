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
import { tryCatch } from "@comis/shared";
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
import { gatewaySessionOwnershipError, resolveGatewaySessionKey } from "./gateway-session-principal.js";
import { persistGatewayInboundMessage, type GatewaySessionAdapter } from "./gateway-inbound-provenance.js";
/**
 * Non-secret section allowlist for the `getConfig` RPC (a security
 * sign-off). Exactly the scalar/projected fields the safe default object
 * emits — sections carrying credentials (`agents` auth/model profiles,
 * `security.secrets`, `channels` tokens, `providers` keys, raw `gateway.tokens`) are absent.
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
  piSessionAdapters?: Map<string, GatewaySessionAdapter>;
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

      const sk = resolveGatewaySessionKey({
        tenantId: container.config.tenantId,
        clientId: params.clientId,
        sessionKey: params.sessionKey,
      });
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
      const existingSession = tryCatch(() => sessionStore.load(sk));
      const ownershipError = gatewaySessionOwnershipError(
        existingSession,
        execAgentId,
        params.clientId,
      );
      if (ownershipError !== undefined) {
        gatewayLogger.error({
          agentId: execAgentId,
          hint: "Use a new gateway session key for this agent or inspect the session store",
          errorKind: "precondition" as const,
        }, "Gateway RPC session ownership rejected");
        emitObservationalEventSafely(
          { eventBus: container.eventBus, logger: gatewayLogger }, "system:error",
          { error: ownershipError, source: "gateway-rpc-session-owner" },
        );
        return Promise.reject(ownershipError);
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
            metadata: {},
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
          try {
            const existingSession = sessionStore.load(sk);
            const messages: unknown[] = [...(existingSession?.messages ?? []), userHistoryMessage];
            sessionStore.save(sk, messages, {
              ...(existingSession?.metadata ?? {}),
              agentId: execAgentId,
              ...(params.clientId !== undefined
                ? { gatewayClientId: params.clientId }
                : {}),
            });
            userHistoryPersisted = true;
            gatewayLogger.debug(
              { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length },
              "Gateway user history persisted",
            );
          } catch (error) {
            gatewayLogger.warn({
              err: sanitizeLogString(error instanceof Error ? error.message : String(error)),
              sessionKey: formatSessionKey(sk),
              step: "gateway-history-user",
              hint: "Check SQLite session storage health and available disk space",
              errorKind: "resource" as const,
            }, "Gateway session history persistence failed");
            emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
              error: new Error("Gateway session history persistence failed"),
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
            try {
              const existingSession = sessionStore.load(sk);
              const messages: unknown[] = [...(existingSession?.messages ?? [])];
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
              sessionStore.save(sk, messages, {
                ...(existingSession?.metadata ?? {}),
                agentId: execAgentId,
                ...(params.clientId !== undefined
                  ? { gatewayClientId: params.clientId }
                  : {}),
              });
              gatewayLogger.debug(
                { agentId: execAgentId, sessionKey: formatSessionKey(sk), messageCount: messages.length },
                "Gateway response history persisted",
              );
            } catch (error) {
              gatewayLogger.warn({
                err: sanitizeLogString(error instanceof Error ? error.message : String(error)),
                sessionKey: formatSessionKey(sk),
                step: "gateway-history-response",
                hint: "Check SQLite session storage health and available disk space",
                errorKind: "resource" as const,
              }, "Gateway session history persistence failed");
              emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "system:error", {
                error: new Error("Gateway session history persistence failed"),
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
      const sk = resolveGatewaySessionKey({
        tenantId: container.config.tenantId,
        clientId: params.clientId,
        sessionKey: params.channelId === undefined
          ? undefined
          : {
              channelId: params.channelId,
              peerId: params.peerId,
            },
      });
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
      const sk = resolveGatewaySessionKey({
        tenantId: container.config.tenantId,
        clientId: params.clientId,
        sessionKey: params.sessionKey,
      });

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
