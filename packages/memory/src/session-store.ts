// SPDX-License-Identifier: Apache-2.0
/** SQLite session persistence keyed by canonical conversation authority. */

import type Database from "better-sqlite3";
import {
  ConversationRefSchema,
  ConversationScopeSchema,
  createConversationRef,
  SessionStoreError,
  systemNowMs,
  type ConversationRef,
  type ConversationScope,
  type SessionData,
  type SessionDetailedEntry,
  type SessionListEntry,
  type SessionQueryScope,
  type SessionStorePort,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { SessionRowSchema } from "./row-schemas.js";

const sessionRowMapper = createRowMapper(SessionRowSchema);
const sessionListRowMapper = createRowMapper(z.strictObject({
  tenant_id: z.string(),
  agent_id: z.string(),
  conversation_ref: z.string(),
  canonical_scope: z.string(),
  updated_at: z.number(),
}));
const sessionDetailedRowMapper = createRowMapper(SessionRowSchema.extend({
  message_count: z.number(),
}));

const SessionMessagesSchema = z.array(z.unknown());
const SessionMetadataSchema = z.record(z.string(), z.unknown());
const SessionQueryScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
});

/** Maximum serialized session size in bytes (10MB). */
export const MAX_SESSION_BYTES = 10 * 1024 * 1024;

interface ScopeIdentity {
  scope: ConversationScope;
  conversationRef: ConversationRef;
  canonicalScope: string;
}

function storeError(message: string, errorKind: SessionStoreError["errorKind"]): SessionStoreError {
  return new SessionStoreError(message, errorKind);
}

function databaseResult<T>(operation: () => T): Result<T, SessionStoreError> {
  const result = tryCatch(operation);
  return result.ok
    ? ok(result.value)
    : err(storeError("Session database operation failed", "resource"));
}

function resolveIdentity(scope: ConversationScope): Result<ScopeIdentity, SessionStoreError> {
  const parsed = ConversationScopeSchema.safeParse(scope);
  if (!parsed.success) return err(storeError("Session operation requires a valid conversation scope", "validation"));
  const reference = createConversationRef(parsed.data);
  if (!reference.ok) return err(storeError(reference.error.message, "validation"));
  return ok({
    scope: parsed.data,
    conversationRef: reference.value,
    canonicalScope: JSON.stringify(parsed.data),
  });
}

function parseQueryScope(scope: SessionQueryScope): Result<SessionQueryScope, SessionStoreError> {
  const parsed = SessionQueryScopeSchema.safeParse(scope);
  return parsed.success
    ? ok(parsed.data)
    : err(storeError("Session query requires explicit tenant and agent authority", "validation"));
}

function parseStoredScope(raw: string): Result<ConversationScope, SessionStoreError> {
  const decoded = tryCatch(() => JSON.parse(raw) as unknown);
  if (!decoded.ok) return err(storeError("Stored session scope is not valid JSON", "internal"));
  const parsed = ConversationScopeSchema.safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(storeError("Stored session scope failed validation", "internal"));
}

function parseMessages(raw: string): Result<unknown[], SessionStoreError> {
  const decoded = tryCatch(() => JSON.parse(raw) as unknown);
  if (!decoded.ok) return err(storeError("Stored session messages are not valid JSON", "internal"));
  const parsed = SessionMessagesSchema.safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(storeError("Stored session messages failed validation", "internal"));
}

function parseMetadata(raw: string): Result<Record<string, unknown>, SessionStoreError> {
  const decoded = tryCatch(() => JSON.parse(raw) as unknown);
  if (!decoded.ok) return err(storeError("Stored session metadata is not valid JSON", "internal"));
  const parsed = SessionMetadataSchema.safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(storeError("Stored session metadata failed validation", "internal"));
}

function parseReference(raw: string): Result<ConversationRef, SessionStoreError> {
  const parsed = ConversationRefSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(storeError("Stored conversation reference failed validation", "internal"));
}

function rowToSessionData(
  row: z.infer<typeof SessionRowSchema>,
  expectedCanonicalScope?: string,
): Result<SessionData, SessionStoreError> {
  if (expectedCanonicalScope !== undefined && row.canonical_scope !== expectedCanonicalScope) {
    return err(storeError("Conversation reference resolved to a different canonical scope", "internal"));
  }
  const scope = parseStoredScope(row.canonical_scope);
  if (!scope.ok) return scope;
  if (scope.value.tenantId !== row.tenant_id || scope.value.agentId !== row.agent_id) {
    return err(storeError("Stored session authority columns disagree with its canonical scope", "internal"));
  }
  const reference = parseReference(row.conversation_ref);
  if (!reference.ok) return reference;
  const expectedReference = createConversationRef(scope.value);
  if (!expectedReference.ok || expectedReference.value !== reference.value) {
    return err(storeError("Stored session reference disagrees with its canonical scope", "internal"));
  }
  const messages = parseMessages(row.messages);
  if (!messages.ok) return messages;
  const metadata = parseMetadata(row.metadata);
  if (!metadata.ok) return metadata;
  return ok({
    conversationRef: reference.value,
    conversationScope: scope.value,
    messages: messages.value,
    metadata: metadata.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Create a SessionStorePort bound to an initialized database. */
export function createSessionStore(db: Database.Database): SessionStorePort {
  const upsertStmt = db.prepare(`
    INSERT INTO sessions (
      tenant_id, agent_id, conversation_ref, canonical_scope,
      messages, created_at, updated_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, agent_id, conversation_ref) DO UPDATE SET
      messages = excluded.messages,
      updated_at = excluded.updated_at,
      metadata = excluded.metadata
  `);
  const loadStmt = db.prepare(`
    SELECT * FROM sessions
    WHERE tenant_id = ? AND agent_id = ? AND conversation_ref = ?
  `);
  const listStmt = db.prepare(`
    SELECT tenant_id, agent_id, conversation_ref, canonical_scope, updated_at
    FROM sessions
    WHERE tenant_id = ? AND agent_id = ?
    ORDER BY updated_at DESC
  `);
  const listDetailedStmt = db.prepare(`
    SELECT *, json_array_length(messages) AS message_count
    FROM sessions
    WHERE tenant_id = ? AND agent_id = ?
    ORDER BY updated_at DESC
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM sessions
    WHERE tenant_id = ? AND agent_id = ? AND conversation_ref = ?
  `);
  const deleteStaleStmt = db.prepare(`
    DELETE FROM sessions
    WHERE tenant_id = ? AND agent_id = ? AND updated_at < ?
  `);

  function loadRow(
    queryScope: SessionQueryScope,
    conversationRef: ConversationRef,
    expectedCanonicalScope?: string,
  ): Result<SessionData | undefined, SessionStoreError> {
    const rowResult = databaseResult(() => loadStmt.get(
      queryScope.tenantId,
      queryScope.agentId,
      conversationRef,
    ));
    if (!rowResult.ok) return rowResult;
    const parsed = sessionRowMapper.parseOptionalRow(rowResult.value);
    if (!parsed.ok) return err(storeError("Stored session row failed validation", "internal"));
    if (parsed.value === undefined) return ok(undefined);
    return rowToSessionData(parsed.value, expectedCanonicalScope);
  }

  return {
    save(scope, messages, metadata) {
      const identity = resolveIdentity(scope);
      if (!identity.ok) return identity;
      const messagesJson = JSON.stringify(messages);
      const metadataJson = JSON.stringify(metadata ?? {});
      const totalBytes = Buffer.byteLength(messagesJson, "utf8") + Buffer.byteLength(metadataJson, "utf8");
      if (totalBytes > MAX_SESSION_BYTES) {
        return err(storeError(`Session data exceeds the ${MAX_SESSION_BYTES}-byte limit`, "validation"));
      }
      const operation = databaseResult(() => db.transaction(() => {
        const existing = sessionRowMapper.parseOptionalRow(loadStmt.get(
          identity.value.scope.tenantId,
          identity.value.scope.agentId,
          identity.value.conversationRef,
        ));
        if (!existing.ok) return err(storeError("Stored session row failed validation", "internal"));
        if (
          existing.value !== undefined
          && existing.value.canonical_scope !== identity.value.canonicalScope
        ) {
          return err(storeError("Conversation reference collides with a different canonical scope", "internal"));
        }
        const now = systemNowMs();
        upsertStmt.run(
          identity.value.scope.tenantId,
          identity.value.scope.agentId,
          identity.value.conversationRef,
          identity.value.canonicalScope,
          messagesJson,
          now,
          now,
          metadataJson,
        );
        return ok(undefined);
      })());
      if (!operation.ok) return operation;
      return operation.value;
    },

    load(scope) {
      const identity = resolveIdentity(scope);
      if (!identity.ok) return identity;
      return loadRow(identity.value.scope, identity.value.conversationRef, identity.value.canonicalScope);
    },

    loadByRef(scope, conversationRef) {
      const query = parseQueryScope(scope);
      if (!query.ok) return query;
      const reference = ConversationRefSchema.safeParse(conversationRef);
      if (!reference.success) return err(storeError("Session lookup requires a valid conversation reference", "validation"));
      return loadRow(query.value, reference.data);
    },

    list(scope) {
      const query = parseQueryScope(scope);
      if (!query.ok) return query;
      const raw = databaseResult(() => listStmt.all(query.value.tenantId, query.value.agentId));
      if (!raw.ok) return raw;
      const parsed = sessionListRowMapper.parseRows(raw.value);
      if (!parsed.ok) return err(storeError("Stored session list failed validation", "internal"));
      const entries: SessionListEntry[] = [];
      for (const row of parsed.value) {
        const conversationRef = parseReference(row.conversation_ref);
        if (!conversationRef.ok) return conversationRef;
        const conversationScope = parseStoredScope(row.canonical_scope);
        if (!conversationScope.ok) return conversationScope;
        const referenceCheck = createConversationRef(conversationScope.value);
        if (!referenceCheck.ok || referenceCheck.value !== conversationRef.value) {
          return err(storeError("Stored session list reference disagrees with canonical scope", "internal"));
        }
        entries.push({
          conversationRef: conversationRef.value,
          conversationScope: conversationScope.value,
          updatedAt: row.updated_at,
        });
      }
      return ok(entries);
    },

    delete(scope) {
      const identity = resolveIdentity(scope);
      if (!identity.ok) return identity;
      const operation = databaseResult(() => db.transaction(() => {
        const loaded = loadRow(identity.value.scope, identity.value.conversationRef, identity.value.canonicalScope);
        if (!loaded.ok) return loaded;
        if (loaded.value === undefined) return ok(false);
        const deleted = deleteStmt.run(
          identity.value.scope.tenantId,
          identity.value.scope.agentId,
          identity.value.conversationRef,
        );
        return ok(deleted.changes > 0);
      })());
      if (!operation.ok) return operation;
      return operation.value;
    },

    deleteByRef(scope, conversationRef) {
      const query = parseQueryScope(scope);
      if (!query.ok) return query;
      const reference = ConversationRefSchema.safeParse(conversationRef);
      if (!reference.success) return err(storeError("Session deletion requires a valid conversation reference", "validation"));
      const operation = databaseResult(() => db.transaction(() => {
        const loaded = loadRow(query.value, reference.data);
        if (!loaded.ok) return loaded;
        if (loaded.value === undefined) return ok(false);
        const deleted = deleteStmt.run(query.value.tenantId, query.value.agentId, reference.data);
        return ok(deleted.changes > 0);
      })());
      if (!operation.ok) return operation;
      return operation.value;
    },

    deleteStale(scope, maxAgeMs) {
      const query = parseQueryScope(scope);
      if (!query.ok) return query;
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
        return err(storeError("Session retention age must be a non-negative finite number", "validation"));
      }
      const deleted = databaseResult(() => deleteStaleStmt.run(
        query.value.tenantId,
        query.value.agentId,
        systemNowMs() - maxAgeMs,
      ));
      return deleted.ok ? ok(deleted.value.changes) : deleted;
    },

    listDetailed(scope) {
      const query = parseQueryScope(scope);
      if (!query.ok) return query;
      const raw = databaseResult(() => listDetailedStmt.all(query.value.tenantId, query.value.agentId));
      if (!raw.ok) return raw;
      const parsed = sessionDetailedRowMapper.parseRows(raw.value);
      if (!parsed.ok) return err(storeError("Stored detailed session list failed validation", "internal"));
      const entries: SessionDetailedEntry[] = [];
      for (const row of parsed.value) {
        const data = rowToSessionData(row);
        if (!data.ok) return data;
        entries.push({
          conversationRef: data.value.conversationRef,
          conversationScope: data.value.conversationScope,
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          metadata: data.value.metadata,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          messageCount: row.message_count,
        });
      }
      return ok(entries);
    },
  };
}
