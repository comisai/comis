// SPDX-License-Identifier: Apache-2.0
/**
 * ChatType — the narrowed 3-value chat classification.
 *
 * Narrows the 5-value `NormalizedMessage.chatType` enum
 * (`"dm" | "group" | "thread" | "channel" | "forum"`) to the 3 values
 * renderers actually branch on: `dm → direct`, `thread`/`forum` fold to their
 * parent (`group`). The `delivery.visibleReplies.{direct|group}` config keys
 * off this narrowed form, so the mapping is defined alongside the type.
 */
import { z } from "zod";

export const ChatTypeSchema = z.enum(["direct", "group", "channel"]);
export type ChatType = z.infer<typeof ChatTypeSchema>;

/** Source enum on `NormalizedMessage.chatType` (5 values). */
export type NormalizedChatType = "dm" | "group" | "thread" | "channel" | "forum";

/**
 * Narrow the 5-value `NormalizedMessage.chatType` to the 3-value `ChatType`.
 * `dm → direct`; `thread`/`forum` fold to their parent `group`;
 * `group` and `channel` pass through. Closed `switch` with an exhaustive
 * `_exhaustive: never` default (AGENTS.md §2.8): adding a source value without
 * a `case` fails `tsc` at the default assignment.
 */
export function narrowChatType(c: NormalizedChatType): ChatType {
  switch (c) {
    case "dm":
      return "direct";
    case "thread":
    case "forum":
    case "group":
      return "group";
    case "channel":
      return "channel";
    default: {
      // Exhaustive-never guard (AGENTS.md §2.8): unreachable for the closed
      // NormalizedChatType union — a future member without a `case` fails tsc
      // here. Defensively folds an out-of-union cast to the safe `group` value.
      const _exhaustive: never = c;
      void _exhaustive;
      return "group";
    }
  }
}
