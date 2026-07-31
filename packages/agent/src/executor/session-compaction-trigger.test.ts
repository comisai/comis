// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for the session soft/hard compaction policy.
 *
 * The production seam is loaded dynamically so this RED commit can prove the
 * current defect without adding an unbuildable static import: the documented
 * session compaction thresholds have no production consumer at HEAD.
 */
import {
  messageToParts,
  type ContextStorePort,
  type ContextStoreScope,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import Database from "better-sqlite3";
import { createLcdStore, initSchema } from "@comis/memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

type CompactionBand = "below" | "soft" | "hard";

interface TriggerState {
  get(sessionKey: string): CompactionBand | undefined;
  set(sessionKey: string, band: CompactionBand): void;
}

interface TriggerResult {
  trigger?: "soft" | "hard";
  memoriesWritten: number;
  summariesCreated: number;
  success: boolean;
}

type RunSessionCompactionAfterTurn = (
  params: Record<string, unknown>,
) => Promise<Result<TriggerResult, Error>>;

const scope: ContextStoreScope = {
  conversationRef: `cv_${"c".repeat(43)}`,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "tenant_a:user_a:telegram:chat_a",
};

const sessionKey = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  userId: "user_a",
  channelId: "chat_a",
} satisfies SessionKey;

function unwrap(result: Result<TriggerResult, Error>): TriggerResult {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function makeState(): TriggerState {
  const bands = new Map<string, CompactionBand>();
  return {
    get: (key) => bands.get(key),
    set: (key, band) => {
      bands.set(key, band);
    },
  };
}

function makeEventBus(): {
  bus: TypedEventBus;
  emissions: Array<{ event: string; payload: Record<string, unknown> }>;
} {
  const emissions: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    bus: {
      emit: (event: string, payload: Record<string, unknown>) => {
        emissions.push({ event, payload });
        return true;
      },
    } as unknown as TypedEventBus,
    emissions,
  };
}

function appendHistory(
  store: ContextStorePort,
  count: number,
  tokenCount: number,
): void {
  for (let index = 0; index < count; index++) {
    const message = index % 2 === 0
      ? {
          role: "user" as const,
          content: `user fact ${index} ${"x".repeat(48)}`,
          timestamp: 1_000 + index,
        }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: `assistant answer ${index}` }],
          api: "anthropic.messages",
          provider: "anthropic",
          model: "test-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "stop",
          timestamp: 1_000 + index,
        };
    store.append({
      scope,
      seq: index,
      role: message.role,
      tokenCount,
      createdAt: 1_000 + index,
      parts: messageToParts(message),
    });
  }
}

async function loadTrigger(): Promise<RunSessionCompactionAfterTurn> {
  // Keep the path non-literal so TypeScript can compile the RED test before the
  // production module exists. Vitest still resolves it at runtime and fails.
  const modulePath = "./session-compaction-trigger.js";
  const loaded = await import(modulePath) as Record<string, unknown>;
  const trigger = loaded.runSessionCompactionAfterTurn;
  expect(typeof trigger).toBe("function");
  return trigger as RunSessionCompactionAfterTurn;
}

describe("session compaction thresholds", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1_536);
    store = createLcdStore(db);
  });

  it("soft crossing flushes one durable memory without trimming the LCD view", async () => {
    appendHistory(store, 20, 40); // 800 / 1000 = 0.80
    const beforeItems = store.getContextItems(scope);
    const state = makeState();
    const { bus, emissions } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const summarize = vi.fn(async () => "The user supplied durable facts for later recall.");
    const run = await loadTrigger();

    const first = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 50_000,
        chunkOverlapMessages: 2,
        chunkMergeSummaries: true,
        reserveTokens: 16_384,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: {
        contextThreshold: 0.95,
        leafChunkTokens: 20_000,
        leafTargetTokens: 1_200,
        freshTailTurns: 2,
      },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 9_000,
      nowFn: () => 9_000,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(first).toMatchObject({
      trigger: "soft",
      memoriesWritten: 1,
      summariesCreated: 0,
      success: true,
    });
    expect(memoryStore).toHaveBeenCalledTimes(1);
    expect(store.getSummaries(scope)).toHaveLength(0);
    expect(store.getContextItems(scope)).toEqual(beforeItems);
    expect(emissions).toContainEqual({
      event: "compaction:flush",
      payload: expect.objectContaining({
        trigger: "soft",
        memoriesWritten: 1,
        success: true,
      }),
    });

    const second = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 50_000,
        chunkOverlapMessages: 2,
        chunkMergeSummaries: true,
        reserveTokens: 16_384,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: { contextThreshold: 0.95 },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 9_001,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(second.trigger).toBeUndefined();
    expect(memoryStore).toHaveBeenCalledTimes(1);
  });

  it("multi-chunk soft flush summarizes chunks independently before the final merge", async () => {
    appendHistory(store, 20, 40);
    const state = makeState();
    const { bus } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const summarize = vi.fn(async (
      _messages: unknown[],
      opts: { previousSummary?: string },
    ) => opts.previousSummary === undefined
      ? "A bounded independent chunk summary."
      : `${opts.previousSummary} ${"expanded cumulative summary ".repeat(200)}`);
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 150,
        chunkOverlapMessages: 0,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: { contextThreshold: 0.95 },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 9_100,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result).toMatchObject({
      trigger: "soft",
      memoriesWritten: 1,
      summariesCreated: 0,
      success: true,
    });
    expect(summarize.mock.calls.length).toBeGreaterThan(2);
    expect(summarize.mock.calls.every(([, opts]) =>
      (opts as { previousSummary?: string }).previousSummary === undefined,
    )).toBe(true);
    expect(memoryStore).toHaveBeenCalledTimes(1);
  });

  it("multi-chunk soft flush accepts a bounded final memory smaller than the original history", async () => {
    appendHistory(store, 20, 40);
    const state = makeState();
    const { bus } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const boundedMergedMemory = "Durable conversation facts remain available. ".repeat(8);
    const summarize = vi.fn(async (messages: Array<{ content?: unknown }>) => {
      const content = messages[0]?.content;
      return typeof content === "string" && content.includes("Chunk summary.")
        ? boundedMergedMemory
        : "Chunk summary.";
    });
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 150,
        chunkOverlapMessages: 0,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: { contextThreshold: 0.95 },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 9_200,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result).toMatchObject({
      trigger: "soft",
      memoriesWritten: 1,
      summariesCreated: 0,
      success: true,
    });
    expect(memoryStore).toHaveBeenCalledWith(
      expect.objectContaining({ content: boundedMergedMemory }),
      {},
    );
  });

  it("multi-chunk soft flush accepts a reserve-bounded expansion of a short tail chunk", async () => {
    appendHistory(store, 20, 40);
    const state = makeState();
    const { bus } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const mergedMemory = "One bounded memory preserves all chunk facts.";
    const summarize = vi.fn(async (messages: unknown[]) => {
      const rendered = JSON.stringify(messages);
      if (rendered.includes("Tail chunk facts")) return mergedMemory;
      if (rendered.includes("assistant answer 19")) {
        return "Tail chunk facts remain durable. ".repeat(40);
      }
      return "Chunk summary.";
    });
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 150,
        chunkOverlapMessages: 0,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: { contextThreshold: 0.95 },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize,
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 9_300,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result).toMatchObject({
      trigger: "soft",
      memoriesWritten: 1,
      summariesCreated: 0,
      success: true,
    });
    expect(memoryStore).toHaveBeenCalledWith(
      expect.objectContaining({ content: mergedMemory }),
      {},
    );
  });

  it("hard crossing flushes memory and trims through the LCD leaf authority", async () => {
    appendHistory(store, 40, 25); // 1000 / 1000 = 1.0
    const beforeCount = store.getContextItems(scope).length;
    const state = makeState();
    const { bus, emissions } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 50_000,
        chunkOverlapMessages: 2,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: {
        contextThreshold: 0.99,
        leafChunkTokens: 20_000,
        leafTargetTokens: 1_200,
        freshTailTurns: 2,
      },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => "A short, durable conversation summary.",
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => "A short, durable conversation summary.",
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 10_000,
      nowFn: () => 10_050,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result.trigger).toBe("hard");
    expect(result.memoriesWritten).toBe(1);
    expect(result.summariesCreated).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(store.getSummaries(scope).length).toBeGreaterThan(0);
    expect(store.getContextItems(scope).length).toBeLessThan(beforeCount);
    expect(emissions).toContainEqual({
      event: "compaction:started",
      payload: expect.objectContaining({
        agentId: scope.agentId,
        sessionKey,
      }),
    });
    expect(emissions).toContainEqual({
      event: "compaction:flush",
      payload: expect.objectContaining({
        trigger: "hard",
        memoriesWritten: 1,
        success: true,
      }),
    });
  });

  it("hard crossing leaves the LCD view intact when the protective flush fails", async () => {
    appendHistory(store, 40, 25);
    const beforeItems = store.getContextItems(scope);
    const state = makeState();
    const { bus } = makeEventBus();
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 50_000,
        chunkOverlapMessages: 2,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: {
        contextThreshold: 0.99,
        leafChunkTokens: 20_000,
        leafTargetTokens: 1_200,
        freshTailTurns: 2,
      },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => "A short summary.",
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => "A durable memory summary.",
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: {
        store: async () => err(new Error("storage unavailable")),
      },
      memoryScope: {},
      state,
      now: 11_000,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result).toMatchObject({
      trigger: "hard",
      memoriesWritten: 0,
      summariesCreated: 0,
      success: false,
    });
    expect(store.getSummaries(scope)).toHaveLength(0);
    expect(store.getContextItems(scope)).toEqual(beforeItems);
  });

  it("hard crossing rejects a failed flush summarizer before writing or trimming", async () => {
    appendHistory(store, 40, 25);
    const beforeItems = store.getContextItems(scope);
    const state = makeState();
    const { bus } = makeEventBus();
    const memoryStore = vi.fn(async (entry: Record<string, unknown>) =>
      ok({
        ...entry,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        visibility: { kind: "conversation" },
      }),
    );
    const run = await loadTrigger();

    const result = unwrap(await run({
      store,
      scope,
      sessionKey,
      formattedKey: scope.sessionKey,
      sessionCompaction: {
        softThresholdRatio: 0.75,
        hardThresholdRatio: 0.9,
        chunkMaxChars: 50_000,
        chunkOverlapMessages: 2,
        chunkMergeSummaries: true,
        reserveTokens: 1_200,
        keepRecentTokens: 32_768,
        postCompactionSections: ["Session Startup", "Red Lines"],
      },
      contextEngine: {
        contextThreshold: 0.99,
        leafChunkTokens: 20_000,
        leafTargetTokens: 1_200,
        freshTailTurns: 2,
      },
      budgetWindowTokens: 1_000,
      getSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => "A short summary.",
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getFlushSummarizerDeps: () => ({
        logger: createMockLogger(),
        summarize: async () => {
          throw new Error("summarizer unavailable");
        },
        getModel: () => ({
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      memoryPort: { store: memoryStore },
      memoryScope: {},
      state,
      now: 12_000,
      logger: createMockLogger(),
      eventBus: bus,
    }));

    expect(result).toMatchObject({
      trigger: "hard",
      memoriesWritten: 0,
      summariesCreated: 0,
      success: false,
    });
    expect(memoryStore).not.toHaveBeenCalled();
    expect(store.getSummaries(scope)).toHaveLength(0);
    expect(store.getContextItems(scope)).toEqual(beforeItems);
  });
});
