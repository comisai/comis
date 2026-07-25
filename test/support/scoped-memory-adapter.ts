// SPDX-License-Identifier: Apache-2.0
import type {
  EmbeddingPort,
  MemoryConfig,
  MemoryEntry,
  MemoryRecallScope,
  MemorySearchOptions,
  MemoryWriteEntry,
  MemoryWriteScope,
  ResolvedTurnScope,
  SessionKey,
} from "@comis/core";
import { createMemoryRecallScope } from "@comis/core";
import { SqliteMemoryAdapter } from "../../packages/memory/src/sqlite-memory-adapter.js";

type LegacySearchOptions = MemorySearchOptions & { agentId?: string };

function turnScope(tenantId: string, agentId: string, principalId: string): ResolvedTurnScope {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "memory-fixture",
    conversationId: "memory-fixture",
    conversationKind: "direct" as const,
  };
  return {
    conversation: { tenantId, agentId, partition: { kind: "agent" } },
    principal: { principalId },
    endpoint,
  };
}

function fixtureWriteScope(entry: Partial<MemoryEntry>): MemoryWriteScope {
  const tenantId = entry.tenantId ?? "default";
  const agentId = entry.agentId ?? "default";
  const principalId = entry.userId ?? "user_a";
  const visibility = entry.visibility?.kind === "conversation"
    ? { kind: "conversation" as const }
    : entry.visibility?.kind === "principal"
      ? { kind: "principal" as const }
      : { kind: "agent-shared" as const };
  return {
    turnScope: turnScope(tenantId, agentId, principalId),
    visibility,
    ...(entry.trustLevel === "external" && visibility.kind !== "conversation"
      ? {
          operatorPermission: {
            kind: "operator-memory-visibility" as const,
            tenantId,
            agentId,
          },
        }
      : {}),
  };
}

function fixtureRecallScope(scope: MemoryRecallScope | SessionKey, options?: LegacySearchOptions): MemoryRecallScope {
  if ("conversationRef" in scope) return scope;
  const tenantId = scope.tenantId;
  const agentId = options?.agentId ?? scope.agentId ?? "default";
  const resolved = createMemoryRecallScope(turnScope(tenantId, agentId, scope.userId), true);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

function stripResolvedFields(entry: MemoryWriteEntry | MemoryEntry): MemoryWriteEntry {
  const source = entry as MemoryEntry;
  const {
    tenantId: _tenantId,
    agentId: _agentId,
    userId: _userId,
    visibility: _visibility,
    ...writeEntry
  } = source;
  return writeEntry;
}

/** Explicit authority bridge for older unit fixtures; production signatures stay strict. */
export class ScopedMemoryTestAdapter extends SqliteMemoryAdapter {
  constructor(config: MemoryConfig, embeddingPort?: EmbeddingPort, logger?: ConstructorParameters<typeof SqliteMemoryAdapter>[2]) {
    super(config, embeddingPort, logger);
  }

  async store(entry: MemoryWriteEntry | MemoryEntry, scope?: MemoryWriteScope) {
    return super.store(stripResolvedFields(entry), scope ?? fixtureWriteScope(entry));
  }

  async search(
    scope: MemoryRecallScope | SessionKey,
    query: string | number[],
    options?: LegacySearchOptions,
  ) {
    const { agentId: _agentId, ...searchOptions } = options ?? {};
    return super.search(fixtureRecallScope(scope, options), query, searchOptions);
  }

  async searchLanes(
    scope: MemoryRecallScope | SessionKey,
    query: string | number[],
    options?: LegacySearchOptions,
  ) {
    const { agentId: _agentId, ...searchOptions } = options ?? {};
    return super.searchLanes(fixtureRecallScope(scope, options), query, searchOptions);
  }
}
