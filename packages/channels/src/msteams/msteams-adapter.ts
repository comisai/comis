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
  AttachmentPayload,
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  MessageHandler,
  MsTeamsConversationStorePort,
  NormalizedMessage,
  NormalizedReaction,
  ReactionHandler,
  SendMessageOptions,
  TimerPort,
} from "@comis/core";
import { runWithContext, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  postConnectorActivity,
} from "./msteams-connector.js";
import { createConnectorTokenProvider } from "./msteams-auth.js";
import { normalizeCardAction } from "./msteams-actions.js";
import { renderMSTeamsCardAttachment } from "./msteams-rich-renderer.js";
import {
  resolveReplyToId,
  resolveTypingServiceUrl,
  withTrailingSlash,
} from "./msteams-adapter-outbound.js";

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
  /** Injected attachment-byte reader (default: node:fs/promises readFile); lets a test run sendAttachment disk-free. */
  readFileImpl?: (path: string) => Promise<Buffer>;
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
  /** The cached Connector bearer, exposed so the media resolver can authenticate a hosted-content fetch. */
  getConnectorToken(): Promise<Result<string, Error>>;
}

// ---------------------------------------------------------------------------
// Outbound send helpers
// ---------------------------------------------------------------------------

/** Default attachment byte reader — the url is a safePath temp file the outbound handler wrote (no path build here). */
const defaultReadFile: (path: string) => Promise<Buffer> = readFile;

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
   * The single sender-authorization gate every inbound path shares — message,
   * reaction, and card-action. In allowlist mode an inbound is admitted only when
   * its sender id OR its conversation id is on the allowlist; "open" mode admits
   * all. One authoritative gate: no path re-implements authorization, so the
   * default-deny decision is made in exactly one place for every inbound kind.
   */
  function isAllowedSender(senderId: string, channelId: string): boolean {
    if (deps.allowMode !== "allowlist") return true;
    return (
      deps.allowFrom.includes(senderId) || deps.allowFrom.includes(channelId)
    );
  }

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
   * Fan a normalized inbound message out to the registered message handlers under
   * a fresh request context; a throwing or rejecting handler is logged and never
   * aborts the loop or its siblings. Shared by the message and card-action paths.
   */
  function fanOutMessage(traceId: string, normalized: NormalizedMessage): void {
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

  /**
   * Map an inbound messageReaction activity to a NormalizedReaction, gate the
   * reactor against the same allowlist the message path uses, and fan it out.
   */
  function processReaction(activity: TeamsReactionActivity): void {
    const reaction = mapMsTeamsReaction(activity);
    if (!reaction) return;

    if (!isAllowedSender(reaction.reactorId, reaction.channelId)) {
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

  /**
   * Route a card-action invoke: normalize it to a button-callback message (the
   * normalizer sets the clicker id from the VERIFIED from.aadObjectId and drops
   * any unrendered verb or missing callback), then gate it through the SAME
   * sender allowlist the message path uses. An unlisted clicker is dropped before
   * onMessage — the card action reuses the one default-deny gate and adds no
   * parallel authorization. No conversation reference is captured: a button
   * callback is not a fresh inbound to reply to.
   */
  function processCardAction(activity: TeamsActivity): void {
    const result = normalizeCardAction(activity);
    if (result.message === null) {
      // Distinguish the benign "not our activity" drop (silent by design — a ping
      // or a non-card invoke) from the security-relevant rejects, each of which
      // gets a §2.7 WARN carrying hint + a distinct errorKind so a T-6
      // arbitrary-verb probe against the approval gate, or a legitimate approver
      // whose click vanished, is diagnosable via comis explain / fleet. The log
      // names the reject class and carries NO secret/token/raw-signature — it
      // mirrors the allowlist-drop WARN shape below.
      switch (result.reason) {
        case "ignored":
          break;
        case "unrendered-verb":
          deps.logger.warn(
            {
              channelType: "msteams" as const,
              hint: "Card-action verb is not in the rendered set; a click cannot invoke a method the bot never rendered",
              errorKind: "validation" as const,
            },
            "Inbound card action dropped: unrendered verb",
          );
          break;
        case "missing-callback":
          deps.logger.warn(
            {
              channelType: "msteams" as const,
              hint: "Card-action invoke carried no signed callback; the action is malformed",
              errorKind: "validation" as const,
            },
            "Inbound card action dropped: missing signed callback",
          );
          break;
        case "missing-clicker":
          deps.logger.warn(
            {
              channelType: "msteams" as const,
              hint: "Card-action activity carried no verified aadObjectId; the clicker cannot be authorized",
              errorKind: "precondition" as const,
            },
            "Inbound card action dropped: no verified clicker id",
          );
          break;
      }
      return;
    }

    const normalized = result.message;

    if (!isAllowedSender(normalized.senderId, normalized.channelId)) {
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
      "Inbound card action",
    );

    fanOutMessage(traceId, normalized);
  }

  function processEvent(activity: TeamsActivity): void {
    // Reactions arrive as messageReaction activities on the same webhook; route
    // them to the reaction fanout before the message mapper (which skips them).
    if (activity.type === "messageReaction") {
      processReaction(activity as TeamsReactionActivity);
      return;
    }

    // Card-action clicks arrive as invoke activities on the same webhook; route
    // them to the card-action path before the message mapper (which skips them),
    // so they traverse the same default-deny gate the message path uses.
    if (activity.type === "invoke") {
      processCardAction(activity);
      return;
    }

    const normalized = mapMsTeamsActivityToNormalized(activity);
    if (!normalized) return;

    // Sender authorization: drop anyone whose aadObjectId AND conversation id are
    // both absent from the allowlist before the message reaches the pipeline.
    if (!isAllowedSender(normalized.senderId, normalized.channelId)) {
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

    fanOutMessage(traceId, normalized);
  }

  /**
   * Health-state update for any outbound Connector result (the connector/helper
   * logs the failure branch). Generic over the ok value so the send path (the new
   * activity id) and the edit/delete path (void) share one health fold.
   */
  function recordActivity<T>(result: Result<T, Error>): Result<T, Error> {
    if (result.ok) {
      _lastMessageAt = now();
      _lastError = undefined;
    } else {
      _lastError = result.error.message;
    }
    return result;
  }

  /**
   * A send (text or attachment) whose serviceUrl could not be resolved: record +
   * WARN + err. Shared by sendMessage and sendAttachment so the "no usable service
   * url" branch is emitted in exactly one place.
   */
  function sendContextError(error: Error): Result<string, Error> {
    _lastError = error.message;
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "Pass serviceUrl in extra, or capture an inbound so a proactive send can recover its routing tuple",
        errorKind: "precondition" as const,
      },
      "Connector send blocked: no usable service url",
    );
    return err(error);
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
      // Reply → the caller's serviceUrl; proactive (none) → the stored reference.
      // The id/serviceUrl safety gates + token mint + POST + classification live in
      // the shared postConnectorActivity helper; this method only builds the body.
      const ctx = await resolveConnectorServiceContext(conversationId, options);
      if (!ctx.ok) return sendContextError(ctx.error);
      const replyToId = resolveReplyToId(options, ctx.value.threadId);

      // Rewrite id-shape-valid @[Name](id) markup into <at>…</at> tags + paired
      // mention entities; text with no valid mention markup is left byte-identical.
      const built = buildMentionEntities(text);
      const activityBody: Record<string, unknown> = { type: "message", text: built.text };
      if (built.entities.length > 0) activityBody.entities = built.entities;
      // DM → top-level; channel/group → threaded reply under the parent.
      if (replyToId !== undefined) activityBody.replyToId = replyToId;
      // Render options.buttons/cards into ONE Adaptive Card attachment, attached
      // only when present so a plain text send stays byte-identical to the bare
      // { type, text } body — a non-approval send carries no attachments key.
      const hasButtons = (options?.buttons?.length ?? 0) > 0;
      const hasCards = (options?.cards?.length ?? 0) > 0;
      if (hasButtons || hasCards) {
        activityBody.attachments = [
          renderMSTeamsCardAttachment(options?.cards ?? [], options?.buttons ?? []),
        ];
      }

      return recordActivity(
        await postConnectorActivity({
          serviceUrl: ctx.value.serviceUrl,
          conversationId,
          activityBody,
          tokens,
          fetchImpl: deps.fetchImpl,
          logger: deps.logger,
          now,
        }),
      );
    },

    async sendAttachment(
      conversationId: string,
      attachment: AttachmentPayload,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Reuses the sendMessage scaffolding verbatim (routing context → id/serviceUrl
      // safety → token → POST via postConnectorActivity); only the activity body
      // differs. Reply → the caller's serviceUrl; proactive (none) → the store.
      const ctx = await resolveConnectorServiceContext(conversationId, options);
      if (!ctx.ok) return sendContextError(ctx.error);
      const replyToId = resolveReplyToId(options, ctx.value.threadId);

      // Teams inline attachment support is IMAGES ONLY. Bot Framework reliably
      // renders an inline `data:` URI only for images; a file/video/audio inline
      // data: URI does not render, and for a multi-MB video base64-inlining reads
      // the whole file into memory and inflates it +33% past BF's inline limit (a
      // memory spike + a guaranteed rejection). A non-image attachment is therefore
      // delivered BY REFERENCE as a plain text message — the bytes are NOT read —
      // preserving the graceful text delivery the daemon callers had before Teams
      // implemented sendAttachment (proper file/video delivery is the deferred
      // FileConsent/SharePoint flow).
      if (attachment.type !== "image") {
        const label =
          attachment.fileName !== undefined && attachment.fileName.length > 0
            ? attachment.fileName
            : "a file";
        const referenceText =
          (attachment.caption !== undefined && attachment.caption.length > 0
            ? `${attachment.caption}\n`
            : "") +
          `[${label}] — Teams inline delivery currently supports images only; this attachment is available on the server.`;
        const referenceBody: Record<string, unknown> = { type: "message", text: referenceText };
        // DM → top-level; channel/group → threaded reply under the parent.
        if (replyToId !== undefined) referenceBody.replyToId = replyToId;
        deps.logger.debug(
          {
            channelType: "msteams" as const,
            attachmentType: attachment.type,
            hint: "Non-image attachment delivered by reference; Bot Framework renders inline data: URIs for images only",
          },
          "Connector attachment delivered by reference (non-image)",
        );
        return recordActivity(
          await postConnectorActivity({
            serviceUrl: ctx.value.serviceUrl,
            conversationId,
            activityBody: referenceBody,
            tokens,
            fetchImpl: deps.fetchImpl,
            logger: deps.logger,
            now,
          }),
        );
      }

      // Read the bytes the shared outbound handler already wrote to a safePath temp
      // file; Teams has no separate upload step, so the image inlines as a data: URI
      // on the activity. Neither the token nor the data URI is ever logged (T-5).
      const read = await fromPromise(
        (deps.readFileImpl ?? defaultReadFile)(attachment.url),
      );
      if (!read.ok) {
        _lastError = read.error.message;
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "Verify the outbound attachment temp file exists and is readable",
            errorKind: "resource" as const,
          },
          "Connector attachment send blocked: could not read the attachment bytes",
        );
        return err(read.error);
      }

      const mime = attachment.mimeType ?? "image/png";
      const activityBody: Record<string, unknown> = {
        type: "message",
        ...(attachment.caption ? { text: attachment.caption } : {}),
        attachments: [
          {
            contentType: mime,
            contentUrl: `data:${mime};base64,${read.value.toString("base64")}`,
            ...(attachment.fileName ? { name: attachment.fileName } : {}),
          },
        ],
      };
      // DM → top-level; channel/group → threaded reply under the parent.
      if (replyToId !== undefined) activityBody.replyToId = replyToId;

      return recordActivity(
        await postConnectorActivity({
          serviceUrl: ctx.value.serviceUrl,
          conversationId,
          activityBody,
          tokens,
          fetchImpl: deps.fetchImpl,
          logger: deps.logger,
          now,
        }),
      );
    },

    /** Expose the cached Connector bearer for the media resolver (delegating getter). */
    getConnectorToken: () => tokens.getToken(),

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
      return recordActivity(
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
      return recordActivity(
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
