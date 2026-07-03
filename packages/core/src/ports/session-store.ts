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

import type { SessionKey } from "../domain/session-key.js";
import type {
  SessionData,
  SessionListEntry,
  SessionDetailedEntry,
} from "./session-store-types.js";

/**
 * SessionStorePort provides CRUD operations for conversation sessions.
 *
 * All operations are synchronous (better-sqlite3 is synchronous). Sessions
 * are keyed by formatted SessionKey strings.
 *
 * Method groups (mirrors source-of-truth layout in
 * packages/memory/src/session-store.ts:82-124):
 *   - Persistence     (3 methods: save, load, loadByFormattedKey)
 *   - Listing         (2 methods: list, listDetailed)
 *   - Mutation        (2 methods: delete, deleteStale)
 *
 * Total: 7 methods. The structural shape MUST match memory's interface
 * exactly so the port and the implementation stay interchangeable.
 */
export interface SessionStorePort {
  save(key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>): void;
  load(key: SessionKey): SessionData | undefined;
  list(tenantId?: string): SessionListEntry[];
  delete(key: SessionKey): boolean;
  deleteStale(maxAgeMs: number): number;
  loadByFormattedKey(sessionKey: string): SessionData | undefined;
  listDetailed(tenantId?: string): SessionDetailedEntry[];
}
