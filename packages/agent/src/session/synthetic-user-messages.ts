// SPDX-License-Identifier: Apache-2.0
/** Exact SDK-generated user-role placeholders that are not inbound messages. */

export const CONTINUATION_USER_MESSAGE = "(continued from previous message)";
export const REDACTED_TOOL_RESULT_USER_MESSAGE =
  "(prior secret operation — no output shown)";

/** Whether text is an internal SDK repair placeholder rather than user input. */
export function isSyntheticSessionUserMessage(text: string): boolean {
  const normalized = text.trim();
  return normalized === CONTINUATION_USER_MESSAGE ||
    normalized === REDACTED_TOOL_RESULT_USER_MESSAGE;
}
