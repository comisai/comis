// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway HTTP route mounting: webhooks, media serving, and OpenAI-compatible API.
 * Extracted from setup-gateway.ts to isolate route mounting (webhook sub-app,
 * media routes, OpenAI /v1/* endpoints with Bearer auth) into a single-concern module.
 * @module
 */

import type { NormalizedMessage, SessionKey, AppContainer, AppConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import {
  safePath,
  generateStrongToken,
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
  createTokenStore,
  type GatewayServerHandle,
} from "@comis/gateway";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";

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
    assembleToolsForAgent,
    preprocessMessageText,
    cachedPort,
    defaultWorkspaceDir,
  } = deps;

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
          const startMs = Date.now();
          let success = true;
          let error: string | undefined;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scheduler:wake event type not yet in EventMap
            container.eventBus.emit("scheduler:wake" as any, { source: "webhook" });
            gatewayLogger.info("Webhook triggered wake event");
          } catch (err: unknown) {
            success = false;
            error = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            container.eventBus.emit("diagnostic:webhook_delivered", {
              webhookId: _mapping.id ?? "unknown",
              source: _mapping.name ?? "webhook",
              event: "wake",
              statusCode: success ? 200 : 500,
              success,
              durationMs: Date.now() - startMs,
              error,
              timestamp: Date.now(),
            });
          }
        },
        onAgentAction: async (_mapping, renderedMessage, renderedSessionKey) => {
          const startMs = Date.now();
          let success = true;
          let error: string | undefined;
          try {
            const execAgentId = _mapping.agentId ?? defaultAgentId;
            const msg: NormalizedMessage = {
              id: randomUUID(),
              channelId: "webhook",
              channelType: "webhook",
              senderId: "webhook",
              text: renderedMessage,
              timestamp: Date.now(),
              attachments: [],
              metadata: { webhookMappingId: _mapping.id },
            };
            const sk: SessionKey = {
              tenantId: container.config.tenantId,
              userId: renderedSessionKey || "webhook",
              channelId: "webhook",
            };
            const tools = await assembleToolsForAgent(execAgentId);
            await getExecutor(execAgentId).execute(msg, sk, tools, undefined, execAgentId);
          } catch (err: unknown) {
            success = false;
            error = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            container.eventBus.emit("diagnostic:webhook_delivered", {
              webhookId: _mapping.id ?? "unknown",
              source: _mapping.name ?? "webhook",
              event: "agent_action",
              statusCode: success ? 200 : 500,
              success,
              durationMs: Date.now() - startMs,
              error,
              timestamp: Date.now(),
            });
          }
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

  const openaiApi = new Hono();

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
    return next();
  });

  // OpenAI /v1/chat/completions
  const completionsApp = createOpenaiCompletionsRoute({
    executeAgent: async ({ message, systemPrompt, sessionKey, onDelta }) => {
      const enrichedText = await preprocessMessageText(message);
      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: sessionKey?.channelId ?? "openai",
        channelType: "openai",
        senderId: sessionKey?.peerId ?? "openai-api",
        text: enrichedText,
        timestamp: Date.now(),
        attachments: [],
        metadata: {
          ...(systemPrompt && { openaiSystemPrompt: systemPrompt }),
        },
      };
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: sessionKey?.userId ?? "openai-api",
        channelId: sessionKey?.channelId ?? "openai",
      };
      const tools = await assembleToolsForAgent(defaultAgentId);
      const result = await getExecutor(defaultAgentId).execute(msg, sk, tools, onDelta, defaultAgentId);
      return {
        response: result.response,
        tokensUsed: result.tokensUsed,
        finishReason: result.finishReason,
      };
    },
    logger: gatewayLogger,
  });
  openaiApi.route("/chat/completions", completionsApp);

  // OpenAI /v1/models
  const modelsApp = createOpenaiModelsRoute({
    getCatalogEntries: () => {
      return Object.values(agents).map((agentCfg) => ({
        provider: agentCfg.provider,
        modelId: agentCfg.model,
        displayName: `${agentCfg.provider}/${agentCfg.model}`,
        contextWindow: 200000,
      }));
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
    executeAgent: async ({ message, sessionKey, onDelta }) => {
      const enrichedText = await preprocessMessageText(message);
      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: sessionKey?.channelId ?? "responses",
        channelType: "responses",
        senderId: sessionKey?.peerId ?? "responses-api",
        text: enrichedText,
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      };
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: sessionKey?.userId ?? "responses-api",
        channelId: sessionKey?.channelId ?? "responses",
      };
      const tools = await assembleToolsForAgent(defaultAgentId);
      const result = await getExecutor(defaultAgentId).execute(msg, sk, tools, onDelta, defaultAgentId);
      return {
        response: result.response,
        tokensUsed: result.tokensUsed,
        finishReason: result.finishReason,
      };
    },
    logger: gatewayLogger,
  });
  openaiApi.route("/responses", responsesApp);

  // Mount auth-wrapped OpenAI API on gateway
  gatewayHandle.app.route("/v1", openaiApi);
  gatewayLogger.debug("OpenAI-compatible API routes mounted at /v1/*");
}
