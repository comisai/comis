// SPDX-License-Identifier: Apache-2.0
/**
 * Unified message tool: multi-action tool for cross-channel messaging.
 *
 * Supports 7 actions: send, reply, react, edit, delete, fetch, attach.
 * Destructive action (delete) requires confirmation via action gate.
 * All actions delegate to the messaging backend via rpcCall indirection.
 * Requires channel_type for explicit adapter resolution.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import {
  readStringParam,
  readNumberParam,
  throwToolError,
  createActionGate,
} from "./tool-helpers.js";
import { createMultiActionDispatchTool } from "./messaging-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const MessageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("send"),
      Type.Literal("reply"),
      Type.Literal("react"),
      Type.Literal("edit"),
      Type.Literal("delete"),
      Type.Literal("fetch"),
      Type.Literal("attach"),
    ],
    { description: "Message action. Valid values: send (new message), reply (respond to message), react (add emoji reaction), edit (modify sent message), delete (remove message), fetch (retrieve message history), attach (send file/media)" },
  ),
  channel_type: Type.String({
    description: "Channel type: telegram, discord, slack, whatsapp",
  }),
  channel_id: Type.String({
    description: "Target channel/chat identifier",
  }),
  text: Type.Optional(
    Type.String({ description: "Message text (for send/reply/edit)" }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Target message ID (for reply/react/edit/delete)" }),
  ),
  emoji: Type.Optional(
    Type.String({ description: "Emoji to react with, Unicode format (for react)" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Max messages to fetch, default 20 (for fetch)" }),
  ),
  before: Type.Optional(
    Type.String({ description: "Fetch messages before this message ID (for fetch)" }),
  ),
  attachment_url: Type.Optional(
    Type.String({ description: "URL or workspace path of file to send: http(s)://, file://, or absolute path (for attach)" }),
  ),
  attachment_type: Type.Optional(
    Type.Union(
      [
        Type.Literal("image"),
        Type.Literal("file"),
        Type.Literal("audio"),
        Type.Literal("video"),
      ],
      { description: "Attachment media type (for attach, default: file). Valid values: image (photo/picture), file (generic document), audio (sound/voice), video (video clip)" },
    ),
  ),
  mime_type: Type.Optional(
    Type.String({ description: "MIME type of attachment (for attach)" }),
  ),
  file_name: Type.Optional(
    Type.String({ description: "Display filename (for attach)" }),
  ),
  caption: Type.Optional(
    Type.String({ description: "Caption text for attachment (for attach)" }),
  ),
  buttons: Type.Optional(
    Type.Array(Type.Array(Type.Object({
      text: Type.String(),
      callback_data: Type.Optional(Type.String({ maxLength: 64 })),
      url: Type.Optional(Type.String({ format: "uri" })),
      style: Type.Optional(Type.Union([
        Type.Literal("primary"), Type.Literal("secondary"),
        Type.Literal("danger"), Type.Literal("link"),
      ], { description: "Button style. Valid values: primary (prominent/blue), secondary (subtle/gray), danger (destructive/red), link (URL button)" })),
    })), { description: "Button rows for interactive messages (for send/reply). Each inner array is one row of buttons." }),
  ),
  cards: Type.Optional(
    Type.Array(Type.Object({
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      image_url: Type.Optional(Type.String({ format: "uri" })),
      color: Type.Optional(Type.Integer()),
      fields: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        value: Type.String(),
        inline: Type.Optional(Type.Boolean()),
      }))),
    }), { description: "Rich card embeds (for send/reply). Renders as embeds on Discord, blocks on Slack, HTML on Telegram." }),
  ),
  effects: Type.Optional(
    Type.Array(Type.Union([Type.Literal("spoiler"), Type.Literal("silent")]),
      { description: "Message delivery effects (for send/reply). Valid values: spoiler (wraps text in spoiler), silent (suppresses notification)" }),
  ),
  thread_reply: Type.Optional(
    Type.Boolean({ description: "Create or continue a thread from this message (for send/reply). Discord creates thread, Slack uses thread_ts." }),
  ),
  _confirmed: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when re-calling a destructive action after user approval. " +
        "When a gated action returns requiresConfirmation, present the action to the user, " +
        "and after they approve, call the same action again with _confirmed: true.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a unified message tool with 7 actions.
 *
 * The delete action is gated via createActionGate and returns
 * requiresConfirmation:true when the action is classified as destructive.
 *
 * @param rpcCall - RPC call function for delegating to the messaging backend
 * @returns AgentTool implementing the cross-channel messaging interface
 */
const VALID_ACTIONS = ["send", "reply", "react", "edit", "delete", "fetch", "attach"] as const;

export function createMessageTool(rpcCall: RpcCall): AgentTool<typeof MessageToolParams> {
  const deleteGate = createActionGate("message.delete");

  return createMultiActionDispatchTool(
    {
      name: "message",
      label: "Message",
      description:
        "Send, reply, react, edit, delete, fetch messages on active channel.",
      parameters: MessageToolParams,
      validActions: VALID_ACTIONS,
      actionHandler: async (action, p, rpcCall) => {
        const channel_type = readStringParam(p, "channel_type");
        const channel_id = readStringParam(p, "channel_id");

        switch (action) {
          case "send": {
            const text = readStringParam(p, "text");
            if (!text || !text.trim()) {
              throwToolError(
                "invalid_value",
                "Message text is empty or whitespace-only.",
                { param: "text", hint: "Provide meaningful message content. Do not send empty, whitespace, or placeholder messages." },
              );
            }
            const buttons = p.buttons as unknown;
            const cards = p.cards as unknown;
            const effects = p.effects as unknown;
            const thread_reply = p.thread_reply as boolean | undefined;
            return rpcCall("message.send", {
              channel_type, channel_id, text,
              ...(buttons ? { buttons } : {}),
              ...(cards ? { cards } : {}),
              ...(effects ? { effects } : {}),
              ...(thread_reply !== undefined ? { thread_reply } : {}),
            });
          }

          case "reply": {
            const text = readStringParam(p, "text");
            if (!text || !text.trim()) {
              throwToolError(
                "invalid_value",
                "Message text is empty or whitespace-only.",
                { param: "text", hint: "Provide meaningful message content. Do not send empty, whitespace, or placeholder messages." },
              );
            }
            const message_id = readStringParam(p, "message_id");
            const buttons = p.buttons as unknown;
            const cards = p.cards as unknown;
            const effects = p.effects as unknown;
            const thread_reply = p.thread_reply as boolean | undefined;
            return rpcCall("message.reply", {
              channel_type, channel_id, text, message_id,
              ...(buttons ? { buttons } : {}),
              ...(cards ? { cards } : {}),
              ...(effects ? { effects } : {}),
              ...(thread_reply !== undefined ? { thread_reply } : {}),
            });
          }

          case "react": {
            const emoji = readStringParam(p, "emoji");
            const message_id = readStringParam(p, "message_id");
            return rpcCall("message.react", { channel_type, channel_id, message_id, emoji });
          }

          case "edit": {
            const text = readStringParam(p, "text");
            if (!text || !text.trim()) {
              throwToolError(
                "invalid_value",
                "Message text is empty or whitespace-only.",
                { param: "text", hint: "Provide meaningful message content. Do not send empty, whitespace, or placeholder messages." },
              );
            }
            const message_id = readStringParam(p, "message_id");
            return rpcCall("message.edit", { channel_type, channel_id, message_id, text });
          }

          case "delete": {
            const gate = deleteGate(p);
            if (gate.requiresConfirmation) {
              return {
                requiresConfirmation: true,
                actionType: gate.actionType,
                hint: "Ask the user to confirm this message deletion, then call again with _confirmed: true.",
              };
            }
            const message_id = readStringParam(p, "message_id");
            return rpcCall("message.delete", { channel_type, channel_id, message_id });
          }

          case "fetch": {
            const limit = readNumberParam(p, "limit", false) ?? 20;
            const before = readStringParam(p, "before", false);
            return rpcCall("message.fetch", { channel_type, channel_id, limit, before });
          }

          default: {
            // action === "attach"
            const attachment_url = readStringParam(p, "attachment_url");
            if (attachment_url) {
              const isHttp = attachment_url.startsWith("http://") || attachment_url.startsWith("https://");
              const isFile = attachment_url.startsWith("file://");
              const isAbsPath = attachment_url.startsWith("/");
              if (!isHttp && !isFile && !isAbsPath) {
                throwToolError(
                  "invalid_value",
                  "Attachment URL must be http://, https://, file:// URL, or an absolute workspace path.",
                  { param: "attachment_url", hint: "Use a valid URL scheme or absolute path." },
                );
              }
            }
            const attachment_type = readStringParam(p, "attachment_type", false) ?? "file";
            const mime_type = readStringParam(p, "mime_type", false);
            const file_name = readStringParam(p, "file_name", false);
            const caption = readStringParam(p, "caption", false);
            return rpcCall("message.attach", {
              channel_type, channel_id, attachment_url, attachment_type,
              mime_type, file_name, caption,
            });
          }
        }
      },
    },
    rpcCall,
  );
}
