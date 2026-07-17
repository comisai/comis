// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Message and platform-action RPC handler methods.
 * Covers 11 methods:
 *   message.send, message.reply, message.react, message.edit,
 *   message.delete, message.fetch, message.attach,
 *   discord.action, telegram.action, slack.action, whatsapp.action
 *
 * Uses computed-property keys `[<Contract>.method]:` so the bidirectional
 * 1:1 architecture test resolves them to the registry. Per-method pipeline:
 * Zod parse runs AFTER stripInternalFields and serves as type narrowing +
 * dev-mode response shape check.
 *
 * @module
 */

import type { ChannelPluginPort } from "@comis/core";
import type { RichButton, RichCard, RichEffect } from "@comis/core";
import {
  safePath,
  PathTraversalError,
  formatForChannel,
  MessageSendContract,
  MessageReplyContract,
  MessageReactContract,
  MessageEditContract,
  MessageDeleteContract,
  MessageFetchContract,
  MessageAttachContract,
  DiscordActionContract,
  TelegramActionContract,
  SlackActionContract,
  WhatsappActionContract,
  stripInternalFields,
  requireCapability,
  CapabilityDeniedError,
  systemGetEnv,
  systemNowMs,
  formatSessionKey,
  parseFormattedSessionKey,
  tryGetContext,
  resolvePlatformDeliveryResult,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { resolveAdapter, authorizeChannelAccess } from "../wiring/daemon-utils.js";
import { wrapOutwardSend } from "./outward-ledger-wrap.js";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/** Minimal broadcast interface for gateway WebSocket push notifications. */
export interface WsBroadcaster {
  broadcast(method: string, params: unknown): boolean;
}

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: ChannelsApiDeps (shared with channel-handlers).
import type { ChannelsApiDeps as MessageHandlerDeps } from "./types.js";
export type { MessageHandlerDeps };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate the agent's `message_id` argument to the platform-native id when
 * it matches a recently-received inbound message UUID. Returns the original
 * value when no match (already-native id from message.send, expired UUID,
 * cross-channel mismatch). Always returns a string.
 */
function resolveMessageId(
  resolver: InboundMessageIdResolver | undefined,
  messageId: string,
  channelType: string,
  channelId: string,
): string {
  if (!resolver) return messageId;
  const record = resolver.resolve(messageId);
  if (!record) return messageId;
  if (record.channelType !== channelType) return messageId;
  if (record.channelId !== channelId) return messageId;
  return record.nativeId;
}

type InboundMessageIdResolver = NonNullable<MessageHandlerDeps["inboundMessageIdResolver"]>;

// ---------------------------------------------------------------------------
// Capability guard — maps RPC methods to ChannelCapability feature flags.
// Unsupported actions are rejected before reaching the adapter, saving a
// tool call and producing a clear error.
// ---------------------------------------------------------------------------

/** Map from RPC method name to the ChannelCapability.features key it requires. */
const ACTION_CAPABILITY_MAP: Record<string, string> = {
  "message.react": "reactions",
  "message.edit": "editMessages",
  "message.delete": "deleteMessages",
  "message.fetch": "fetchHistory",
  "message.attach": "attachments",
};

/**
 * Throw early if the channel does not support the requested action.
 * Skip the check when the channel type has no registered plugin (unknown
 * channel adapter). `plugins` is always supplied by the production
 * composition root (setup-channels-adapters.ts wires ≥9 plugin entries).
 */
function assertCapability(
  method: string,
  channelType: string,
  plugins: Map<string, ChannelPluginPort>,
): void {
  const featureKey = ACTION_CAPABILITY_MAP[method];
  if (!featureKey) return;
  const plugin = plugins.get(channelType);
  if (!plugin) return;
  const features = plugin.capabilities.features as Record<string, unknown>;
  if (!features[featureKey]) {
    const action = method.split(".")[1];
    throw new Error(
      `Action "${action}" is not supported on ${channelType}. This channel does not support ${featureKey}.`,
    );
  }
}

/**
 * Assert that an optional ChannelPort method is implemented on
 * the resolved adapter, and return a bound, non-undefined reference for direct
 * invocation. The production sentinel is `assertCapability()` which runs first
 * — this helper exists ONLY so TypeScript stops treating the now-optional
 * method as `undefined` after the gate has already passed. If the gate is
 * wired incorrectly (capability says supported but adapter omits the method)
 * we throw loudly here instead of crashing with TypeError later.
 */
function requireMethod<TMethod extends (...args: never[]) => unknown>(
  adapter: { channelType: string },
  methodName: string,
  method: TMethod | undefined,
): TMethod {
  if (typeof method !== "function") {
    throw new Error(
      `Channel "${adapter.channelType}" does not implement adapter.${methodName} but its capability gate claims support — fix plugin CAPABILITIES or adapter implementation.`,
    );
  }
  return method.bind(adapter) as TMethod;
}

/**
 * The outward irreversible-action gate for an agent-
 * initiated orch:message send. Called AFTER authorizeChannelAccess, BEFORE
 * deliver, for message.send/reply/react. Consults `boundedAutonomy.tryOutward`
 * (origin-only + per-target grant + per-hour + volume); on a deny it throws a
 * `CapabilityDeniedError` whose §2.7 WARN names the reason.
 *
 * NOT gated when: (a) there is no agent origin (`_agentId` absent — a daemon-
 * initiated cron/heartbeat send, mirroring authorizeChannelAccess's daemon-allow),
 * or (b) `boundedAutonomy` is not wired (older/non-autonomy daemon). `isOrigin` is
 * `channelId === _callerChannelId`; `volume` is the text length (react: the emoji).
 */
function enforceOutwardQuota(
  deps: MessageHandlerDeps,
  rawParams: Record<string, unknown>,
  channelId: string,
  volume: number,
): void {
  const agentId = rawParams._agentId as string | undefined;
  // Daemon-initiated (no agent origin) or no service wired → not gated.
  if (agentId === undefined || deps.boundedAutonomy === undefined) return;
  const isOrigin = channelId === (rawParams._callerChannelId as string | undefined);
  const quota = deps.boundedAutonomy.tryOutward(agentId, channelId, isOrigin, volume);
  if (!quota.ok) {
    deps.logger.warn(
      {
        agentId,
        channelId,
        errorKind: "validation" as const,
        hint: `outward quota: ${quota.error.reason} — the agent's send was bounded (autonomy.outward.* / autonomy.message.maxPerHour); only the origin channel + explicitly-granted targets are auto-allowable`,
      },
      "Outward message quota denied",
    );
    throw new CapabilityDeniedError("orch:message");
  }
}

/**
 * Resolve the `(rootRunId, outwardStepIndex)` idempotency
 * key for an outward send from the threaded raw params.
 *
 * `rootRunId` is injected by the authenticated RPC boundary. The
 * `_outwardStepIndex` is the monotonic step the RPC chokepoint
 * allocated + injected for EVERY autonomy outward call.
 *
 * `_outwardStepIndex` is read as-is — `undefined` ⇒ pass-through (no
 * ledger) in {@link wrapOutwardSend}. It is NEVER defaulted to 0 here (two
 * un-indexed sends would collide on the idempotency key and block one distinct
 * operation). A non-autonomy / interactive send has no rootRunId and no
 * step index, so the wrap is a pure pass-through.
 */
function resolveOutwardLedgerContext(
  deps: MessageHandlerDeps,
  rawParams: Record<string, unknown>,
): { rootRunId: string | undefined; outwardStepIndex: number | undefined } {
  const rootRunId = rawParams._rootRunId as string | undefined;
  // Read the injected step index verbatim — NEVER `?? 0`.
  const outwardStepIndex = rawParams._outwardStepIndex as number | undefined;
  return { rootRunId, outwardStepIndex };
}

/**
 * Create message and platform-action RPC handlers.
 * @param deps - Injected dependencies (channel adapter registry)
 * @returns Record mapping method names to handler functions
 */
export function createMessageHandlers(deps: MessageHandlerDeps): Record<string, RpcHandler> {
  return {
    [MessageSendContract.method]: async (rawParams) => {
      // In-process capability gate — the agent loop skips
      // checkScope, so orch:message is enforced here, reading the injected
      // _capabilities from raw params BEFORE the strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      const channelId = rawParams.channel_id as string;
      const text = rawParams.text as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);
      // Gate the outward send (origin/grant/per-hour/volume) for an
      // agent origin, before deliver. Volume = the message body length.
      enforceOutwardQuota(deps, rawParams, channelId, typeof text === "string" ? text.length : 1);

      const userParams = stripInternalFields(rawParams);
      MessageSendContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(rawParams.buttons ? { buttons: rawParams.buttons as RichButton[][] } : {}),
        ...(rawParams.cards ? { cards: rawParams.cards as RichCard[] } : {}),
        ...(rawParams.effects ? { effects: rawParams.effects as RichEffect[] } : {}),
        ...(rawParams.thread_reply !== undefined ? { threadReply: rawParams.thread_reply as boolean } : {}),
      };
      // Wrap the existing deliverToChannel with the closed five-state ledger
      // (begin → markUnknown → commit, fail, or unresolved park). A committed
      // operation identity short-circuits; an ambiguous outcome is parked and
      // escalated rather than queried or replayed. The quota gate above is
      // unchanged, and a send without rootRunId/step is a pure pass-through.
      const { rootRunId, outwardStepIndex } = resolveOutwardLedgerContext(deps, rawParams);
      const wrapResult = await wrapOutwardSend({
        ledger: deps.outwardLedger,
        rootRunId,
        outwardStepIndex,
        agentId: (rawParams._agentId as string | undefined) ?? "",
        channelType,
        channelId,
        operationKind: "message_send",
        operationOptions: extra,
        text: typeof text === "string" ? text : String(text),
        doSend: async () => {
          const dr = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
            extra: Object.keys(extra).length > 0 ? extra : undefined,
            origin: "rpc:message.send",
          });
          const platformDelivery = resolvePlatformDeliveryResult(dr);
          if (!platformDelivery.ok) return platformDelivery;
          if (platformDelivery.value.failedChunks > 0) return { ok: false as const, error: new Error("Message delivery failed") };
          const platformMessageId = platformDelivery.value.chunks[0]?.messageId;
          return platformMessageId === undefined || platformMessageId.length === 0
            ? err(new Error("Message delivery returned no platform receipt"))
            : ok({ messageId: platformMessageId });
        },
        logger: deps.logger,
      });
      if (!wrapResult.ok) throw wrapResult.error;
      const result = { messageId: wrapResult.value.messageId, channelId };
      if (IS_DEV) MessageSendContract.response.parse(result);
      return result;
    },

    [MessageReplyContract.method]: async (rawParams) => {
      // In-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      const channelId = rawParams.channel_id as string;
      const text = rawParams.text as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);
      // Gate the outward reply (volume = the reply body length).
      enforceOutwardQuota(deps, rawParams, channelId, typeof text === "string" ? text.length : 1);

      const userParams = stripInternalFields(rawParams);
      MessageReplyContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(rawParams.buttons ? { buttons: rawParams.buttons as RichButton[][] } : {}),
        ...(rawParams.cards ? { cards: rawParams.cards as RichCard[] } : {}),
        ...(rawParams.effects ? { effects: rawParams.effects as RichEffect[] } : {}),
        ...(rawParams.thread_reply !== undefined ? { threadReply: rawParams.thread_reply as boolean } : {}),
      };
      // Wrap the EXISTING delivery call as in message.send.
      const { rootRunId, outwardStepIndex } = resolveOutwardLedgerContext(deps, rawParams);
      const wrapResult = await wrapOutwardSend({
        ledger: deps.outwardLedger,
        rootRunId,
        outwardStepIndex,
        agentId: (rawParams._agentId as string | undefined) ?? "",
        channelType,
        channelId,
        operationKind: "message_reply",
        targetMessageId: messageId,
        operationOptions: extra,
        text: typeof text === "string" ? text : String(text),
        doSend: async () => {
          const dr = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
            replyTo: messageId,
            extra: Object.keys(extra).length > 0 ? extra : undefined,
            origin: "rpc:message.reply",
          });
          const platformDelivery = resolvePlatformDeliveryResult(dr);
          if (!platformDelivery.ok) return platformDelivery;
          if (platformDelivery.value.failedChunks > 0) return { ok: false as const, error: new Error("Message delivery failed") };
          const platformMessageId = platformDelivery.value.chunks[0]?.messageId;
          return platformMessageId === undefined || platformMessageId.length === 0
            ? err(new Error("Message delivery returned no platform receipt"))
            : ok({ messageId: platformMessageId });
        },
        logger: deps.logger,
      });
      if (!wrapResult.ok) throw wrapResult.error;
      const result = { messageId: wrapResult.value.messageId, channelId };
      if (IS_DEV) MessageReplyContract.response.parse(result);
      return result;
    },

    [MessageReactContract.method]: async (rawParams) => {
      // In-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      assertCapability("message.react", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      const emoji = rawParams.emoji as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);
      // Gate the outward reaction as ONE fixed unit.
      // A reaction is a single irreversible action; counting it as `emoji.length`
      // (1–few chars) made the per-action volumeCap (4000) effectively inert for
      // reactions while giving the unit inconsistent meaning vs send/reply (which
      // pass text.length). A flat 1 keeps the per-hour quota the real bound on
      // mass-react and makes the volume semantics uniform across actions.
      enforceOutwardQuota(deps, rawParams, channelId, 1);

      const userParams = stripInternalFields(rawParams);
      MessageReactContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const reactToMessage = requireMethod(adapter, "reactToMessage", adapter.reactToMessage);
      // Wrap the EXISTING reactToMessage with the ledger. A reaction sends an
      // emoji (not free text), so the emoji is the digest input. The real target
      // message id is the durable platform receipt; no synthetic id is created.
      const { rootRunId, outwardStepIndex } = resolveOutwardLedgerContext(deps, rawParams);
      const wrapResult = await wrapOutwardSend({
        ledger: deps.outwardLedger,
        rootRunId,
        outwardStepIndex,
        agentId: (rawParams._agentId as string | undefined) ?? "",
        channelType,
        channelId,
        operationKind: "message_react",
        targetMessageId: messageId,
        text: emoji,
        doSend: async () => {
          const reactResult = await reactToMessage(channelId, messageId, emoji);
          if (!reactResult.ok) return reactResult;
          return ok({ messageId });
        },
        logger: deps.logger,
      });
      if (!wrapResult.ok) throw wrapResult.error;
      const result = { reacted: true as const, channelId, messageId, emoji };
      if (IS_DEV) MessageReactContract.response.parse(result);
      return result;
    },

    // sendMessage formats through deliverToChannel, editMessage formats here,
    // and sendAttachment carries binary content rather than channel text.
    [MessageEditContract.method]: async (rawParams) => {
      // message.edit is admin-only and outside the agent's orch:message
      // capability. Agent origins are rejected by the admin-scope RPC gate;
      // authenticated admin gateway callers do not carry agent capabilities.
      const channelType = rawParams.channel_type as string;
      assertCapability("message.edit", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      const text = rawParams.text as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageEditContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const editMessage = requireMethod(adapter, "editMessage", adapter.editMessage);
      const formatted = formatForChannel(text, channelType);
      const editResult = await editMessage(channelId, messageId, formatted);
      if (!editResult.ok) throw editResult.error;
      const result = { edited: true as const, channelId, messageId };
      if (IS_DEV) MessageEditContract.response.parse(result);
      return result;
    },

    [MessageDeleteContract.method]: async (rawParams) => {
      // message.delete is admin-only and denied to non-admin request origins;
      // it is intentionally outside the agent's orch:message capability.
      const channelType = rawParams.channel_type as string;
      assertCapability("message.delete", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageDeleteContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const deleteMessage = requireMethod(adapter, "deleteMessage", adapter.deleteMessage);
      const delResult = await deleteMessage(channelId, messageId);
      if (!delResult.ok) throw delResult.error;
      const result = { deleted: true as const, channelId, messageId };
      if (IS_DEV) MessageDeleteContract.response.parse(result);
      return result;
    },

    [MessageFetchContract.method]: async (rawParams) => {
      const channelType = rawParams.channel_type as string;
      assertCapability("message.fetch", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      const limit = (rawParams.limit as number) ?? 20;
      const before = rawParams.before as string | undefined;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageFetchContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const fetchMessages = requireMethod(adapter, "fetchMessages", adapter.fetchMessages);
      const fetchResult = await fetchMessages(channelId, { limit, before });
      if (!fetchResult.ok) throw fetchResult.error;
      const result = { messages: fetchResult.value as unknown as Record<string, unknown>[], channelId };
      if (IS_DEV) MessageFetchContract.response.parse(result);
      return result;
    },

    [MessageAttachContract.method]: async (rawParams) => {
      // message.attach is admin-only and denied to non-admin request origins;
      // it is intentionally outside the agent's orch:message capability.
      const channelType = rawParams.channel_type as string;
      assertCapability("message.attach", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageAttachContract.request.parse(userParams);

      let attachmentUrl = rawParams.attachment_url as string;

      // Resolve file:// URLs and absolute paths to validated local paths
      const isFileUrl = attachmentUrl.startsWith("file://");
      const isAbsPath = attachmentUrl.startsWith("/");
      if (isFileUrl || isAbsPath) {
        const rawPath = isFileUrl
          ? decodeURIComponent(new URL(attachmentUrl).pathname)
          : attachmentUrl;

        // Determine workspace dir for the calling agent
        const callerAgentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
        const workspaceDir = deps.workspaceDirs.get(callerAgentId) ?? deps.defaultWorkspaceDir;

        // Validate path stays within workspace
        const relativePath = relative(workspaceDir, rawPath);
        try {
          safePath(workspaceDir, relativePath);
        } catch (e) {
          if (e instanceof PathTraversalError) {
            throw new Error(`Attachment path blocked: file must be inside workspace "${workspaceDir}"`, { cause: e });
          }
          throw e;
        }

        // Check file exists
        try {
          const fileStat = await stat(rawPath);
          deps.logger.debug(
            { channelType, chatId: channelId, filePath: rawPath, sizeBytes: fileStat.size },
            "Local file attachment resolved",
          );
        } catch {
          throw new Error(`Attachment file not found: ${rawPath}`);
        }

        attachmentUrl = rawPath;
      }

      // Gateway is a transport layer, not a ChannelPort adapter.
      // Serve the file via /media/:id and push a WebSocket notification.
      if (channelType === "gateway") {
        if (!deps.wsConnections || !deps.mediaDir) {
          throw new Error("Gateway attachment support requires wsConnections and mediaDir");
        }

        const { createHash } = await import("node:crypto");
        const { copyFile, writeFile, readFile, mkdir } = await import("node:fs/promises");
        const { basename, extname } = await import("node:path");
        // fs-safe-allowed: gateway-media output dir is operator-configured (`deps.mediaDir`); not ~/.comis/ directly
        await mkdir(deps.mediaDir, { recursive: true });
        const fileBuffer = await readFile(attachmentUrl);
        const hash = createHash("sha256").update(fileBuffer).digest("hex").slice(0, 16);
        const ext = extname(attachmentUrl) || ".bin";
        const mediaId = `${hash}${ext}`;
        const mediaPath = safePath(deps.mediaDir, mediaId);

        await copyFile(attachmentUrl, mediaPath);

        // Write sidecar metadata for media-routes.ts content-type resolution
        const mimeType = (rawParams.mime_type as string | undefined) ?? "application/octet-stream";
        // fs-safe-allowed: gateway-media sidecar `.meta` next to mediaPath in operator-configured mediaDir; not ~/.comis/ directly
        await writeFile(
          `${mediaPath}.meta`,
          JSON.stringify({ contentType: mimeType, savedAt: systemNowMs(), size: fileBuffer.length }),
        );

        const requestContext = tryGetContext();
        const sessionKey = requestContext?.sessionKey
          ? parseFormattedSessionKey(requestContext.sessionKey)
          : undefined;
        const hasMatchingSession = sessionKey?.channelId === channelId;

        const attachmentType = (rawParams.attachment_type as string) ?? "file";
        const fileName = (rawParams.file_name as string | undefined) ?? basename(attachmentUrl);
        const caption = rawParams.caption as string | undefined;
        if (hasMatchingSession && requestContext?.clientId && sessionKey) {
          deps.wsConnections.sendToClientId(requestContext.clientId, "notification.attachment", {
            sessionKey: formatSessionKey(sessionKey),
            channelId,
            url: `/media/${mediaId}`,
            type: attachmentType,
            mimeType,
            fileName,
            caption,
            timestamp: systemNowMs(),
          });
        } else if (hasMatchingSession) {
          deps.logger.warn({
            channelId,
            hint: "Use an authenticated gateway request so the attachment can be targeted to its client",
            errorKind: "precondition" as const,
          }, "Gateway attachment notification skipped without client identity");
        }

        // Persist attachment marker to SQLite session so it survives page navigation
        if (deps.onGatewayAttachment) {
          const json = JSON.stringify({ url: `/media/${mediaId}`, type: attachmentType, mimeType, fileName });
          const marker = caption
            ? `${caption}\n\n<!-- attachment:${json} -->`
            : `<!-- attachment:${json} -->`;
          if (hasMatchingSession && sessionKey) {
            deps.onGatewayAttachment(sessionKey, marker);
          } else {
            deps.logger.warn({
              channelId,
              hint: "Attach gateway media from the active gateway session so its history identity is available",
              errorKind: "precondition" as const,
            }, "Gateway attachment delivered without persistent session history");
          }
        }

        const result = {
          receipt: { kind: "tracked" as const, messageId: mediaId },
          channelId,
        };
        if (IS_DEV) MessageAttachContract.response.parse(result);
        return result;
      }

      // Non-gateway channel types use the adapter
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const sendAttachment = requireMethod(adapter, "sendAttachment", adapter.sendAttachment);
      const attachResult = await sendAttachment(channelId, {
        type: (rawParams.attachment_type as "image" | "file" | "audio" | "video") ?? "file",
        url: attachmentUrl,
        mimeType: rawParams.mime_type as string | undefined,
        fileName: rawParams.file_name as string | undefined,
        caption: rawParams.caption as string | undefined,
      });
      if (!attachResult.ok) throw attachResult.error;
      const result = { receipt: attachResult.value, channelId };
      if (IS_DEV) MessageAttachContract.response.parse(result);
      return result;
    },

    [DiscordActionContract.method]: async (rawParams) => {
      const channelType = "discord";
      const action = rawParams.action as string;

      const userParams = stripInternalFields(rawParams);
      DiscordActionContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (rawParams.channel_id) {
        authorizeChannelAccess(
          rawParams._callerChannelId as string | undefined,
          rawParams.channel_id as string,
          rawParams._trustLevel as string | undefined,
        );
      }
      const actionResult = await adapter.platformAction(action, rawParams);
      if (!actionResult.ok) throw actionResult.error;
      const result = actionResult.value as Record<string, unknown>;
      if (IS_DEV) DiscordActionContract.response.parse(result);
      return result;
    },

    [TelegramActionContract.method]: async (rawParams) => {
      const channelType = "telegram";
      const action = rawParams.action as string;

      const userParams = stripInternalFields(rawParams);
      TelegramActionContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (rawParams.chat_id) {
        authorizeChannelAccess(
          rawParams._callerChannelId as string | undefined,
          rawParams.chat_id as string,
          rawParams._trustLevel as string | undefined,
        );
      }
      const actionResult = await adapter.platformAction(action, rawParams);
      if (!actionResult.ok) throw actionResult.error;
      const result = actionResult.value as Record<string, unknown>;
      if (IS_DEV) TelegramActionContract.response.parse(result);
      return result;
    },

    [SlackActionContract.method]: async (rawParams) => {
      const channelType = "slack";
      const action = rawParams.action as string;

      const userParams = stripInternalFields(rawParams);
      SlackActionContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (rawParams.channel_id) {
        authorizeChannelAccess(
          rawParams._callerChannelId as string | undefined,
          rawParams.channel_id as string,
          rawParams._trustLevel as string | undefined,
        );
      }
      const actionResult = await adapter.platformAction(action, rawParams);
      if (!actionResult.ok) throw actionResult.error;
      const result = actionResult.value as Record<string, unknown>;
      if (IS_DEV) SlackActionContract.response.parse(result);
      return result;
    },

    [WhatsappActionContract.method]: async (rawParams) => {
      const channelType = "whatsapp";
      const action = rawParams.action as string;

      const userParams = stripInternalFields(rawParams);
      WhatsappActionContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (rawParams.group_jid) {
        authorizeChannelAccess(
          rawParams._callerChannelId as string | undefined,
          rawParams.group_jid as string,
          rawParams._trustLevel as string | undefined,
        );
      }
      const actionResult = await adapter.platformAction(action, rawParams);
      if (!actionResult.ok) throw actionResult.error;
      const result = actionResult.value as Record<string, unknown>;
      if (IS_DEV) WhatsappActionContract.response.parse(result);
      return result;
    },
  };
}
