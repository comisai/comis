// SPDX-License-Identifier: Apache-2.0
/**
 * Session Label Store: Human-readable labels for sessions.
 *
 * Provides a thin facade for reading/writing session labels through the
 * existing `metadata.label` field in SessionStore's metadata JSON column.
 * No schema migration required -- labels are stored as a regular metadata key.
 *
 * @module
 */

import type { SessionKey } from "@comis/core";
import type { SessionStore } from "@comis/memory";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Facade for managing human-readable session labels via metadata.label.
 */
export interface SessionLabelStore {
  /** Get the label for a session. Returns undefined if no label set. */
  getLabel(key: SessionKey): string | undefined;
  /** Set a label for a session. Creates/updates metadata.label. No-op if session doesn't exist. */
  setLabel(key: SessionKey, label: string): void;
  /** Remove the label from a session. No-op if session doesn't exist. */
  removeLabel(key: SessionKey): void;
  /** List sessions that have labels, returning [sessionKey, label] pairs. */
  listLabeled(tenantId?: string): Array<{ sessionKey: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SessionLabelStore wrapping the given SessionStore.
 *
 * Labels are stored in `metadata.label` -- no schema migration needed.
 * All operations delegate to the underlying SessionStore for persistence.
 */
export function createSessionLabelStore(store: SessionStore): SessionLabelStore {
  return {
    getLabel(key: SessionKey): string | undefined {
      const data = store.load(key);
      if (!data) return undefined;
      const label = data.metadata?.label;
      return typeof label === "string" ? label : undefined;
    },

    setLabel(key: SessionKey, label: string): void {
      const data = store.load(key);
      if (!data) return; // Can't label a non-existent session
      store.save(key, data.messages, { ...data.metadata, label });
    },

    removeLabel(key: SessionKey): void {
      const data = store.load(key);
      if (!data) return;
       
      const { label: _, ...rest } = data.metadata;
      store.save(key, data.messages, rest);
    },

    listLabeled(tenantId?: string): Array<{ sessionKey: string; label: string }> {
      const detailed = store.listDetailed(tenantId);
      const result: Array<{ sessionKey: string; label: string }> = [];
      for (const entry of detailed) {
        const label = entry.metadata?.label;
        if (typeof label === "string") {
          result.push({ sessionKey: entry.sessionKey, label });
        }
      }
      return result;
    },
  };
}
