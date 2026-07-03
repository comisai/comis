// SPDX-License-Identifier: Apache-2.0
/**
 * Channels + message + platform-action RPC contracts. Mirrors the two daemon
 * handler factory files that share the `ChannelsApiDeps` cluster slice:
 *
 *   - `packages/daemon/src/api/channel-handlers.ts`  ( 8 methods — channels.* +
 *                                                     delivery.queue.status)
 *   - `packages/daemon/src/api/message-handlers.ts`  (11 methods — message.* +
 *                                                     4 platform.action)
 *
 * Both handler files map to the SAME ApiDeps slice (`ChannelsApiDeps`) and so
 * share one contract file. The aggregator below preserves per-handler grouping
 * via `// --- xxx-handlers.ts ---` comment blocks; the order within the array
 * is documentation-only (the bidirectional 1:1 test treats it as an unordered
 * set).
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations):
 *
 *   channel-handlers.ts:
 *   - `channels.list`            (admin per setup-gateway-api.ts:257-259)
 *   - `channels.get`             (admin)
 *   - `channels.enable`          (admin — in-handler `_trustLevel === "admin"` gate)
 *   - `channels.disable`         (admin — in-handler gate)
 *   - `channels.restart`         (admin — in-handler gate)
 *   - `channels.health`          (rpc per setup-gateway-api.ts:277)
 *   - `channels.capabilities`    (rpc)
 *   - `delivery.queue.status`    (rpc — registered intrinsically via
 *                                 channel-handlers; read-only observability)
 *
 *   message-handlers.ts:
 *   - `message.send`             (rpc — outward-send subset; see the scope
 *                                 rationale on the contract)
 *   - `message.reply`            (rpc — outward-send subset)
 *   - `message.edit`             (admin)
 *   - `message.delete`           (admin)
 *   - `message.fetch`            (admin)
 *   - `message.react`            (rpc — outward-send subset)
 *   - `message.attach`           (admin)
 *   - `telegram.action`          (admin)
 *   - `discord.action`           (admin)
 *   - `slack.action`             (admin)
 *   - `whatsapp.action`          (admin)
 *
 * **Loose-record use** (escape hatch). Several request and response positions
 * carry loosely-typed payloads:
 *
 *   - `message.send / .reply.request` — `buttons`, `cards`, `effects` are rich
 *     content payloads (RichButton[][], RichCard[], RichEffect[] from
 *     @comis/core); modelled as `z.array(z.record(z.string(), z.unknown()))`
 *     because tight modeling would re-encode the entire rich-content surface
 *     in the contract.
 *   - `message.fetch.response.messages` — array of platform-shaped message
 *     records (ChannelMessage from @comis/core); modelled as loose-array
 *     because each channel's wire format differs.
 *   - `discord.action / telegram.action / slack.action / whatsapp.action`
 *     request + response — platform-action requests carry arbitrary platform-
 *     specific parameters (e.g., telegram's `chat_id`, discord's `guildId`);
 *     responses carry adapter.platformAction's return value (varies by
 *     adapter). Both modelled as loose-record.
 *   - `channels.capabilities.response.features` — feature map varies by
 *     plugin (`reactions`, `editMessages`, etc.); modelled as loose-record.
 *
 * Modelling these tighter would pin per-platform wire formats across daemon
 * restarts on every channel feature addition. The authoritative validation
 * is the adapter's own typing; the contract is type narrowing + dev-mode
 * shape-regression canary.
 *
 * **Allowlist compliance.** All schemas use the 12-shape allowlist:
 * z.object, z.string (bare `z.string()` everywhere — no `.url()` /
 * `.regex()` refinements), z.number, z.boolean, z.literal, z.enum, z.array,
 * z.nullable, z.optional, z.record (loose-record value-type).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// --- channel-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// channels.health
// ---------------------------------------------------------------------------

/**
 * `channels.health` — Channel health summary (read-only observability).
 * Rpc-scoped per setup-gateway-api.ts:277. Handler path: channel-handlers.ts:36-55.
 *
 * Returns an empty `channels: []` + `enabled: false` when `deps.healthMonitor`
 * is undefined; otherwise iterates the monitor's getHealthSummary() entries
 * and projects each into a tight shape (channelType, state, connectionMode,
 * timing fields, restart counts, uptimeMs).
 *
 * Request: `{}`.
 * Response: `{ channels: HealthEntry[], timestamp: number, enabled: boolean }`.
 */
export const ChannelsHealthContract = defineContract({
  method: "channels.health",
  request: z.object({}),
  response: z.object({
    channels: z.array(z.object({
      channelType: z.string(),
      state: z.string(),
      connectionMode: z.string(),
      lastCheckedAt: z.number(),
      lastMessageAt: z.nullable(z.number()),
      error: z.nullable(z.string()),
      stateChangedAt: z.number(),
      consecutiveFailures: z.number(),
      activeRuns: z.number(),
      restartAttempts: z.number(),
      uptimeMs: z.number(),
    })),
    timestamp: z.number(),
    enabled: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// delivery.queue.status
// ---------------------------------------------------------------------------

/**
 * `delivery.queue.status` — Per-status counts in the delivery queue.
 * Read-only observability. Handler path: channel-handlers.ts:58-66.
 *
 * Bespoke pre-Zod validation: none — empty params accepted, optional
 * channel_type filter.
 *
 * Returns all zeros when `deps.deliveryQueue` is undefined; otherwise calls
 * `deps.deliveryQueue.statusCounts(channel_type)` and throws on Result error.
 *
 * Request: `{ channel_type? }`.
 * Response: `{ pending, inFlight, failed, delivered, expired }`.
 */
export const DeliveryQueueStatusContract = defineContract({
  method: "delivery.queue.status",
  request: z.object({
    channel_type: z.string().optional(),
  }),
  response: z.object({
    pending: z.number(),
    inFlight: z.number(),
    failed: z.number(),
    delivered: z.number(),
    expired: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// channels.capabilities
// ---------------------------------------------------------------------------

/**
 * `channels.capabilities` — Platform capabilities features for a channel.
 * Rpc-scoped per setup-gateway-api.ts:277. Handler path: channel-handlers.ts:69-75.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `channel_type` → `"Missing required parameter: channel_type"`.
 *   - Unknown channel type in `channelPlugins` → `"Channel type not found: <type>"`.
 *
 * LOOSE-RECORD for `features`: the feature map varies by plugin
 * (reactions, editMessages, deleteMessages, fetchHistory, attachments,
 * threads, mentions, formatting, buttons, cards, effects). Tight modeling
 * would re-encode the ChannelCapability surface in the contract.
 *
 * Request: `{ channel_type }`.
 * Response: `{ channelType, features: LooseRecord }`.
 */
export const ChannelsCapabilitiesContract = defineContract({
  method: "channels.capabilities",
  request: z.object({
    channel_type: z.string(),
  }),
  response: z.object({
    channelType: z.string(),
    features: z.record(z.string(), z.unknown()),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// channels.list
// ---------------------------------------------------------------------------

/**
 * `channels.list` — List all channel adapters with their running/stopped
 * status. Admin-scoped per setup-gateway-api.ts:257-259. Handler path:
 * channel-handlers.ts:78-105.
 *
 * Iterates `deps.adaptersByType` (running) + `deps.channelConfig` (configured-
 * but-stopped). Each entry carries `channelType`, optional `channelId`, and
 * `status: "running" | "stopped"`.
 *
 * Request: `{}`.
 * Response: `{ channels: ChannelListEntry[], total: number }`.
 */
export const ChannelsListContract = defineContract({
  method: "channels.list",
  request: z.object({}),
  response: z.object({
    channels: z.array(z.object({
      channelType: z.string(),
      channelId: z.string().optional(),
      status: z.enum(["running", "stopped"]),
    })),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// channels.get
// ---------------------------------------------------------------------------

/**
 * `channels.get` — Get detailed info for a single channel adapter. Admin-
 * scoped per setup-gateway-api.ts:257-259. Handler path: channel-handlers.ts:108-133.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `channel_type` → `"Missing required parameter: channel_type"`.
 *   - Not in adaptersByType AND not in channelConfig → `"Channel type not found"`.
 *
 * Two response variants:
 *   - Running: `{ channelType, channelId, status: "running" }`.
 *   - Stopped/configured: `{ channelType, status: "stopped", configured: true }`.
 *
 * Modelled as a single response schema with optional `channelId` and
 * optional `configured` boolean; `status` is a tight enum.
 *
 * Request: `{ channel_type }`.
 * Response: `{ channelType, channelId?, status, configured? }`.
 */
export const ChannelsGetContract = defineContract({
  method: "channels.get",
  request: z.object({
    channel_type: z.string(),
  }),
  response: z.object({
    channelType: z.string(),
    channelId: z.string().optional(),
    status: z.enum(["running", "stopped"]),
    configured: z.boolean().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// channels.enable
// ---------------------------------------------------------------------------

/**
 * `channels.enable` — Enable (start) a channel adapter. Admin-only. Handler
 * path: channel-handlers.ts:136-183.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for channel management"`.
 *   - Missing `channel_type` → `"Missing required parameter: channel_type"`.
 *   - Not in adaptersByType → `"Channel type not found or not configured"`.
 *
 * Calls `adapter.start()`, registers with healthMonitor, persists best-effort
 * to config.yaml.
 *
 * Request: `{ channel_type }`.
 * Response: `{ channelType, status: "running", message: "Channel adapter started" }`.
 */
export const ChannelsEnableContract = defineContract({
  method: "channels.enable",
  request: z.object({
    channel_type: z.string(),
  }),
  response: z.object({
    channelType: z.string(),
    status: z.literal("running"),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// channels.disable
// ---------------------------------------------------------------------------

/**
 * `channels.disable` — Disable (stop) a channel adapter. Admin-only. Handler
 * path: channel-handlers.ts:186-233.
 *
 * Bespoke pre-Zod validation: same as channels.enable.
 *
 * Calls `adapter.stop()`, deregisters from healthMonitor, persists best-effort
 * to config.yaml.
 *
 * Request: `{ channel_type }`.
 * Response: `{ channelType, status: "stopped", message: "Channel adapter stopped" }`.
 */
export const ChannelsDisableContract = defineContract({
  method: "channels.disable",
  request: z.object({
    channel_type: z.string(),
  }),
  response: z.object({
    channelType: z.string(),
    status: z.literal("stopped"),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// channels.restart
// ---------------------------------------------------------------------------

/**
 * `channels.restart` — Restart a channel adapter (stop then start). Admin-only.
 * Handler path: channel-handlers.ts:236-267.
 *
 * Bespoke pre-Zod validation: same as channels.enable. Plus: if stop fails,
 * start is NOT called.
 *
 * Request: `{ channel_type }`.
 * Response: `{ channelType, status: "running", message: "Channel adapter restarted" }`.
 */
export const ChannelsRestartContract = defineContract({
  method: "channels.restart",
  request: z.object({
    channel_type: z.string(),
  }),
  response: z.object({
    channelType: z.string(),
    status: z.literal("running"),
    message: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- message-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// message.send
// ---------------------------------------------------------------------------

/**
 * `message.send` — Send a text message via a channel adapter. Rpc-scoped
 * (see the scope rationale on the contract). Handler path: message-handlers.ts:104-123.
 *
 * Authorizes channel access via `authorizeChannelAccess`. Resolves adapter
 * via `resolveAdapter`. Optional rich content (`buttons`, `cards`, `effects`)
 * passed via `extra` to `deliveryService.deliverToChannel`.
 *
 * LOOSE-ARRAY for `buttons`, `cards`, `effects` request positions: rich
 * content shapes (RichButton[][], RichCard[], RichEffect[] from @comis/core).
 * Tight modeling would re-encode the entire rich-content surface.
 *
 * Request: `{ channel_type, channel_id, text, buttons?, cards?, effects?, thread_reply? }`.
 * Response: `{ messageId, channelId }`.
 */
export const MessageSendContract = defineContract({
  method: "message.send",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    text: z.string(),
    buttons: z.array(z.array(z.record(z.string(), z.unknown()))).optional(),
    cards: z.array(z.record(z.string(), z.unknown())).optional(),
    effects: z.array(z.record(z.string(), z.unknown())).optional(),
    thread_reply: z.boolean().optional(),
  }),
  response: z.object({
    messageId: z.string(),
    channelId: z.string(),
  }),
  // Orchestration surface (the genuinely-outward send subset),
  // NOT control plane. Scoped rpc rather than admin so the deny-by-origin
  // chokepoint (keyed on scopes.includes("admin")) does not deny an agent its
  // own granted orch:message before the requireCapability gate runs. The handler
  // still gates on orch:message; admin gateway tokens carry rpc so are unaffected.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// message.reply
// ---------------------------------------------------------------------------

/**
 * `message.reply` — Reply to an existing message via a channel adapter.
 * Rpc-scoped. Handler path: message-handlers.ts:125-146.
 *
 * Resolves inbound UUID `message_id` to platform-native id via
 * `inboundMessageIdResolver` before adapter call. Same rich content options
 * as message.send.
 *
 * Request: `{ channel_type, channel_id, message_id, text, buttons?, cards?, effects?, thread_reply? }`.
 * Response: `{ messageId, channelId }`.
 */
export const MessageReplyContract = defineContract({
  method: "message.reply",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    message_id: z.string(),
    text: z.string(),
    buttons: z.array(z.array(z.record(z.string(), z.unknown()))).optional(),
    cards: z.array(z.record(z.string(), z.unknown())).optional(),
    effects: z.array(z.record(z.string(), z.unknown())).optional(),
    thread_reply: z.boolean().optional(),
  }),
  response: z.object({
    messageId: z.string(),
    channelId: z.string(),
  }),
  // Outward send subset → orchestration surface, rpc-scoped
  // (governed by orch:message), not control plane. See message.send rationale.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// message.react
// ---------------------------------------------------------------------------

/**
 * `message.react` — React to a message with an emoji. Rpc-scoped. Handler
 * path: message-handlers.ts:148-159.
 *
 * Capability-gated (`reactions` feature). Resolves inbound UUID via
 * `inboundMessageIdResolver` before adapter call.
 *
 * Request: `{ channel_type, channel_id, message_id, emoji }`.
 * Response: `{ reacted: true, channelId, messageId, emoji }`.
 */
export const MessageReactContract = defineContract({
  method: "message.react",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    message_id: z.string(),
    emoji: z.string(),
  }),
  response: z.object({
    reacted: z.literal(true),
    channelId: z.string(),
    messageId: z.string(),
    emoji: z.string(),
  }),
  // Outward send subset → orchestration surface, rpc-scoped
  // (governed by orch:message), not control plane. See message.send rationale.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// message.edit
// ---------------------------------------------------------------------------

/**
 * `message.edit` — Edit an existing message. Admin-only. Handler path:
 * message-handlers.ts:163-175.
 *
 * edit/delete/fetch/attach STAY admin-only (deny-by-origin) and
 * are NOT part of `orch:message` — the cap exposes only the genuinely-outward
 * send subset (send/reply/react). An agent origin is denied at the chokepoint.
 *
 * Capability-gated (`editMessages` feature). Resolves inbound UUID. Text is
 * formatted via `formatForChannel` before adapter.editMessage call.
 *
 * Request: `{ channel_type, channel_id, message_id, text }`.
 * Response: `{ edited: true, channelId, messageId }`.
 */
export const MessageEditContract = defineContract({
  method: "message.edit",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    message_id: z.string(),
    text: z.string(),
  }),
  response: z.object({
    edited: z.literal(true),
    channelId: z.string(),
    messageId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// message.delete
// ---------------------------------------------------------------------------

/**
 * `message.delete` — Delete a message. Admin-only. Handler path:
 * message-handlers.ts:177-187.
 *
 * Capability-gated (`deleteMessages` feature). Resolves inbound UUID.
 *
 * Request: `{ channel_type, channel_id, message_id }`.
 * Response: `{ deleted: true, channelId, messageId }`.
 */
export const MessageDeleteContract = defineContract({
  method: "message.delete",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    message_id: z.string(),
  }),
  response: z.object({
    deleted: z.literal(true),
    channelId: z.string(),
    messageId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// message.fetch
// ---------------------------------------------------------------------------

/**
 * `message.fetch` — Fetch recent messages from a channel. Admin-only. Handler
 * path: message-handlers.ts:189-200.
 *
 * Capability-gated (`fetchHistory` feature). `limit` defaults to 20.
 *
 * LOOSE-ARRAY for response `messages`: array of ChannelMessage records
 * from `@comis/core`; each channel's wire format differs (Telegram exposes
 * `from`/`text`/`date`, Discord exposes `author`/`content`/`timestamp`).
 *
 * Request: `{ channel_type, channel_id, limit?, before? }`.
 * Response: `{ messages: LooseArray, channelId }`.
 */
export const MessageFetchContract = defineContract({
  method: "message.fetch",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    limit: z.number().optional(),
    before: z.string().optional(),
  }),
  response: z.object({
    messages: z.array(z.record(z.string(), z.unknown())),
    channelId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// message.attach
// ---------------------------------------------------------------------------

/**
 * `message.attach` — Send a file/image/audio/video attachment via a channel.
 * Admin-only. Handler path: message-handlers.ts:202-309 (largest handler in
 * the message-handlers file).
 *
 * Capability-gated (`attachments` feature). Resolves `file://` URLs and
 * absolute paths to validated local paths (workspace-bounded via `safePath`).
 *
 * Special-case: when `channel_type === "gateway"`, copies the file to
 * `deps.mediaDir`, hashes it, writes `.meta` sidecar, and broadcasts a
 * `notification.attachment` WebSocket message. Non-gateway channels route
 * through `adapter.sendAttachment`.
 *
 * `attachment_type` enum: `"image" | "file" | "audio" | "video"` (defaults to
 * `"file"` when missing).
 *
 * Request: `{ channel_type, channel_id, attachment_url, attachment_type?,
 * mime_type?, file_name?, caption? }`.
 * Response: `{ messageId, channelId }`.
 */
export const MessageAttachContract = defineContract({
  method: "message.attach",
  request: z.object({
    channel_type: z.string(),
    channel_id: z.string(),
    attachment_url: z.string(),
    attachment_type: z.enum(["image", "file", "audio", "video"]).optional(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
    caption: z.string().optional(),
  }),
  response: z.object({
    messageId: z.string(),
    channelId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// discord.action
// ---------------------------------------------------------------------------

/**
 * `discord.action` — Discord-specific platform action (channel pin/unpin,
 * voice connect/disconnect, role management, etc.). Admin-only. Handler
 * path: message-handlers.ts:311-325.
 *
 * LOOSE-RECORD for request + response: platform-action parameters vary
 * by action (e.g., `pin_message` carries `message_id`; `voice_connect`
 * carries `voice_channel_id`); response is `adapter.platformAction`'s return
 * value, which is action-dependent.
 *
 * Request: `{ action, channel_id?, ... arbitrary platform-specific fields }`.
 * Response: LooseRecord (varies by action).
 */
export const DiscordActionContract = defineContract({
  method: "discord.action",
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// telegram.action
// ---------------------------------------------------------------------------

/**
 * `telegram.action` — Telegram-specific platform action (set commands, pin
 * message, manage admins, etc.). Admin-only. Handler path:
 * message-handlers.ts:327-341.
 *
 * LOOSE-RECORD for request + response.
 *
 * Request: `{ action, chat_id?, ... arbitrary platform-specific fields }`.
 * Response: LooseRecord.
 */
export const TelegramActionContract = defineContract({
  method: "telegram.action",
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// slack.action
// ---------------------------------------------------------------------------

/**
 * `slack.action` — Slack-specific platform action (pin message, invite to
 * channel, manage workspaces, etc.). Admin-only. Handler path:
 * message-handlers.ts:343-357.
 *
 * LOOSE-RECORD for request + response.
 *
 * Request: `{ action, channel_id?, ... arbitrary platform-specific fields }`.
 * Response: LooseRecord.
 */
export const SlackActionContract = defineContract({
  method: "slack.action",
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// whatsapp.action
// ---------------------------------------------------------------------------

/**
 * `whatsapp.action` — WhatsApp-specific platform action (group admin
 * promote/demote, group settings, etc.). Admin-only. Handler path:
 * message-handlers.ts:359-373.
 *
 * LOOSE-RECORD for request + response.
 *
 * Request: `{ action, group_jid?, ... arbitrary platform-specific fields }`.
 * Response: LooseRecord.
 */
export const WhatsappActionContract = defineContract({
  method: "whatsapp.action",
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Domain array — appended to API_CONTRACTS_ORDERED in index.ts.
// ===========================================================================

/**
 * Aggregator array — 19 entries grouped by handler-file in handler-factory
 * PropertyAssignment order:
 *
 *   - channel-handlers.ts (8): channels.health, delivery.queue.status,
 *     channels.capabilities, channels.list, channels.get, channels.enable,
 *     channels.disable, channels.restart.
 *   - message-handlers.ts (11): message.send, message.reply, message.react,
 *     message.edit, message.delete, message.fetch, message.attach,
 *     discord.action, telegram.action, slack.action, whatsapp.action.
 */
export const CHANNELS_CONTRACTS = [
  // channel-handlers.ts (8)
  ChannelsHealthContract,
  DeliveryQueueStatusContract,
  ChannelsCapabilitiesContract,
  ChannelsListContract,
  ChannelsGetContract,
  ChannelsEnableContract,
  ChannelsDisableContract,
  ChannelsRestartContract,
  // message-handlers.ts (11)
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
] as const;
