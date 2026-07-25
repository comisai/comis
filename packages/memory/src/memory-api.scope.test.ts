// SPDX-License-Identifier: Apache-2.0
import type { ConversationRef, MemoryConfig, MemoryEntry, MemoryRecallScope, SessionStorePort } from "@comis/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApi } from "./memory-api.js";
import { initSchema } from "./schema.js";
import { ScopedMemoryTestAdapter as SqliteMemoryAdapter } from "../../../test/support/scoped-memory-adapter.js";

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
  rerankerThreads: 1,
};

const memory: MemoryEntry = {
  id: "00000000-0000-4000-8000-000000000002",
  tenantId: "tenant_a",
  agentId: "agent_a",
  userId: "user_a",
  visibility: { kind: "agent-shared" },
  content: "explicit authority scope",
  trustLevel: "learned",
  source: { who: "agent" },
  tags: [],
  createdAt: 1_700_000_000_000,
};

describe("memory api explicit authority scope", () => {
  const adapters: SqliteMemoryAdapter[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const adapter of adapters) adapter.close();
    for (const db of databases) db.close();
    adapters.length = 0;
    databases.length = 0;
  });

  function makeApi() {
    const db = new Database(":memory:");
    databases.push(db);
    initSchema(db, 4);
    const adapter = new SqliteMemoryAdapter(config);
    adapters.push(adapter);
    return {
      api: createMemoryApi(
        db,
        adapter,
        {} as unknown as SessionStorePort,
        config,
      ),
      adapter,
      db,
    };
  }

  it("search uses explicit recall authority while management calls reject missing tenant authority", async () => {
    const { api, adapter } = makeApi();
    const stored = await adapter.store(memory);
    expect(stored.ok).toBe(true);

    const scope: MemoryRecallScope = {
      tenantId: "tenant_a",
      agentId: "agent_a",
      conversationRef: `cv_${"A".repeat(43)}` as ConversationRef,
      principalId: "user_a",
      includeAgentShared: true,
    };
    expect(await api.search("authority", { scope })).toHaveLength(1);
    expect(() => api.stats(undefined as unknown as string, "agent_a")).toThrow(/tenant/i);
    const pin = await api.pin(memory.id, undefined as unknown as string, "agent_a");
    expect(pin.ok).toBe(false);
    expect(() => api.clear({ agentId: "agent_a" } as { tenantId: string; agentId: string })).toThrow(/tenant/i);
  });
});
