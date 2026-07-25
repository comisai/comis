// SPDX-License-Identifier: Apache-2.0
// @allow-throw: SQLite invariant failures are raised inside adapter boundaries that translate them to Result errors.
import type Database from "better-sqlite3";
import { z } from "zod";
import type { MemoryRecallScope } from "@comis/core";

export interface MemoryAuthorityScope {
  tenantId: string;
  agentId: string;
  visibilityKey: string;
}

const PartitionRowSchema = z.strictObject({ partition_id: z.number().int().positive() });
const AuthorityRowSchema = z.strictObject({
  tenant_id: z.string(),
  agent_id: z.string(),
  visibility: z.enum(["conversation", "principal", "agent-shared"]),
  conversation_ref: z.string().nullable(),
  principal_id: z.string().nullable(),
});

export function memoryVisibilityKeys(scope: MemoryRecallScope): string[] {
  return [
    `conversation:${scope.conversationRef}`,
    `principal:${scope.principalId}`,
    ...(scope.includeAgentShared ? ["agent-shared"] : []),
  ];
}

export function memoryVisibilityClause(
  scope: MemoryRecallScope,
  columnPrefix: "" | "m." = "",
): { sql: string; params: [string, string] } {
  const sql = `((`+
    `${columnPrefix}visibility = 'conversation' AND ${columnPrefix}conversation_ref = ?) OR (`+
    `${columnPrefix}visibility = 'principal' AND ${columnPrefix}principal_id = ?)`+
    (scope.includeAgentShared ? ` OR ${columnPrefix}visibility = 'agent-shared')` : ")");
  return { sql, params: [scope.conversationRef, scope.principalId] };
}

export function findMemoryAuthorityPartition(
  db: Database.Database,
  scope: MemoryAuthorityScope,
): number | undefined {
  const parsed = PartitionRowSchema.safeParse(
    db
      .prepare(
        `SELECT partition_id
         FROM memory_authority_partitions
         WHERE tenant_id = ? AND agent_id = ? AND visibility_key = ?`,
      )
      .get(scope.tenantId, scope.agentId, scope.visibilityKey),
  );
  return parsed.success ? parsed.data.partition_id : undefined;
}

export function requireMemoryAuthorityPartition(
  db: Database.Database,
  scope: MemoryAuthorityScope,
): number {
  db.prepare(
    `INSERT OR IGNORE INTO memory_authority_partitions (tenant_id, agent_id, visibility_key)
     VALUES (?, ?, ?)`,
  ).run(scope.tenantId, scope.agentId, scope.visibilityKey);
  const partitionId = findMemoryAuthorityPartition(db, scope);
  if (partitionId === undefined) {
    throw new Error("Memory authority partition could not be resolved after insertion");
  }
  return partitionId;
}

export function requireMemoryAuthorityPartitionForMemory(
  db: Database.Database,
  memoryId: string,
): number {
  const parsed = AuthorityRowSchema.safeParse(
    db.prepare("SELECT tenant_id, agent_id, visibility, conversation_ref, principal_id FROM memories WHERE id = ?").get(memoryId),
  );
  if (!parsed.success) {
    throw new Error("Memory authority cannot be resolved for an unknown memory row");
  }
  return requireMemoryAuthorityPartition(db, {
    tenantId: parsed.data.tenant_id,
    agentId: parsed.data.agent_id,
    visibilityKey: parsed.data.visibility === "conversation"
      ? `conversation:${parsed.data.conversation_ref as string}`
      : parsed.data.visibility === "principal"
        ? `principal:${parsed.data.principal_id as string}`
        : "agent-shared",
  });
}

export function memoryAuthorityToken(partitionId: number): string {
  return `authority_${partitionId}`;
}

export function buildScopedFtsMatch(match: string, partitionIds: readonly number[]): string {
  const tokens = partitionIds.map((partitionId) => `"${memoryAuthorityToken(partitionId)}"`).join(" OR ");
  return `authority_token : (${tokens}) AND content : (${match})`;
}
