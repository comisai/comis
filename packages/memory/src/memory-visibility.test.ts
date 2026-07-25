// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryConfig,
  MemoryWriteEntry,
  MemoryWriteScope,
  ResolvedTurnScope,
} from "@comis/core";
import { createMemoryRecallScope } from "@comis/core";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

const config: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    rerankerModel: "hf:test/reranker.gguf",
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
  rerankerModelsDir: "models",
  rerankerGpu: "false",
  rerankerThreads: 4,
};

function turn(conversationId: string, principalId: string): ResolvedTurnScope {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-main",
    conversationId,
    conversationKind: "shared" as const,
  };
  return {
    conversation: {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "endpoint-conversation", endpoint },
    },
    principal: { principalId },
    endpoint,
  };
}

function entry(id: string, content: string, trustLevel: "learned" | "external" = "learned"): MemoryWriteEntry {
  return {
    id,
    content,
    trustLevel,
    source: { who: "user_a", channel: "telegram" },
    tags: [],
    createdAt: 1_700_000_000_000,
  };
}

function writeScope(
  turnScope: ResolvedTurnScope,
  visibility: MemoryWriteScope["visibility"],
  operator = false,
): MemoryWriteScope {
  return {
    turnScope,
    visibility,
    ...(operator
      ? {
          operatorPermission: {
            kind: "operator-memory-visibility" as const,
            tenantId: turnScope.conversation.tenantId,
            agentId: turnScope.conversation.agentId,
          },
        }
      : {}),
  };
}

function recallScope(turnScope: ResolvedTurnScope, includeAgentShared: boolean) {
  const scope = createMemoryRecallScope(turnScope, includeAgentShared);
  if (!scope.ok) throw scope.error;
  return scope.value;
}

describe("memory visibility store boundary", () => {
  it("conversation visible memories stay invisible outside their conversation", async () => {
    const adapter = new SqliteMemoryAdapter(config);
    const chatA = turn("chat-a", "user-a");
    const chatB = turn("chat-b", "user-a");
    await adapter.store(entry("conversation-a", "orchid conversation fact"), writeScope(chatA, { kind: "conversation" }));

    const visible = await adapter.search(recallScope(chatA, false), "orchid");
    const hidden = await adapter.search(recallScope(chatB, false), "orchid");

    expect(visible.ok && visible.value.map((result) => result.entry.id)).toContain("conversation-a");
    expect(hidden.ok && hidden.value).toEqual([]);
    adapter.close();
  });

  it("principal visible memories stay invisible to another principal in the same conversation", async () => {
    const adapter = new SqliteMemoryAdapter(config);
    const userA = turn("shared-chat", "user-a");
    const userB = turn("shared-chat", "user-b");
    await adapter.store(entry("principal-a", "saffron principal fact"), writeScope(userA, { kind: "principal" }));

    const visible = await adapter.search(recallScope(userA, false), "saffron");
    const hidden = await adapter.search(recallScope(userB, false), "saffron");

    expect(visible.ok && visible.value.map((result) => result.entry.id)).toContain("principal-a");
    expect(hidden.ok && hidden.value).toEqual([]);
    adapter.close();
  });

  it("agent shared memories require the include agent shared read flag", async () => {
    const adapter = new SqliteMemoryAdapter(config);
    const turnScope = turn("shared-chat", "user-a");
    await adapter.store(entry("shared-a", "cobalt shared fact"), writeScope(turnScope, { kind: "agent-shared" }));

    const excluded = await adapter.search(recallScope(turnScope, false), "cobalt");
    const included = await adapter.search(recallScope(turnScope, true), "cobalt");

    expect(excluded.ok && excluded.value).toEqual([]);
    expect(included.ok && included.value.map((result) => result.entry.id)).toContain("shared-a");
    adapter.close();
  });

  it("widening visibility without typed operator permission returns err and emits an audit decision", async () => {
    const audit = vi.fn();
    const adapter = new SqliteMemoryAdapter(config, undefined, {
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(), audit,
    });
    const turnScope = turn("shared-chat", "user-a");
    const stored = await adapter.store(entry("narrow-a", "topaz narrow fact"), writeScope(turnScope, { kind: "conversation" }));
    expect(stored.ok).toBe(true);

    const changed = await adapter.changeVisibility("narrow-a", writeScope(turnScope, { kind: "agent-shared" }));

    expect(changed.ok).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }), "Memory visibility change denied");
    adapter.close();
  });

  it("external provenance content cannot exceed conversation visibility without explicit operator policy", async () => {
    const audit = vi.fn();
    const adapter = new SqliteMemoryAdapter(config, undefined, {
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(), audit,
    });
    const turnScope = turn("shared-chat", "user-a");

    const denied = await adapter.store(
      entry("external-denied", "amber external fact", "external"),
      writeScope(turnScope, { kind: "principal" }),
    );
    const allowed = await adapter.store(
      entry("external-allowed", "amber operator fact", "external"),
      writeScope(turnScope, { kind: "agent-shared" }, true),
    );

    expect(denied.ok).toBe(false);
    expect(allowed.ok).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }), "Memory visibility write denied");
    adapter.close();
  });

  it("changing visibility creates a new memory id and removes the original under the old scope", async () => {
    const adapter = new SqliteMemoryAdapter(config);
    const turnScope = turn("shared-chat", "user-a");
    await adapter.store(entry("visibility-old", "violet visibility fact"), writeScope(turnScope, { kind: "conversation" }));

    const changed = await adapter.changeVisibility(
      "visibility-old",
      writeScope(turnScope, { kind: "agent-shared" }, true),
    );
    expect(changed.ok && changed.value?.id).not.toBe("visibility-old");

    const oldScope = await adapter.search(recallScope(turnScope, false), "violet");
    const sharedScope = await adapter.search(recallScope(turnScope, true), "violet");
    expect(oldScope.ok && oldScope.value).toEqual([]);
    expect(sharedScope.ok && sharedScope.value.map((result) => result.entry.id)).toEqual([changed.ok ? changed.value?.id : undefined]);
    expect(adapter.getDb().prepare("SELECT id FROM memories WHERE id = ?").get("visibility-old")).toBeUndefined();
    adapter.close();
  });
});
