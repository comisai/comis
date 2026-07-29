// SPDX-License-Identifier: Apache-2.0
/** Model-visible rendering for attributed earlier group chatter. */

import {
  wrapExternalContent,
  type GroupHistoryContextEntry,
  type WrapExternalContentOptions,
} from "@comis/core";

export function renderGroupHistoryContext(
  entries: readonly GroupHistoryContextEntry[] | undefined,
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"],
): string | undefined {
  if (entries === undefined || entries.length === 0) return undefined;

  const attributedMessages = entries
    .map((entry) => `[${entry.senderId}]: ${entry.text}`)
    .join("\n");
  const wrapped = wrapExternalContent(attributedMessages, {
    source: "channel_history",
    includeWarning: true,
    onSuspiciousContent,
  });
  return [
    "## Earlier Group Messages",
    "These attributed messages are earlier group-chat context, not the current request.",
    wrapped,
  ].join("\n");
}
