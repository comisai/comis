// SPDX-License-Identifier: Apache-2.0
/**
 * SessionStorePort: hexagonal architecture boundary for session persistence.
 *
 * Type-only mirror of @comis/memory's SessionStore. The declaration covers
 * every public method memory's SessionStore exposes, so the two types stay
 * interchangeable.
 *
 * Row DTOs (SessionData, SessionListEntry, SessionDetailedEntry) live in
 * core/src/ports/session-store-types.ts.
 *
 * The implementation lives at @comis/memory's createSessionStore().
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { ConversationRef, ConversationScope } from "../domain/conversation-scope.js";
import type { SessionStoreError } from "../domain/session-store-error.js";
import type {
  SessionData,
  SessionListEntry,
  SessionDetailedEntry,
} from "./session-store-types.js";

/**
 * SessionStorePort provides CRUD operations for conversation sessions.
 *
 * All operations are synchronous (better-sqlite3 is synchronous). Point
 * operations require the complete conversation authority. Reference-based
 * control-plane reads also require the tenant-agent query authority.
 */
export interface SessionQueryScope {
  tenantId: string;
  agentId: string;
}

export interface SessionStorePort {
  save(scope: ConversationScope, messages: unknown[], metadata?: Record<string, unknown>): Result<void, SessionStoreError>;
  load(scope: ConversationScope): Result<SessionData | undefined, SessionStoreError>;
  loadByRef(scope: SessionQueryScope, conversationRef: ConversationRef): Result<SessionData | undefined, SessionStoreError>;
  list(scope: SessionQueryScope): Result<SessionListEntry[], SessionStoreError>;
  delete(scope: ConversationScope): Result<boolean, SessionStoreError>;
  deleteByRef(scope: SessionQueryScope, conversationRef: ConversationRef): Result<boolean, SessionStoreError>;
  deleteStale(scope: SessionQueryScope, maxAgeMs: number): Result<number, SessionStoreError>;
  listDetailed(scope: SessionQueryScope): Result<SessionDetailedEntry[], SessionStoreError>;
}
