// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-agent isolation integration tests.
 *
 * Verifies two core isolation behaviors:
 * - Multi-agent memory isolation (separate MemoryPorts yield separate memories)
 * - Multi-agent session isolation (separate SessionStores yield separate session data)
 *
 * Each pair of agents (alpha and beta) operates with fully independent
 * infrastructure -- separate MemoryPorts and separate SessionStores --
 * ensuring zero data leakage between concurrent agents.
 */

import type {
  MemoryPort,
  MemorySearchResult,
  SessionKey,
  RagConfig,
} from "@comis/core";
import type { SessionStore, SessionData } from "@comis/memory";
import { ok } from "@comis/shared";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRagRetriever } from "../rag/rag-retriever.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

// Mock sanitizeToolOutput to passthrough (required for createRagRetriever)
vi.mock("../safety/tool-sanitizer.js", () => ({
  sanitizeToolOutput: vi.fn((text: string) => text),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Factory for MemorySearchResult (copied from rag-retriever.test.ts).
 */
function createMockResult(overrides: {
  id?: string;
  content?: string;
  trustLevel?: "system" | "learned" | "external";
  channel?: string;
  createdAt?: number;
  score?: number;
}): MemorySearchResult {
  return {
    entry: {
      id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
      tenantId: "default",
      agentId: "default",
      userId: "user-1",
      content: overrides.content ?? "Test memory content",
      trustLevel: overrides.trustLevel ?? "learned",
      source: {
        who: "agent",
        channel: overrides.channel,
      },
      tags: [],
      createdAt: overrides.createdAt ?? 1700000000000,
    },
    score: overrides.score ?? 0.8,
  };
}

/**
 * Create a mock MemoryPort for a specific agent with seeded search results.
 * All 6 MemoryPort methods are vi.fn(); search returns ok(seededResults).
 */
function createAgentMemoryPort(
  _agentId: string,
  seededResults: MemorySearchResult[],
): MemoryPort {
  return {
    store: vi.fn(),
    retrieve: vi.fn(),
    search: vi.fn().mockResolvedValue(ok(seededResults)),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };
}

/**
 * In-memory fake SessionStore (copied from session-concurrency.test.ts).
 */
interface StoredSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function createFakeSessionStore(): SessionStore & {
  _sessions: Map<string, StoredSession>;
} {
  const sessions = new Map<string, StoredSession>();

  function keyStr(key: SessionKey): string {
    return `${key.tenantId}:${key.userId}:${key.channelId}`;
  }

  return {
    _sessions: sessions,

    save(key, messages, metadata) {
      const k = keyStr(key);
      const existing = sessions.get(k);
      const now = Date.now();
      sessions.set(k, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    load(key): SessionData | undefined {
      const k = keyStr(key);
      const s = sessions.get(k);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    list(tenantId?) {
      const entries: Array<{ sessionKey: string; updatedAt: number }> = [];
      for (const [k, v] of sessions) {
        if (tenantId === undefined || k.startsWith(tenantId + ":")) {
          entries.push({ sessionKey: k, updatedAt: v.updatedAt });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    delete(key) {
      const k = keyStr(key);
      return sessions.delete(k);
    },

    deleteStale(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) {
          sessions.delete(k);
          deleted++;
        }
      }
      return deleted;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const s = sessions.get(sessionKey);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    listDetailed(tenantId?: string) {
      const entries: Array<{
        sessionKey: string;
        tenantId: string;
        userId: string;
        channelId: string;
        metadata: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
      }> = [];
      for (const [k, v] of sessions) {
        const parts = k.split(":");
        const tid = parts[0] ?? "";
        if (tenantId === undefined || tid === tenantId) {
          entries.push({
            sessionKey: k,
            tenantId: tid,
            userId: parts[1] ?? "",
            channelId: parts[2] ?? "",
            metadata: v.metadata,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared RAG config for memory isolation tests */
const ragConfig: RagConfig = {
  enabled: true,
  maxResults: 10,
  maxContextChars: 4000,
  minScore: 0.1,
  includeTrustLevels: ["system", "learned"],
};

// ---------------------------------------------------------------------------
// -- Multi-agent memory isolation
// ---------------------------------------------------------------------------

describe("-- Multi-agent memory isolation", () => {
  const alphaMemories: MemorySearchResult[] = [
    createMockResult({
      id: "alpha-1",
      content: "Alpha user prefers dark mode",
      trustLevel: "system",
      score: 0.9,
    }),
    createMockResult({
      id: "alpha-2",
      content: "Alpha agent learned about TypeScript",
      trustLevel: "learned",
      score: 0.8,
    }),
  ];

  const betaMemories: MemorySearchResult[] = [
    createMockResult({
      id: "beta-1",
      content: "Beta user prefers light mode",
      trustLevel: "system",
      score: 0.9,
    }),
    createMockResult({
      id: "beta-2",
      content: "Beta agent learned about Python",
      trustLevel: "learned",
      score: 0.8,
    }),
  ];

  const alphaKey: SessionKey = {
    tenantId: "alpha",
    userId: "user-1",
    channelId: "ch-1",
  };

  const betaKey: SessionKey = {
    tenantId: "beta",
    userId: "user-1",
    channelId: "ch-1",
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("alpha and beta with separate MemoryPorts see only their own memories", async () => {
    const alphaMemory = createAgentMemoryPort("alpha", alphaMemories);
    const betaMemory = createAgentMemoryPort("beta", betaMemories);

    const alphaRetriever = createRagRetriever({
      memoryPort: alphaMemory,
      config: ragConfig,
    });
    const betaRetriever = createRagRetriever({
      memoryPort: betaMemory,
      config: ragConfig,
    });

    const [alphaResult, betaResult] = await Promise.all([
      alphaRetriever.retrieve("preferences", alphaKey),
      betaRetriever.retrieve("preferences", betaKey),
    ]);

    // Alpha results contain only alpha memories
    expect(alphaResult).toHaveLength(1);
    expect(alphaResult[0]).toContain("Alpha user prefers dark mode");
    expect(alphaResult[0]).toContain("Alpha agent learned about TypeScript");
    expect(alphaResult[0]).not.toContain("Beta");

    // Beta results contain only beta memories
    expect(betaResult).toHaveLength(1);
    expect(betaResult[0]).toContain("Beta user prefers light mode");
    expect(betaResult[0]).toContain("Beta agent learned about Python");
    expect(betaResult[0]).not.toContain("Alpha");
  });

  it("concurrent retrieval with parallel execution tracking", async () => {
    let parallelCount = 0;
    let peakParallel = 0;

    // Create ports with delayed search to prove parallel execution
    const alphaMemory = createAgentMemoryPort("alpha", alphaMemories);
    const betaMemory = createAgentMemoryPort("beta", betaMemories);

    // Override search with delayed versions that track parallelism
    vi.mocked(alphaMemory.search).mockImplementation(async () => {
      parallelCount++;
      peakParallel = Math.max(peakParallel, parallelCount);
      await delay(50);
      parallelCount--;
      return ok(alphaMemories);
    });

    vi.mocked(betaMemory.search).mockImplementation(async () => {
      parallelCount++;
      peakParallel = Math.max(peakParallel, parallelCount);
      await delay(50);
      parallelCount--;
      return ok(betaMemories);
    });

    const alphaRetriever = createRagRetriever({
      memoryPort: alphaMemory,
      config: ragConfig,
    });
    const betaRetriever = createRagRetriever({
      memoryPort: betaMemory,
      config: ragConfig,
    });

    const [alphaResult, betaResult] = await Promise.all([
      alphaRetriever.retrieve("preferences", alphaKey),
      betaRetriever.retrieve("preferences", betaKey),
    ]);

    // Actual parallel execution occurred
    expect(peakParallel).toBeGreaterThanOrEqual(2);

    // Results still contain only their own memories
    expect(alphaResult).toHaveLength(1);
    expect(alphaResult[0]).toContain("Alpha user prefers dark mode");
    expect(alphaResult[0]).not.toContain("Beta");

    expect(betaResult).toHaveLength(1);
    expect(betaResult[0]).toContain("Beta user prefers light mode");
    expect(betaResult[0]).not.toContain("Alpha");
  });

  it("alpha store does not appear in beta search", async () => {
    // Create two separate MemoryPorts with independent stored entries
    const alphaStored: MemorySearchResult[] = [];
    const betaStored: MemorySearchResult[] = [];

    const alphaMemory: MemoryPort = {
      store: vi.fn().mockImplementation(async () => {
        alphaStored.push(
          createMockResult({
            id: "alpha-stored",
            content: "Alpha private data stored via store()",
            trustLevel: "learned",
            score: 0.95,
          }),
        );
        return ok(undefined);
      }),
      retrieve: vi.fn(),
      search: vi.fn().mockImplementation(async () => ok(alphaStored)),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    };

    const betaMemory: MemoryPort = {
      store: vi.fn(),
      retrieve: vi.fn(),
      search: vi.fn().mockImplementation(async () => ok(betaMemories)),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    };

    // Alpha stores an entry
    await alphaMemory.store({
      content: "Alpha private data",
      trustLevel: "learned",
      source: { who: "agent" },
      tags: [],
    } as never);

    // Verify alpha stored it
    expect(alphaStored).toHaveLength(1);

    // Beta searches -- returns only beta's seeded data
    const betaRetriever = createRagRetriever({
      memoryPort: betaMemory,
      config: ragConfig,
    });
    const betaResult = await betaRetriever.retrieve("data", betaKey);

    // Beta NEVER sees alpha's stored data
    expect(betaResult).toHaveLength(1);
    expect(betaResult[0]).not.toContain("Alpha private data");
    expect(betaResult[0]).toContain("Beta user prefers light mode");
  });
});

// ---------------------------------------------------------------------------
// -- Multi-agent session isolation
// ---------------------------------------------------------------------------

describe("-- Multi-agent session isolation", () => {
  const alphaKey: SessionKey = {
    tenantId: "alpha",
    userId: "user-1",
    channelId: "ch-1",
  };

  const betaKey: SessionKey = {
    tenantId: "beta",
    userId: "user-1",
    channelId: "ch-1",
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("alpha and beta with separate SessionStores maintain session isolation", () => {
    const storeAlpha = createFakeSessionStore();
    const storeBeta = createFakeSessionStore();
    const mgrAlpha = createSessionLifecycle(storeAlpha);
    const mgrBeta = createSessionLifecycle(storeBeta);

    // Alpha saves messages
    mgrAlpha.save(alphaKey, [
      { role: "user", content: "alpha message 1" },
      { role: "assistant", content: "alpha reply 1" },
    ]);

    // Beta saves messages
    mgrBeta.save(betaKey, [
      { role: "user", content: "beta message 1" },
      { role: "assistant", content: "beta reply 1" },
    ]);

    // Alpha sees only alpha's data
    const alphaMessages = mgrAlpha.loadOrCreate(alphaKey);
    expect(alphaMessages).toHaveLength(2);
    expect((alphaMessages[0] as { content: string }).content).toBe(
      "alpha message 1",
    );

    // Beta sees only beta's data
    const betaMessages = mgrBeta.loadOrCreate(betaKey);
    expect(betaMessages).toHaveLength(2);
    expect((betaMessages[0] as { content: string }).content).toBe(
      "beta message 1",
    );

    // Cross-agent isolation: alpha's store has no beta data
    const alphaCrossBeta = mgrAlpha.loadOrCreate(betaKey);
    expect(alphaCrossBeta).toEqual([]);

    // Cross-agent isolation: beta's store has no alpha data
    const betaCrossAlpha = mgrBeta.loadOrCreate(alphaKey);
    expect(betaCrossAlpha).toEqual([]);
  });

  it("concurrent session save and load maintain isolation", async () => {
    const storeAlpha = createFakeSessionStore();
    const storeBeta = createFakeSessionStore();
    const mgrAlpha = createSessionLifecycle(storeAlpha);
    const mgrBeta = createSessionLifecycle(storeBeta);

    let parallelCount = 0;
    let peakParallel = 0;

    await Promise.all([
      (async () => {
        parallelCount++;
        peakParallel = Math.max(peakParallel, parallelCount);
        mgrAlpha.save(alphaKey, [
          { role: "user", content: "alpha concurrent" },
        ]);
        await delay(30);
        const loaded = mgrAlpha.loadOrCreate(alphaKey);
        expect(loaded).toHaveLength(1);
        expect((loaded[0] as { content: string }).content).toBe(
          "alpha concurrent",
        );
        parallelCount--;
      })(),
      (async () => {
        parallelCount++;
        peakParallel = Math.max(peakParallel, parallelCount);
        mgrBeta.save(betaKey, [
          { role: "user", content: "beta concurrent" },
        ]);
        await delay(30);
        const loaded = mgrBeta.loadOrCreate(betaKey);
        expect(loaded).toHaveLength(1);
        expect((loaded[0] as { content: string }).content).toBe(
          "beta concurrent",
        );
        parallelCount--;
      })(),
    ]);

    // Actual concurrency was achieved
    expect(peakParallel).toBeGreaterThanOrEqual(2);

    // Alpha store has only alpha's data
    expect(storeAlpha._sessions.size).toBe(1);
    expect(storeAlpha._sessions.has("alpha:user-1:ch-1")).toBe(true);

    // Beta store has only beta's data
    expect(storeBeta._sessions.size).toBe(1);
    expect(storeBeta._sessions.has("beta:user-1:ch-1")).toBe(true);
  });

  it("alpha session deletion does not affect beta session", () => {
    const storeAlpha = createFakeSessionStore();
    const storeBeta = createFakeSessionStore();
    const mgrAlpha = createSessionLifecycle(storeAlpha);
    const mgrBeta = createSessionLifecycle(storeBeta);

    // Both agents save sessions
    mgrAlpha.save(alphaKey, [
      { role: "user", content: "alpha data" },
      { role: "assistant", content: "alpha reply" },
    ]);
    mgrBeta.save(betaKey, [
      { role: "user", content: "beta data" },
      { role: "assistant", content: "beta reply" },
    ]);

    // Delete alpha's session
    mgrAlpha.expire(alphaKey);

    // Alpha's session is gone
    const alphaMessages = mgrAlpha.loadOrCreate(alphaKey);
    expect(alphaMessages).toEqual([]);

    // Beta's session is unaffected
    const betaMessages = mgrBeta.loadOrCreate(betaKey);
    expect(betaMessages).toHaveLength(2);
    expect((betaMessages[0] as { content: string }).content).toBe("beta data");
    expect((betaMessages[1] as { content: string }).content).toBe(
      "beta reply",
    );
  });
});
