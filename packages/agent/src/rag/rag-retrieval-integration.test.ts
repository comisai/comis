// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for RAG retrieval.
 *
 * Composes real factory instances with seeded data and minimal mocking:
 * - MemoryPort: mock or tracking stub (no real SQLite)
 * - RAG retriever: real factory instance
 *
 * @module
 */

import type {
  MemoryPort,
  MemorySearchResult,
  SessionKey,
  RagConfig,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRagRetriever } from "./rag-retriever.js";

// Mock sanitizeToolOutput to passthrough (same pattern as rag-retriever.test.ts)
vi.mock("../safety/tool-sanitizer.js", () => ({
  sanitizeToolOutput: vi.fn((text: string) => text),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock MemoryPort with all 6 vi.fn() methods.
 */
function createMockMemoryPort(): MemoryPort {
  return {
    store: vi.fn(),
    retrieve: vi.fn(),
    search: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };
}

/**
 * Factory for MemorySearchResult with realistic defaults.
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
 * Create a SessionKey with sensible defaults.
 */
function makeSessionKey(overrides?: Partial<SessionKey>): SessionKey {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    channelId: "channel-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RAG retrieval with seeded memory
// ---------------------------------------------------------------------------

describe("RAG retrieval with seeded memory", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const seededResults: MemorySearchResult[] = [
    createMockResult({
      id: "00000000-0000-0000-0000-000000000001",
      content: "User prefers dark mode",
      trustLevel: "system",
      score: 0.95,
    }),
    createMockResult({
      id: "00000000-0000-0000-0000-000000000002",
      content: "User works with TypeScript daily",
      trustLevel: "learned",
      score: 0.88,
    }),
    createMockResult({
      id: "00000000-0000-0000-0000-000000000003",
      content: "User mentioned liking cats",
      trustLevel: "learned",
      channel: "telegram",
      score: 0.75,
    }),
    createMockResult({
      id: "00000000-0000-0000-0000-000000000004",
      content: "Weather data from external API",
      trustLevel: "external",
      score: 0.70,
    }),
    createMockResult({
      id: "00000000-0000-0000-0000-000000000005",
      content: "System configuration note about retry limits",
      trustLevel: "system",
      score: 0.65,
    }),
    createMockResult({
      id: "00000000-0000-0000-0000-000000000006",
      content: "Untrusted scraped web content about AI",
      trustLevel: "external",
      score: 0.55,
    }),
  ];

  it("retrieves seeded entries and filters by configured trust levels", async () => {
    const memoryPort = createMockMemoryPort();
    vi.mocked(memoryPort.search).mockResolvedValue(ok(seededResults));

    const config: RagConfig = {
      enabled: true,
      maxResults: 10,
      maxContextChars: 4000,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned"],
    };
    const retriever = createRagRetriever({ memoryPort, config });
    const sessionKey = makeSessionKey();

    const result = await retriever.retrieve("user preferences", sessionKey);

    // One formatted section returned
    expect(result).toHaveLength(1);

    // System and learned entries included
    expect(result[0]).toContain("User prefers dark mode");
    expect(result[0]).toContain("User works with TypeScript daily");
    expect(result[0]).toContain("User mentioned liking cats");
    expect(result[0]).toContain("System configuration note about retry limits");

    // External entries excluded
    expect(result[0]).not.toContain("Weather data from external API");
    expect(result[0]).not.toContain("Untrusted scraped web content about AI");

    // Trust annotations present for included entries
    expect(result[0]).toContain("[system]");
    expect(result[0]).toContain("[learned]");

    // External annotation NOT present (no external entries included)
    expect(result[0]).not.toContain("[external/untrusted]");
  });

  it("includes external entries when configured in trust levels", async () => {
    const memoryPort = createMockMemoryPort();
    vi.mocked(memoryPort.search).mockResolvedValue(ok(seededResults));

    const config: RagConfig = {
      enabled: true,
      maxResults: 10,
      maxContextChars: 8000,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned", "external"],
    };
    const retriever = createRagRetriever({ memoryPort, config });
    const sessionKey = makeSessionKey();

    const result = await retriever.retrieve("all data", sessionKey);

    expect(result).toHaveLength(1);

    // All 6 entries included
    expect(result[0]).toContain("User prefers dark mode");
    expect(result[0]).toContain("User works with TypeScript daily");
    expect(result[0]).toContain("User mentioned liking cats");
    expect(result[0]).toContain("Weather data from external API");
    expect(result[0]).toContain("System configuration note about retry limits");
    expect(result[0]).toContain("Untrusted scraped web content about AI");

    // External entries get [external/untrusted] annotation
    expect(result[0]).toContain("[external/untrusted]");
  });

  it("enforces maxContextChars budget with many seeded entries", async () => {
    const memoryPort = createMockMemoryPort();

    // Seed 15 entries each with ~100 chars of content, all "system" trust
    // (system trust avoids wrapExternalContent inflation)
    const manyResults: MemorySearchResult[] = [];
    for (let i = 0; i < 15; i++) {
      manyResults.push(
        createMockResult({
          id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
          content: `Memory entry number ${String(i).padStart(2, "0")} with padding text to reach approximately one hundred characters of total content length`,
          trustLevel: "system",
          score: 0.95 - i * 0.01,
        }),
      );
    }
    vi.mocked(memoryPort.search).mockResolvedValue(ok(manyResults));

    const config: RagConfig = {
      enabled: true,
      maxResults: 20,
      maxContextChars: 500,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned"],
    };
    const retriever = createRagRetriever({ memoryPort, config });
    const sessionKey = makeSessionKey();

    const result = await retriever.retrieve("all memories", sessionKey);

    expect(result).toHaveLength(1);
    // Budget enforced -- output never exceeds maxContextChars
    expect(result[0].length).toBeLessThanOrEqual(500);
    // First entries included
    expect(result[0]).toContain("Memory entry number 00");
    // Last entries cut off by budget
    expect(result[0]).not.toContain("Memory entry number 14");
  });

  it("passes agentId through to MemoryPort.search options", async () => {
    const memoryPort = createMockMemoryPort();
    vi.mocked(memoryPort.search).mockResolvedValue(ok([]));

    const config: RagConfig = {
      enabled: true,
      maxResults: 5,
      maxContextChars: 4000,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned"],
    };
    const retriever = createRagRetriever({ memoryPort, config });
    const sessionKey = makeSessionKey();

    await retriever.retrieve("query", sessionKey, { agentId: "agent-alpha" });

    expect(memoryPort.search).toHaveBeenCalledWith(sessionKey, "query", {
      limit: 5,
      minScore: 0.1,
      agentId: "agent-alpha",
    });
  });

  it("includes date and channel source annotations in formatted output", async () => {
    const memoryPort = createMockMemoryPort();

    const results: MemorySearchResult[] = [
      createMockResult({
        id: "00000000-0000-0000-0000-000000000010",
        content: "User asked about weather",
        trustLevel: "learned",
        channel: "telegram",
        createdAt: 1700000000000, // 2023-11-14
        score: 0.85,
      }),
      createMockResult({
        id: "00000000-0000-0000-0000-000000000011",
        content: "System config loaded",
        trustLevel: "system",
        createdAt: 1704067200000, // 2024-01-01
        score: 0.80,
      }),
    ];
    vi.mocked(memoryPort.search).mockResolvedValue(ok(results));

    const config: RagConfig = {
      enabled: true,
      maxResults: 10,
      maxContextChars: 4000,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned"],
    };
    const retriever = createRagRetriever({ memoryPort, config });
    const sessionKey = makeSessionKey();

    const result = await retriever.retrieve("weather", sessionKey);

    expect(result).toHaveLength(1);
    // Date annotations present (YYYY-MM-DD format)
    expect(result[0]).toContain("2023-11-14");
    expect(result[0]).toContain("2024-01-01");
    // Channel source annotation for telegram entry
    expect(result[0]).toContain("via telegram");
  });
});
