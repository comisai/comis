// SPDX-License-Identifier: Apache-2.0
/**
 * Auto-Reply Engine: Inbound message activation decision logic.
 *
 * Determines whether an inbound message should activate the agent pipeline,
 * be injected as silent history context, or be ignored entirely.
 *
 * - DM messages always activate the agent (direct interactions).
 * - Group messages are gated by the configured activation mode:
 *   - `always`: respond to every group message
 *   - `mention-gated`: respond only when the bot is @mentioned or replied to
 *   - `custom`: respond when the message text matches a configured regex pattern
 *
 * Non-trigger group messages can optionally be injected into the session's
 * conversation history as context-only entries, giving the agent awareness
 * of group discussion without generating a response.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import type { AutoReplyEngineConfig } from "@comis/core";

import { isRegexSafe } from "./regex-guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decision returned by the auto-reply engine.
 *
 * - `activate`: Message triggers the full agent pipeline
 * - `inject-history`: Message saved as context-only history (no agent response)
 * - `ignore`: Message discarded entirely
 */
export type AutoReplyDecision =
  | { action: "activate"; reason: string }
  | { action: "inject-history"; reason: string }
  | { action: "ignore"; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if a message originates from a group context.
 *
 * Platform detection:
 * - Telegram: metadata.telegramChatType exists and !== "private"
 * - Discord: metadata.guildId is present (truthy)
 * - WhatsApp: metadata.isGroup === true
 * - Default: false (treated as DM)
 *
 * Defaults to false when metadata is ambiguous, ensuring DMs are never
 * accidentally classified as group messages.
 */
export function isGroupMessage(msg: NormalizedMessage): boolean {
  const meta = msg.metadata ?? {};
  // Telegram: telegramChatType !== "private" means group/supergroup/channel
  if (meta.telegramChatType && meta.telegramChatType !== "private") return true;
  // Discord: guildId present means guild (server) context
  if (meta.guildId) return true;
  // WhatsApp: explicit isGroup flag from message mapper
  if (meta.isGroup === true) return true;
  // Slack: slackChannelType present and not "im" means public/private channel
  if (meta.slackChannelType && meta.slackChannelType !== "im") return true;
  return false;
}

/**
 * Detect if the bot was mentioned in the message.
 *
 * Checks metadata flags set by platform message mappers:
 * - metadata.isMentioned (generic mention flag)
 * - metadata.isBotMentioned (explicit bot mention flag)
 * - metadata.replyToBot (reply to bot's own message counts as mention)
 */
export function isBotMentioned(msg: NormalizedMessage): boolean {
  const meta = msg.metadata ?? {};
  return (
    meta.isMentioned === true ||
    meta.isBotMentioned === true ||
    meta.replyToBot === true
  );
}

/**
 * Test message text against custom regex patterns.
 *
 * Each pattern is compiled as a RegExp and tested against the text.
 * Invalid patterns are silently skipped (try/catch per pattern) to
 * prevent ReDoS crashes from user-configured patterns.
 *
 * Returns true on first matching pattern.
 */
function matchesCustomPattern(text: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      const check = isRegexSafe(pattern);
      if (!check.safe) continue; // Skip overly complex patterns
      const re = new RegExp(pattern);
      if (re.test(text)) return true;
    } catch {
      // Invalid regex pattern -- skip silently
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate how to handle an inbound message.
 *
 * @param msg - The normalized inbound message
 * @param config - Auto-reply engine configuration
 * @param isGroup - Whether the message originates from a group context
 * @returns Decision: activate, inject-history, or ignore
 */
export function evaluateAutoReply(
  msg: NormalizedMessage,
  config: AutoReplyEngineConfig,
  isGroup: boolean,
): AutoReplyDecision {
  // DMs always activate -- fast path (never gate DMs)
  if (!isGroup) {
    return { action: "activate", reason: "dm" };
  }

  switch (config.groupActivation) {
    case "always":
      return { action: "activate", reason: "always-mode" };

    case "mention-gated": {
      if (isBotMentioned(msg)) {
        return { action: "activate", reason: "mention-detected" };
      }
      return config.historyInjection
        ? { action: "inject-history", reason: "group-not-mentioned" }
        : { action: "ignore", reason: "group-not-mentioned" };
    }

    case "custom": {
      if (matchesCustomPattern(msg.text, config.customPatterns)) {
        return { action: "activate", reason: "custom-pattern-matched" };
      }
      return config.historyInjection
        ? { action: "inject-history", reason: "group-no-pattern-match" }
        : { action: "ignore", reason: "group-no-pattern-match" };
    }

    default: {
      // Exhaustive guard: should never be reached with valid config
      const _exhaustive: never = config.groupActivation;
      return { action: "ignore", reason: `unknown-mode-${_exhaustive}` };
    }
  }
}
