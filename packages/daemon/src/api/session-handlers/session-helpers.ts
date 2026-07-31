// SPDX-License-Identifier: Apache-2.0
/**
 * Shared session-handler helpers.
 *
 * Explicit-authority session helpers shared across the session handler
 * bundles. Runtime lifecycle handlers may also consult the authority-scoped LCD
 * conversation index; filesystem transcripts are not a control-plane index.
 *
 * @module
 */

import { systemGetEnv } from "@comis/core";

// SessionsApiDeps remains the source of truth for session dependencies.
// MemoryApiDeps owns the optional eventBus field shared by dispatcher slices;
// session read handlers borrow only that field for durable authorization audit.
import type { MemoryApiDeps, SessionsApiDeps } from "../types.js";
export type SessionHandlerDeps =
  & SessionsApiDeps
  & Pick<MemoryApiDeps, "eventBus">;

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
export const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/** Load one session only through explicit tenant-agent-ref authority. */
export function loadAuthorizedSession(
  deps: SessionHandlerDeps,
  scope: import("@comis/core").SessionQueryScope,
  conversationRef: import("@comis/core").ConversationRef,
): import("@comis/core").SessionData | undefined {
  const loaded = deps.sessionStore.loadByRef(scope, conversationRef);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

const LCD_CONVERSATION_PAGE_SIZE = 200;

/** Find one LCD conversation without widening beyond the explicit tenant-agent scope. */
export function findLcdConversation(
  deps: SessionHandlerDeps,
  scope: import("@comis/core").SessionQueryScope,
  conversationRef: import("@comis/core").ConversationRef,
) {
  if (!deps.contextBrowse) return undefined;
  let offset = 0;
  while (true) {
    const page = deps.contextBrowse.listConversations(scope, {
      limit: LCD_CONVERSATION_PAGE_SIZE,
      offset,
    });
    const match = page.conversations.find((entry) => entry.conversationRef === conversationRef);
    if (match) return match;
    offset += page.conversations.length;
    if (page.conversations.length === 0 || offset >= page.total) return undefined;
  }
}
