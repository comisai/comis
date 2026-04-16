/**
 * Unicode-to-Slack shortname mapping for lifecycle reaction emoji.
 *
 * Slack's reactions.add/remove APIs require shortnames (e.g., "thinking_face"),
 * not Unicode characters. This map covers all lifecycle reaction emoji from
 * both the unicode and platform emoji tiers.
 */

/**
 * Maps Unicode emoji characters to their Slack reaction shortnames.
 *
 * Covers all emoji used in EMOJI_SETS (both unicode and platform tiers).
 * Slack shortnames do not include colons -- they are bare names
 * (e.g., "thinking_face" not ":thinking_face:").
 */
export const UNICODE_TO_SLACK: Map<string, string> = new Map([
  ["\u{1F440}", "eyes"],
  ["\u{1F914}", "thinking_face"],
  ["\u{1F50D}", "mag"],
  ["\u{1F50E}", "mag_right"],
  ["\u{1F527}", "wrench"],
  ["\u{1F4BB}", "computer"],
  ["\u{1F310}", "globe_with_meridians"],
  ["\u{1F3A8}", "art"],
  ["\u{2705}", "white_check_mark"],
  ["\u{274C}", "x"],
  ["\u{23F3}", "hourglass_flowing_sand"],
  ["\u{26A0}\u{FE0F}", "warning"],
  ["\u{1F9E0}", "brain"],
  ["\u{2699}\u{FE0F}", "gear"],
  ["\u{1F4DD}", "memo"],
  ["\u{1F578}\u{FE0F}", "spider_web"],
  ["\u{1F5BC}\u{FE0F}", "frame_with_picture"],
  ["\u{1F6A8}", "rotating_light"],
]);

/**
 * Converts a Unicode emoji to its Slack reaction shortname.
 *
 * If the emoji is not in the mapping, returns the input unchanged.
 * This allows non-lifecycle emoji to pass through unmodified.
 */
export function toSlackShortname(unicode: string): string {
  return UNICODE_TO_SLACK.get(unicode) ?? unicode;
}
