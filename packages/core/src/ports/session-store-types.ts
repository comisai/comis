// SPDX-License-Identifier: Apache-2.0
/**
 * Row DTOs for SessionStorePort. Type-only.
 *
 * Lifted verbatim from packages/memory/src/session-store.ts:47-74. After
 * Phase 31 commit 2, memory's session-store.ts no longer declares them;
 * memory/src/index.ts re-exports them from "@comis/core" so daemon's
 * value-imports (`from "@comis/memory"`) continue to resolve.
 *
 * Per design §8.2.1, these stay in core/src/ports/ (NOT core/src/domain/)
 * to preserve the domain/persistence boundary — they are raw row shapes,
 * NOT domain entities.
 *
 * @module
 */

/** Data returned when loading a session. */
export interface SessionData {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Session listing entry. */
export interface SessionListEntry {
  sessionKey: string;
  updatedAt: number;
}

/** Detailed session listing entry with all fields needed for kind derivation. */
export interface SessionDetailedEntry {
  sessionKey: string;
  tenantId: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
