/**
 * Slack Message Mapper: Converts Slack message events to NormalizedMessage.
 *
 * This is a pure function that receives a plain Slack message event object.
 * The adapter extracts the event from Bolt's callback and passes it here,
 * keeping this function testable without Bolt middleware.
 *
 * Key conversions:
 * - Slack ts "1234567890.123456" -> timestamp in milliseconds
 * - thread_ts preserved in metadata for threading
 * - Files mapped via buildSlackAttachments()
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";
import { buildSlackAttachments } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Slack event types (minimal, to avoid pulling in all Slack types)
// ---------------------------------------------------------------------------

export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

export interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  bot_id?: string;
  subtype?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Slack timestamp string to Unix milliseconds.
 *
 * Slack timestamps have the format "1234567890.123456" where the part
 * before the dot is Unix seconds. We parse that part and multiply by 1000.
 *
 * @internal Exported for testing only -- no external consumers. Used internally by mapSlackToNormalized.
 */
export function parseSlackTs(ts: string): number {
  const dotIndex = ts.indexOf(".");
  const secondsPart = dotIndex >= 0 ? ts.slice(0, dotIndex) : ts;
  return parseInt(secondsPart, 10) * 1000;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a Slack message event to a NormalizedMessage.
 *
 * @param event - A Slack message event object
 * @returns A fully populated NormalizedMessage
 */
export function mapSlackToNormalized(event: SlackMessageEvent): NormalizedMessage {
  const metadata: Record<string, unknown> = {
    slackTs: event.ts,
  };

  // Preserve thread context
  if (event.thread_ts) {
    metadata.slackThreadTs = event.thread_ts;
  }

  // Preserve bot_id for filtering
  if (event.bot_id) {
    metadata.slackBotId = event.bot_id;
  }

  // Derive chatType from Slack channel ID prefix and thread context
  const chatType = event.channel.startsWith("D") ? "dm" as const
    : (event.thread_ts && event.thread_ts !== event.ts) ? "thread" as const
    : "group" as const;

  return {
    id: randomUUID(),
    channelId: event.channel,
    channelType: "slack",
    senderId: event.user ?? "unknown",
    text: event.text ?? "",
    timestamp: parseSlackTs(event.ts),
    attachments: buildSlackAttachments(event.files),
    chatType,
    metadata,
  };
}
