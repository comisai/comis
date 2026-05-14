// SPDX-License-Identifier: Apache-2.0
/**
 * Session store for conversation persistence.
 *
 * Provides CRUD operations on the `sessions` table using better-sqlite3
 * prepared statements. Sessions survive process restarts since they are
 * stored in SQLite.
 *
 * Factory function pattern (createSessionStore) consistent with
 * createSecretManager for minimal public surface area.
 */

import type Database from "better-sqlite3";
import { formatSessionKey, systemNowMs, type SessionData, type SessionDetailedEntry, type SessionKey, type SessionListEntry, type SessionStorePort } from "@comis/core";
import { z } from "zod";
import type { SessionRow } from "./types.js";

const SessionMessagesSchema = z.array(z.unknown());
const SessionMetadataSchema = z.record(z.string(), z.unknown());

/** Maximum serialized session size in bytes (10MB). */
export const MAX_SESSION_BYTES = 10 * 1024 * 1024;

/** Parse JSON-encoded messages with Zod validation, falling back to empty array on corrupt data. */
function parseMessages(raw: string): unknown[] {
  try {
    const result = SessionMessagesSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/** Parse JSON-encoded metadata with Zod validation, falling back to empty object on corrupt data. */
function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const result = SessionMetadataSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

// SessionData, SessionListEntry, SessionDetailedEntry, SessionStorePort —
// canonical home is `@comis/core/src/ports/session-store-types.ts` (Phase 31
// commit 1 / MEM-CTX-PORTS-03). Imported above for use in the factory body's
// internal type narrowing.

/**
 * Create a SessionStorePort bound to the given database.
 *
 * Assumes `initSchema()` has already been called on the database
 * to create the `sessions` table.
 */
export function createSessionStore(db: Database.Database): SessionStorePort {
  // Prepare statements once for performance
  const upsertStmt = db.prepare(`
    INSERT INTO sessions (session_key, tenant_id, user_id, channel_id, messages, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      messages = excluded.messages,
      updated_at = excluded.updated_at,
      metadata = excluded.metadata
  `);

  const loadStmt = db.prepare("SELECT * FROM sessions WHERE session_key = ?");

  const listAllStmt = db.prepare(
    "SELECT session_key, updated_at FROM sessions ORDER BY updated_at DESC",
  );

  const listByTenantStmt = db.prepare(
    "SELECT session_key, updated_at FROM sessions WHERE tenant_id = ? ORDER BY updated_at DESC",
  );

  const deleteStmt = db.prepare("DELETE FROM sessions WHERE session_key = ?");

  const deleteStaleStmt = db.prepare("DELETE FROM sessions WHERE updated_at < ?");

  const loadByKeyStmt = db.prepare("SELECT * FROM sessions WHERE session_key = ?");

  const listDetailedAllStmt = db.prepare(
    "SELECT session_key, tenant_id, user_id, channel_id, metadata, created_at, updated_at, json_array_length(messages) AS message_count FROM sessions ORDER BY updated_at DESC",
  );
  const listDetailedByTenantStmt = db.prepare(
    "SELECT session_key, tenant_id, user_id, channel_id, metadata, created_at, updated_at, json_array_length(messages) AS message_count FROM sessions WHERE tenant_id = ? ORDER BY updated_at DESC",
  );

  return {
    save(key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>): void {
      const now = systemNowMs();
      const sessionKey = formatSessionKey(key);
      const messagesJson = JSON.stringify(messages);
      const metadataJson = JSON.stringify(metadata ?? {});

      // Validate serialized session size before storing
      const totalBytes = Buffer.byteLength(messagesJson, "utf-8") + Buffer.byteLength(metadataJson, "utf-8");
      if (totalBytes > MAX_SESSION_BYTES) {
        throw new Error(
          `Session data exceeds maximum size: ${totalBytes} bytes > ${MAX_SESSION_BYTES} bytes (10MB limit)`,
        );
      }

      upsertStmt.run(
        sessionKey,
        key.tenantId,
        key.userId,
        key.channelId,
        messagesJson,
        now,
        now,
        metadataJson,
      );
    },

    load(key: SessionKey): SessionData | undefined {
      const sessionKey = formatSessionKey(key);
      const row = loadStmt.get(sessionKey) as SessionRow | undefined;
      if (!row) return undefined;

      return {
        messages: parseMessages(row.messages),
        metadata: parseMetadata(row.metadata),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    list(tenantId?: string): SessionListEntry[] {
      const rows = (
        tenantId !== undefined ? listByTenantStmt.all(tenantId) : listAllStmt.all()
      ) as Array<{ session_key: string; updated_at: number }>;

      return rows.map((r) => ({
        sessionKey: r.session_key,
        updatedAt: r.updated_at,
      }));
    },

    delete(key: SessionKey): boolean {
      const sessionKey = formatSessionKey(key);
      const result = deleteStmt.run(sessionKey);
      return result.changes > 0;
    },

    deleteStale(maxAgeMs: number): number {
      const cutoff = systemNowMs() - maxAgeMs;
      const result = deleteStaleStmt.run(cutoff);
      return result.changes;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const row = loadByKeyStmt.get(sessionKey) as SessionRow | undefined;
      if (!row) return undefined;
      return {
        messages: parseMessages(row.messages),
        metadata: parseMetadata(row.metadata),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    listDetailed(tenantId?: string): SessionDetailedEntry[] {
      const rows = (
        tenantId !== undefined
          ? listDetailedByTenantStmt.all(tenantId)
          : listDetailedAllStmt.all()
      ) as Array<{
        session_key: string;
        tenant_id: string;
        user_id: string;
        channel_id: string;
        metadata: string;
        created_at: number;
        updated_at: number;
        message_count: number;
      }>;
      return rows.map((r) => ({
        sessionKey: r.session_key,
        tenantId: r.tenant_id,
        userId: r.user_id,
        channelId: r.channel_id,
        metadata: parseMetadata(r.metadata),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.message_count,
      }));
    },
  };
}
