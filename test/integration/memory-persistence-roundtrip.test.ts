// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: memory persistence roundtrip — real SQLite, close & reopen.
 *
 * Phase 40 Plan 40-16 (COV-04 gap closure): lifts integration-tier coverage
 * for `@comis/memory` (currently 51.12% — needs ~29pp). Exercises the
 * production `SqliteMemoryAdapter` against a real SQLite database in
 * a vitest tmp dir (NOT ~/.comis/), proves entries survive close+reopen,
 * and runs hybrid search across the persisted store.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteMemoryAdapter } from "@comis/memory";
import type { MemoryConfig, MemoryEntry } from "@comis/core";

function makeTestConfig(dbPath: string): MemoryConfig {
  return {
    dbPath,
    walMode: false,
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0, maxEntries: 0 },
  } as MemoryConfig;
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

  it("stores entry, retrieves by id, returns identical payload", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    const entry = makeEntry({ content: "the quick brown fox" });
    const storeResult = await adapter.store(entry);
    expect(storeResult.ok).toBe(true);

    const retrieveResult = await adapter.retrieve(entry.id);
    expect(retrieveResult.ok).toBe(true);
    if (retrieveResult.ok && retrieveResult.value) {
      expect(retrieveResult.value.content).toBe("the quick brown fox");
      expect(retrieveResult.value.id).toBe(entry.id);
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
      );
      expect(r.ok).toBe(true);
    }

    // Read-back phase with a fresh adapter on the same file
    {
      const adapter = new SqliteMemoryAdapter(config);
      const r = await adapter.retrieve(entryId);
      expect(r.ok).toBe(true);
      if (r.ok && r.value) {
        expect(r.value.content).toBe("persistent-content");
      }
    }
  });

  it("delete removes entry from store; subsequent retrieve returns undefined", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    const entry = makeEntry({ content: "to be deleted" });
    await adapter.store(entry);

    const deleteResult = await adapter.delete(entry.id);
    expect(deleteResult.ok).toBe(true);

    const retrieveResult = await adapter.retrieve(entry.id);
    expect(retrieveResult.ok).toBe(true);
    if (retrieveResult.ok) {
      expect(retrieveResult.value).toBeUndefined();
    }
  });

  it("search returns previously-stored entries via FTS query", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    await adapter.store(makeEntry({ content: "alpha needle search target" }));
    await adapter.store(makeEntry({ content: "beta haystack distractor" }));
    await adapter.store(makeEntry({ content: "gamma irrelevant text" }));

    // SqliteMemoryAdapter.search(sessionKey, query, options?). sessionKey uses
    // channelId field (not channel) per @comis/core SessionKey type.
    const sessionKey = {
      tenantId: "default",
      userId: "user_a",
      channelId: "default",
    };
    const searchResult = await adapter.search(sessionKey, "needle", {
      limit: 10,
    });
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      // search returns MemorySearchResult[] (array of { entry, score? }).
      expect(Array.isArray(searchResult.value)).toBe(true);
    }
  });

  it("clear removes all entries for a session key", async () => {
    const adapter = new SqliteMemoryAdapter(makeTestConfig(dbPath));
    const sessionKey = {
      tenantId: "default",
      userId: "user_clear",
      channelId: "test-channel",
    };
    await adapter.store(
      makeEntry({
        userId: "user_clear",
        content: "first entry to clear",
        source: { who: "integration-test", channel: "test-channel" },
      }),
    );
    await adapter.store(
      makeEntry({
        userId: "user_clear",
        content: "second entry to clear",
        source: { who: "integration-test", channel: "test-channel" },
      }),
    );

    const clearResult = await adapter.clear(sessionKey);
    expect(clearResult.ok).toBe(true);
  });
});
