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
