/**
 * SQLite WAL memory concurrency tests.
 *
 * Validates that concurrent memory operations under SQLite WAL mode
 * with multiple SqliteMemoryAdapter connections produce no errors.
 *
 * CRITICAL: Uses file-based SQLite (NOT :memory:). :memory: databases
 * cannot be shared across connections. WAL concurrency testing requires
 * file-based DB with multiple SqliteMemoryAdapter instances.
 *
 * NOTE on better-sqlite3 synchronous behavior:
 * better-sqlite3 is synchronous -- all SQL operations execute on the main
 * thread and are naturally serialized by the Node.js event loop within a
 * single connection. Promise.all with sync operations may not actually
 * overlap within a single tick. However, these tests validate the contract:
 * concurrent calls from multiple adapter instances do not produce unhandled
 * errors under WAL mode. If SQLITE_BUSY errors appear, adding
 * `busy_timeout = 5000` pragma to SqliteMemoryAdapter would resolve them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import type { MemoryEntry, MemoryConfig, SessionKey } from "@comis/core";
import type { Result } from "@comis/shared";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid MemoryEntry for testing. */
function makeEntry(
  overrides?: Partial<MemoryEntry> & { memoryType?: string },
): MemoryEntry & { memoryType?: string } {
  return {
    id: overrides?.id ?? randomUUID(),
    tenantId: overrides?.tenantId ?? "default",
    agentId: overrides?.agentId ?? "default",
    userId: overrides?.userId ?? "user-1",
    content: overrides?.content ?? "test memory content",
    trustLevel: overrides?.trustLevel ?? "learned",
    source: overrides?.source ?? { who: "agent", channel: "telegram" },
    tags: overrides?.tags ?? [],
    createdAt: overrides?.createdAt ?? Date.now(),
    ...(overrides?.memoryType ? { memoryType: overrides.memoryType } : {}),
  };
}

/** Remove .db, .db-wal, .db-shm files. */
function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* ignore -- file may not exist */
    }
  }
}

/** Create a WAL-enabled MemoryConfig for a given dbPath. */
function createWalConfig(dbPath: string): MemoryConfig {
  return {
    dbPath,
    walMode: true,
    embeddingModel: "test",
    embeddingDimensions: 4,
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0, maxEntries: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WAL concurrency tests", () => {
  let dbPath: string;
  const adapters: SqliteMemoryAdapter[] = [];

  const sessionKey: SessionKey = {
    tenantId: "default",
    userId: "user-1",
    channelId: "ch-1",
  };

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `wal-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    // Close all adapters (some may already be closed)
    for (const adapter of adapters) {
      try {
        adapter.close();
      } catch {
        /* already closed */
      }
    }
    adapters.length = 0;
    cleanupDb(dbPath);
  });

  // ── Concurrent store() and search() under WAL ──────────────────────

  describe("Concurrent store() and search() under WAL", () => {
    it("concurrent store and search from different adapters produce no errors", async () => {
      const config = createWalConfig(dbPath);
      const adapter1 = new SqliteMemoryAdapter(config);
      adapters.push(adapter1);
      const adapter2 = new SqliteMemoryAdapter(config);
      adapters.push(adapter2);

      // Verify WAL is active
      const journalMode = adapter1
        .getDb()
        .pragma("journal_mode", { simple: true });
      expect(journalMode).toBe("wal");

      // Seed some data via adapter1 so search has results to find
      const e1 = makeEntry({ id: "e1", content: "seed entry one" });
      const e2 = makeEntry({ id: "e2", content: "seed entry two" });
      const e3 = makeEntry({ id: "e3", content: "seed entry three" });
      await adapter1.store(e1);
      await adapter1.store(e2);
      await adapter1.store(e3);

      // Fire concurrent operations from both adapters
      const results = await Promise.all([
        adapter1.store(makeEntry({ id: "e4", content: "concurrent entry four" })),
        adapter2.store(makeEntry({ id: "e5", content: "concurrent entry five" })),
        adapter1.search(sessionKey, "concurrent"),
        adapter2.search(sessionKey, "entry"),
      ]);

      // All 4 results should succeed
      for (let i = 0; i < results.length; i++) {
        if (!results[i]!.ok) {
          const errResult = results[i] as { ok: false; error: Error };
          console.error(`Result ${i} failed:`, errResult.error.message);
        }
        expect(results[i]!.ok).toBe(true);
      }
    });

    it("interleaved store-then-search across adapters returns stored data", async () => {
      const config = createWalConfig(dbPath);
      const adapter1 = new SqliteMemoryAdapter(config);
      adapters.push(adapter1);
      const adapter2 = new SqliteMemoryAdapter(config);
      adapters.push(adapter2);

      // adapter1 stores "alpha data"
      const storeResult1 = await adapter1.store(
        makeEntry({ id: "alpha-1", content: "alpha data" }),
      );
      expect(storeResult1.ok).toBe(true);

      // adapter2 searches for "alpha" -- should find it (WAL readers see committed writes)
      const searchResult1 = await adapter2.search(sessionKey, "alpha");
      expect(searchResult1.ok).toBe(true);
      if (searchResult1.ok) {
        expect(searchResult1.value.length).toBeGreaterThanOrEqual(1);
        expect(searchResult1.value[0]!.entry.content).toBe("alpha data");
      }

      // adapter2 stores "beta data"
      const storeResult2 = await adapter2.store(
        makeEntry({ id: "beta-1", content: "beta data" }),
      );
      expect(storeResult2.ok).toBe(true);

      // adapter1 searches for "beta" -- should find it
      const searchResult2 = await adapter1.search(sessionKey, "beta");
      expect(searchResult2.ok).toBe(true);
      if (searchResult2.ok) {
        expect(searchResult2.value.length).toBeGreaterThanOrEqual(1);
        expect(searchResult2.value[0]!.entry.content).toBe("beta data");
      }
    });
  });

  // ── Concurrent store() calls with no SQLITE_BUSY ───────────────────

  describe("Concurrent store() calls with no SQLITE_BUSY", () => {
    it("multiple concurrent store calls from different connections succeed", async () => {
      const config = createWalConfig(dbPath);
      const adapter1 = new SqliteMemoryAdapter(config);
      adapters.push(adapter1);
      const adapter2 = new SqliteMemoryAdapter(config);
      adapters.push(adapter2);

      // Fire 10 concurrent store calls alternating between adapters
      const promises: Promise<Result<MemoryEntry, Error>>[] = [];
      for (let i = 0; i < 10; i++) {
        const adapter = i % 2 === 0 ? adapter1 : adapter2;
        promises.push(
          adapter.store(
            makeEntry({ id: `concurrent-${i}`, content: `entry ${i}` }),
          ),
        );
      }

      const results = await Promise.all(promises);

      // ALL results should have ok === true (no SQLITE_BUSY errors)
      for (let i = 0; i < results.length; i++) {
        if (!results[i]!.ok) {
          const errResult = results[i] as { ok: false; error: Error };
          console.error(
            `Store ${i} failed with SQLITE_BUSY or other error:`,
            errResult.error.message,
          );
        }
        expect(results[i]!.ok).toBe(true);
      }

      // Verify data integrity: retrieve each of the 10 entries
      for (let i = 0; i < 10; i++) {
        const retrieved = await adapter1.retrieve(`concurrent-${i}`);
        expect(retrieved.ok).toBe(true);
        if (retrieved.ok) {
          expect(retrieved.value).toBeDefined();
          expect(retrieved.value!.content).toBe(`entry ${i}`);
        }
      }
    });

    it("high-volume concurrent stores (20 entries) from 3 adapters", async () => {
      const config = createWalConfig(dbPath);
      const adapter1 = new SqliteMemoryAdapter(config);
      adapters.push(adapter1);
      const adapter2 = new SqliteMemoryAdapter(config);
      adapters.push(adapter2);
      const adapter3 = new SqliteMemoryAdapter(config);
      adapters.push(adapter3);

      const allAdapters = [adapter1, adapter2, adapter3];

      // Fire 20 stores distributed across 3 adapters (round-robin)
      const promises: Promise<Result<MemoryEntry, Error>>[] = [];
      for (let i = 0; i < 20; i++) {
        const adapter = allAdapters[i % 3]!;
        promises.push(
          adapter.store(
            makeEntry({ id: `vol-${i}`, content: `volume entry ${i}` }),
          ),
        );
      }

      const results = await Promise.all(promises);

      // All 20 should succeed
      for (let i = 0; i < results.length; i++) {
        if (!results[i]!.ok) {
          const errResult = results[i] as { ok: false; error: Error };
          console.error(
            `High-volume store ${i} failed:`,
            errResult.error.message,
          );
        }
        expect(results[i]!.ok).toBe(true);
      }

      // Verify: count of entries in DB matches 20
      const row = adapter1
        .getDb()
        .prepare("SELECT COUNT(*) as count FROM memories")
        .get() as { count: number };
      expect(row.count).toBe(20);
    });
  });
});
