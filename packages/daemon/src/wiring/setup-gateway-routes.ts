// SPDX-License-Identifier: Apache-2.0
// @allow-throw: gateway-route wiring re-raise; consumed at daemon.ts bootstrap catch boundary.
/**
 * Gateway HTTP route mounting: webhooks, media serving, and OpenAI-compatible API.
 * Extracted from setup-gateway.ts to isolate route mounting (webhook sub-app,
 * media routes, OpenAI /v1/* endpoints with Bearer auth) into a single-concern module.
 * @module
 */

import type { NormalizedMessage, SessionKey, AppContainer, AppConfig, UserTrustLevel, ElevatedReplyConfig } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "@comis/agent";
import {
  safePath,
  generateStrongToken,
  systemNowMs,
  runWithContext,
  formatSessionKey,
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
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
// Defer a mid-turn config-change SIGUSR2 until the synchronous
// chat/responses-API response flushes.
import { withConfigMutationFence } from "../api/shared/persist-to-config.js";

// ---------------------------------------------------------------------------
// Context trust resolution for the token-authenticated API surfaces
// (OpenAI chat-completions + responses). The message CONTENT is still user
// input, so these paths default to the "user" UserTrustLevel — privileged
// platform tools (memory_manage delete/flush, agents_manage, …) stay gated.
//
// An operator can elevate the whole API surface to admin by setting the
// agent's `elevatedReply.defaultTrustLevel: admin` (the chat API's senderId is
// a random per-request peerId, so senderTrustMap can never target it — but the
// senderTrustMap branch is honored too for completeness / the responses path).
// This reconciles the two trust systems: previously `defaultTrustLevel: admin`
// only un-deferred the admin tools (made them visible) while the platform-tool
// execution guard still saw a HARD-CODED "user" and denied them
// ("permission_denied: requires admin, current level is user") — an incoherent
// half-state where the agent is handed a tool it cannot run. Mapping: the
// privileged elevatedReply value "admin" → UserTrustLevel "admin"; everything
// else (external/learned/system/unset) → "user" (the prior, safe default).
// ---------------------------------------------------------------------------

/**
 * Resolve the {@link UserTrustLevel} for a token-authenticated API request from
 * the agent's elevated-reply config. Pure: same inputs → same output.
 *
 * @param elevatedReply - the agent's elevatedReply config (may be undefined)
 * @param senderId - the inbound message senderId (for senderTrustMap lookup)
 * @returns "admin" iff the resolved elevatedReply trust is exactly "admin";
 *          otherwise "user" (never auto-elevates, never downgrades to guest).
 */
export function resolveContextTrustLevel(
  elevatedReply: ElevatedReplyConfig | undefined,
  senderId: string,
): UserTrustLevel {
  const resolved =
    elevatedReply?.senderTrustMap?.[senderId] ??
    elevatedReply?.defaultTrustLevel ??
    "external";
  return resolved === "admin" ? "admin" : "user";
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
  /** Deterministic unattended honest-fail backstop (webhook-claude-cli-tdd-20260701,
   *  `WEBHOOK-CLAUDE-AGENT-DRIVE-RELIABILITY`): after an unattended (webhook) agent turn, reap the
   *  LIVE terminal drives the turn created but NEVER tasked (no `send_text`) — the model
   *  nondeterministically hallucinates "I have no task", launches Claude Code, and ends the turn
   *  without delivering the task. Reaping ≥1 such drive means the task never ran → the webhook
   *  delivery is recorded as an HONEST failure (not a silent success with a leaked idle drive). The
   *  model-independent floor beneath the wait-tool `WAIT_TASK_NOT_DELIVERED_NOTE` best-effort recovery.
   *  Absent ⇒ inert (byte-identical to today). Wired in the composition root from `terminalRegistries`. */
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
    assembleToolsForAgent,
    preprocessMessageText,
    cachedPort,
    defaultWorkspaceDir,
    interactiveCallbackWiring,
    msTeamsIngress,
    reapNeverTaskedDrives,
  } = deps;

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
              durationMs: systemNowMs() - startMs,
              error,
              timestamp: systemNowMs(),
            });
          }
        },
        onAgentAction: async (_mapping, renderedMessage, renderedSessionKey) => {
          const startMs = systemNowMs();
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
              timestamp: systemNowMs(),
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
            // Deterministic honest-fail backstop (WEBHOOK-CLAUDE-AGENT-DRIVE-RELIABILITY): if the turn
            // launched Claude Code but ended WITHOUT delivering the task (a live never-tasked drive —
            // the "I have no task" flub the wait-tool directive can't reliably fix), reap it and record
            // an HONEST failure instead of the silent success this branch would otherwise report.
            // OWNER: the webhook route calls execute() DIRECTLY (it does not run the inbound pipeline's
            // resolveAndPreprocess that fills ctx.userId/sessionKey), so the RequestContext leaves both
            // UNSET → the terminal tools' resolveOwner falls back to `{ agentId: deps.agentId (=execAgentId),
            // sessionKey: "" }`. That fallback is the owner the drive is registered under — confirmed by the
            // descriptor ground truth ({agentId:"default", sessionKey:""}, webhook-claude-cli-tdd-20260701).
            if (reapNeverTaskedDrives) {
              const { reaped } = await reapNeverTaskedDrives(execAgentId, {
                agentId: execAgentId,
                sessionKey: "",
              });
              if (reaped.length > 0) {
                success = false;
                error = `agent ended the unattended webhook turn without delivering the task to Claude Code — reaped ${reaped.length} never-tasked terminal drive(s); the task did not run`;
                gatewayLogger.warn(
                  { execAgentId, reapedCount: reaped.length, webhookId: _mapping.id ?? "unknown", hint: "the driven coding CLI was launched but the task was never sent (send_text) — the task-delivery precondition for a successful drive was not met; re-fire the webhook or drive it interactively" },
                  "unattended webhook drive stranded a never-tasked terminal drive — reaped and recorded an honest failure",
                );
              }
            }
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
              durationMs: systemNowMs() - startMs,
              error,
              timestamp: systemNowMs(),
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
  // Model validation (live finding 2026-06-11): the route factory's
  // resolveModel → 404 guard was DEAD because the wiring never passed it —
  // model: "anything-at-all" returned 200 served by the default agent.
  // Accepted forms, all resolved against the configured agents (the same
  // catalog /v1/models advertises): "provider/model", the bare model id,
  // or an agent id. Anything else → 404 Model not found.
  const resolveModel = (modelId: string): { provider: string; modelId: string } | undefined => {
    for (const [agentId, agentCfg] of Object.entries(agents)) {
      const provider = agentCfg.provider;
      const model = agentCfg.model;
      if (
        modelId === `${provider}/${model}` ||
        modelId === model ||
        modelId === agentId
      ) {
        return { provider, modelId: model };
      }
    }
    return undefined;
  };
  const completionsApp = createOpenaiCompletionsRoute({
    resolveModel,
    executeAgent: async ({ message, systemPrompt, sessionKey, onDelta }) => {
      const enrichedText = await preprocessMessageText(message);
      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: sessionKey?.channelId ?? "openai",
        channelType: "openai",
        senderId: sessionKey?.peerId ?? "openai-api",
        text: enrichedText,
        timestamp: systemNowMs(),
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
      // §2.6 (live finding 2026-06-10): this route closure IS the channel entry
      // for the openai-compatible chat API — without runWithContext every executor log line is
      // traceId-less (no trace stitching) and the degraded reply cannot carry
      // its incident ref. One context per inbound request, minted here.
      // The traceId is minted OUTSIDE runWithContext so it can be returned to the route
      // and carried on the per-turn diagnostic:message_processed emit — the SAME key the
      // tool:executed observe() writes outcome_events with, so the Verified Learning
      // resolve loop (setup-learning.ts) finds the rows for this single-agent chat-API
      // turn (it fires neither graph:completed nor the channel pipeline's emit). Live
      // finding 2026-06-18: without this, chat-API turn outcomes were observed but NEVER
      // resolved (no reward/forget/skill-promote) and were invisible to obs.
      const turnTraceId = randomUUID();
      // Hold the config-mutation fence across the turn so a
      // config-mutating tool (heartbeat_manage/config.patch/…) that schedules a
      // SIGUSR2 restart mid-turn defers it until this synchronous HTTP response
      // flushes — otherwise the daemon restarts under the in-flight request and
      // the caller gets "Empty reply from server" even though the config applied.
      const result = await withConfigMutationFence(() => runWithContext(
        {
          traceId: turnTraceId,
          tenantId: sk.tenantId,
          userId: sk.userId,
          sessionKey: formatSessionKey(sk),
          startedAt: systemNowMs(),
          // Token-authenticated caller, but the message CONTENT is user input,
          // so the platform-tool trust defaults to "user". An operator may
          // elevate the whole chat API to admin via the agent's
          // elevatedReply.defaultTrustLevel — see resolveContextTrustLevel.
          trustLevel: resolveContextTrustLevel(agents[defaultAgentId]?.elevatedReply, msg.senderId),
          channelType: "openai",
        },
        () => getExecutor(defaultAgentId).execute(msg, sk, tools, onDelta, defaultAgentId),
      ));
      return {
        response: result.response,
        tokensUsed: result.tokensUsed,
        finishReason: result.finishReason,
        stepsExecuted: result.stepsExecuted,
        llmCalls: result.llmCalls,
        traceId: turnTraceId,
        agentId: defaultAgentId,
        // FORMATTED tenant-qualified key (tenantId:userId:channelId) so the per-turn
        // diagnostic carries the right tenant — the Verified Learning resolve derives
        // tenant via deriveTenantFromSessionKey and a 2-part key resolves the wrong pool.
        sessionKey: formatSessionKey(sk),
      };
    },
    eventBus: container.eventBus,
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
        timestamp: systemNowMs(),
        attachments: [],
        metadata: {},
      };
      const sk: SessionKey = {
        tenantId: container.config.tenantId,
        userId: sessionKey?.userId ?? "responses-api",
        channelId: sessionKey?.channelId ?? "responses",
      };
      const tools = await assembleToolsForAgent(defaultAgentId);
      // §2.6 (live finding 2026-06-10): this route closure IS the channel entry
      // for the OpenResponses API — without runWithContext every executor log line is
      // traceId-less (no trace stitching) and the degraded reply cannot carry
      // its incident ref. One context per inbound request, minted here.
      // Hold the config-mutation fence across the turn (see the
      // chat-completions path) so a mid-turn config-mutating tool's SIGUSR2
      // restart defers until this synchronous response flushes.
      const result = await withConfigMutationFence(() => runWithContext(
        {
          traceId: randomUUID(),
          tenantId: sk.tenantId,
          userId: sk.userId,
          sessionKey: formatSessionKey(sk),
          startedAt: systemNowMs(),
          // Token-authenticated caller, but the message CONTENT is user input,
          // so the platform-tool trust defaults to "user". An operator may
          // elevate via the agent's elevatedReply.defaultTrustLevel —
          // see resolveContextTrustLevel.
          trustLevel: resolveContextTrustLevel(agents[defaultAgentId]?.elevatedReply, msg.senderId),
          channelType: "responses",
        },
        () => getExecutor(defaultAgentId).execute(msg, sk, tools, onDelta, defaultAgentId),
      ));
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
