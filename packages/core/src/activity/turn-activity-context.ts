// SPDX-License-Identifier: Apache-2.0
/**
 * TurnActivityContext — concrete per-turn routing context.
 *
 * `ActivityEvent.channelKey` alone is too thin for renderers and routers.
 * Channels need agent identity, session correlation, channel-adapter selection,
 * reply targeting, and thread routing. Centralising those in one frozen object
 * given to the coordinator at construction makes the contract explicit and lets
 * renderers stay stateless. Pure type-only file (no I/O, no logger).
 */
import type { ChatType } from "../domain/chat-type.js";

export interface TurnActivityContext {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly traceId: string;
  /** "telegram" | "discord" | "slack" | "whatsapp" | "signal" | "imessage" | "line" | "irc" | "email" | "echo" | "acp". */
  readonly channelType: string;
  /** Platform-specific channel/chat identifier. */
  readonly channelKey: string;
  /** "direct" | "group" | "channel" (narrowed from NormalizedMessage.chatType). */
  readonly chatType: ChatType;
  /** Platform message id of the inbound that started this turn. Reply-correlation anchor. */
  readonly inboundMessageId: string;
  /** Thread/topic id when the inbound came from one (Telegram forum, Discord/Slack thread). */
  readonly threadId?: string;
  /** Reply-to target for assistant messages (often = inboundMessageId in DMs; sometimes a quoted msg in groups). */
  readonly replyTo?: string;
  /**
   * Renderer instance key. Unique per (agentId, channelType, channelKey,
   * chatType). Used by composition root to look up the renderer + by
   * observability for grouping.
   */
  readonly rendererKey: string;
}
