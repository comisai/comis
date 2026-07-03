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
  SendMessageOptions,
} from "@comis/core";
import { runWithContext, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { classifyMsTeamsError } from "./errors.js";
import {
  mapMsTeamsActivityToNormalized,
  type TeamsActivity,
} from "./message-mapper.js";
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

/**
 * The Connector service URL used when a caller supplies none. The per-conversation
 * serviceUrl from the inbound activity should be preferred; this global-cloud
 * default keeps a bare send working.
 */
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

/**
 * A conservative conversation-id charset: the characters Teams conversation ids
 * use, with path separators and control characters excluded so the id cannot
 * escape the Connector REST path it is interpolated into.
 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:@._=+;-]+$/;

/** Reject a conversation id that is empty, `..`-escaping, or out of charset. */
function isSafeConversationId(id: string): boolean {
  return id.length > 0 && !id.includes("..") && CONVERSATION_ID_PATTERN.test(id);
}

/**
 * Bot Framework Connector service-host suffixes. A minted Connector bearer token
 * is only ever transmitted to a host under one of these, so an inbound activity
 * bearing a hostile serviceUrl cannot exfiltrate the token to an arbitrary
 * origin. A static defense-in-depth allowlist.
 */
const BF_SERVICE_HOST_SUFFIXES = [".botframework.com", ".trafficmanager.net"];

/**
 * A send target is safe only over https, free of a `..` traversal segment, and
 * hosted under a Bot Framework Connector service host — so the bearer token is
 * never sent to an arbitrary origin.
 */
function isSafeServiceUrl(serviceUrl: string): boolean {
  if (serviceUrl.includes("..")) return false;
  const parsed = tryCatch(() => new URL(serviceUrl));
  if (!parsed.ok || parsed.value.protocol !== "https:") return false;
  const host = parsed.value.hostname.toLowerCase();
  return BF_SERVICE_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

/** Resolve the send target, preferring an explicit serviceUrl; ensures a trailing slash. */
function resolveServiceUrl(options?: SendMessageOptions): string {
  const raw =
    typeof options?.extra?.serviceUrl === "string"
      ? options.extra.serviceUrl
      : DEFAULT_SERVICE_URL;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Resolve the reply target for a threaded channel/group reply. A direct message
 * carries none, so its activity is sent top-level.
 */
function resolveReplyToId(options?: SendMessageOptions): string | undefined {
  if (typeof options?.replyTo === "string" && options.replyTo.length > 0) {
    return options.replyTo;
  }
  const fromExtra = options?.extra?.replyToId;
  return typeof fromExtra === "string" && fromExtra.length > 0
    ? fromExtra
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

  const handlers: MessageHandler[] = [];
  const _channelId = "msteams-pending";

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
  function processEvent(activity: TeamsActivity): void {
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
      // No persistent connection to tear down.
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
      const serviceUrl = resolveServiceUrl(options);
      const replyToId = resolveReplyToId(options);

      // Path-safety gate: validate the interpolated segments before building the
      // REST path — a traversal id must never reach a fetch.
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

      const url = `${serviceUrl}v3/conversations/${conversationId}/activities`;
      const activityBody: Record<string, unknown> = { type: "message", text };
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

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      void params;
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
