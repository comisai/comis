// SPDX-License-Identifier: Apache-2.0
/**
 * SessionStorePort: hexagonal architecture boundary for session persistence.
 *
 * Type-only mirror of @comis/memory's SessionStore. Per RESEARCH.md §A.4
 * recommendation ("keep all 7 methods to match memory's surface so memory's
 * createSessionStore return-type swap is a pure rename"), this declaration
 * covers every public method memory's SessionStore exposes.
 *
 * Row DTOs (SessionData, SessionListEntry, SessionDetailedEntry) live in
 * core/src/ports/session-store-types.ts per MEM-CTX-PORTS-03.
 *
 * The implementation lives at @comis/memory's createSessionStore(). Phase 31
 * commit 2 makes that factory's return type compatible with this port
 * (return-type-only change — implementation unchanged).
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
 * exactly so Phase 31 commit 3 retarget is a pure name swap.
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
