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
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { resolveAdapter, authorizeChannelAccess } from "../wiring/daemon-utils.js";

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
  return method;
}

/**
 * Create message and platform-action RPC handlers.
 * @param deps - Injected dependencies (channel adapter registry)
 * @returns Record mapping method names to handler functions
 */
export function createMessageHandlers(deps: MessageHandlerDeps): Record<string, RpcHandler> {
  return {
    [MessageSendContract.method]: async (rawParams) => {
      // CAP-03/05 (v8 §3.7): in-process capability gate — the agent loop skips
      // checkScope, so orch:message is enforced here, reading the injected
      // _capabilities from raw params BEFORE the strip.
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      const channelId = rawParams.channel_id as string;
      const text = rawParams.text as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageSendContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(rawParams.buttons ? { buttons: rawParams.buttons as RichButton[][] } : {}),
        ...(rawParams.cards ? { cards: rawParams.cards as RichCard[] } : {}),
        ...(rawParams.effects ? { effects: rawParams.effects as RichEffect[] } : {}),
        ...(rawParams.thread_reply !== undefined ? { threadReply: rawParams.thread_reply as boolean } : {}),
      };
      const deliveryResult = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        origin: "rpc:message.send",
      });
      if (!deliveryResult.ok) throw deliveryResult.error;
      if (deliveryResult.value.failedChunks > 0) throw new Error("Message delivery failed");
      const result = { messageId: deliveryResult.value.chunks[0]?.messageId ?? "delivered", channelId };
      if (IS_DEV) MessageSendContract.response.parse(result);
      return result;
    },

    [MessageReplyContract.method]: async (rawParams) => {
      // CAP-03/05 (v8 §3.7): in-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      const channelId = rawParams.channel_id as string;
      const text = rawParams.text as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageReplyContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(rawParams.buttons ? { buttons: rawParams.buttons as RichButton[][] } : {}),
        ...(rawParams.cards ? { cards: rawParams.cards as RichCard[] } : {}),
        ...(rawParams.effects ? { effects: rawParams.effects as RichEffect[] } : {}),
        ...(rawParams.thread_reply !== undefined ? { threadReply: rawParams.thread_reply as boolean } : {}),
      };
      const deliveryResult = await deps.deliveryService.deliverToChannel(adapter, channelId, text, {
        replyTo: messageId,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        origin: "rpc:message.reply",
      });
      if (!deliveryResult.ok) throw deliveryResult.error;
      if (deliveryResult.value.failedChunks > 0) throw new Error("Message delivery failed");
      const result = { messageId: deliveryResult.value.chunks[0]?.messageId ?? "delivered", channelId };
      if (IS_DEV) MessageReplyContract.response.parse(result);
      return result;
    },

    [MessageReactContract.method]: async (rawParams) => {
      // CAP-03/05 (v8 §3.7): in-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

      const channelType = rawParams.channel_type as string;
      assertCapability("message.react", channelType, deps.channelPlugins);
      const channelId = rawParams.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, rawParams.message_id as string, channelType, channelId);
      const emoji = rawParams.emoji as string;
      authorizeChannelAccess(rawParams._callerChannelId as string | undefined, channelId, rawParams._trustLevel as string | undefined);

      const userParams = stripInternalFields(rawParams);
      MessageReactContract.request.parse(userParams);

      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const reactToMessage = requireMethod(adapter, "reactToMessage", adapter.reactToMessage);
      const reactResult = await reactToMessage(channelId, messageId, emoji);
      if (!reactResult.ok) throw reactResult.error;
      const result = { reacted: true as const, channelId, messageId, emoji };
      if (IS_DEV) MessageReactContract.response.parse(result);
      return result;
    },

    // AUDIT(498): All text->channel paths verified. sendMessage uses deliverToChannel
    // (formats internally). editMessage formats here. sendAttachment is binary-only.
    [MessageEditContract.method]: async (rawParams) => {
      // CAP-03/05 (v8 §3.7): in-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

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
      // CAP-03/05 (v8 §3.7): in-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

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
      // CAP-03/05 (v8 §3.7): in-process capability gate (see message.send).
      requireCapability(rawParams._capabilities as string[] | undefined, "orch:message");

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

        // Push notification to all gateway clients with attachment metadata
        const attachmentType = (rawParams.attachment_type as string) ?? "file";
        const fileName = (rawParams.file_name as string | undefined) ?? basename(attachmentUrl);
        const caption = rawParams.caption as string | undefined;
        deps.wsConnections.broadcast("notification.attachment", {
          url: `/media/${mediaId}`,
          type: attachmentType,
          mimeType,
          fileName,
          caption,
          timestamp: systemNowMs(),
        });

        // Persist attachment marker to SQLite session so it survives page navigation
        if (deps.onGatewayAttachment) {
          const json = JSON.stringify({ url: `/media/${mediaId}`, type: attachmentType, mimeType, fileName });
          const marker = caption
            ? `${caption}\n\n<!-- attachment:${json} -->`
            : `<!-- attachment:${json} -->`;
          deps.onGatewayAttachment(channelId, marker);
        }

        const result = { messageId: mediaId, channelId };
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
      const result = { messageId: attachResult.value, channelId };
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
