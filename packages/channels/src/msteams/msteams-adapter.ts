// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Channel Adapter: a route-driven ChannelPort implementation.
 *
 * Teams delivers activities as HTTPS POSTs, so this adapter holds no socket and
 * no long-poll. `start()` validates credentials and marks the adapter connected;
 * inbound activities arrive through `handleWebhookEvents`, which the mounted
 * gateway ingress calls after it has authenticated the request. Each activity is
 * normalized, gated against the sender allowlist, and fanned out to the
 * registered message handlers under a fresh request context.
 *
 * Outbound `sendMessage` posts to the Bot Framework Connector REST API with a
 * cached bearer token: a direct message sends a top-level activity, while a
 * channel or group reply threads under the parent via `replyToId`.
 *
 * The adapter delivers a clean NormalizedMessage — external-content fencing is a
 * shared executor concern applied to every channel, deliberately not duplicated
 * here.
 *
 * @module
 */

import type {
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  MessageHandler,
  MsTeamsConversationStorePort,
  NormalizedReaction,
  ReactionHandler,
  SendMessageOptions,
  TimerPort,
} from "@comis/core";
import { runWithContext, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { classifyMsTeamsError } from "./errors.js";
import { buildMentionEntities } from "./mentions.js";
import {
  mapMsTeamsActivityToNormalized,
  resolveCaptureThreadId,
  type TeamsActivity,
} from "./message-mapper.js";
import {
  mapMsTeamsReaction,
  type TeamsReactionActivity,
} from "./msteams-reaction-binder.js";
import { rebuildConversationReference } from "./msteams-proactive.js";
import {
  createMsTeamsConnector,
  isSafeConversationId,
  isSafeServiceUrl,
} from "./msteams-connector.js";
import { createConnectorTokenProvider } from "./msteams-auth.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for the Microsoft Teams adapter. */
export interface MsTeamsAdapterDeps {
  /** Bot application (client) id. */
  appId: string;
  /** Bot application secret — sent only on the token request, never logged. */
  appPassword: string;
  /** Single-tenant directory id — required for the client-credentials grant. */
  tenantId: string;
  /** Sender ids (aadObjectId) and/or conversation ids allowed to reach handlers. */
  allowFrom: string[];
  /** "allowlist" (default) drops unknown senders; "open" processes any sender. */
  allowMode: "allowlist" | "open";
  /** Logger for the inbound/outbound boundary matrix. */
  logger: ComisLogger;
  /** Injected fetch, defaulting to the global; lets a unit test stub the send. */
  fetchImpl?: typeof fetch;
  /** Injected clock in ms, defaulting to systemNowMs; makes timing deterministic. */
  now?: () => number;
  /**
   * Injected timer for the typing keepalive. OPTIONAL — mirrors the `now`/`fetchImpl`
   * seams so the composition root stays typecheck-clean before it supplies its runtime
   * timers; when absent the typing keepalive degrades to a no-op (never a raw setTimeout).
   */
  timer?: TimerPort;
  /**
   * Persisted conversation-reference store. OPTIONAL — every inbound captures the
   * routing tuple here, and a proactive send (no caller serviceUrl) recovers it.
   * When absent, capture is skipped and a proactive send errs (never a wrong-host
   * default). Injected by the composition root as the core port type.
   */
  conversationStore?: MsTeamsConversationStorePort;
}

/**
 * The Teams adapter handle. Extends the base ChannelPort with the route-driven
 * `handleWebhookEvents` driver the gateway ingress calls; `handleWebhookEvents`
 * is deliberately NOT on the base ChannelPort (mirrors the LINE handle).
 */
export interface MsTeamsAdapterHandle extends ChannelPort {
  /** Process authenticated inbound Teams activities from the gateway ingress. */
  handleWebhookEvents(activities: TeamsActivity[]): void;
}

// ---------------------------------------------------------------------------
// Outbound send helpers (pure)
// ---------------------------------------------------------------------------

/** Ensure a service base URL ends in a single trailing slash for path composition. */
function withTrailingSlash(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Resolve the reply target. A Teams direct message is always sent top-level, so
 * a `dm` chatType forces no replyToId even when the caller supplies one (the
 * delivery layer stamps a reply target on every inbound). Channel and group
 * replies thread under the parent via replyToId; a proactive send with no
 * explicit reply target threads under the stored thread root (channel/group
 * references carry one, a 1:1 does not — so a DM stays top-level).
 */
function resolveReplyToId(
  options?: SendMessageOptions,
  fallbackThreadId?: string,
): string | undefined {
  // Honor "DM → top-level": never thread a direct message, whatever was passed.
  if (options?.extra?.chatType === "dm") return undefined;
  if (typeof options?.replyTo === "string" && options.replyTo.length > 0) {
    return options.replyTo;
  }
  const fromExtra = options?.extra?.replyToId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  return typeof fallbackThreadId === "string" && fallbackThreadId.length > 0
    ? fallbackThreadId
    : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Microsoft Teams adapter implementing the ChannelPort interface.
 *
 * Route-driven: `start()` validates the three secret-mode credentials and marks
 * the adapter connected without opening any connection. Inbound activities are
 * dispatched through `handleWebhookEvents`.
 */
export function createMsTeamsAdapter(
  deps: MsTeamsAdapterDeps,
): MsTeamsAdapterHandle {
  const now = deps.now ?? systemNowMs;

  // Cached client-credentials token provider for the outbound Connector send.
  const tokens = createConnectorTokenProvider({
    appId: deps.appId,
    appPassword: deps.appPassword,
    tenantId: deps.tenantId,
    logger: deps.logger,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });

  // Connector transport: the edit/delete REST mutations + the typing keepalive.
  // Shares the cached token; the adapter resolves the routing context and drives it.
  const connector = createMsTeamsConnector({
    tokens,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
    now,
    timer: deps.timer,
  });

  const handlers: MessageHandler[] = [];
  // Teams surfaces inbound reactions as messageReaction activities on the same
  // webhook; the send-reaction port methods stay omitted (Teams exposes no
  // bot-reaction send API), so only the inbound fanout is wired.
  const reactionHandlers: ReactionHandler[] = [];
  // Stable channel identity. This webhook adapter has no self-identity fetch
  // (unlike Slack resolving botUserId at start), so it reports a constant id.
  const _channelId = "msteams";

  // Health tracking. `_lastError` is a string because ChannelStatus.error is a
  // string; the message is captured on failure branches for getStatus().
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  /**
   * Process a single inbound activity: map → allowlist-gate → record liveness →
   * fan out to handlers under a fresh request context.
   */
  /**
   * Fan a mapped reaction out to the registered reaction handlers under a fresh
   * request context; a throwing or rejecting handler is logged and never aborts
   * the loop or its siblings (mirrors the message fanout).
   */
  function fanOutReactions(traceId: string, reaction: NormalizedReaction): void {
    void runWithContext(
      {
        traceId,
        startedAt: now(),
        channelType: "msteams",
        tenantId: "default",
        trustLevel: "admin",
      },
      () => {
        for (const handler of reactionHandlers) {
          try {
            Promise.resolve(handler(reaction)).catch((handlerErr) => {
              deps.logger.error(
                {
                  err: handlerErr,
                  hint: "Check the msteams inbound reaction handler",
                  errorKind: "internal" as const,
                },
                "Inbound reaction handler error",
              );
            });
          } catch (handlerErr) {
            deps.logger.error(
              {
                err: handlerErr,
                hint: "Check the msteams inbound reaction handler",
                errorKind: "internal" as const,
              },
              "Inbound reaction handler error",
            );
          }
        }
      },
    );
  }

  /**
   * Map an inbound messageReaction activity to a NormalizedReaction, gate the
   * reactor against the same allowlist the message path uses, and fan it out.
   */
  function processReaction(activity: TeamsReactionActivity): void {
    const reaction = mapMsTeamsReaction(activity);
    if (!reaction) return;

    if (
      deps.allowMode === "allowlist" &&
      !deps.allowFrom.includes(reaction.reactorId) &&
      !deps.allowFrom.includes(reaction.channelId)
    ) {
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          hint: "Add the aadObjectId or conversation.id to channels.msteams.allowFrom",
          errorKind: "precondition" as const,
        },
        "Inbound reaction from non-allowlisted reactor dropped",
      );
      return;
    }

    _lastMessageAt = now();

    // An inbound reaction is an inbound activity too: refresh the routing tuple so
    // a later proactive send recovers the freshest reference. Key by the same
    // stripped channelId the message path and a proactive send target; the thread
    // root is resolved identically so a reaction never clobbers a message capture.
    captureReference(activity, reaction.channelId, resolveCaptureThreadId(activity));

    const traceId = randomUUID();
    deps.logger.debug(
      { step: "channels-inbound", channelType: "msteams" as const, traceId },
      "Inbound reaction",
    );
    fanOutReactions(traceId, reaction);
  }

  /**
   * Fire-and-forget upsert of the conversation routing tuple on every inbound so a
   * later proactive send can recover it. The key is `conversationId` — the mapper's
   * stripped `normalized.channelId` (the ;messageid= thread suffix is carried
   * separately as `threadId`), NOT the raw `conversation.id`: a proactive send
   * targets that same stripped channelId, so keying by the raw id would miss on a
   * threaded reference. Tenant is `channelData.tenant.id` (fallback
   * `conversation.tenantId`). Skips when there is no store or no serviceUrl to route
   * with; a capture failure is logged at DEBUG and never breaks inbound delivery.
   */
  function captureReference(
    activity: TeamsActivity,
    conversationId: string,
    threadId: string | undefined,
  ): void {
    const store = deps.conversationStore;
    if (store === undefined) return;
    const serviceUrl = activity.serviceUrl;
    const tenantId =
      activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
    if (typeof serviceUrl !== "string" || serviceUrl.length === 0) return;
    if (typeof tenantId !== "string" || tenantId.length === 0) return;

    Promise.resolve(
      store.capture({
        conversationId,
        serviceUrl,
        tenantId,
        threadId,
        updatedAt: now(),
      }),
    ).then(
      (result) => {
        if (!result.ok) {
          deps.logger.debug(
            {
              channelType: "msteams" as const,
              hint: "Inspect the conversation store write path",
              errorKind: "internal" as const,
            },
            "Conversation reference capture returned an error",
          );
        }
      },
      (captureErr) => {
        deps.logger.debug(
          {
            channelType: "msteams" as const,
            err: captureErr,
            hint: "Inspect the conversation store write path",
            errorKind: "internal" as const,
          },
          "Conversation reference capture threw",
        );
      },
    );
  }

  /**
   * Resolve the Connector service context for an outbound call. A reply rides the
   * caller's `extra.serviceUrl` (the 228 path — never consults the store); a
   * proactive send (no serviceUrl) recovers the stored reference and RE-VALIDATES
   * its serviceUrl through the host allowlist before use. A miss (or no store)
   * errs — never a wrong-host default that would 403 or leak the token.
   */
  async function resolveConnectorServiceContext(
    conversationId: string,
    options?: SendMessageOptions,
  ): Promise<Result<{ serviceUrl: string; threadId?: string }, Error>> {
    const explicit =
      typeof options?.extra?.serviceUrl === "string"
        ? options.extra.serviceUrl
        : undefined;
    if (explicit !== undefined) {
      return ok({ serviceUrl: withTrailingSlash(explicit) });
    }

    const store = deps.conversationStore;
    const got = store !== undefined ? await store.get(conversationId) : undefined;
    if (got === undefined || !got.ok || got.value === undefined) {
      return err(new Error("no stored conversation reference for a proactive send"));
    }
    const rebuilt = rebuildConversationReference(got.value, isSafeServiceUrl);
    if (!rebuilt.ok) return err(rebuilt.error);
    return ok({
      serviceUrl: withTrailingSlash(rebuilt.value.serviceUrl),
      threadId: rebuilt.value.threadId,
    });
  }

  function processEvent(activity: TeamsActivity): void {
    // Reactions arrive as messageReaction activities on the same webhook; route
    // them to the reaction fanout before the message mapper (which skips them).
    if (activity.type === "messageReaction") {
      processReaction(activity as TeamsReactionActivity);
      return;
    }

    const normalized = mapMsTeamsActivityToNormalized(activity);
    if (!normalized) return;

    // Sender authorization: drop anyone whose aadObjectId AND conversation id are
    // both absent from the allowlist before the message reaches the pipeline.
    if (
      deps.allowMode === "allowlist" &&
      !deps.allowFrom.includes(normalized.senderId) &&
      !deps.allowFrom.includes(normalized.channelId)
    ) {
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          senderId: normalized.senderId,
          hint: "Add the aadObjectId or conversation.id to channels.msteams.allowFrom",
          errorKind: "precondition" as const,
        },
        "Inbound from non-allowlisted sender dropped",
      );
      return;
    }

    _lastMessageAt = now();

    // Capture the routing tuple so a later proactive send can recover it. Key by
    // the stripped normalized.channelId — the SAME id a proactive send targets —
    // not the raw conversation.id (which keeps the ;messageid= thread suffix).
    captureReference(
      activity,
      normalized.channelId,
      normalized.metadata.msteamsThreadId as string | undefined,
    );

    const traceId = randomUUID();
    normalized.metadata.traceId = traceId;

    deps.logger.info(
      {
        step: "channels-inbound",
        channelType: "msteams" as const,
        messageId: normalized.id,
        chatId: normalized.channelId,
        traceId,
      },
      "Inbound message",
    );

    void runWithContext(
      {
        traceId,
        startedAt: now(),
        channelType: "msteams",
        tenantId: "default",
        trustLevel: "admin",
      },
      () => {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(normalized)).catch((handlerErr) => {
              deps.logger.error(
                {
                  err: handlerErr,
                  hint: "Check the msteams inbound message handler",
                  errorKind: "internal" as const,
                },
                "Inbound message handler error",
              );
            });
          } catch (handlerErr) {
            deps.logger.error(
              {
                err: handlerErr,
                hint: "Check the msteams inbound message handler",
                errorKind: "internal" as const,
              },
              "Inbound message handler error",
            );
          }
        }
      },
    );
  }

  /** Extract an explicit typing serviceUrl from the action params (direct or under extra). */
  function resolveTypingServiceUrl(
    params: Record<string, unknown>,
  ): string | undefined {
    const direct =
      typeof params.serviceUrl === "string" ? params.serviceUrl : undefined;
    const extra = params.extra;
    const fromExtra =
      typeof extra === "object" &&
      extra !== null &&
      typeof (extra as { serviceUrl?: unknown }).serviceUrl === "string"
        ? (extra as { serviceUrl: string }).serviceUrl
        : undefined;
    return direct ?? fromExtra;
  }

  /** Health-state update for an edit/delete Connector result (the connector logs the branch). */
  function recordMutation(result: Result<void, Error>): Result<void, Error> {
    if (result.ok) {
      _lastMessageAt = now();
      _lastError = undefined;
    } else {
      _lastError = result.error.message;
    }
    return result;
  }

  /** A proactive edit/delete that could not recover a serviceUrl: WARN + record + err. */
  function mutationContextError(
    error: Error,
    op: "edit" | "delete",
  ): Result<void, Error> {
    _lastError = error.message;
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        op,
        hint: "Pass serviceUrl in extra, or capture an inbound so the edit/delete can recover its routing tuple",
        errorKind: "precondition" as const,
      },
      "Connector activity mutation blocked: no usable service url",
    );
    return err(error);
  }

  const adapter: MsTeamsAdapterHandle = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "msteams";
    },

    async start(): Promise<Result<void, Error>> {
      // Route-driven: the gateway mounts the inbound route externally. The only
      // start-time work is a credential pre-flight; no connection is opened.
      if (
        !deps.appId.trim() ||
        !deps.appPassword.trim() ||
        !deps.tenantId.trim()
      ) {
        const credErr = new Error(
          "Teams app credentials (appId, appPassword, tenantId) must not be empty",
        );
        deps.logger.error(
          {
            channelType: "msteams" as const,
            err: credErr,
            hint: "Set MSTEAMS_APP_PASSWORD and msteams.appId/tenantId",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(credErr);
      }

      _connected = true;
      _startedAt = now();
      deps.logger.info(
        { channelType: "msteams" as const, mode: "webhook" },
        "Adapter started",
      );
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      // No persistent connection to tear down; cancel any running typing keepalive.
      connector.stopTyping();
      _connected = false;
      deps.logger.info({ channelType: "msteams" as const }, "Adapter stopped");
      return ok(undefined);
    },

    async sendMessage(
      conversationId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const startedAt = now();

      // Path-safety gate: validate the conversation id before any store lookup or
      // REST path build — a traversal id must never reach a fetch.
      if (!isSafeConversationId(conversationId)) {
        _lastError = "conversation id failed the path-safety check";
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "Reject the conversation id: it must be free of path separators and '..'",
            errorKind: "precondition" as const,
          },
          "Connector send blocked: unsafe conversation id",
        );
        return err(new Error("unsafe conversation id"));
      }

      // Reply → the caller's serviceUrl; proactive (none) → the stored reference.
      const ctx = await resolveConnectorServiceContext(conversationId, options);
      if (!ctx.ok) {
        _lastError = ctx.error.message;
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "Pass serviceUrl in extra, or capture an inbound so a proactive send can recover its routing tuple",
            errorKind: "precondition" as const,
          },
          "Connector send blocked: no usable service url",
        );
        return err(ctx.error);
      }
      const serviceUrl = ctx.value.serviceUrl;
      const replyToId = resolveReplyToId(options, ctx.value.threadId);

      if (!isSafeServiceUrl(serviceUrl)) {
        _lastError = "service url failed the path-safety check";
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "Reject the serviceUrl: it must be an https Bot Framework Connector host (e.g. *.botframework.com / *.trafficmanager.net) free of '..'",
            errorKind: "precondition" as const,
          },
          "Connector send blocked: unsafe service url",
        );
        return err(new Error("unsafe service url"));
      }

      const tok = await tokens.getToken();
      if (!tok.ok) {
        _lastError = tok.error.message;
        return err(tok.error);
      }

      const url = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
      // Rewrite id-shape-valid @[Name](id) markup into <at>…</at> tags + paired
      // mention entities; text with no valid mention markup is left byte-identical.
      const built = buildMentionEntities(text);
      const activityBody: Record<string, unknown> = { type: "message", text: built.text };
      if (built.entities.length > 0) activityBody.entities = built.entities;
      // DM → top-level; channel/group → threaded reply under the parent.
      if (replyToId !== undefined) activityBody.replyToId = replyToId;

      const responded = await fromPromise(
        (deps.fetchImpl ?? fetch)(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tok.value}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(activityBody),
        }),
      );
      if (!responded.ok) {
        // No response reached us: a transport-level fault (undefined status).
        const classified = classifyMsTeamsError(undefined, responded.error);
        _lastError = responded.error.message;
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Connector send failed: no response from the connector",
        );
        return err(responded.error);
      }

      const res = responded.value;
      if (!res.ok) {
        const classified = classifyMsTeamsError(res.status);
        _lastError = `connector send returned status ${res.status}`;
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            status: res.status,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Connector send failed: connector returned an error status",
        );
        return err(new Error(`connector send returned status ${res.status}`));
      }

      const parsed = await fromPromise(res.json() as Promise<{ id?: string }>);
      const sentId =
        parsed.ok && typeof parsed.value.id === "string"
          ? parsed.value.id
          : "sent";

      _lastMessageAt = now();
      _lastError = undefined;
      deps.logger.info(
        {
          step: "channels-outbound",
          channelType: "msteams" as const,
          messageId: sentId,
          chatId: conversationId,
          durationMs: now() - startedAt,
        },
        "Outbound message",
      );
      return ok(sentId);
    },

    async editMessage(
      channelId: string,
      messageId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      // Reply → the caller's serviceUrl; an in-place edit with none recovers the
      // stored reference (the edit-in-place renderer supplies no serviceUrl).
      const ctx = await resolveConnectorServiceContext(channelId, options);
      if (!ctx.ok) return mutationContextError(ctx.error, "edit");
      return recordMutation(
        await connector.editActivity(ctx.value.serviceUrl, channelId, messageId, text),
      );
    },

    async deleteMessage(
      channelId: string,
      messageId: string,
    ): Promise<Result<void, Error>> {
      // deleteMessage carries no options, so it always recovers the serviceUrl the
      // inbound captured — exactly how the edit-in-place renderer calls it.
      const ctx = await resolveConnectorServiceContext(channelId);
      if (!ctx.ok) return mutationContextError(ctx.error, "delete");
      return recordMutation(
        await connector.deleteActivity(ctx.value.serviceUrl, channelId, messageId),
      );
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      if (action === "sendTyping") {
        // Suppressed during streaming (the streamed text is itself the activity):
        // cancel any running keepalive and do not start a new one.
        if (params.streaming === true) {
          connector.stopTyping();
          return ok({ typing: false });
        }
        // No timer injected → the keepalive degrades to a no-op.
        if (deps.timer === undefined) return ok({ typing: false });
        const conversationId =
          typeof params.chatId === "string"
            ? params.chatId
            : typeof params.channelId === "string"
              ? params.channelId
              : undefined;
        if (conversationId === undefined || !isSafeConversationId(conversationId)) {
          return ok({ typing: false });
        }
        // Reply-context typing rides the supplied serviceUrl; mid-turn typing with
        // none recovers it from the store (the orchestrator passes only chatId).
        const explicitServiceUrl = resolveTypingServiceUrl(params);
        const ctx = await resolveConnectorServiceContext(
          conversationId,
          explicitServiceUrl !== undefined
            ? { extra: { serviceUrl: explicitServiceUrl } }
            : undefined,
        );
        if (!ctx.ok || !isSafeServiceUrl(ctx.value.serviceUrl)) {
          return ok({ typing: false });
        }
        connector.startTyping(conversationId, ctx.value.serviceUrl);
        return ok({ typing: true });
      }

      if (action === "stopTyping") {
        connector.stopTyping();
        return ok({ typing: false });
      }

      const unsupportedErr = new Error(`Unsupported action: ${action} on msteams`);
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          err: unsupportedErr,
          hint: `Action '${action}' is not supported by the Microsoft Teams adapter`,
          errorKind: "validation" as const,
        },
        "Unsupported platform action",
      );
      return err(unsupportedErr);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    onReaction(handler: ReactionHandler): void {
      reactionHandlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "msteams",
        uptime:
          _connected && _startedAt !== undefined ? now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "webhook",
      };
    },

    handleWebhookEvents(activities: TeamsActivity[]): void {
      for (const activity of activities) {
        try {
          processEvent(activity);
        } catch (eventErr) {
          deps.logger.error(
            {
              err: eventErr,
              hint: "Check the msteams webhook event handler for unhandled errors",
              errorKind: "internal" as const,
            },
            "msteams: failed to process activity",
          );
        }
      }
    },
  };

  return adapter;
}
