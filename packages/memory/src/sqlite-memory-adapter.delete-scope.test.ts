// SPDX-License-Identifier: Apache-2.0
import type { MemoryConfig, MemoryEntry } from "@comis/core";
import { afterEach, describe, expect, it } from "vitest";
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

function entry(): MemoryEntry {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "tenant_a",
    agentId: "agent_a",
    userId: "user_a",
    content: "agent a private memory",
    trustLevel: "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: 1_700_000_000_000,
  };
}

describe("memory deletion authority scope", () => {
  const adapters: SqliteMemoryAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters) adapter.close();
    adapters.length = 0;
  });

  it("delete by id refuses a row outside the caller's tenant-agent scope", async () => {
    const adapter = new SqliteMemoryAdapter(config);
    adapters.push(adapter);
    const stored = await adapter.store(entry());
    expect(stored.ok).toBe(true);

    const refused = await adapter.delete(entry().id, {
      tenantId: "tenant_a",
      agentId: "agent_b",
    });

    expect(refused).toEqual({ ok: true, value: false });
    expect(
      adapter.getDb().prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?").get(entry().id),
    ).toEqual({ count: 1 });
  });
});
