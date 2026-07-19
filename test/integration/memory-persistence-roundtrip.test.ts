// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: memory persistence roundtrip — real SQLite, close & reopen.
 *
 * Lifts integration-tier coverage for `@comis/memory`. Exercises the
 * production `SqliteMemoryAdapter` against a real SQLite database in
 * a vitest tmp dir (NOT ~/.comis/), proves entries survive close+reopen,
 * and runs hybrid search across the persisted store.
 *
 * The `MemoryPort` surface is `store / search / delete` (no `retrieve`,
 * no `clear` — those would be redundant with search-by-content and the
 * retention policy in @comis/core). Roundtrip is verified by storing an
 * entry and confirming a search returns it.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteMemoryAdapter } from "@comis/memory";
import { createMemoryRecallScope } from "@comis/core";
import type {
  MemoryConfig,
  MemoryEntry,
  MemoryRecallScope,
  MemoryWriteScope,
  ResolvedTurnScope,
} from "@comis/core";

function makeTestConfig(dbPath: string): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    recall: {
      embeddingModel: "test-model",
      embeddingDimensions: 4,
    },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
  } as MemoryConfig;
}

// Explicit resolved authority for the store/search paths. Production signatures are
// two-arg: store(entry, MemoryWriteScope) and search(MemoryRecallScope, query). Entries
// are written agent-shared, so recall sets includeAgentShared=true to see them.
const TURN_SCOPE: ResolvedTurnScope = {
  conversation: { tenantId: "default", agentId: "default", partition: { kind: "agent" } },
  principal: { principalId: "user_a" },
  endpoint: {
    channelType: "test",
    channelInstanceId: "memory-int-fixture",
    conversationId: "memory-int-fixture",
    conversationKind: "direct",
  },
};

const WRITE_SCOPE: MemoryWriteScope = {
  turnScope: TURN_SCOPE,
  visibility: { kind: "agent-shared" },
};

function recallScope(): MemoryRecallScope {
  const resolved = createMemoryRecallScope(TURN_SCOPE, true);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? "default",
    agentId: overrides.agentId ?? "default",
    userId: overrides.userId ?? "user_a",
    content: overrides.content ?? "integration test memory entry",
    trustLevel: overrides.trustLevel ?? "system",
    source: overrides.source ?? { who: "integration-test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
  } as MemoryEntry;
}

describe("INTEGRATION: memory persistence — SqliteMemoryAdapter roundtrip", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-memory-int-"));
    dbPath = join(tmpDir, "test-memory.db");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("stores entry, search returns the persisted payload", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    const entry = makeEntry({ content: "the quick brown fox" });
    const storeResult = await adapter.store(entry, WRITE_SCOPE);
    expect(storeResult.ok).toBe(true);

    const searchResult = await adapter.search(recallScope(), "quick");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      const ids = searchResult.value.map((r) => r.entry.id);
      expect(ids).toContain(entry.id);
      const hit = searchResult.value.find((r) => r.entry.id === entry.id);
      expect(hit?.entry.content).toBe("the quick brown fox");
    }
  });

  it("persists entries across close-and-reopen of the adapter", async () => {
    const config = makeTestConfig(dbPath);
    const entryId = randomUUID();

    // Write phase
    {
      const adapter = new SqliteMemoryAdapter(config);
      const r = await adapter.store(
        makeEntry({ id: entryId, content: "persistent-content" }),
        WRITE_SCOPE,
      );
      expect(r.ok).toBe(true);
      adapter.close();
    }

    // Read-back phase with a fresh adapter on the same file
    {
      const adapter = new SqliteMemoryAdapter(config);
      const r = await adapter.search(recallScope(), "persistent");
      expect(r.ok).toBe(true);
      if (r.ok) {
        const hit = r.value.find((x) => x.entry.id === entryId);
        expect(hit).toBeDefined();
        expect(hit!.entry.content).toBe("persistent-content");
      }
      adapter.close();
    }
  });

  it("delete removes entry from store; subsequent search does not return it", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    const entry = makeEntry({ content: "to be deleted soon" });
    await adapter.store(entry, WRITE_SCOPE);

    const deleteResult = await adapter.delete(entry.id, {
      tenantId: entry.tenantId,
      agentId: entry.agentId,
    });
    expect(deleteResult.ok).toBe(true);

    const searchResult = await adapter.search(recallScope(), "deleted");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      const stillThere = searchResult.value.some(
        (r) => r.entry.id === entry.id,
      );
      expect(stillThere).toBe(false);
    }
  });

  it("search returns previously-stored entries via FTS query", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    await adapter.store(makeEntry({ content: "alpha needle search target" }), WRITE_SCOPE);
    await adapter.store(makeEntry({ content: "beta haystack distractor" }), WRITE_SCOPE);
    await adapter.store(makeEntry({ content: "gamma irrelevant text" }), WRITE_SCOPE);

    const searchResult = await adapter.search(
      recallScope(),
      "needle",
      { limit: 10 },
    );
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(Array.isArray(searchResult.value)).toBe(true);
      const contents = searchResult.value.map((r) => r.entry.content);
      expect(contents.some((c) => c.includes("needle"))).toBe(true);
    }
  });
});
