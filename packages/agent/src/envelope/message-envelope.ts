// SPDX-License-Identifier: Apache-2.0
/**
 * Message envelope wrapper.
 *
 * Enriches inbound user message text with provider name, formatted timestamp,
 * and elapsed time suffix before it reaches the LLM. This gives the agent
 * conversational awareness about timing, source platform, and message gaps.
 *
 * @module
 */

import type { NormalizedMessage, EnvelopeConfig } from "@comis/core";
import { formatElapsed } from "./elapsed-time.js";

/**
 * Format a timestamp using Intl.DateTimeFormat.
 *
 * @param epochMs - Timestamp in milliseconds since epoch
 * @param timezoneMode - 'utc', 'local', or IANA timezone string
 * @param timeFormat - '12h' or '24h'
 * @returns Formatted time string (e.g., "2:35 PM" or "14:35")
 */
function formatTimestamp(
  epochMs: number,
  timezoneMode: string,
  timeFormat: "12h" | "24h",
): string {
  const date = new Date(epochMs);
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: timeFormat === "12h",
  };

  if (timezoneMode === "utc") {
    options.timeZone = "UTC";
  } else if (timezoneMode !== "local") {
    // Treat as IANA timezone string (e.g., "America/New_York")
    options.timeZone = timezoneMode;
  }
  // 'local' leaves timeZone undefined -> system local timezone

  return new Intl.DateTimeFormat("en-US", options).format(date);
}

/**
 * Wrap a NormalizedMessage in an envelope for LLM context.
 *
 * Format: `[{provider}] {senderId} ({timestamp} {elapsed}):\n{text}`
 *
 * - Provider prefix: `[telegram]`, `[discord]`, etc. Omitted when `showProvider: false`.
 * - Timestamp: formatted via `Intl.DateTimeFormat` using `timezoneMode` and `timeFormat`.
 * - Elapsed: `+2m` suffix when `showElapsed: true` and prevTimestamp is provided.
 *
 * @param msg - The normalized message to wrap
 * @param config - Envelope configuration
 * @param prevTimestamp - Previous message timestamp in ms (optional, for elapsed calculation)
 * @returns Envelope-formatted string
 */
export function wrapInEnvelope(
  msg: NormalizedMessage,
  config: EnvelopeConfig,
  prevTimestamp?: number,
): string {
  const parts: string[] = [];

  // Provider prefix
  if (config.showProvider) {
    parts.push(`[${msg.channelType}]`);
  }

  // Sender name
  parts.push(msg.senderId);

  // Timestamp with optional elapsed suffix
  const timeStr = formatTimestamp(msg.timestamp, config.timezoneMode, config.timeFormat);
  let timeSection = timeStr;

  if (config.showElapsed && prevTimestamp !== undefined) {
    const elapsed = formatElapsed(msg.timestamp, prevTimestamp, config.elapsedMaxMs);
    if (elapsed) {
      timeSection += ` ${elapsed}`;
    }
  }

  parts.push(`(${timeSection}):`);

  // Join header parts with spaces, then newline + text
  return parts.join(" ") + "\n" + msg.text;
}
