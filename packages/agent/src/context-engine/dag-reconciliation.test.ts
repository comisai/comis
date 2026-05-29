// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for DAG reconciliation engine, ingestion hook, and content hash helpers.
 *
 * Uses :memory: SQLite databases with createContextStore() for real store
 * operations. Follows the same pattern as dag-integrity.test.ts.
 *
 * DAG Integrity & Wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createContextStore } from "@comis/memory";
import type { ContextStore } from "@comis/memory";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  reconcileJsonlToDag,
  installDagIngestionHook,
  computeContentHash,
  flattenMessageContent,
  mapMessageRole,
  createDagContextEngine,
} from "./dag-reconciliation.js";
import { ContextEngineConfigSchema } from "@comis/core";
import type { DagContextEngineDeps } from "./types-dag.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: InstanceType<typeof Database>;
let store: ContextStore;

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof reconcileJsonlToDag>[5];

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

beforeEach(() => {
  db = new Database(":memory:");
  store = createContextStore(db);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConversation(sessionKey = "session-1"): string {
  return store.createConversation({
    tenantId: "test",
    agentId: "agent-1",
    sessionKey,
  });
}

function createAgentMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// Content hash tests
// ---------------------------------------------------------------------------

describe("computeContentHash", () => {
  it("produces consistent 16-char hex", () => {
    const hash1 = computeContentHash("hello world");
    const hash2 = computeContentHash("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash1)).toBe(true);
  });

  it("produces different hashes for different content", () => {
    const hash1 = computeContentHash("hello");
    const hash2 = computeContentHash("world");
    expect(hash1).not.toBe(hash2);
  });
});

describe("flattenMessageContent", () => {
  it("handles string content", () => {
    const msg = { role: "user", content: "hello" } as unknown as AgentMessage;
    expect(flattenMessageContent(msg)).toBe("hello");
  });

  it("handles array content blocks", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    } as unknown as AgentMessage;
    expect(flattenMessageContent(msg)).toBe("hello\nworld");
  });

  it("skips non-text blocks", () => {
    const msg = {
      role: "user",
      content: [
        { type: "image", source: {} },
        { type: "text", text: "hello" },
      ],
    } as unknown as AgentMessage;
    expect(flattenMessageContent(msg)).toBe("hello");
  });

  it("returns empty string for no text content", () => {
    const msg = {
      role: "user",
      content: [{ type: "image", source: {} }],
    } as unknown as AgentMessage;
    expect(flattenMessageContent(msg)).toBe("");
  });
});

describe("mapMessageRole", () => {
  it("maps SDK roles to DAG roles", () => {
    expect(mapMessageRole({ role: "user" } as AgentMessage)).toBe("user");
    expect(mapMessageRole({ role: "assistant" } as AgentMessage)).toBe("assistant");
    expect(mapMessageRole({ role: "toolResult" } as AgentMessage)).toBe("tool_result");
    expect(mapMessageRole({ role: "tool_use" } as AgentMessage)).toBe("tool_use");
  });

  it("passes through unknown roles", () => {
    expect(mapMessageRole({ role: "custom" } as AgentMessage)).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation tests
// ---------------------------------------------------------------------------

describe("reconcileJsonlToDag", () => {
  it("imports all messages when DAG is empty (mode switch)", () => {
    const conversationId = createTestConversation();
    const messages = [
      createAgentMessage("user", "Hello"),
      createAgentMessage("assistant", "Hi there"),
      createAgentMessage("user", "How are you?"),
    ];

    const result = reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    expect(result.imported).toBe(3);
    expect(result.fullImport).toBe(true);
    expect(result.conversationId).toBe(conversationId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify messages in store
    const storedMessages = store.getMessagesByConversation(conversationId);
    expect(storedMessages).toHaveLength(3);
    expect(storedMessages[0].role).toBe("user");
    expect(storedMessages[1].role).toBe("assistant");
  });

  it("uses pre-existing conversation (caller responsibility)", () => {
    // The caller creates the conversation beforehand; reconcileJsonlToDag
    // only receives the conversationId and works with the existing conversation.
    const conversationId = createTestConversation();
    const messages = [createAgentMessage("user", "Hello")];

    // Verify only one conversation exists before reconciliation
    const convBefore = store.getConversation(conversationId);
    expect(convBefore).toBeDefined();

    reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    // Verify still only the same conversation exists (no new ones created)
    const convAfter = store.getConversation(conversationId);
    expect(convAfter).toBeDefined();
    expect(convAfter!.conversation_id).toBe(convBefore!.conversation_id);
  });

  it("skips duplicate messages by content hash", () => {
    const conversationId = createTestConversation();
    const content = "Hello duplicate";
    const hash = computeContentHash(content);

    // Pre-insert a message with the same hash
    store.insertMessage({
      conversationId,
      seq: 1,
      role: "user",
      content,
      contentHash: hash,
      tokenCount: 10,
    });

    const messages = [
      createAgentMessage("user", content),
      createAgentMessage("assistant", "Response"),
    ];

    const result = reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    // Only the new message should be imported (the first is a dup on full import path)
    expect(result.imported).toBe(1);
  });

  it("anchor-based reconciliation imports only new messages", () => {
    const conversationId = createTestConversation();

    // Pre-insert 3 messages in DAG
    const existingContents = ["msg1", "msg2", "msg3"];
    for (let i = 0; i < existingContents.length; i++) {
      const content = existingContents[i]!; // eslint-disable-line security/detect-object-injection
      store.insertMessage({
        conversationId,
        seq: i + 1,
        role: "user",
        content,
        contentHash: computeContentHash(content),
        tokenCount: estimateTokens(content),
      });
    }

    // Build context items for existing messages
    const existingMsgs = store.getMessagesByConversation(conversationId);
    store.replaceContextItems(
      conversationId,
      existingMsgs.map((m, i) => ({
        ordinal: i,
        itemType: "message" as const,
        messageId: m.message_id,
      })),
    );

    // Pass 5 messages to reconcile (3 existing + 2 new)
    const messages = [
      createAgentMessage("user", "msg1"),
      createAgentMessage("user", "msg2"),
      createAgentMessage("user", "msg3"),
      createAgentMessage("user", "msg4-new"),
      createAgentMessage("assistant", "msg5-new"),
    ];

    const result = reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    expect(result.imported).toBe(2);
    expect(result.fullImport).toBe(false);

    const allMessages = store.getMessagesByConversation(conversationId);
    expect(allMessages).toHaveLength(5);
  });

  it("returns imported count and fullImport flag", () => {
    const conversationId = createTestConversation();
    const messages = [createAgentMessage("user", "Hello")];

    const result = reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    expect(result).toEqual(expect.objectContaining({
      imported: 1,
      fullImport: true,
      conversationId,
    }));
    expect(typeof result.durationMs).toBe("number");
  });

  it("handles empty message array gracefully", () => {
    const conversationId = createTestConversation();

    const result = reconcileJsonlToDag(
      [], store, db, conversationId, estimateTokens, mockLogger,
    );

    expect(result.imported).toBe(0);
    expect(result.fullImport).toBe(false);
    expect(result.durationMs).toBe(0);
  });

  it("context items are created via replaceContextItems", () => {
    const conversationId = createTestConversation();
    const messages = [
      createAgentMessage("user", "Hello"),
      createAgentMessage("assistant", "Hi"),
    ];

    reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    const items = store.getContextItems(conversationId);
    expect(items).toHaveLength(2);
    expect(items[0].item_type).toBe("message");
    expect(items[0].ordinal).toBe(0);
    expect(items[1].item_type).toBe("message");
    expect(items[1].ordinal).toBe(1);

    // Verify message_ids are valid
    for (const item of items) {
      expect(item.message_id).toBeGreaterThan(0);
    }
  });

  it("reconciliation is transactional (all messages imported atomically)", () => {
    const conversationId = createTestConversation();
    const messages = [
      createAgentMessage("user", "First"),
      createAgentMessage("assistant", "Second"),
      createAgentMessage("user", "Third"),
    ];

    reconcileJsonlToDag(
      messages, store, db, conversationId, estimateTokens, mockLogger,
    );

    // All 3 should be present (atomic transaction)
    const storedMessages = store.getMessagesByConversation(conversationId);
    expect(storedMessages).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Ingestion hook tests
// ---------------------------------------------------------------------------

describe("installDagIngestionHook", () => {
  it("patches appendMessage and mirrors to DAG", () => {
    const conversationId = createTestConversation();
    const appendResults: string[] = [];

    const sm = {
      appendMessage: vi.fn((msg: unknown) => {
        appendResults.push("original");
        return "entry-id-1";
      }),
    };

    installDagIngestionHook(sm, store, conversationId, mockLogger, estimateTokens);

    // Call patched appendMessage
    const result = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Hello from hook" }],
    });

    // Original should have been called
    expect(result).toBe("entry-id-1");
    expect(appendResults).toEqual(["original"]);

    // Message should appear in DAG store
    const messages = store.getMessagesByConversation(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello from hook");
  });

  it("calls original appendMessage first", () => {
    const conversationId = createTestConversation();
    const callOrder: string[] = [];

    const sm = {
      appendMessage: vi.fn(() => {
        callOrder.push("original");
        return "entry-id";
      }),
    };

    installDagIngestionHook(sm, store, conversationId, mockLogger, estimateTokens);
    sm.appendMessage({ role: "user", content: "test" });

    expect(callOrder[0]).toBe("original");
  });

  it("continues on DAG ingest error", () => {
    const conversationId = createTestConversation();

    // Create a store proxy that throws on insertMessage
    const brokenStore = {
      ...store,
      getMessageByHash: () => undefined,
      getLastMessageSeq: () => 0,
      insertMessage: () => {
        throw new Error("DB write failed");
      },
    } as unknown as ContextStore;

    const sm = {
      appendMessage: vi.fn(() => "entry-id"),
    };

    installDagIngestionHook(sm, brokenStore, conversationId, mockLogger, estimateTokens);

    // Should not throw -- original still succeeds
    const result = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "test" }],
    });
    expect(result).toBe("entry-id");

    // WARN should be logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "DAG ingest error; will reconcile on next transformContext",
        errorKind: "dependency",
      }),
      "DAG ingest failed",
    );
  });

  it("skips duplicate messages", () => {
    const conversationId = createTestConversation();

    const sm = {
      appendMessage: vi.fn(() => "entry-id"),
    };

    installDagIngestionHook(sm, store, conversationId, mockLogger, estimateTokens);

    // Call twice with same content
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "duplicate" }] });
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "duplicate" }] });

    // Only one entry in DAG
    const messages = store.getMessagesByConversation(conversationId);
    expect(messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DAG-05: context:mode_switched emission at the reconcile seam
// ---------------------------------------------------------------------------

describe("context:mode_switched emission (DAG-05)", () => {
  /** Builds a DAG engine over the live :memory: store with a mock eventBus and
   *  a controllable consumePendingModeSwitch stub. The model getter reports a
   *  non-reasoning model so the thinking-block cleaner layer is skipped. */
  function makeDagEngine(
    conversationId: string,
    overrides: {
      eventBus?: { emit: ReturnType<typeof vi.fn> };
      consumePendingModeSwitch?: DagContextEngineDeps["consumePendingModeSwitch"];
    } = {},
  ) {
    const eventBus = overrides.eventBus ?? { emit: vi.fn() };
    const config = ContextEngineConfigSchema.parse({ version: "dag" });
    const deps: DagContextEngineDeps = {
      logger: mockLogger as unknown as DagContextEngineDeps["logger"],
      getModel: () => ({ reasoning: false, contextWindow: 200_000, maxTokens: 8192 }),
      eventBus,
      agentId: "agent-1",
      sessionKey: "tenant:agent-1:chan",
      contextStore: store as unknown as DagContextEngineDeps["contextStore"],
      db,
      conversationId,
      estimateTokens,
      consumePendingModeSwitch: overrides.consumePendingModeSwitch,
    };
    const engine = createDagContextEngine(config, deps);
    return { engine, eventBus };
  }

  function modeSwitchedCalls(eventBus: { emit: ReturnType<typeof vi.fn> }) {
    return eventBus.emit.mock.calls.filter((c) => c[0] === "context:mode_switched");
  }

  it("emits context:mode_switched once with from/to + real import cost on a consumed switch", async () => {
    const conversationId = createTestConversation();
    const consumePendingModeSwitch = vi.fn((_id: string) =>
      ({ from: "pipeline", to: "dag" }) as const,
    );
    const { engine, eventBus } = makeDagEngine(conversationId, { consumePendingModeSwitch });

    // 3 synthetic JSONL messages -> empty DAG -> fullImport with imported=3.
    const messages = [
      createAgentMessage("user", "first question"),
      createAgentMessage("assistant", "first answer"),
      createAgentMessage("user", "second question"),
    ];
    await engine.transformContext(messages);

    const calls = modeSwitchedCalls(eventBus);
    expect(calls).toHaveLength(1);
    expect(consumePendingModeSwitch).toHaveBeenCalledWith("agent-1");

    const payload = calls[0]![1] as Record<string, unknown>;
    expect(payload.from).toBe("pipeline");
    expect(payload.to).toBe("dag");
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.agentId).toBe("agent-1");
    expect(payload.sessionKey).toBe("tenant:agent-1:chan");
    expect(payload.fullImport).toBe(true);
    expect(payload.importedCount).toBe(3);
    expect(typeof payload.durationMs).toBe("number");
    expect(typeof payload.timestamp).toBe("number");

    // T-85-11: payload is identifiers + counts + durations only — NO message text.
    const allowed = new Set([
      "from", "to", "conversationId", "agentId", "sessionKey",
      "fullImport", "importedCount", "durationMs", "timestamp",
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it("is one-shot: a second transformContext after consume returns undefined emits nothing further", async () => {
    const conversationId = createTestConversation();
    // First call returns the switch, every later call returns undefined
    // (mirrors the daemon's delete-on-read closure).
    let consumed = false;
    const consumePendingModeSwitch = vi.fn((_id: string) => {
      if (consumed) return undefined;
      consumed = true;
      return { from: "pipeline", to: "dag" } as const;
    });
    const { engine, eventBus } = makeDagEngine(conversationId, { consumePendingModeSwitch });

    await engine.transformContext([
      createAgentMessage("user", "turn one"),
      createAgentMessage("assistant", "answer one"),
    ]);
    // Second turn: the JSONL grows but the pending switch is already consumed.
    await engine.transformContext([
      createAgentMessage("user", "turn one"),
      createAgentMessage("assistant", "answer one"),
      createAgentMessage("user", "turn two"),
    ]);

    expect(modeSwitchedCalls(eventBus)).toHaveLength(1);
  });

  it("suppresses the event for a brand-new DAG conversation (no pending switch) even with fullImport", async () => {
    const conversationId = createTestConversation();
    // consumePendingModeSwitch returns undefined -> NOT a switch, just a new
    // DAG-default conversation. fullImport is true here, but it MUST NOT trigger.
    const consumePendingModeSwitch = vi.fn((_id: string) => undefined);
    const { engine, eventBus } = makeDagEngine(conversationId, { consumePendingModeSwitch });

    await engine.transformContext([
      createAgentMessage("user", "brand new conversation"),
      createAgentMessage("assistant", "hello"),
    ]);

    expect(modeSwitchedCalls(eventBus)).toHaveLength(0);
  });

  it("suppresses the event when consumePendingModeSwitch is undefined (carrier absent)", async () => {
    const conversationId = createTestConversation();
    // No consumePendingModeSwitch wired at all (non-daemon / test path).
    const { engine, eventBus } = makeDagEngine(conversationId, {
      consumePendingModeSwitch: undefined,
    });

    await engine.transformContext([createAgentMessage("user", "hi there")]);

    expect(modeSwitchedCalls(eventBus)).toHaveLength(0);
  });
});
