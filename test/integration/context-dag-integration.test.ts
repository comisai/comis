// SPDX-License-Identifier: Apache-2.0
/**
 * DAG-mode context engine integration tests.
 *
 * Validates cross-component behaviors: ingest+assemble pipeline, compaction
 * cycle with originals recovery, ctx_recall E2E path via handler dispatch,
 * mode switch reconciliation, and DAG-mode metrics emission.
 *
 * All tests run in-process using :memory: SQLite databases and mock LLM
 * boundaries. No daemon, no real LLM calls.
 *
 * TEST-11: DAG Ingest + Assemble
 * TEST-12: Compaction Cycle (Originals Recoverable)
 * TEST-13: ctx_recall E2E (Handler-Level via createContextHandlers)
 * TEST-14: Mode Switch (Pipeline to DAG)
 * TEST-15: Metrics Emission in DAG Mode
 *
 * Phase 415: Integration Testing (Plan 02).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Resolve better-sqlite3 from the memory package (it's a dependency there, not at root)
const memoryPkgDir = resolve(__dirname, "../../packages/memory");
const require = createRequire(resolve(memoryPkgDir, "package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

import { createContextStore, type ContextStore } from "@comis/memory";
import { TypedEventBus, ContextEngineConfigSchema } from "@comis/core";
import {
  reconcileJsonlToDag,
  createDagContextEngine,
  runDagCompaction,
  shouldCompact,
  checkIntegrity,
  computeTokenBudget,
  CHARS_PER_TOKEN_RATIO,
  runLeafPass,
  resolveFreshTailBoundary,
} from "@comis/agent";
import type {
  DagContextEngineDeps,
  DagCompactionConfig,
  DagCompactionDeps,
  ReconciliationResult,
  IntegrityCheckDeps,
  CompactionDeps,
  TokenBudget,
} from "@comis/agent";
import { createContextHandlers } from "@comis/daemon";
import type { ContextHandlerDeps } from "@comis/daemon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

function createAgentMessage(role: "user" | "assistant", text: string): AgentMessage {
  return { role, content: text };
}

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

function createTestStore(db: InstanceType<typeof Database>): ContextStore {
  return createContextStore(db);
}

function createTestConversation(store: ContextStore): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "test-agent",
    sessionKey: "test:u:c",
  });
}

function buildSyntheticMessages(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    // Generate ~200 char content per message
    const padding = "x".repeat(150);
    const content = `Message ${i + 1} from ${role}. ${padding}. End of message ${i + 1}.`;
    messages.push(createAgentMessage(role, content));
  }
  return messages;
}

const mockGenerateSummary = vi.fn().mockImplementation(
  async (msgs: unknown[]) =>
    "Summary of " + (Array.isArray(msgs) ? msgs.length : 0) + " messages. " + "x".repeat(100),
);

// =========================================================================
// TEST-11: DAG Ingest + Assemble
// =========================================================================

describe("TEST-11: DAG Ingest + Assemble", () => {
  let db: InstanceType<typeof Database>;
  let store: ContextStore;
  let conversationId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = createTestStore(db);
    conversationId = createTestConversation(store);
  });

  afterEach(() => {
    db.close();
  });

  it("ingests 20 messages via reconciliation into empty DAG (full import)", () => {
    const messages = buildSyntheticMessages(20);

    const result = reconcileJsonlToDag(
      messages,
      store,
      db,
      conversationId,
      estimateTokens,
      mockLogger,
    );

    expect(result.imported).toBe(20);
    expect(result.fullImport).toBe(true);
    expect(result.conversationId).toBe(conversationId);
  });

  it("creates context items for all ingested messages", () => {
    const messages = buildSyntheticMessages(20);
    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    const storedMessages = store.getMessagesByConversation(conversationId);
    expect(storedMessages.length).toBe(20);

    const contextItems = store.getContextItems(conversationId);
    expect(contextItems.length).toBe(20);

    // Each context item links to its corresponding message
    for (const item of contextItems) {
      expect(item.item_type).toBe("message");
      expect(item.message_id).not.toBeNull();
    }
  });

  it("assembler produces output with recall guidance via createDagContextEngine", async () => {
    const messages = buildSyntheticMessages(20);
    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    const eventBus = new TypedEventBus();
    const config = ContextEngineConfigSchema.parse({
      enabled: true,
      version: "dag",
      freshTailTurns: 3,
    });

    const deps: DagContextEngineDeps = {
      logger: mockLogger,
      getModel: () => ({
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
      }),
      eventBus,
      agentId: "test-agent",
      sessionKey: "test:u:c",
      contextStore: store,
      db,
      conversationId,
      estimateTokens,
    };

    const engine = createDagContextEngine(config, deps);
    const output = await engine.transformContext(messages);

    // Output is an array of messages (not empty)
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);

    // First message contains recall guidance text
    const firstContent =
      typeof output[0].content === "string"
        ? output[0].content
        : JSON.stringify(output[0].content);
    expect(firstContent).toContain("ctx_search");
  });
});

// =========================================================================
// TEST-12: Compaction Cycle (Originals Recoverable)
// =========================================================================

describe("TEST-12: Compaction Cycle (Originals Recoverable)", () => {
  let db: InstanceType<typeof Database>;
  let store: ContextStore;
  let conversationId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = createTestStore(db);
    conversationId = createTestConversation(store);
  });

  afterEach(() => {
    db.close();
  });

  it("compaction creates summaries while preserving all original messages", async () => {
    // Build 30 messages with ~300 chars each for higher token count
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
      const padding = "y".repeat(250);
      const content = `Long message ${i + 1} from ${role}. ${padding}. End of long message ${i + 1}.`;
      messages.push(createAgentMessage(role, content));
    }

    // Step 1: Ingest
    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    // Step 2: Verify pre-compaction state
    const preMessages = store.getMessagesByConversation(conversationId);
    expect(preMessages.length).toBe(30);
    const preSummaries = store.getSummariesByConversation(conversationId);
    expect(preSummaries.length).toBe(0);

    // Step 3: Run compaction with low threshold to force trigger
    const compactionConfig: DagCompactionConfig = {
      leafMinFanout: 4,
      leafChunkTokens: 5_000,
      leafTargetTokens: 200,
      condensedMinFanout: 4,
      condensedTargetTokens: 400,
      freshTailTurns: 3,
      contextThreshold: 0.1,
      incrementalMaxDepth: 0,
    };

    const compactionDeps: DagCompactionDeps = {
      store,
      logger: mockLogger,
      generateSummary: mockGenerateSummary,
      getModel: () => ({ model: {}, getApiKey: async () => "test-key" }),
      estimateTokens,
      eventBus: new TypedEventBus(),
      agentId: "test-agent",
      sessionKey: "test:u:c",
    };

    // Verify shouldCompact returns true (use small context window so token total exceeds threshold)
    const budget = computeTokenBudget(4_000, 0);
    const needsCompaction = shouldCompact(
      store,
      conversationId,
      { contextThreshold: 0.1 },
      budget,
    );
    expect(needsCompaction).toBe(true);

    // Run compaction
    await runDagCompaction(conversationId, compactionConfig, compactionDeps);

    // Step 4: Verify post-compaction
    const postSummaries = store.getSummariesByConversation(conversationId);
    expect(postSummaries.length).toBeGreaterThan(0);

    // LLM mock was invoked
    expect(mockGenerateSummary).toHaveBeenCalled();

    // Originals recoverable: all 30 messages still in ctx_messages
    const postMessages = store.getMessagesByConversation(conversationId);
    expect(postMessages.length).toBe(30);

    // Each summary has source message IDs that exist
    for (const summary of postSummaries) {
      const sourceIds = store.getSourceMessageIds(summary.summary_id);
      expect(sourceIds.length).toBeGreaterThan(0);

      // All source messages still exist
      const sourceMessages = store.getMessagesByIds(sourceIds);
      expect(sourceMessages.length).toBe(sourceIds.length);
    }
  });

  it("integrity check passes after compaction (no unrecoverable issues)", async () => {
    // Build and ingest messages
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
      const padding = "z".repeat(250);
      const content = `Integrity msg ${i + 1} from ${role}. ${padding}. End.`;
      messages.push(createAgentMessage(role, content));
    }

    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    const compactionConfig: DagCompactionConfig = {
      leafMinFanout: 4,
      leafChunkTokens: 5_000,
      leafTargetTokens: 200,
      condensedMinFanout: 4,
      condensedTargetTokens: 400,
      freshTailTurns: 3,
      contextThreshold: 0.1,
      incrementalMaxDepth: 0,
    };

    const compactionDeps: DagCompactionDeps = {
      store,
      logger: mockLogger,
      generateSummary: mockGenerateSummary,
      getModel: () => ({ model: {}, getApiKey: async () => "test-key" }),
      estimateTokens,
      eventBus: new TypedEventBus(),
      agentId: "test-agent",
      sessionKey: "test:u:c",
    };

    await runDagCompaction(conversationId, compactionConfig, compactionDeps);

    // Run integrity check
    const report = checkIntegrity(
      { store, db, logger: mockLogger, agentId: "test-agent", sessionKey: "test:u:c" },
      conversationId,
    );
    expect(report.errorsLogged).toBe(0);
  });
});

// =========================================================================
// TEST-14: Mode Switch (Pipeline to DAG)
// =========================================================================

describe("TEST-14: Mode Switch (Pipeline to DAG)", () => {
  let db: InstanceType<typeof Database>;
  let store: ContextStore;
  let conversationId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = createTestStore(db);
    conversationId = createTestConversation(store);
  });

  afterEach(() => {
    db.close();
  });

  it("mode switch triggers fullImport=true and imports all pipeline messages", () => {
    // Step 1: Simulate pipeline messages (exist in JSONL but not in DAG)
    const pipelineMessages = buildSyntheticMessages(10);

    // Step 2: Fresh DB/store/conversation already created in beforeEach

    // Step 3: Call reconciliation (mode switch triggers full import)
    const result = reconcileJsonlToDag(
      pipelineMessages,
      store,
      db,
      conversationId,
      estimateTokens,
      mockLogger,
    );

    // Assertions
    expect(result.fullImport).toBe(true);
    expect(result.imported).toBe(10);
  });

  it("DAG state is correct after mode switch", () => {
    const pipelineMessages = buildSyntheticMessages(10);
    reconcileJsonlToDag(pipelineMessages, store, db, conversationId, estimateTokens, mockLogger);

    // Verify messages exist
    const storedMessages = store.getMessagesByConversation(conversationId);
    expect(storedMessages.length).toBe(10);

    // Verify context items exist
    const contextItems = store.getContextItems(conversationId);
    expect(contextItems.length).toBe(10);

    // Messages have correct content matching originals
    for (let i = 0; i < storedMessages.length; i++) {
      expect(storedMessages[i].content).toContain(`Message ${i + 1}`);
    }
  });

  it("integrity check passes after mode switch", () => {
    const pipelineMessages = buildSyntheticMessages(10);
    reconcileJsonlToDag(pipelineMessages, store, db, conversationId, estimateTokens, mockLogger);

    const report = checkIntegrity(
      { store, db, logger: mockLogger, agentId: "test-agent", sessionKey: "test:u:c" },
      conversationId,
    );
    expect(report.errorsLogged).toBe(0);
  });

  it("subsequent reconciliation is incremental (not full)", () => {
    const pipelineMessages = buildSyntheticMessages(10);
    reconcileJsonlToDag(pipelineMessages, store, db, conversationId, estimateTokens, mockLogger);

    // Add 2 more messages and re-run reconciliation
    const msg11 = createAgentMessage("user", "Extra message 11. " + "x".repeat(150));
    const msg12 = createAgentMessage("assistant", "Extra message 12. " + "x".repeat(150));

    const result2 = reconcileJsonlToDag(
      [...pipelineMessages, msg11, msg12],
      store,
      db,
      conversationId,
      estimateTokens,
      mockLogger,
    );

    expect(result2.fullImport).toBe(false);
    expect(result2.imported).toBe(2);
  });
});

// =========================================================================
// TEST-13: ctx_recall E2E (Handler-Level via createContextHandlers)
// =========================================================================

describe("TEST-13: ctx_recall E2E (Handler-Level)", () => {
  let db: InstanceType<typeof Database>;
  let store: ContextStore;
  let conversationId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = createTestStore(db);
    conversationId = store.createConversation({
      tenantId: "test",
      agentId: "test-agent",
      sessionKey: "test-session",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("context.search handler returns FTS results from store via handler dispatch chain", async () => {
    // Insert messages with unique markers
    store.insertMessage({
      conversationId,
      seq: 1,
      role: "user",
      content: "Please check the UNIQUE_RECALL_MARKER_42 configuration",
      contentHash: "h1",
      tokenCount: 10,
    });
    for (let i = 2; i <= 10; i++) {
      store.insertMessage({
        conversationId,
        seq: i,
        role: i % 2 === 0 ? "assistant" : "user",
        content: `Regular message number ${i} about general topics`,
        contentHash: `h${i}`,
        tokenCount: 8,
      });
    }

    // Build handler deps
    const handlerDeps: ContextHandlerDeps = {
      store,
      tenantId: "test",
      resolveConversationId: (sessionKey: string) =>
        sessionKey === "test-session" ? conversationId : undefined,
      rpcCall: vi.fn(),
      config: {
        maxRecallsPerDay: 10,
        maxExpandTokens: 8000,
        recallTimeoutMs: 120_000,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    const handlers = createContextHandlers(handlerDeps);

    // Invoke context.search handler
    const searchResult = (await handlers["context.search"]!({
      _callerSessionKey: "test-session",
      query: "UNIQUE_RECALL_MARKER_42",
    })) as { results: Array<{ type: string; content: string; id: string }>; total: number };

    expect(searchResult.results.length).toBeGreaterThanOrEqual(1);
    const hasMarker = searchResult.results.some(
      (r) => r.content.includes("UNIQUE_RECALL_MARKER_42"),
    );
    expect(hasMarker).toBe(true);
  });

  it("expansion grant CRUD lifecycle works through correct store API", () => {
    // Create a grant
    store.createGrant({
      grantId: "grant_test_001",
      issuerSession: "test-session",
      conversationIds: [conversationId],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    // Verify active grant
    const grant = store.getGrant("grant_test_001");
    expect(grant).toBeDefined();
    expect(grant!.revoked).toBe(0);
    expect(grant!.issuer_session).toBe("test-session");

    // Revoke the grant
    store.revokeGrant("grant_test_001");

    // Verify revoked
    const revokedGrant = store.getGrant("grant_test_001");
    expect(revokedGrant!.revoked).toBe(1);
  });

  it("context.recall handler spawns mock sub-agent, creates+revokes grant", async () => {
    // Insert a summary the recall can find
    store.insertSummary({
      summaryId: "sum_recall_test",
      conversationId,
      kind: "leaf",
      depth: 0,
      content: "Discussion about UNIQUE_RECALL_MARKER_42 settings",
      tokenCount: 8,
    });

    // Set up the rpcCall mock to return a canned sub-agent result
    const mockRpcCall = vi
      .fn()
      .mockResolvedValue({ response: "The marker was found in config." });

    const recallDeps: ContextHandlerDeps = {
      store,
      tenantId: "test",
      resolveConversationId: (sessionKey: string) =>
        sessionKey === "test-session" ? conversationId : undefined,
      rpcCall: mockRpcCall,
      config: {
        maxRecallsPerDay: 10,
        maxExpandTokens: 8000,
        recallTimeoutMs: 120_000,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    const recallHandlers = createContextHandlers(recallDeps);

    // Invoke recall
    const recallResult = (await recallHandlers["context.recall"]!({
      _callerSessionKey: "test-session",
      prompt: "What was the UNIQUE_RECALL_MARKER_42?",
      summary_ids: ["sum_recall_test"],
    })) as {
      answer: string;
      citations: string[];
      grantId: string;
    };

    // Verify result
    expect(recallResult.answer).toBe("The marker was found in config.");
    expect(recallResult.citations).toContain("sum_recall_test");
    expect(recallResult.grantId).toMatch(/^grant_/);

    // Verify sub-agent was spawned correctly
    expect(mockRpcCall).toHaveBeenCalledWith(
      "session.spawn",
      expect.objectContaining({
        tool_groups: ["context_expand"],
      }),
    );

    // Verify the grant created by recall is now revoked and cleaned up
    // The handler calls revokeGrant then cleanupExpiredGrants, which deletes
    // revoked grants. So getGrant returns undefined (deleted) or revoked=1.
    const recallGrant = store.getGrant(recallResult.grantId);
    if (recallGrant) {
      expect(recallGrant.revoked).toBe(1);
    } else {
      // Grant was deleted by cleanupExpiredGrants (which removes revoked grants)
      // Verify no active grants remain for this session
      const activeGrants = store.getActiveGrants("test-session");
      expect(activeGrants.length).toBe(0);
    }
  });
});

// =========================================================================
// TEST-15: Metrics Emission in DAG Mode
// =========================================================================

describe("TEST-15: Metrics Emission in DAG Mode", () => {
  let db: InstanceType<typeof Database>;
  let store: ContextStore;
  let conversationId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = createTestStore(db);
    conversationId = createTestConversation(store);
  });

  afterEach(() => {
    db.close();
  });

  it("context:pipeline event fires in DAG mode with all expected fields", async () => {
    const messages = buildSyntheticMessages(10);
    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    const eventBus = new TypedEventBus();
    let capturedEvent: Record<string, unknown> | undefined;
    eventBus.on("context:pipeline", (data: unknown) => {
      capturedEvent = data as Record<string, unknown>;
    });

    const config = ContextEngineConfigSchema.parse({
      enabled: true,
      version: "dag",
    });

    const deps: DagContextEngineDeps = {
      logger: mockLogger,
      getModel: () => ({
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
      }),
      eventBus,
      agentId: "test-agent",
      sessionKey: "test:u:c",
      contextStore: store,
      db,
      conversationId,
      estimateTokens,
    };

    const engine = createDagContextEngine(config, deps);
    await engine.transformContext(messages);

    // Verify all expected fields are present
    expect(capturedEvent).toBeDefined();
    expect(typeof capturedEvent!.agentId).toBe("string");
    expect(typeof capturedEvent!.sessionKey).toBe("string");
    expect(typeof capturedEvent!.tokensLoaded).toBe("number");
    expect(typeof capturedEvent!.tokensEvicted).toBe("number");
    expect(typeof capturedEvent!.tokensMasked).toBe("number");
    expect(typeof capturedEvent!.tokensCompacted).toBe("number");
    expect(typeof capturedEvent!.thinkingBlocksRemoved).toBe("number");
    expect(typeof capturedEvent!.budgetUtilization).toBe("number");
    expect(typeof capturedEvent!.evictionCategories).toBe("object");
    expect(typeof capturedEvent!.rereadCount).toBe("number");
    expect(Array.isArray(capturedEvent!.rereadTools)).toBe(true);
    expect(typeof capturedEvent!.sessionDepth).toBe("number");
    expect(typeof capturedEvent!.sessionToolResults).toBe("number");
    // DAG-mode event shape replaces boolean `cacheHit` with three-way
    // cache token accounting: hit/write/miss. The non-DAG engine uses
    // `cacheFenceIndex` instead.
    expect(typeof capturedEvent!.cacheHitTokens).toBe("number");
    expect(typeof capturedEvent!.cacheWriteTokens).toBe("number");
    expect(typeof capturedEvent!.cacheMissTokens).toBe("number");
    expect(typeof capturedEvent!.durationMs).toBe("number");
    expect(typeof capturedEvent!.layerCount).toBe("number");
    expect((capturedEvent!.layerCount as number)).toBeGreaterThanOrEqual(1);
    expect(capturedEvent!.timestamp).toBeGreaterThan(0);
  });

  it("context:dag_compacted event fires after compaction with all expected fields", async () => {
    // Build and ingest messages
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
      const padding = "m".repeat(250);
      const content = `Metrics msg ${i + 1} from ${role}. ${padding}. End.`;
      messages.push(createAgentMessage(role, content));
    }
    reconcileJsonlToDag(messages, store, db, conversationId, estimateTokens, mockLogger);

    const eventBus = new TypedEventBus();
    let compactionEvent: Record<string, unknown> | undefined;
    eventBus.on("context:dag_compacted", (data: unknown) => {
      compactionEvent = data as Record<string, unknown>;
    });

    const compactionConfig: DagCompactionConfig = {
      leafMinFanout: 4,
      leafChunkTokens: 5_000,
      leafTargetTokens: 200,
      condensedMinFanout: 4,
      condensedTargetTokens: 400,
      freshTailTurns: 3,
      contextThreshold: 0.1,
      incrementalMaxDepth: 0,
    };

    const compactionDeps: DagCompactionDeps = {
      store,
      logger: mockLogger,
      generateSummary: mockGenerateSummary,
      getModel: () => ({ model: {}, getApiKey: async () => "test-key" }),
      estimateTokens,
      eventBus,
      agentId: "test-agent",
      sessionKey: "test:u:c",
    };

    await runDagCompaction(conversationId, compactionConfig, compactionDeps);

    // Verify all 9 expected fields are present
    expect(compactionEvent).toBeDefined();
    expect(compactionEvent!.conversationId).toBe(conversationId);
    expect(typeof compactionEvent!.agentId).toBe("string");
    expect(typeof compactionEvent!.sessionKey).toBe("string");
    expect(typeof compactionEvent!.leafSummariesCreated).toBe("number");
    expect(typeof compactionEvent!.condensedSummariesCreated).toBe("number");
    expect(typeof compactionEvent!.maxDepthReached).toBe("number");
    expect(typeof compactionEvent!.totalSummariesCreated).toBe("number");
    expect(compactionEvent!.durationMs).toBeGreaterThanOrEqual(0);
    expect(compactionEvent!.timestamp).toBeGreaterThan(0);
  });
});
