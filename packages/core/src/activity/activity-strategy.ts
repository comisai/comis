// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityStrategy + selectStrategy.
 *
 * Pure capability → strategy routing. The six "real" channel strategies are
 * derived from the declared `ChannelCapability` (edit / delete / buttons /
 * maxMessageChars). Two surfaces have no capability shape that distinguishes
 * them from a real channel — Echo (TestSink) overlaps text-only channels, and
 * ACP (Structured) carries no ChannelPlugin/capability at all (it is a
 * structured `SessionUpdate` stream). Those two route on
 * the `channelType` signal the coordinator already holds on
 * `TurnActivityContext.channelType`.
 *
 * Pure: no I/O, no logger, no channel import.
 */
import type { ChannelCapability } from "../domain/channel-capability.js";

export type ActivityStrategy =
  | "EditPlace" // edit-in-place + delete on success (Telegram, Discord, Slack, WhatsApp)
  | "DeleteAndRepost" // delete + repost on each transition (Signal)
  | "AppendOnly" // single status + final summary (iMessage, LINE)
  | "LinePerEvent" // one short line per event (IRC)
  | "DigestOnly" // end-of-turn summary email only (Email)
  | "Structured" // JSON SessionUpdate stream (ACP)
  | "TestSink"; // recorder (Echo)

/** IRC's defining constraint — one short line per event under a 512-char cap. */
const IRC_MAX_CHARS = 512;
/** Email's defining trait — by far the largest cap; end-of-turn digest only. */
const DIGEST_MIN_CHARS = 100_000;

/**
 * Route a channel to its activity rendering strategy.
 *
 * @param cap - The channel's declared capability (drives the 8 real channels).
 * @param channelType - Optional routing signal for the two surfaces that are
 *   not separable from capability alone: `"echo"` → TestSink, `"acp"` →
 *   Structured. Any other value (or omission) falls through to capability
 *   routing.
 */
export function selectStrategy(
  cap: ChannelCapability,
  channelType?: string,
): ActivityStrategy {
  // Explicit signal for the test/structured surfaces (no distinguishing cap shape).
  if (channelType === "acp") return "Structured";
  if (channelType === "echo") return "TestSink";

  const { editMessages, deleteMessages } = cap.features;

  // Edit-capable channels render in place (Telegram, Discord, Slack, WhatsApp).
  if (editMessages) return "EditPlace";

  // No edit, but can delete → delete-and-repost on each transition (Signal).
  if (deleteMessages) return "DeleteAndRepost";

  // From here: no edit, no delete.
  // IRC is the only channel with a 512-char line cap → one short line per event.
  if (cap.limits.maxMessageChars <= IRC_MAX_CHARS) return "LinePerEvent";

  // Email has by far the largest cap and renders an end-of-turn digest only.
  if (cap.limits.maxMessageChars >= DIGEST_MIN_CHARS) return "DigestOnly";

  // A text-only sink with no attachments (and not IRC) is Echo's TestSink shape.
  if (!cap.features.attachments) return "TestSink";

  // Remaining no-edit/no-delete channels with attachments (iMessage, LINE) append.
  return "AppendOnly";
}
