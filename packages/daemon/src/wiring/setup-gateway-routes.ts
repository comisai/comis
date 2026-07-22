// SPDX-License-Identifier: Apache-2.0
// @allow-throw: gateway-route wiring re-raise; consumed at daemon.ts bootstrap catch boundary.
/**
 * Gateway HTTP route mounting: webhooks, media serving, and OpenAI-compatible API.
 * Extracted from setup-gateway.ts to isolate route mounting (webhook sub-app,
 * media routes, OpenAI /v1/* endpoints with Bearer auth) into a single-concern module.
 * @module
 */

import type {
  NormalizedMessage,
  SessionKey,
  AppContainer,
  AppConfig,
  UserTrustLevel,
  EventMap,
  WebhookFailureReason,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type {
  AgentExecutor,
  BackgroundSessionResolver,
} from "@comis/agent";
import {
  safePath,
  enrichCurrentContext,
  generateStrongToken,
  systemNowMs,
  runWithContext,
  formatSessionKey,
  tryGetContext,
  createDeliveryOrigin,
  createConversationLocator,
  emitObservationalEventSafely,
  RequestContextSchema,
  wrapExternalContent,
} from "@comis/core";
import {
  extractBearerToken,
  checkScope,
  createMappedWebhookEndpoint,
  getPresetMappings,
  createOpenaiCompletionsRoute,
  createOpenaiModelsRoute,
  createOpenaiEmbeddingsRoute,
  createResponsesRoute,
  createMediaRoutes,
  createApprovalTokenRoute,
  createTokenStore,
  type GatewayServerHandle,
} from "@comis/gateway";
import { Hono, type Env } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
// Defer a mid-turn config-change SIGUSR2 until the synchronous
// chat/responses-API response flushes.
import { withConfigMutationFence } from "../api/shared/persist-to-config.js";
import {
  classifyExecutionAbortReason,
  classifyExecutionFinishReason,
} from "@comis/orchestrator";
import { bindApiExecutionCancellation } from "./api-execution-cancellation.js";

interface OpenaiApiEnv extends Env {
  Variables: { clientScopes: readonly string[] };
}

/**
 * Resolve API request trust solely from the authenticated bearer-token scopes.
 * Agent selection and reply configuration are not authentication signals.
 */
export function resolveApiTrustLevel(
  authenticatedScopes: readonly string[],
): UserTrustLevel {
  return checkScope(authenticatedScopes, "admin") ? "admin" : "user";
}

function resolveApiTraceId(requestedTraceId: string | undefined): string {
  if (
    requestedTraceId !== undefined
    && RequestContextSchema.shape.traceId.safeParse(requestedTraceId).success
  ) {
    return requestedTraceId;
  }
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for gateway route mounting. */
export interface GatewayRouteDeps {
  /** Gateway server handle to mount routes on. */
  gatewayHandle: GatewayServerHandle;
  /** Webhooks config section (optional). */
  webhooksConfig?: AppConfig["webhooks"];
  /** Bootstrap output (config, eventBus, secretManager, tenantId). */
  container: AppContainer;
  /** Default agent ID for fallback routing. */
  defaultAgentId: string;
  /** Agent configuration map. */
  agents: AppConfig["agents"];
  /** Gateway-scoped logger. */
  gatewayLogger: ComisLogger;
  /** Gateway config section (for token store). */
  gwConfig: AppConfig["gateway"];
  /** Token store for Bearer auth verification. */
  tokenStore: ReturnType<typeof createTokenStore>;
  /** Resolver for per-agent executors. */
  getExecutor: (agentId: string) => AgentExecutor;
  /** Resolves the exact live SDK run for HTTP disconnect cancellation. */
  sessionResolver: BackgroundSessionResolver;
  /** Assembles the three-tier tool pipeline for an agent. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("./setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  /** Preprocesses message text (link understanding, etc.). */
  preprocessMessageText: (text: string) => Promise<string>;
  /** Cached embedding port for OpenAI embeddings route. */
  cachedPort: unknown;
  /** Per-agent workspace directory paths. */
  workspaceDirs: Map<string, string>;
  /** Default workspace directory (resolved from workspaceDirs). */
  defaultWorkspaceDir?: string;
  /** Interactive-callback wiring: the single-use email approval-token map
   *  + resolver. When present, the `ALL /approve/:token` route is mounted. */
  interactiveCallbackWiring?: import("./setup-interactive-callback.js").InteractiveCallbackWiring;
  /** Microsoft Teams inbound ingress sub-app. When present (the channel is
   *  enabled and its credentials validated, so the composition root built a
   *  caller-backed ingress), the `/channels/msteams` route is mounted; absent
   *  ⇒ no route exists. Presence is the mount signal. */
  msTeamsIngress?: import("hono").Hono;
  /** After an unattended webhook turn, reap terminal drives that were
   *  launched but never received a task. Any reap makes delivery a failure.
   *  Absent means no terminal-drive backstop is configured. */
  reapNeverTaskedDrives?: (agentId: string, owner: { agentId: string; sessionKey: string }) => Promise<{ reaped: string[] }>;
}

// ---------------------------------------------------------------------------
// Route mounting function
// ---------------------------------------------------------------------------

/**
 * Mount all HTTP routes on the gateway server:
 * - Webhook mapping sub-app (if webhooks configured)
 * - Media serving routes
 * - OpenAI-compatible API routes (/v1/chat/completions, /v1/models, /v1/embeddings, /v1/responses)
 */
export function mountGatewayRoutes(deps: GatewayRouteDeps): void {
  const {
    gatewayHandle,
    webhooksConfig,
    container,
    defaultAgentId,
    agents,
    gatewayLogger,
    tokenStore,
    getExecutor,
    sessionResolver,
    assembleToolsForAgent,
    preprocessMessageText,
    cachedPort,
    defaultWorkspaceDir,
    interactiveCallbackWiring,
    msTeamsIngress,
    reapNeverTaskedDrives,
  } = deps;

  interface ActiveApiExecution {
    agentId: string;
    sessionKey: string;
    abortReason?: EventMap["execution:aborted"]["reason"];
  }
  const activeApiExecutions = new Map<string, Set<ActiveApiExecution>>();
  container.eventBus.on("execution:aborted", (event) => {
    const traceId = tryGetContext()?.traceId;
    if (traceId === undefined) return;
    const activeForTrace = activeApiExecutions.get(traceId);
    if (!activeForTrace) return;
    const abortedSessionKey = formatSessionKey(event.sessionKey);
    for (const active of activeForTrace) {
      if (
        active.agentId === event.agentId &&
        active.sessionKey === abortedSessionKey
      ) {
        active.abortReason = event.reason;
      }
    }
  });

  const executeWithLifecycle = async (
    agentId: string,
    sessionKey: SessionKey,
    traceId: string,
    execute: () => ReturnType<AgentExecutor["execute"]>,
  ): Promise<{
    result: Awaited<ReturnType<AgentExecutor["execute"]>>;
    lifecycle: ReturnType<typeof classifyExecutionFinishReason>;
  }> => {
    const active: ActiveApiExecution = {
      agentId,
      sessionKey: formatSessionKey(sessionKey),
    };
    const activeForTrace = activeApiExecutions.get(traceId) ?? new Set<ActiveApiExecution>();
    activeForTrace.add(active);
    activeApiExecutions.set(traceId, activeForTrace);
    try {
      const result = await execute();
      const authoritativeAbortReason = active.abortReason;
      return {
        result,
        lifecycle: authoritativeAbortReason !== undefined
          ? classifyExecutionAbortReason(authoritativeAbortReason)
          : classifyExecutionFinishReason(result),
      };
    } finally {
      activeForTrace.delete(active);
      if (activeForTrace.size === 0) activeApiExecutions.delete(traceId);
    }
  };

  // -------------------------------------------------------------------------
  // Email approval-token route
  // -------------------------------------------------------------------------
  // Single-use, 5-min, revoke-on-first-touch GET handler for the signed email
  // approval link. Mounted at `ALL /approve/:token` so a mail-client preview
  // prefetch also consumes the token. The token map + resolver come from the
  // composition-root wiring (the same gate/router the chat buttons resolve
  // through). Skipped when no wiring is present (no channels / approvals path).
  if (interactiveCallbackWiring !== undefined) {
    gatewayHandle.app.route(
      "/approve",
      createApprovalTokenRoute({
        tokens: interactiveCallbackWiring.tokens,
        resolveApproval: interactiveCallbackWiring.resolveApproval,
        logger: gatewayLogger,
      }),
    );
    gatewayLogger.debug(
      { submodule: "approval-token" },
      "Email approval-token route mounted at /approve/*",
    );
  }

  // -------------------------------------------------------------------------
  // Microsoft Teams inbound ingress
  // -------------------------------------------------------------------------
  // The net-new gateway ingress: a Hono sub-app that authenticates inbound
  // activities (Bearer pre-gate → signed-token validation → fast ack) before
  // driving them into the channel pipeline. Mounted ONLY when the composition
  // root threaded a built ingress here (the channel is enabled and its
  // credentials validated) — presence is the mount signal, so a disabled
  // channel produces no route. This closes the dead-route failure mode where a
  // handler factory ships with no production caller mounting it.
  if (msTeamsIngress !== undefined) {
    gatewayHandle.app.route("/channels/msteams", msTeamsIngress);
    gatewayLogger.debug(
      { submodule: "msteams-ingress" },
      "Microsoft Teams ingress mounted at /channels/msteams/*",
    );
  }

  // -------------------------------------------------------------------------
  // Webhook mapping sub-app
  // -------------------------------------------------------------------------

  if (webhooksConfig?.enabled) {
    const presetMappings = getPresetMappings(webhooksConfig.presets ?? []);
    const customMappings = webhooksConfig.mappings ?? [];
    const allMappings = [...presetMappings, ...customMappings];

    if (allMappings.length > 0) {
      // Resolve webhook HMAC token (config -> SecretManager -> auto-generate).
      // SecretRef already resolved by daemon bootstrap; cast to string.
      let resolvedWebhookToken = webhooksConfig.token as string | undefined;
      if (!resolvedWebhookToken) {
        resolvedWebhookToken = container.secretManager.get("WEBHOOK_HMAC_SECRET");
        if (!resolvedWebhookToken) {
          resolvedWebhookToken = generateStrongToken();
          gatewayLogger.warn(
            { envVar: "WEBHOOK_HMAC_SECRET", hint: "Set WEBHOOK_HMAC_SECRET in environment or secrets store for HMAC persistence across restarts", errorKind: "config" as const },
            "Webhook HMAC secret auto-generated (ephemeral -- HMAC verification active but secret will change on restart)",
          );
        }
      }

      const webhookApp = createMappedWebhookEndpoint({
        mappings: allMappings,
        secret: resolvedWebhookToken,
        maxBodyBytes: webhooksConfig.maxBodyBytes,
        onWake: async (_mapping) => {
          const startMs = systemNowMs();
          let success = true;
          let failureReason: WebhookFailureReason | undefined;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scheduler:wake event type not yet in EventMap
            container.eventBus.emit("scheduler:wake" as any, { source: "webhook" });
            gatewayLogger.info("Webhook triggered wake event");
          } catch (err: unknown) {
            success = false;
            failureReason = "handler_error";
            throw err;
          } finally {
            emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "diagnostic:webhook_delivered", {
              webhookId: _mapping.id ?? "unknown",
              source: _mapping.name ?? "webhook",
              event: "wake",
              statusCode: success ? 200 : 500,
              success,
              durationMs: systemNowMs() - startMs,
              failureReason,
              timestamp: systemNowMs(),
            });
          }
        },
        onAgentAction: async (_mapping, renderedMessage, renderedSessionKey) => {
          const execAgentId = _mapping.agentId ?? defaultAgentId;
          const routeChannelId = renderedSessionKey || "webhook";
          const sk: SessionKey = {
            tenantId: container.config.tenantId,
            agentId: execAgentId,
            userId: "webhook",
            channelId: routeChannelId,
          };
          const deliveryOrigin = createDeliveryOrigin({
            tenantId: sk.tenantId,
            userId: sk.userId,
            channelType: "webhook",
            channelId: routeChannelId,
          });
          return runWithContext({
            traceId: randomUUID(),
            startedAt: systemNowMs(),
            tenantId: sk.tenantId,
            channelType: "webhook",
            trustLevel: "guest",
          }, async () => {
            const startMs = systemNowMs();
            let success = true;
            let failureReason: WebhookFailureReason | undefined;
            try {
              const resolvedContext = enrichCurrentContext({
                tenantId: sk.tenantId,
                userId: sk.userId,
                sessionKey: sk,
                agentId: execAgentId,
                trustLevel: "guest",
                deliveryOrigin,
              });
              if (!resolvedContext.ok) throw resolvedContext.error;
              const msg: NormalizedMessage = {
                id: randomUUID(),
                channelId: routeChannelId,
                channelType: "webhook",
                senderId: sk.userId,
                text: wrapExternalContent(renderedMessage, { source: "webhook" }),
                timestamp: systemNowMs(),
                attachments: [],
                metadata: { webhookMappingId: _mapping.id },
              };
              const tools = await assembleToolsForAgent(execAgentId);
              const executionResult = await getExecutor(execAgentId).execute(
                msg,
                sk,
                tools,
                undefined,
                execAgentId,
              );
              const outcome = classifyExecutionFinishReason(executionResult);
              if (outcome.status !== "success") {
                throw new Error(`Webhook agent execution ended with ${executionResult.finishReason}`);
              }
              // A terminal drive that was launched but never tasked means the
              // webhook action did not run, even if the agent turn itself ended.
              if (reapNeverTaskedDrives) {
                const { reaped } = await reapNeverTaskedDrives(execAgentId, {
                  agentId: execAgentId,
                  sessionKey: formatSessionKey(sk),
                });
                if (reaped.length > 0) {
                  success = false;
                  failureReason = "task_not_delivered";
                  gatewayLogger.warn(
                    { execAgentId, reapedCount: reaped.length, webhookId: _mapping.id ?? "unknown", hint: "the driven coding CLI was launched but the task was never sent (send_text) — the task-delivery precondition for a successful drive was not met; re-fire the webhook or drive it interactively", errorKind: "precondition" as const },
                    "unattended webhook drive stranded a never-tasked terminal drive — reaped and recorded an honest failure",
                  );
                }
              }
            } catch (err: unknown) {
              success = false;
              failureReason = "handler_error";
              throw err;
            } finally {
              emitObservationalEventSafely({ eventBus: container.eventBus, logger: gatewayLogger }, "diagnostic:webhook_delivered", {
                webhookId: _mapping.id ?? "unknown",
                source: _mapping.name ?? "webhook",
                event: "agent_action",
                statusCode: success ? 200 : 500,
                success,
                durationMs: systemNowMs() - startMs,
                failureReason,
                timestamp: systemNowMs(),
              });
            }
          });
        },
      });

      const basePath = webhooksConfig.path ?? "/hooks";
      gatewayHandle.app.route(basePath, webhookApp);
      gatewayLogger.info(
        { basePath, mappingCount: allMappings.length, presets: webhooksConfig.presets },
        "Webhook mapping mounted on gateway",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Media serving routes
  // -------------------------------------------------------------------------

  if (defaultWorkspaceDir) {
    const mediaRoutes = createMediaRoutes({ mediaDir: safePath(defaultWorkspaceDir, "media"), tokenStore });
    gatewayHandle.app.route("/media", mediaRoutes);
    gatewayLogger.debug("Media serving routes mounted at /media/*");
  }

  // -------------------------------------------------------------------------
  // OpenAI-compatible API routes with Bearer token auth
  // -------------------------------------------------------------------------

  const openaiApi = new Hono<OpenaiApiEnv>();

  // Body size limit on OpenAI POST endpoints (default 1MB)
  const bodyLimitMw = bodyLimit({
    maxSize: deps.gwConfig.httpBodyLimitBytes ?? 1_048_576,
    onError: (c) => {
      return c.json({
        error: {
          message: "Request body too large",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      }, 413);
    },
  });
  openaiApi.use("/chat/completions", bodyLimitMw);
  openaiApi.use("/embeddings", bodyLimitMw);
  openaiApi.use("/responses", bodyLimitMw);

  // Bearer token auth middleware for all OpenAI routes
  openaiApi.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = extractBearerToken(authHeader) ?? "";
    const client = tokenStore.verify(token);
    if (!client) {
      return c.json({
        error: {
          message: "Unauthorized",
          type: "authentication_error",
          param: null,
          code: null,
        },
      }, 401);
    }
    // Enforce "api" or "rpc" scope on OpenAI-compatible endpoints
    if (!checkScope(client.scopes, "api") && !checkScope(client.scopes, "rpc")) {
      return c.json({
        error: {
          message: "Insufficient scope",
          type: "authorization_error",
          param: null,
          code: null,
        },
      }, 403);
    }
    c.set("clientScopes", Object.freeze([...client.scopes]));
    return next();
  });

  // OpenAI /v1/chat/completions
  // Resolve model aliases against the configured-agent catalog. Unknown or
  // ambiguous aliases are rejected instead of silently using another agent.
  const resolveModel = (modelId: string): { provider: string; modelId: string; agentId: string } | undefined => {
    const exactAgent = Object.hasOwn(agents, modelId) ? agents[modelId] : undefined;
    if (exactAgent) {
      return {
        provider: exactAgent.provider,
        modelId: exactAgent.model,
        agentId: modelId,
      };
    }
    const aliasMatches = Object.entries(agents).filter(([, agentCfg]) => (
      modelId === `${agentCfg.provider}/${agentCfg.model}` ||
      modelId === agentCfg.model
    ));
    if (aliasMatches.length !== 1) return undefined;
    const aliasMatch = aliasMatches[0];
    if (!aliasMatch) return undefined;
    const [agentId, agentCfg] = aliasMatch;
    return { provider: agentCfg.provider, modelId: agentCfg.model, agentId };
  };
  const completionsApp = createOpenaiCompletionsRoute({
    tenantId: container.config.tenantId,
    agentId: defaultAgentId,
    resolveModel,
    executeAgent: async ({
      message,
      currentUserText,
      systemPrompt,
      sessionKey,
      onDelta,
      traceId: requestedTraceId,
      agentId: requestedAgentId,
      authenticatedScopes = [],
      signal,
    }) => {
      const executionAgentId = requestedAgentId ?? defaultAgentId;
      const turnTraceId = resolveApiTraceId(requestedTraceId);
      const requestChannelId = sessionKey?.peerId ?? turnTraceId;
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        agentId: executionAgentId,
        userId: sessionKey?.userId ?? "openai-api",
        channelId: sessionKey?.channelId ?? "openai",
        ...(sessionKey?.peerId !== undefined ? { peerId: sessionKey.peerId } : {}),
      };
      const senderId = sessionKey?.peerId ?? "openai-api";
      const trustLevel = resolveApiTrustLevel(authenticatedScopes);
      const requestStartedAt = systemNowMs();
      const deliveryOrigin = createDeliveryOrigin({
        channelType: "openai",
        channelId: requestChannelId,
        userId: sk.userId,
        tenantId: sk.tenantId,
      });
      const endpoint = {
        channelType: "openai",
        channelInstanceId: "gateway",
        conversationId: requestChannelId,
        conversationKind: "direct" as const,
      };
      const conversation = createConversationLocator({
        tenantId: sk.tenantId,
        agentId: executionAgentId,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: sk.userId,
        },
      });
      if (!conversation.ok) throw conversation.error;
      const turnScope = {
        conversation: conversation.value.conversationScope,
        principal: { principalId: sk.userId },
        endpoint,
      };
      return runWithContext(
        {
          traceId: turnTraceId,
          tenantId: sk.tenantId,
          startedAt: requestStartedAt,
          trustLevel,
          channelType: "openai",
        },
        async () => {
          const resolvedContext = enrichCurrentContext({
            tenantId: sk.tenantId,
            userId: sk.userId,
            sessionKey: sk,
            agentId: executionAgentId,
            trustLevel,
            deliveryOrigin,
            turnScope,
          });
          if (!resolvedContext.ok) throw resolvedContext.error;
          const cancellation = bindApiExecutionCancellation({
            signal,
            traceId: turnTraceId,
            agentId: executionAgentId,
            channelType: "openai",
            channelId: requestChannelId,
            sessionKey: sk,
            conversationRef: conversation.value.conversationRef,
            sessionResolver,
            eventBus: container.eventBus,
            logger: gatewayLogger,
          });
          try {
            cancellation.throwIfAborted();
            const preparation = await cancellation.waitFor((async () => {
              const enrichedText = await preprocessMessageText(message);
              cancellation.throwIfAborted();
              const tools = await assembleToolsForAgent(executionAgentId);
              return { enrichedText, tools };
            })());
            cancellation.throwIfAborted();
            const messageId = randomUUID();
            const timestamp = systemNowMs();
            const msg: NormalizedMessage = {
              id: messageId,
              channelId: requestChannelId,
              channelType: "openai",
              senderId,
              text: preparation.enrichedText,
              timestamp,
              attachments: [],
              originalMessages: [{
                id: messageId,
                channelId: requestChannelId,
                channelType: "openai",
                senderId,
                text: currentUserText,
                timestamp,
              }],
              metadata: {
                ...(systemPrompt && { openaiSystemPrompt: systemPrompt }),
              },
            };
            const { result, lifecycle } = await executeWithLifecycle(
              executionAgentId,
              sk,
              turnTraceId,
              () => withConfigMutationFence(() => getExecutor(executionAgentId).execute(
                msg,
                sk,
                preparation.tools,
                onDelta,
                executionAgentId,
              )),
            );
            return {
              response: result.response,
              tokensUsed: result.tokensUsed,
              finishReason: result.finishReason,
              stepsExecuted: result.stepsExecuted,
              llmCalls: result.llmCalls,
              ...lifecycle,
              traceId: turnTraceId,
              agentId: executionAgentId,
              sessionKey: formatSessionKey(sk),
            };
          } finally {
            await cancellation.dispose();
          }
        },
      );
    },
    eventBus: container.eventBus,
    logger: gatewayLogger,
  });
  openaiApi.route("/chat/completions", completionsApp);

  // OpenAI /v1/models
  const modelsApp = createOpenaiModelsRoute({
    getCatalogEntries: () => {
      const entries = Object.entries(agents);
      const aliasCounts = new Map<string, number>();
      for (const [, agentCfg] of entries) {
        const alias = `${agentCfg.provider}/${agentCfg.model}`;
        aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
      }
      return entries.map(([agentId, agentCfg]) => {
        const alias = `${agentCfg.provider}/${agentCfg.model}`;
        const aliasIsUnambiguous = aliasCounts.get(alias) === 1 && !Object.hasOwn(agents, alias);
        return {
          id: aliasIsUnambiguous ? alias : agentId,
          provider: agentCfg.provider,
          modelId: agentCfg.model,
          displayName: alias,
          contextWindow: 200000,
        };
      });
    },
  });
  openaiApi.route("/models", modelsApp);

  // OpenAI /v1/embeddings
  const embeddingsApp = createOpenaiEmbeddingsRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cachedPort type is opaque at wiring boundary
    getEmbeddingPort: () => cachedPort as any,
    logger: gatewayLogger,
  });
  openaiApi.route("/embeddings", embeddingsApp);

  // OpenResponses /v1/responses
  const responsesApp = createResponsesRoute({
    resolveModel,
    tenantId: container.config.tenantId,
    agentId: defaultAgentId,
    executeAgent: async ({
      message,
      currentUserText,
      systemPrompt,
      sessionKey,
      onDelta,
      traceId: requestedTraceId,
      agentId: requestedAgentId,
      authenticatedScopes = [],
      signal,
    }) => {
      const executionAgentId = requestedAgentId ?? defaultAgentId;
      const turnTraceId = resolveApiTraceId(requestedTraceId);
      const requestChannelId = sessionKey?.peerId ?? turnTraceId;
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        agentId: executionAgentId,
        userId: sessionKey?.userId ?? "responses-api",
        channelId: sessionKey?.channelId ?? "responses",
        ...(sessionKey?.peerId !== undefined ? { peerId: sessionKey.peerId } : {}),
      };
      const senderId = sessionKey?.peerId ?? "responses-api";
      const trustLevel = resolveApiTrustLevel(authenticatedScopes);
      const requestStartedAt = systemNowMs();
      const deliveryOrigin = createDeliveryOrigin({
        channelType: "responses",
        channelId: requestChannelId,
        userId: sk.userId,
        tenantId: sk.tenantId,
      });
      const endpoint = {
        channelType: "responses",
        channelInstanceId: "gateway",
        conversationId: requestChannelId,
        conversationKind: "direct" as const,
      };
      const conversation = createConversationLocator({
        tenantId: sk.tenantId,
        agentId: executionAgentId,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: sk.userId,
        },
      });
      if (!conversation.ok) throw conversation.error;
      const turnScope = {
        conversation: conversation.value.conversationScope,
        principal: { principalId: sk.userId },
        endpoint,
      };
      return runWithContext(
        {
          traceId: turnTraceId,
          tenantId: sk.tenantId,
          startedAt: requestStartedAt,
          trustLevel,
          channelType: "responses",
        },
        async () => {
          const resolvedContext = enrichCurrentContext({
            tenantId: sk.tenantId,
            userId: sk.userId,
            sessionKey: sk,
            agentId: executionAgentId,
            trustLevel,
            deliveryOrigin,
            turnScope,
          });
          if (!resolvedContext.ok) throw resolvedContext.error;
          const cancellation = bindApiExecutionCancellation({
            signal,
            traceId: turnTraceId,
            agentId: executionAgentId,
            channelType: "responses",
            channelId: requestChannelId,
            sessionKey: sk,
            conversationRef: conversation.value.conversationRef,
            sessionResolver,
            eventBus: container.eventBus,
            logger: gatewayLogger,
          });
          try {
            cancellation.throwIfAborted();
            const preparation = await cancellation.waitFor((async () => {
              const enrichedText = await preprocessMessageText(message);
              cancellation.throwIfAborted();
              const tools = await assembleToolsForAgent(executionAgentId);
              return { enrichedText, tools };
            })());
            cancellation.throwIfAborted();
            const messageId = randomUUID();
            const timestamp = systemNowMs();
            const msg: NormalizedMessage = {
              id: messageId,
              channelId: requestChannelId,
              channelType: "responses",
              senderId,
              text: preparation.enrichedText,
              timestamp,
              attachments: [],
              originalMessages: [{
                id: messageId,
                channelId: requestChannelId,
                channelType: "responses",
                senderId,
                text: currentUserText,
                timestamp,
              }],
              metadata: {
                ...(systemPrompt && { openaiSystemPrompt: systemPrompt }),
              },
            };
            const { result, lifecycle } = await executeWithLifecycle(
              executionAgentId,
              sk,
              turnTraceId,
              () => withConfigMutationFence(() => getExecutor(executionAgentId).execute(
                msg,
                sk,
                preparation.tools,
                onDelta,
                executionAgentId,
              )),
            );
            return {
              response: result.response,
              tokensUsed: result.tokensUsed,
              finishReason: result.finishReason,
              stepsExecuted: result.stepsExecuted,
              llmCalls: result.llmCalls,
              ...lifecycle,
              traceId: turnTraceId,
              agentId: executionAgentId,
              sessionKey: formatSessionKey(sk),
            };
          } finally {
            await cancellation.dispose();
          }
        },
      );
    },
    eventBus: container.eventBus,
    logger: gatewayLogger,
  });
  openaiApi.route("/responses", responsesApp);

  // Mount auth-wrapped OpenAI API on gateway
  gatewayHandle.app.route("/v1", openaiApi);
  gatewayLogger.debug("OpenAI-compatible API routes mounted at /v1/*");
}
