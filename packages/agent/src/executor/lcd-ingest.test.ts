// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD afterTurn ingest write-path (Plan 128-03, A1).
 *
 * RED-first. Drives the not-yet-built `ingestTurn`:
 *  - Test 1 (append the delta): N new messages → exactly N `append` calls with
 *    monotonic seq starting at `startSeq`, each carrying role / tokenCount /
 *    createdAt / parts.
 *  - Test 2 (idempotent / empty delta): the helper appends exactly
 *    `messages.length` rows; an EMPTY delta appends nothing (the idempotency
 *    contract — the caller passes only the not-yet-persisted slice).
 *  - Test 3 (tokenCount agent-side): each `append` carries
 *    `estimateMessageTokens(msg)`; a thinking block's reasoning tokens ARE
 *    counted (F3) even though the codec excludes reasoning from visible content.
 *  - Test 4 (parts via codec): each `append` carries `messageToParts(msg)` — a
 *    `tool_use` block survives as a STRUCTURED block (NOT flattened to text).
 *  - Test 5 (scope correct): the SECURITY scope columns
 *    `{ conversationId, tenantId, agentId, sessionKey }` are all populated.
 *  - Test 6 (non-fatal): a throwing `append` does NOT propagate out of
 *    `ingestTurn` — it logs + continues (subsequent messages still attempted).
 *  - Test 7 (round-trip integration — the load-bearing proof): a multi-step
 *    turn ingested via `ingestTurn` then read back via the Plan-02 LCD assembler
 *    reconstructs faithful messages with the `tool_use`/`tool_result` blocks
 *    intact and the stable id paired — exactly what the assembler reads.
 *
 * The store is the REAL `createLcdStore(new Database(":memory:"))` — `@comis/memory`
 * is an agent devDependency, allowed in `.test.ts` only (the agent↛memory cut).
 */
import {
  type AppendMessageInput,
  type ContextStorePort,
  type ContextStoreScope,
  messageToParts,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { initSchema, createLcdStore } from "@comis/memory";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ingestTurn, ingestTurnGuarded } from "./lcd-ingest.js";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import { createLcdContextEngine } from "../context-engine/lcd-assembler.js";
import type { ContextEngineDeps } from "../context-engine/types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = 1000;
const CONVERSATION_ID = "conv-ingest";

const SCOPE: ContextStoreScope = {
  conversationId: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: FIXED_NOW } as Message;
}

function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: FIXED_NOW,
  } as unknown as Message;
}

function assistantThinking(thinking: string, text: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: FIXED_NOW,
  } as unknown as Message;
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolUse",
    timestamp: FIXED_NOW,
  } as unknown as Message;
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: FIXED_NOW,
  } as unknown as Message;
}

/** An in-memory ContextStorePort double recording every append input. */
function makeRecordingStore(): {
  store: ContextStorePort;
  appended: AppendMessageInput[];
} {
  const appended: AppendMessageInput[] = [];
  const store: ContextStorePort = {
    append(input: AppendMessageInput): void {
      appended.push(input);
    },
    getMessages() {
      return [];
    },
  };
  return { store, appended };
}

function isToolCallBlock(b: unknown): b is { type: "toolCall"; id: string; name: string } {
  return !!b && typeof b === "object" && (b as { type?: string }).type === "toolCall";
}

function roleOf(m: AgentMessage): string {
  return (m as unknown as { role: string }).role;
}

const dagConfig = (freshTailTurns: number) =>
  ({ enabled: true, thinkingKeepTurns: 10, historyTurns: 15, version: "dag", freshTailTurns }) as unknown as Parameters<typeof createLcdContextEngine>[0];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestTurn", () => {
  it("Test 1: appends the delta with monotonic seq from startSeq, carrying role/tokenCount/createdAt/parts", () => {
    const { store, appended } = makeRecordingStore();
    const logger = createMockLogger();
    const delta: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_1", "read", { path: "/a" }) as AgentMessage,
      toolResult("tu_1", "read", "ok") as AgentMessage,
    ];

    ingestTurn(store, SCOPE, 5, delta, FIXED_NOW, logger);

    expect(appended).toHaveLength(3);
    expect(appended.map((a) => a.seq)).toEqual([5, 6, 7]); // monotonic from startSeq
    expect(appended.map((a) => a.role)).toEqual(["user", "assistant", "toolResult"]);
    for (const a of appended) {
      expect(a.scope).toEqual(SCOPE);
      expect(a.createdAt).toBe(FIXED_NOW);
      expect(typeof a.tokenCount).toBe("number");
      expect(Array.isArray(a.parts)).toBe(true);
    }
  });

  it("Test 2: an EMPTY delta appends nothing (the idempotent-retry contract)", () => {
    const { store, appended } = makeRecordingStore();
    const logger = createMockLogger();

    ingestTurn(store, SCOPE, 9, [], FIXED_NOW, logger);

    expect(appended).toHaveLength(0); // a retry with no new messages persists nothing
  });

  it("Test 3: tokenCount is computed agent-side via estimateMessageTokens; thinking tokens ARE counted (F3)", () => {
    const { store, appended } = makeRecordingStore();
    const logger = createMockLogger();
    const thinking = "a".repeat(400); // 400/4 = 100 reasoning tokens (CHARS_PER_TOKEN)
    const msg = assistantThinking(thinking, "answer");

    ingestTurn(store, SCOPE, 0, [msg as AgentMessage], FIXED_NOW, logger);

    expect(appended).toHaveLength(1);
    // Exactly the agent-side estimate — the store NEVER computes tokens (127 contract).
    expect(appended[0]!.tokenCount).toBe(estimateMessageTokens(msg));
    // F3: the reasoning tokens are budgeted at write time (the estimate counts the
    // thinking block) — so a message WITH reasoning costs strictly more than one without.
    const withoutThinking = assistantText("answer");
    expect(estimateMessageTokens(msg)).toBeGreaterThan(estimateMessageTokens(withoutThinking));
  });

  it("Test 4: parts are produced by messageToParts — a tool_use survives as a STRUCTURED block, not text", () => {
    const { store, appended } = makeRecordingStore();
    const logger = createMockLogger();
    const msg = assistantToolCall("tu_42", "read", { path: "/x" });

    ingestTurn(store, SCOPE, 0, [msg as AgentMessage], FIXED_NOW, logger);

    expect(appended).toHaveLength(1);
    // Byte-for-byte the codec output (verbatim metadata.raw blocks + envelope).
    expect(appended[0]!.parts).toEqual(messageToParts(msg));
    // The tool_use part is a structured tool_use part carrying the stable id —
    // NOT flattened to a text part (the deleted dag-assembler bug).
    const part = appended[0]!.parts[0]!;
    expect(part.kind).toBe("tool_use");
    expect(part.toolCallId).toBe("tu_42");
  });

  it("Test 5: the scope passed to append carries all four SECURITY columns populated", () => {
    const { store, appended } = makeRecordingStore();
    const logger = createMockLogger();

    ingestTurn(store, SCOPE, 0, [userMsg("hello") as AgentMessage], FIXED_NOW, logger);

    expect(appended).toHaveLength(1);
    const scope = appended[0]!.scope;
    // No undefined/empty scoping column — a missing one would create a
    // cross-session-readable row (threat (c) / T-128-08).
    expect(scope.conversationId).toBeTruthy();
    expect(scope.tenantId).toBeTruthy();
    expect(scope.agentId).toBeTruthy();
    expect(scope.sessionKey).toBeTruthy();
  });

  it("Test 6: a throwing append is non-fatal — no throw escapes; subsequent messages still attempted + logged", () => {
    const attempts: number[] = [];
    const store: ContextStorePort = {
      append(input: AppendMessageInput): void {
        attempts.push(input.seq);
        if (input.seq === 1) throw new Error("disk full");
      },
      getMessages() {
        return [];
      },
    };
    const logger = createMockLogger();
    const delta: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_1", "read", {}) as AgentMessage, // seq 1 → throws
      assistantText("recovered") as AgentMessage, // seq 2 → must still be attempted
    ];

    // The turn must NOT fail — no throw escapes.
    expect(() => ingestTurn(store, SCOPE, 0, delta, FIXED_NOW, logger)).not.toThrow();
    // Per-entry try/catch: the failure is isolated, the next message is attempted.
    expect(attempts).toEqual([0, 1, 2]);
    // The failure branch logs the canonical err/hint/errorKind fields.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.any(String),
    );
  });

  it("Test 7: round-trip — a multi-step turn ingested via ingestTurn reads back faithfully through the Plan-02 assembler", async () => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const logger = createMockLogger();

    // A multi-step tool turn: user → assistant(tool_use) → toolResult → assistant(text).
    const turn: AgentMessage[] = [
      userMsg("read /a please") as AgentMessage,
      assistantToolCall("tu_1", "read", { path: "/a" }) as AgentMessage,
      toolResult("tu_1", "read", "file contents") as AgentMessage,
      assistantText("here is the file") as AgentMessage,
    ];

    // WRITE-PATH: ingest the whole turn at afterTurn (startSeq 0 — empty store).
    ingestTurn(store, SCOPE, 0, turn, FIXED_NOW, logger);

    // READ-PATH: the Plan-02 assembler reconstructs history FROM THE STORE. The
    // live array is the FULL canonical conversation (the SDK passes
    // `state.messages`, never a tail-only slice — CR-01); with freshTailTurns=1
    // the fresh tail is just the trailing assistant, so the tu_1 step falls in the
    // history prefix [0,3) which the assembler takes from the STORE rows (the
    // codec round-trip), proving the write→read→assemble path the loop bug broke.
    const mockLogger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: mockLogger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({ reasoning: true, contextWindow: 200_000, maxTokens: 8_192 }),
      contextStore: store,
      conversationId: CONVERSATION_ID,
      agentId: "agent_a",
      sessionKey: "sess-a",
    };
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(turn);

    // The tool_use BLOCK survives with its stable id (the codec round-trip — NOT
    // flattened to text), and the top-level toolResult is paired to it.
    const historyAssistant = out.find(
      (m) => roleOf(m) === "assistant" && (m as unknown as { content: unknown[] }).content.some(isToolCallBlock),
    );
    expect(historyAssistant).toBeDefined();
    const tc = (historyAssistant as unknown as { content: unknown[] }).content.find(isToolCallBlock);
    expect(tc).toMatchObject({ id: "tu_1", name: "read" });
    const tr = out.find((m) => roleOf(m) === "toolResult");
    expect(tr).toBeDefined();
    expect((tr as unknown as { toolCallId: string }).toolCallId).toBe("tu_1");
    // The user message that ingest persisted is present (store-sourced).
    expect(out.some((m) => roleOf(m) === "user")).toBe(true);
  });

  it("Test 8: emits a step-tagged DEBUG with the canonical observability fields after a successful ingest", () => {
    const { store } = makeRecordingStore();
    const logger = createMockLogger();

    ingestTurn(store, SCOPE, 0, [userMsg("hi") as AgentMessage], FIXED_NOW, logger);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "lcd-ingest",
        conversationId: CONVERSATION_ID,
        agentId: "agent_a",
        sessionKey: "sess-a",
        appended: 1,
      }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// ingestTurnGuarded — the WR-01 shrink guard: derive the delta defensively and
// SKIP cleanly (with a WARN) when the live array is shorter than the store's
// persisted high-water mark, rather than slicing past the end and either
// persisting nothing forever or re-appending at an existing seq (the unique
// (conversationId, seq) index would throw, the per-entry catch would swallow it,
// and the turn's messages would be silently never persisted).
// ---------------------------------------------------------------------------

/** A recording store whose persisted COUNT is controllable (the high-water mark). */
function makeStoreWithPersistedCount(persistedCount: number): {
  store: ContextStorePort;
  appended: AppendMessageInput[];
} {
  const appended: AppendMessageInput[] = [];
  const store: ContextStorePort = {
    append(input: AppendMessageInput): void {
      appended.push(input);
    },
    // The assembler/ingest both read `getMessages(id).length` as the high-water
    // mark; return that many placeholder rows so .length is the mark.
    getMessages() {
      return new Array(persistedCount).fill(null) as unknown as ReturnType<ContextStorePort["getMessages"]>;
    },
  };
  return { store, appended };
}

describe("ingestTurnGuarded (WR-01 shrink guard)", () => {
  it("Test 9: live array SHORTER than the persisted high-water mark → SKIPS the append and WARNs (no seq collision)", () => {
    // The store already holds 6 persisted rows; a heal reassigned state.messages
    // SMALLER (4 < 6). Slicing live[6..] from a length-4 array is empty (or, on a
    // rewritten tail, re-appends at an existing seq → unique-index throw). The
    // guard must SKIP and WARN so the divergence is observable, not silent.
    const { store, appended } = makeStoreWithPersistedCount(6);
    const logger = createMockLogger();
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantText("a0") as AgentMessage,
      userMsg("u1") as AgentMessage,
      assistantText("a1") as AgentMessage,
    ];

    ingestTurnGuarded(store, SCOPE, live, FIXED_NOW, logger);

    // NOTHING appended (no empty-delta no-op that advances nothing; no collision).
    expect(appended).toHaveLength(0);
    // WARN carries the §2.7 fields (hint + a VALID closed-union errorKind) so an
    // operator can act on the live/store divergence.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "precondition",
        liveLen: 4,
        persisted: 6,
        hint: expect.any(String),
        conversationId: CONVERSATION_ID,
      }),
      expect.any(String),
    );
  });

  it("Test 10: live array >= persisted high-water mark → appends only the not-yet-persisted delta", () => {
    // Normal mid-turn: 2 already persisted, live has 4 → append exactly live[2..4).
    const { store, appended } = makeStoreWithPersistedCount(2);
    const logger = createMockLogger();
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantText("a0") as AgentMessage,
      userMsg("u1") as AgentMessage, // seq 2 — the delta
      assistantText("a1") as AgentMessage, // seq 3 — the delta
    ];

    ingestTurnGuarded(store, SCOPE, live, FIXED_NOW, logger);

    // Only the not-yet-persisted tail, at the correct continuing seqs.
    expect(appended).toHaveLength(2);
    expect(appended.map((a) => a.seq)).toEqual([2, 3]);
    expect(appended.map((a) => a.role)).toEqual(["user", "assistant"]);
    // No divergence → no WARN.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// Suppress unused-import lint when vi is only used in a subset of runs.
void vi;
