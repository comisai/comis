// SPDX-License-Identifier: Apache-2.0
/**
 * Row DTOs for SessionStorePort. Type-only.
 *
 * memory's session-store.ts does not declare these directly;
 * memory/src/index.ts re-exports them from "@comis/core" so daemon's
 * value-imports (`from "@comis/memory"`) resolve.
 *
 * These stay in core/src/ports/ (NOT core/src/domain/) to preserve the
 * domain/persistence boundary — they are raw row shapes, NOT domain
 * entities.
 *
 * @module
 */

import type { ConversationRef, ConversationScope } from "../domain/conversation-scope.js";

/** Data returned when loading a session. */
export interface SessionData {
  conversationRef: ConversationRef;
  conversationScope: ConversationScope;
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Session listing entry. */
export interface SessionListEntry {
  conversationRef: ConversationRef;
  conversationScope: ConversationScope;
  updatedAt: number;
}

/** Detailed session listing entry with all fields needed for kind derivation. */
export interface SessionDetailedEntry {
  conversationRef: ConversationRef;
  conversationScope: ConversationScope;
  tenantId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
