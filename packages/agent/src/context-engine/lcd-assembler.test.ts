// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD `dag`-mode assembly engine (Plan 128-02, A1/A2/A4).
 *
 * RED-first. Drives the corrected loop-fix path:
 *  - history reconstructed from the STORE via the core `partsToMessage` codec
 *    (verbatim `metadata.raw` blocks, stable ids) — NOT flattened-to-text (the
 *    deleted dag-assembler bug that produced the 54-read loop),
 *  - the fresh tail (last N STEPS) sliced from the LIVE array VERBATIM (A1),
 *  - `sanitizeToolUseResultPairing` (Plan 01) run as the FINAL step (A2),
 *  - the assembled array grows on a tool step and carries a top-level
 *    `toolResult` (A4 unit-level shadow).
 *
 * The store is the REAL `createLcdStore(new Database(":memory:"))` — `@comis/memory`
 * is an agent devDependency, allowed in `.test.ts` only (NOT production code —
 * the agent↛memory cut). Exercising the real store proves the write→read→assemble
 * round-trip the loop bug broke.
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
import { initSchema } from "@comis/memory";
import { createLcdStore } from "@comis/memory";
import { describe, it, expect, beforeEach } from "vitest";
import { createContextEngine } from "./context-engine.js";
import { createLcdContextEngine, freshTailBoundaryIndex } from "./lcd-assembler.js";
import type { ContextEngineDeps } from "./types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_CREATED_AT = 1000;
const CONVERSATION_ID = "conv-lcd";

const SCOPE: ContextStoreScope = {
  conversationId: CONVERSATION_ID,
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: FIXED_CREATED_AT } as Message;
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
    timestamp: FIXED_CREATED_AT,
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
    timestamp: FIXED_CREATED_AT,
  } as unknown as Message;
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: FIXED_CREATED_AT,
  } as unknown as Message;
}

/** Build the deps the assembler reads, with a real in-memory store wired. */
function makeDeps(store: ContextStorePort): {
  deps: ContextEngineDeps;
  logger: ReturnType<typeof createMockLogger>;
} {
  const logger = createMockLogger();
  const deps: ContextEngineDeps = {
    logger: logger as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: true, contextWindow: 200_000, maxTokens: 8_192 }),
    contextStore: store,
    conversationId: CONVERSATION_ID,
    agentId: "agent_a",
    sessionKey: "sess-a",
  };
  return { deps, logger };
}

/** Persist a canonical pi-ai message into the store at the next seq. */
function append(store: ContextStorePort, msg: Message, seq: number): void {
  const input: AppendMessageInput = {
    scope: SCOPE,
    seq,
    role: msg.role,
    tokenCount: 1,
    createdAt: FIXED_CREATED_AT,
    parts: messageToParts(msg),
  };
  store.append(input);
}

// A dag config carrying the activated freshTailTurns (= STEP count).
const dagConfig = (freshTailTurns: number) =>
  ({ enabled: true, thinkingKeepTurns: 10, historyTurns: 15, version: "dag", freshTailTurns }) as unknown as Parameters<typeof createLcdContextEngine>[0];

function isToolCallBlock(b: unknown): b is { type: "toolCall"; id: string; name: string } {
  return !!b && typeof b === "object" && (b as { type?: string }).type === "toolCall";
}

function roleOf(m: AgentMessage): string {
  return (m as unknown as { role: string }).role;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("freshTailBoundaryIndex", () => {
  it("Test 1: counts the last N ASSISTANT messages (steps), not user-turns", () => {
    const msgs: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_1", "read", {}) as AgentMessage, // assistant_a
      toolResult("tu_1", "read", "ok") as AgentMessage,
      assistantText("a") as AgentMessage, // assistant_b
      userMsg("u1") as AgentMessage,
      assistantText("c") as AgentMessage, // assistant_c
    ];
    // N=2 → 2nd-from-last assistant is index 3 (assistant_b); slice = [assistant_b, user, assistant_c].
    const idx = freshTailBoundaryIndex(msgs, 2);
    expect(idx).toBe(3);
    expect(msgs.slice(idx).map(roleOf)).toEqual(["assistant", "user", "assistant"]);
  });

  it("Test 1b: N larger than the number of assistant messages returns 0 (whole array)", () => {
    const msgs: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantText("a") as AgentMessage,
    ];
    expect(freshTailBoundaryIndex(msgs, 8)).toBe(0);
  });
});

describe("createLcdContextEngine", () => {
  let store: ContextStorePort;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("Test 2: the fresh tail is the ORIGINAL live blocks (verbatim, not text-flattened)", async () => {
    // Live array: a tool-call step lives in the fresh tail.
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_1", "read", { path: "/a" }) as AgentMessage,
      toolResult("tu_1", "read", "contents") as AgentMessage,
    ];
    for (let i = 0; i < live.length; i++) append(store, live[i] as Message, i);

    const { deps } = makeDeps(store);
    const engine = createLcdContextEngine(dagConfig(8), deps);
    const out = await engine.transformContext(live);

    // The assistant tool_use block survives as a STRUCTURED toolCall block,
    // referentially the live block (never collapsed to {type:'text'}).
    const assistant = out.find((m) => roleOf(m) === "assistant")!;
    const blocks = (assistant as unknown as { content: unknown[] }).content;
    const tc = blocks.find(isToolCallBlock);
    expect(tc).toBeDefined();
    expect(tc).toMatchObject({ type: "toolCall", id: "tu_1", name: "read" });
    // Referential identity: the fresh-tail slice passed the live block through.
    expect(blocks[0]).toBe((live[1] as unknown as { content: unknown[] }).content[0]);
  });

  it("Test 3: history is reconstructed from the STORE via the codec (paired, stable ids, NOT flattened)", async () => {
    // A multi-step turn persisted to the store: user → assistant(tu_1) → toolResult(tu_1) → assistant(text)
    const persisted: Message[] = [
      userMsg("u0"),
      assistantToolCall("tu_1", "read", { path: "/a" }),
      toolResult("tu_1", "read", "contents"),
      assistantText("done"),
    ];
    for (let i = 0; i < persisted.length; i++) append(store, persisted[i] as Message, i);

    // The LIVE array carries ONLY the trailing assistant("done") (the fresh tail).
    // The tu_1 tool_use + its result exist ONLY in the store — so finding them in
    // the output PROVES history was reconstructed from the store (an identity
    // pass-through of the live array could not produce them).
    const live: AgentMessage[] = [assistantText("done") as AgentMessage];
    const { deps } = makeDeps(store);
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    // The tool_use BLOCK + its top-level toolResult survive with the stable id
    // tu_1 (the codec round-trip — NOT flattened to text).
    const historyAssistant = out.find(
      (m) => roleOf(m) === "assistant" && (m as unknown as { content: unknown[] }).content.some(isToolCallBlock),
    );
    expect(historyAssistant).toBeDefined();
    const tc = (historyAssistant as unknown as { content: unknown[] }).content.find(isToolCallBlock);
    expect(tc).toMatchObject({ id: "tu_1", name: "read" });
    const tr = out.find((m) => roleOf(m) === "toolResult");
    expect(tr).toBeDefined();
    expect((tr as unknown as { toolCallId: string }).toolCallId).toBe("tu_1");
    // And the user message from history is present (store-sourced).
    expect(out.some((m) => roleOf(m) === "user")).toBe(true);
  });

  it("Test 4: transcript repair runs LAST — an unpaired tool_use gets a synthesized result", async () => {
    // Store an assistant tool_use with NO matching result (a dangling call).
    const stored: Message[] = [
      userMsg("u0"),
      assistantToolCall("tu_orphan", "read", { path: "/x" }),
    ];
    for (let i = 0; i < stored.length; i++) append(store, stored[i] as Message, i);

    // Live array carries only the trailing assistant text as the fresh tail,
    // so the orphan call sits in history. freshTailTurns=1.
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_orphan", "read", { path: "/x" }) as AgentMessage,
      assistantText("final") as AgentMessage,
    ];
    // Note: only the first two are in the store; the assembler reads HISTORY from
    // the store and the FRESH TAIL from the live array.
    const { deps } = makeDeps(store);
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    // Provider-valid: every toolResult follows a preceding tool_use, AND the
    // dangling tu_orphan got a synthesized result (repair ran last).
    const seenCalls = new Set<string>();
    for (const m of out) {
      if (roleOf(m) === "assistant") {
        for (const b of (m as unknown as { content: unknown[] }).content) {
          if (isToolCallBlock(b)) seenCalls.add(b.id);
        }
      }
      if (roleOf(m) === "toolResult") {
        const id = (m as unknown as { toolCallId: string }).toolCallId;
        expect(seenCalls.has(id)).toBe(true); // result never precedes its call
      }
    }
    const resultIds = out
      .filter((m) => roleOf(m) === "toolResult")
      .map((m) => (m as unknown as { toolCallId: string }).toolCallId);
    expect(resultIds).toContain("tu_orphan"); // synthesized
  });

  it("Test 5: a tool step GROWS the array and contains a top-level toolResult (A4 shadow)", async () => {
    // Tool-free turn baseline.
    const toolFree: Message[] = [userMsg("u0"), assistantText("hi")];
    for (let i = 0; i < toolFree.length; i++) append(store, toolFree[i] as Message, i);
    const { deps: depsFree } = makeDeps(store);
    const engineFree = createLcdContextEngine(dagConfig(8), depsFree);
    const outFree = await engineFree.transformContext(toolFree as AgentMessage[]);

    // Tool turn (fresh DB).
    const db2 = new Database(":memory:");
    initSchema(db2, 1536);
    const store2 = createLcdStore(db2);
    const toolTurn: Message[] = [
      userMsg("u0"),
      assistantToolCall("tu_1", "read", {}),
      toolResult("tu_1", "read", "ok"),
    ];
    for (let i = 0; i < toolTurn.length; i++) append(store2, toolTurn[i] as Message, i);
    const { deps: depsTool } = makeDeps(store2);
    const engineTool = createLcdContextEngine(dagConfig(8), depsTool);
    const outTool = await engineTool.transformContext(toolTurn as AgentMessage[]);

    expect(outTool.length).toBeGreaterThan(outFree.length); // grows on a tool step
    expect(outTool.some((m) => roleOf(m) === "toolResult")).toBe(true); // carries the toolResult
  });

  it("Test 7: history/fresh-tail overlap does NOT double a message", async () => {
    // Both the store and the live array hold the full 4-message turn; with
    // freshTailTurns large enough the fresh tail covers part of it. The concat
    // must NOT emit a message twice (fresh tail authoritative for its range).
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantToolCall("tu_1", "read", {}) as AgentMessage,
      toolResult("tu_1", "read", "ok") as AgentMessage,
      assistantText("done") as AgentMessage,
    ];
    for (let i = 0; i < live.length; i++) append(store, live[i] as Message, i);

    const { deps } = makeDeps(store);
    // freshTailTurns=1 → fresh tail = [assistantText("done")]; history = first 3.
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    // Exactly one assistant("done") text message, not two.
    const doneCount = out.filter(
      (m) =>
        roleOf(m) === "assistant" &&
        (m as unknown as { content: { type: string; text?: string }[] }).content.some(
          (b) => b.type === "text" && b.text === "done",
        ),
    ).length;
    expect(doneCount).toBe(1);
    // Exactly one tu_1 tool_use, exactly one tu_1 toolResult (no split/dup pair).
    const tu1Calls = out.filter(
      (m) =>
        roleOf(m) === "assistant" &&
        (m as unknown as { content: unknown[] }).content.some((b) => isToolCallBlock(b) && b.id === "tu_1"),
    ).length;
    const tu1Results = out.filter(
      (m) => roleOf(m) === "toolResult" && (m as unknown as { toolCallId: string }).toolCallId === "tu_1",
    ).length;
    expect(tu1Calls).toBe(1);
    expect(tu1Results).toBe(1);
  });
});

describe("createContextEngine dag fallback (Test 6)", () => {
  it("Test 6: version 'dag' with NO store wired falls through to the pipeline with a config WARN", async () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({ reasoning: true, contextWindow: 200_000, maxTokens: 8_192 }),
      // deliberately NO contextStore / conversationId
    };
    const engine = createContextEngine(
      { enabled: true, thinkingKeepTurns: 10, historyTurns: 15, version: "dag" } as unknown as Parameters<
        typeof createContextEngine
      >[0],
      deps,
    );

    // WARN with the canonical config errorKind (does not crash, does not no-op).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.any(String),
    );

    // Pipeline behavior: below the masking threshold it returns the array unchanged.
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hello" }] } as AgentMessage,
    ];
    const result = await engine.transformContext(messages);
    expect(result).toBe(messages); // pipeline pass-through, not a no-op crash
  });
});
