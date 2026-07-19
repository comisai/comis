// SPDX-License-Identifier: Apache-2.0
import type { EmbeddingPort, MemoryConfig, MemoryEntry, SessionKey } from "@comis/core";
import { ok } from "@comis/shared";
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

const embeddingPort: EmbeddingPort = {
  provider: "test",
  dimensions: 4,
  modelId: "test-model",
  async embed() {
    return ok([1, 0, 0, 0]);
  },
  async embedBatch(texts) {
    return ok(texts.map(() => [1, 0, 0, 0]));
  },
};

const inScope: SessionKey = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  userId: "user_a",
  channelId: "channel_a",
};

function makeEntry(
  id: string,
  content: string,
  embedding: number[],
  scope: { tenantId: string; agentId: string } = inScope,
): MemoryEntry {
  return {
    id,
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    userId: "user_a",
    content,
    embedding,
    trustLevel: "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: 1_700_000_000_000,
  };
}

async function storeForeignCorpus(adapter: SqliteMemoryAdapter): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    const result = await adapter.store(
      makeEntry(
        `foreign-${index}`,
        "orchid orchid orchid orchid orchid orchid orchid",
        [1, 0, 0, 0],
        { tenantId: "tenant_b", agentId: "agent_b" },
      ),
    );
    expect(result.ok ? undefined : result.error.message).toBeUndefined();
  }
}

describe("memory recall candidate scoping", () => {
  const adapters: SqliteMemoryAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters) adapter.close();
    adapters.length = 0;
  });

  function createAdapter(): SqliteMemoryAdapter {
    const adapter = new SqliteMemoryAdapter(config, embeddingPort);
    adapters.push(adapter);
    return adapter;
  }

  it("in-scope hybrid results are unaffected by a dominant out-of-scope corpus", async () => {
    const adapter = createAdapter();
    await adapter.store(makeEntry("local-a", "orchid project note", [0.8, 0.2, 0, 0]));
    await adapter.store(makeEntry("local-b", "orchid schedule note", [0.7, 0.3, 0, 0]));

    const baseline = await adapter.search(inScope, "orchid", { limit: 2, agentId: "agent_a" });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    await storeForeignCorpus(adapter);
    const withForeign = await adapter.search(inScope, "orchid", { limit: 2, agentId: "agent_a" });

    expect(withForeign.ok).toBe(true);
    if (!withForeign.ok) return;
    expect(withForeign.value.map(({ entry, score }) => ({ id: entry.id, score }))).toEqual(
      baseline.value.map(({ entry, score }) => ({ id: entry.id, score })),
    );
    expect(withForeign.value).toHaveLength(2);
  });

  it("vector-only search fills its limit from in-scope rows despite higher-ranking foreign rows", async () => {
    const adapter = createAdapter();
    await adapter.store(makeEntry("local-a", "local vector one", [0.8, 0.2, 0, 0]));
    await adapter.store(makeEntry("local-b", "local vector two", [0.7, 0.3, 0, 0]));
    await storeForeignCorpus(adapter);

    const result = await adapter.search(inScope, [1, 0, 0, 0], {
      limit: 2,
      agentId: "agent_a",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((item) => item.entry.id)).toEqual(["local-a", "local-b"]);
  });

  it("split-lane search scopes each lane's candidates before fusion", async () => {
    const adapter = createAdapter();
    await adapter.store(makeEntry("local-a", "orchid local one", [0.8, 0.2, 0, 0]));
    await adapter.store(makeEntry("local-b", "orchid local two", [0.7, 0.3, 0, 0]));
    await storeForeignCorpus(adapter);

    const result = await adapter.searchLanes(inScope, "orchid", {
      limit: 2,
      agentId: "agent_a",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fts.map((item) => item.entry.id)).toEqual(["local-a", "local-b"]);
    expect(result.value.vector.map((item) => item.entry.id)).toEqual(["local-a", "local-b"]);
  });
});
