// SPDX-License-Identifier: Apache-2.0
/**
 * Message and platform-action RPC handler methods.
 * Covers 11 methods:
 *   message.send, message.reply, message.react, message.edit,
 *   message.delete, message.fetch, message.attach,
 *   discord.action, telegram.action, slack.action, whatsapp.action
 * Extracted from daemon.ts rpcCallInner switch block
 * @module
 */

import type { ChannelPort, ChannelPluginPort } from "@comis/core";
import type { RichButton, RichCard, RichEffect } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { safePath, PathTraversalError } from "@comis/core";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { deliverToChannel, formatForChannel } from "@comis/channels";
import { resolveAdapter, authorizeChannelAccess } from "../wiring/daemon-utils.js";

import type { RpcHandler } from "./types.js";

/** Minimal broadcast interface for gateway WebSocket push notifications. */
export interface WsBroadcaster {
  broadcast(method: string, params: unknown): boolean;
}

/** Dependencies required by message/platform-action handlers. */
export interface MessageHandlerDeps {
  adaptersByType: Map<string, ChannelPort>;
  /** Channel plugin registry for capability-based action gating (optional for backward compat). */
  channelPlugins?: Map<string, ChannelPluginPort>;
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  defaultAgentId: string;
  logger: ComisLogger;
  /** WebSocket connection manager for gateway push notifications (optional, set after gateway init). */
  wsConnections?: WsBroadcaster;
  /** Path to the media directory where files are served via /media/:id (optional, set after gateway init). */
  mediaDir?: string;
  /** Callback fired when an attachment is broadcast to gateway clients, allowing session persistence. */
  onGatewayAttachment?: (channelId: string, marker: string) => void;
  /** Delivery queue for crash-safe persistence */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** Resolves daemon NormalizedMessage.id UUIDs to platform-native message
   *  ids for delete/edit/react handlers. Optional — when absent, message_id
   *  passes through unchanged (which fails on Telegram for inbound UUIDs but
   *  works for native ids returned by message.send). */
  inboundMessageIdResolver?: import("../wiring/inbound-message-id-resolver.js").InboundMessageIdResolver;
}

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
// When channelPlugins is provided, unsupported actions are rejected before
// reaching the adapter, saving a tool call and producing a clear error.
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
 * Gracefully skips the check when channelPlugins is not provided (backward
 * compat) or when the channel type has no registered plugin (unknown channel).
 */
function assertCapability(
  method: string,
  channelType: string,
  plugins: Map<string, ChannelPluginPort> | undefined,
): void {
  if (!plugins) return;
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
 * Create message and platform-action RPC handlers.
 * @param deps - Injected dependencies (channel adapter registry)
 * @returns Record mapping method names to handler functions
 */
export function createMessageHandlers(deps: MessageHandlerDeps): Record<string, RpcHandler> {
  return {
    "message.send": async (params) => {
      const channelType = params.channel_type as string;
      const channelId = params.channel_id as string;
      const text = params.text as string;
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(params.buttons ? { buttons: params.buttons as RichButton[][] } : {}),
        ...(params.cards ? { cards: params.cards as RichCard[] } : {}),
        ...(params.effects ? { effects: params.effects as RichEffect[] } : {}),
        ...(params.thread_reply !== undefined ? { threadReply: params.thread_reply as boolean } : {}),
      };
      const result = await deliverToChannel(adapter, channelId, text, {
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        origin: "rpc:message.send",
      }, deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
      if (!result.ok) throw result.error;
      if (result.value.failedChunks > 0) throw new Error("Message delivery failed");
      return { messageId: result.value.chunks[0]?.messageId ?? "delivered", channelId };
    },

    "message.reply": async (params) => {
      const channelType = params.channel_type as string;
      const channelId = params.channel_id as string;
      const text = params.text as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, params.message_id as string, channelType, channelId);
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const extra: Record<string, unknown> = {
        ...(params.buttons ? { buttons: params.buttons as RichButton[][] } : {}),
        ...(params.cards ? { cards: params.cards as RichCard[] } : {}),
        ...(params.effects ? { effects: params.effects as RichEffect[] } : {}),
        ...(params.thread_reply !== undefined ? { threadReply: params.thread_reply as boolean } : {}),
      };
      const result = await deliverToChannel(adapter, channelId, text, {
        replyTo: messageId,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        origin: "rpc:message.reply",
      }, deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
      if (!result.ok) throw result.error;
      if (result.value.failedChunks > 0) throw new Error("Message delivery failed");
      return { messageId: result.value.chunks[0]?.messageId ?? "delivered", channelId };
    },

    "message.react": async (params) => {
      const channelType = params.channel_type as string;
      assertCapability("message.react", channelType, deps.channelPlugins);
      const channelId = params.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, params.message_id as string, channelType, channelId);
      const emoji = params.emoji as string;
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const result = await adapter.reactToMessage(channelId, messageId, emoji);
      if (!result.ok) throw result.error;
      return { reacted: true, channelId, messageId, emoji };
    },

    // AUDIT(498): All text->channel paths verified. sendMessage uses deliverToChannel
    // (formats internally). editMessage formats here. sendAttachment is binary-only.
    "message.edit": async (params) => {
      const channelType = params.channel_type as string;
      assertCapability("message.edit", channelType, deps.channelPlugins);
      const channelId = params.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, params.message_id as string, channelType, channelId);
      const text = params.text as string;
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const formatted = formatForChannel(text, channelType);
      const result = await adapter.editMessage(channelId, messageId, formatted);
      if (!result.ok) throw result.error;
      return { edited: true, channelId, messageId };
    },

    "message.delete": async (params) => {
      const channelType = params.channel_type as string;
      assertCapability("message.delete", channelType, deps.channelPlugins);
      const channelId = params.channel_id as string;
      const messageId = resolveMessageId(deps.inboundMessageIdResolver, params.message_id as string, channelType, channelId);
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const result = await adapter.deleteMessage(channelId, messageId);
      if (!result.ok) throw result.error;
      return { deleted: true, channelId, messageId };
    },

    "message.fetch": async (params) => {
      const channelType = params.channel_type as string;
      assertCapability("message.fetch", channelType, deps.channelPlugins);
      const channelId = params.channel_id as string;
      const limit = (params.limit as number) ?? 20;
      const before = params.before as string | undefined;
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const result = await adapter.fetchMessages(channelId, { limit, before });
      if (!result.ok) throw result.error;
      return { messages: result.value, channelId };
    },

    "message.attach": async (params) => {
      const channelType = params.channel_type as string;
      assertCapability("message.attach", channelType, deps.channelPlugins);
      const channelId = params.channel_id as string;
      authorizeChannelAccess(params._originChannelId as string | undefined, channelId, params._trustLevel as string | undefined);

      let attachmentUrl = params.attachment_url as string;

      // Resolve file:// URLs and absolute paths to validated local paths
      const isFileUrl = attachmentUrl.startsWith("file://");
      const isAbsPath = attachmentUrl.startsWith("/");
      if (isFileUrl || isAbsPath) {
        const rawPath = isFileUrl
          ? decodeURIComponent(new URL(attachmentUrl).pathname)
          : attachmentUrl;

        // Determine workspace dir for the calling agent
        const callerAgentId = (params._agentId as string | undefined) ?? deps.defaultAgentId;
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
        await mkdir(deps.mediaDir, { recursive: true });
        const fileBuffer = await readFile(attachmentUrl);
        const hash = createHash("sha256").update(fileBuffer).digest("hex").slice(0, 16);
        const ext = extname(attachmentUrl) || ".bin";
        const mediaId = `${hash}${ext}`;
        const mediaPath = safePath(deps.mediaDir, mediaId);

        await copyFile(attachmentUrl, mediaPath);

        // Write sidecar metadata for media-routes.ts content-type resolution
        const mimeType = (params.mime_type as string | undefined) ?? "application/octet-stream";
        await writeFile(
          `${mediaPath}.meta`,
          JSON.stringify({ contentType: mimeType, savedAt: Date.now(), size: fileBuffer.length }),
        );

        // Push notification to all gateway clients with attachment metadata
        const attachmentType = (params.attachment_type as string) ?? "file";
        const fileName = (params.file_name as string | undefined) ?? basename(attachmentUrl);
        const caption = params.caption as string | undefined;
        deps.wsConnections.broadcast("notification.attachment", {
          url: `/media/${mediaId}`,
          type: attachmentType,
          mimeType,
          fileName,
          caption,
          timestamp: Date.now(),
        });

        // Persist attachment marker to SQLite session so it survives page navigation
        if (deps.onGatewayAttachment) {
          const json = JSON.stringify({ url: `/media/${mediaId}`, type: attachmentType, mimeType, fileName });
          const marker = caption
            ? `${caption}\n\n<!-- attachment:${json} -->`
            : `<!-- attachment:${json} -->`;
          deps.onGatewayAttachment(channelId, marker);
        }

        return { messageId: mediaId, channelId };
      }

      // Non-gateway channel types use the adapter
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      const result = await adapter.sendAttachment(channelId, {
        type: (params.attachment_type as "image" | "file" | "audio" | "video") ?? "file",
        url: attachmentUrl,
        mimeType: params.mime_type as string | undefined,
        fileName: params.file_name as string | undefined,
        caption: params.caption as string | undefined,
      });
      if (!result.ok) throw result.error;
      return { messageId: result.value, channelId };
    },

    "discord.action": async (params) => {
      const channelType = "discord";
      const action = params.action as string;
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (params.channel_id) {
        authorizeChannelAccess(
          params._originChannelId as string | undefined,
          params.channel_id as string,
          params._trustLevel as string | undefined,
        );
      }
      const result = await adapter.platformAction(action, params);
      if (!result.ok) throw result.error;
      return result.value;
    },

    "telegram.action": async (params) => {
      const channelType = "telegram";
      const action = params.action as string;
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (params.chat_id) {
        authorizeChannelAccess(
          params._originChannelId as string | undefined,
          params.chat_id as string,
          params._trustLevel as string | undefined,
        );
      }
      const result = await adapter.platformAction(action, params);
      if (!result.ok) throw result.error;
      return result.value;
    },

    "slack.action": async (params) => {
      const channelType = "slack";
      const action = params.action as string;
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (params.channel_id) {
        authorizeChannelAccess(
          params._originChannelId as string | undefined,
          params.channel_id as string,
          params._trustLevel as string | undefined,
        );
      }
      const result = await adapter.platformAction(action, params);
      if (!result.ok) throw result.error;
      return result.value;
    },

    "whatsapp.action": async (params) => {
      const channelType = "whatsapp";
      const action = params.action as string;
      const adapter = resolveAdapter(channelType, deps.adaptersByType);
      if (params.group_jid) {
        authorizeChannelAccess(
          params._originChannelId as string | undefined,
          params.group_jid as string,
          params._trustLevel as string | undefined,
        );
      }
      const result = await adapter.platformAction(action, params);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}
