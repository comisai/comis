// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-agent isolation integration tests.
 *
 * Verifies two core isolation behaviors:
 * - Multi-agent memory isolation (separate caller-supplied result arrays
 *   yield separate formatted memory sections — the formatter is purely
 *   transformational and has no shared state across calls)
 * - Multi-agent session isolation (separate SessionStores yield separate
 *   session data)
 *
 * The canonical retrieval entry point is HybridMemoryInjector
 * (createHybridMemoryInjector). The splitter operates per-call on
 * caller-supplied results, so per-agent isolation holds by construction
 * (the injector itself has no MemoryPort dependency and no shared state).
 */

import type { MemorySearchResult, SessionKey, SessionStorePort } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import type { SessionStore, SessionData } from "@comis/memory";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHybridMemoryInjector } from "../rag/hybrid-memory-injector.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Factory for MemorySearchResult (analog: hybrid-memory-injector.test.ts:6-20).
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
      id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
      tenantId: "default",
      agentId: "default",
      userId: "user-1",
      content: overrides.content ?? "Test memory content",
      trustLevel: overrides.trustLevel ?? "learned",
      source: {
        who: "agent",
        channel: overrides.channel ?? "test",
      },
      tags: [],
      createdAt: overrides.createdAt ?? 1700000000000,
    },
    score: overrides.score ?? 0.8,
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

function createTestSessionLifecycle(store: ReturnType<typeof createFakeSessionStore>) {
  const port = {
    save: (scope: SessionKey, messages: unknown[], metadata?: Record<string, unknown>) => {
      store.save(scope, messages, metadata);
      return ok(undefined);
    },
    load: (scope: SessionKey) => ok(store.load(scope)),
    delete: (scope: SessionKey) => ok(store.delete(scope)),
    deleteStale: (_scope: unknown, maxAgeMs: number) => ok(store.deleteStale(maxAgeMs)),
  } as unknown as SessionStorePort;
  return createSessionLifecycle(port);
}

function unwrap<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// -- Multi-agent memory isolation
// ---------------------------------------------------------------------------
//
// Architecture: createHybridMemoryInjector is the canonical
// retrieval-formatting entry point. It takes pre-resolved
// MemorySearchResult[] arrays from the caller (production wiring resolves
// the array via the per-agent MemoryPort.search() upstream) and splits them
// between inline + system-prompt placement.
//
// Per-agent isolation holds by construction: the injector has no shared
// state across calls and no MemoryPort dependency; passing distinct result
// arrays guarantees distinct formatted output. The isolation tests below
// pass the per-agent MemorySearchResult[] directly to .split() — equivalent
// to wiring distinct MemoryPort instances per agent in production.

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

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("alpha and beta hybrid injectors emit only their own memories", () => {
    // Each agent gets an independent injector instance and feeds its own
    // pre-resolved results array. The injector has no shared state across
    // calls, so cross-contamination is impossible by construction.
    const alphaInjector = createHybridMemoryInjector();
    const betaInjector = createHybridMemoryInjector();

    const alphaInjection = alphaInjector.split(alphaMemories, 4000);
    const betaInjection = betaInjector.split(betaMemories, 4000);

    // Alpha output contains only alpha memories
    const alphaText =
      (alphaInjection.inlineMemory ?? "") +
      alphaInjection.systemPromptSections.join("");
    expect(alphaText).toContain("Alpha user prefers dark mode");
    expect(alphaText).toContain("Alpha agent learned about TypeScript");
    expect(alphaText).not.toContain("Beta");

    // Beta output contains only beta memories
    const betaText =
      (betaInjection.inlineMemory ?? "") +
      betaInjection.systemPromptSections.join("");
    expect(betaText).toContain("Beta user prefers light mode");
    expect(betaText).toContain("Beta agent learned about Python");
    expect(betaText).not.toContain("Alpha");
  });

  it("concurrent split() calls on shared injector do not cross-contaminate", async () => {
    let parallelCount = 0;
    let peakParallel = 0;

    // Single injector instance, two concurrent calls with distinct result
    // arrays. .split() is synchronous + pure, so this asserts the injector
    // has no hidden shared state that could leak across calls.
    const injector = createHybridMemoryInjector();

    const [alphaInjection, betaInjection] = await Promise.all([
      (async () => {
        parallelCount++;
        peakParallel = Math.max(peakParallel, parallelCount);
        await delay(20);
        const out = injector.split(alphaMemories, 4000);
        parallelCount--;
        return out;
      })(),
      (async () => {
        parallelCount++;
        peakParallel = Math.max(peakParallel, parallelCount);
        await delay(20);
        const out = injector.split(betaMemories, 4000);
        parallelCount--;
        return out;
      })(),
    ]);

    // Actual parallel execution occurred
    expect(peakParallel).toBeGreaterThanOrEqual(2);

    // Results still contain only their own memories
    const alphaText =
      (alphaInjection.inlineMemory ?? "") +
      alphaInjection.systemPromptSections.join("");
    expect(alphaText).toContain("Alpha user prefers dark mode");
    expect(alphaText).not.toContain("Beta");

    const betaText =
      (betaInjection.inlineMemory ?? "") +
      betaInjection.systemPromptSections.join("");
    expect(betaText).toContain("Beta user prefers light mode");
    expect(betaText).not.toContain("Alpha");
  });

  it("alpha private content never appears in beta output (distinct input arrays)", () => {
    // Simulates two agents whose upstream MemoryPort.search() returns
    // disjoint result sets — production wiring guarantees this because each
    // agent has its own MemoryPort instance with its own tenant scope.
    const alphaPrivate: MemorySearchResult[] = [
      createMockResult({
        id: "alpha-stored",
        content: "Alpha private data stored via store()",
        trustLevel: "learned",
        score: 0.95,
      }),
    ];

    const alphaInjector = createHybridMemoryInjector();
    const betaInjector = createHybridMemoryInjector();

    // Alpha sees its own private data
    const alphaInjection = alphaInjector.split(alphaPrivate, 4000);
    const alphaText =
      (alphaInjection.inlineMemory ?? "") +
      alphaInjection.systemPromptSections.join("");
    expect(alphaText).toContain("Alpha private data");

    // Beta receives ONLY its own seeded data — alpha's private content
    // never crosses the boundary because beta's input array does not
    // contain it.
    const betaInjection = betaInjector.split(betaMemories, 4000);
    const betaText =
      (betaInjection.inlineMemory ?? "") +
      betaInjection.systemPromptSections.join("");
    expect(betaText).not.toContain("Alpha private data");
    expect(betaText).toContain("Beta user prefers light mode");
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
    const mgrAlpha = createTestSessionLifecycle(storeAlpha);
    const mgrBeta = createTestSessionLifecycle(storeBeta);

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
    const alphaMessages = unwrap(mgrAlpha.loadOrCreate(alphaKey));
    expect(alphaMessages).toHaveLength(2);
    expect((alphaMessages[0] as { content: string }).content).toBe(
      "alpha message 1",
    );

    // Beta sees only beta's data
    const betaMessages = unwrap(mgrBeta.loadOrCreate(betaKey));
    expect(betaMessages).toHaveLength(2);
    expect((betaMessages[0] as { content: string }).content).toBe(
      "beta message 1",
    );

    // Cross-agent isolation: alpha's store has no beta data
    const alphaCrossBeta = unwrap(mgrAlpha.loadOrCreate(betaKey));
    expect(alphaCrossBeta).toEqual([]);

    // Cross-agent isolation: beta's store has no alpha data
    const betaCrossAlpha = unwrap(mgrBeta.loadOrCreate(alphaKey));
    expect(betaCrossAlpha).toEqual([]);
  });

  it("concurrent session save and load maintain isolation", async () => {
    const storeAlpha = createFakeSessionStore();
    const storeBeta = createFakeSessionStore();
    const mgrAlpha = createTestSessionLifecycle(storeAlpha);
    const mgrBeta = createTestSessionLifecycle(storeBeta);

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
        const loaded = unwrap(mgrAlpha.loadOrCreate(alphaKey));
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
        const loaded = unwrap(mgrBeta.loadOrCreate(betaKey));
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
    const mgrAlpha = createTestSessionLifecycle(storeAlpha);
    const mgrBeta = createTestSessionLifecycle(storeBeta);

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
    const alphaMessages = unwrap(mgrAlpha.loadOrCreate(alphaKey));
    expect(alphaMessages).toEqual([]);

    // Beta's session is unaffected
    const betaMessages = unwrap(mgrBeta.loadOrCreate(betaKey));
    expect(betaMessages).toHaveLength(2);
    expect((betaMessages[0] as { content: string }).content).toBe("beta data");
    expect((betaMessages[1] as { content: string }).content).toBe(
      "beta reply",
    );
  });
});
