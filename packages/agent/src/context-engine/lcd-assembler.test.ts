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

    // The LIVE array is the FULL canonical conversation (the SDK passes
    // `session.agent.state.messages`, never a tail-only slice). With
    // freshTailTurns=1 the fresh tail is just the trailing assistant("done")
    // (index 3), so the tu_1 tool_use + its result fall in the history prefix
    // [0,3) — which the assembler takes from the STORE rows (`history[i]`), NOT
    // from the live array. The live tu_1/toolResult blocks here are plain
    // `tool_use`/top-level casts; the store rows are codec-reconstructed canonical
    // blocks, so finding the STRUCTURED `toolCall` block + paired top-level
    // toolResult in the output PROVES the history prefix was reconstructed from
    // the store via the codec.
    const live: AgentMessage[] = persisted as AgentMessage[];
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
    // Store-source proof (codec read path): the emitted history-prefix assistant
    // is the codec-RECONSTRUCTED row, NOT the live array's object at that index —
    // a referentially-DISTINCT message. (If the assembler had passed the live
    // prefix through instead of reconstructing from the store, this would be the
    // SAME object and the round-trip the loop bug broke would be untested.)
    expect(historyAssistant).not.toBe(live[1]);
  });

  it("Test 4: transcript repair runs LAST — an unpaired tool_use gets a synthesized result", async () => {
    // A turn whose assistant tool_use NEVER got a matching result (a dangling
    // call), then a trailing assistant text. Store and live are 1:1 (the 128
    // no-compaction invariant). freshTailTurns=1 → fresh tail = [assistant("final")],
    // so the orphan call sits in the reconstructed-from-store HISTORY.
    const turn: Message[] = [
      userMsg("u0"),
      assistantToolCall("tu_orphan", "read", { path: "/x" }),
      assistantText("final"),
    ];
    for (let i = 0; i < turn.length; i++) append(store, turn[i] as Message, i);

    const live: AgentMessage[] = turn as AgentMessage[];
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

  it("Test 8: mid-turn (live LONGER than store) drops NO middle-history message and doubles NONE (CR-01)", async () => {
    // THE PRODUCTION STATE the count-subtraction de-dup got wrong. `transformContext`
    // runs BEFORE every LLM call mid-turn, but the store is written only at
    // afterTurn — so the live array always carries the current turn's
    // not-yet-persisted messages and `live.length (L) > store.length (H)`.
    //
    // Persist the PERSISTED PREFIX ONLY: 9 completed messages (u0..a3 then u4).
    const persistedPrefix: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
      userMsg("u3"),
      assistantText("a3"),
      userMsg("u4"),
    ];
    for (let i = 0; i < persistedPrefix.length; i++) append(store, persistedPrefix[i] as Message, i);

    // The LIVE array = the persisted prefix (9) PLUS the in-flight turn's 3
    // not-yet-persisted messages (a4, u5, a5). L=12, H=9, L−H=3.
    const live: AgentMessage[] = [
      ...(persistedPrefix as AgentMessage[]),
      assistantText("a4") as AgentMessage,
      userMsg("u5") as AgentMessage,
      assistantText("a5") as AgentMessage,
    ];

    const { deps } = makeDeps(store);
    // freshTailTurns=2 → tailStart = 2nd-from-last assistant = index 9 (a4),
    // freshTail=[a4,u5,a5] (len 3). The buggy slice keeps history[0..H−F)=
    // history[0..6) and DROPS the contiguous mid-history block [u3,a3,u4]
    // (store indices 6,7,8) — the fresh tail does NOT re-add them.
    const engine = createLcdContextEngine(dagConfig(2), deps);
    const out = await engine.transformContext(live);

    // Every conversation message appears EXACTLY ONCE — no middle-block drop,
    // no double at the seam. Project to the user/assistant text payloads.
    const texts = out.map((m) => {
      const c = (m as unknown as { content: unknown }).content;
      if (typeof c === "string") return c;
      const arr = c as { type: string; text?: string }[];
      const t = arr.find((b) => b.type === "text");
      return t?.text ?? "";
    });
    expect(texts).toEqual(["u0", "a0", "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5"]);

    // The fresh tail is the LIVE tail: the trailing 3 are the live objects verbatim.
    expect(out[9]).toBe(live[9]);
    expect(out[10]).toBe(live[10]);
    expect(out[11]).toBe(live[11]);
  });

  it("Test 9: live array SHRINKS below the store count — assembler over-includes nothing, doubles nothing (WR-01)", async () => {
    // A future heal/compaction could reassign state.messages SMALLER than the
    // append-only store. The assembler seam must stay robust to live.length <=
    // store.length: no negative slice, no double at the join.
    const persisted: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    for (let i = 0; i < persisted.length; i++) append(store, persisted[i] as Message, i);

    // Live array is SHORTER than the store (4 < 6).
    const live: AgentMessage[] = [
      userMsg("u0") as AgentMessage,
      assistantText("a0") as AgentMessage,
      userMsg("u1") as AgentMessage,
      assistantText("a1") as AgentMessage,
    ];

    const { deps } = makeDeps(store);
    // freshTailTurns=1 → tailStart = last assistant = index 3 (a1); freshTail=[a1].
    // historyPrefix = live[0..3) reconstructed from store rows (all persisted).
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    const texts = out.map((m) => {
      const c = (m as unknown as { content: unknown }).content;
      if (typeof c === "string") return c;
      const arr = c as { type: string; text?: string }[];
      const t = arr.find((b) => b.type === "text");
      return t?.text ?? "";
    });
    // Exactly the live array's own conversation, each message once — the store's
    // EXTRA rows (u2,a2) are NOT over-included, and a1 is NOT doubled at the seam.
    expect(texts).toEqual(["u0", "a0", "u1", "a1"]);
    expect(texts.filter((t) => t === "a1")).toHaveLength(1);
  });
});

describe("createLcdContextEngine context_items + eviction (Plan 05, C3/A3)", () => {
  let store: ContextStorePort;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Seed N completed user/assistant text turns into the store (seq 0..2N-1). */
  function seedTextTurns(count: number): Message[] {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(userMsg(`u${i}`));
      msgs.push(assistantText(`a${i}`));
    }
    for (let i = 0; i < msgs.length; i++) append(store, msgs[i] as Message, i);
    return msgs;
  }

  it("Plan05 Test A: a leaf summary surfaces as a user-role text message at the replaced ordinal, in order", async () => {
    // 6 turns (12 messages, seq 0..11). Lazy-seed makes context_items 1:1.
    const msgs = seedTextTurns(6);
    expect(msgs.length).toBe(12);
    // Force the lazy seed (1:1 context_items), then range-replace ordinals [0,3]
    // (the oldest two turns: u0,a0,u1,a1) with ONE leaf summary-ref.
    store.getContextItems(CONVERSATION_ID);
    const SUMMARY_TEXT = "LEAF-SUMMARY-OF-FIRST-TWO-TURNS";
    store.appendLeafSummary({
      scope: SCOPE,
      tokenCount: 5,
      content: SUMMARY_TEXT,
      descendantCount: 4,
      earliestAt: FIXED_CREATED_AT,
      latestAt: FIXED_CREATED_AT,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: FIXED_CREATED_AT,
      startOrdinal: 0,
      endOrdinal: 3,
    });

    // The LIVE array is the full 12-message conversation. freshTailTurns=1 keeps
    // only the trailing assistant("a5") in the fresh tail, so the WHOLE summary
    // sits in the reconstructed-from-store history prefix.
    const live: AgentMessage[] = msgs as AgentMessage[];
    const { deps } = makeDeps(store);
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    // The summary content surfaces as a USER-role text message (the 130 swap
    // point — NEVER system/assistant; untrusted-by-role per T-129-14).
    const summaryMsg = out.find(
      (m) =>
        roleOf(m) === "user" &&
        (m as unknown as { content: unknown }).content !== undefined &&
        JSON.stringify((m as unknown as { content: unknown }).content).includes(SUMMARY_TEXT),
    );
    expect(summaryMsg).toBeDefined();
    expect(roleOf(summaryMsg as AgentMessage)).toBe("user");

    // Order preserved: the summary sits where the replaced range began (ordinal 0),
    // BEFORE the surviving u2/a2 turn. Project to text and assert the sequence.
    const texts = out.map((m) => {
      const c = (m as unknown as { content: unknown }).content;
      if (typeof c === "string") return c;
      const arr = c as { type: string; text?: string }[];
      return arr.find((b) => b.type === "text")?.text ?? "";
    });
    const summaryIdx = texts.findIndex((t) => t.includes(SUMMARY_TEXT));
    const u2Idx = texts.indexOf("u2");
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(u2Idx).toBeGreaterThan(summaryIdx); // summary-ref replaced the OLDEST range
    // The replaced raw messages (u0,a0,u1,a1) are GONE — replaced by the one ref.
    expect(texts).not.toContain("u0");
    expect(texts).not.toContain("a0");
    expect(texts).not.toContain("u1");
    expect(texts).not.toContain("a1");
  });

  it("Plan05 Test B: over-budget eviction drops the OLDEST evictable steps; the fresh tail is intact even when H is tiny", async () => {
    // 10 turns (20 messages). Each store message tokenCount=1 (append() default),
    // so the evictable prefix is cheap per message; we force a TINY model window
    // so the H budget allows only a couple of steps.
    const msgs = seedTextTurns(10);
    const live: AgentMessage[] = msgs as AgentMessage[];

    const logger = createMockLogger();
    // A SMALL context window: with computeTokenBudget's O+M+R reserves this
    // produces H = 0 (everything reserved) — the eviction must drop the entire
    // evictable prefix while the fresh tail STILL ships (A3 unconditional concat).
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({ reasoning: true, contextWindow: 1_000, maxTokens: 256 }),
      getSystemTokensEstimate: () => 0,
      contextStore: store,
      conversationId: CONVERSATION_ID,
      agentId: "agent_a",
      sessionKey: "sess-a",
    };
    // freshTailTurns=2 → fresh tail = last two assistant steps (a8-onward region).
    const engine = createLcdContextEngine(dagConfig(2), deps);
    const out = await engine.transformContext(live);

    const texts = out.map((m) => {
      const c = (m as unknown as { content: unknown }).content;
      if (typeof c === "string") return c;
      const arr = c as { type: string; text?: string }[];
      return arr.find((b) => b.type === "text")?.text ?? "";
    });

    // FRESH TAIL INTACT: the last freshTailTurns assistant steps are present
    // verbatim at the END even though H forced the prefix to drop. With
    // freshTailTurns=2 the fresh tail covers [a8 .. a9] region → a8 and a9 survive.
    expect(texts).toContain("a9");
    expect(texts).toContain("a8");
    expect(texts[texts.length - 1]).toBe("a9"); // the live tail rides last
    // The trailing fresh-tail objects are the LIVE objects verbatim (never evicted).
    expect(out[out.length - 1]).toBe(live[live.length - 1]);

    // OLDEST EVICTED: with H=0 the whole evictable prefix is dropped — the oldest
    // turns are gone (only the fresh tail remains).
    expect(texts).not.toContain("u0");
    expect(texts).not.toContain("a0");
    // The assembled array is no larger than the fresh-tail span (prefix fully dropped).
    expect(out.length).toBeLessThan(live.length);
  });

  it("Plan05 Test C: no-summary path still assembles 1:1 (the 128 round-trip invariant holds under context_items resolution)", async () => {
    // A plain 3-turn conversation, NO leaf pass. Lazy-seeded context_items are
    // 1:1 with messages → the assembled output must equal the 128 behavior
    // (every message present once, paired, in order) with a generous budget.
    const persisted: Message[] = [
      userMsg("u0"),
      assistantToolCall("tu_1", "read", { path: "/a" }),
      toolResult("tu_1", "read", "contents"),
      assistantText("done"),
    ];
    for (let i = 0; i < persisted.length; i++) append(store, persisted[i] as Message, i);

    const live: AgentMessage[] = persisted as AgentMessage[];
    const { deps } = makeDeps(store);
    const engine = createLcdContextEngine(dagConfig(1), deps);
    const out = await engine.transformContext(live);

    // The user message, the tool_use BLOCK with stable id tu_1, and its paired
    // top-level toolResult all survive (codec round-trip, NOT flattened).
    expect(out.some((m) => roleOf(m) === "user")).toBe(true);
    const historyAssistant = out.find(
      (m) => roleOf(m) === "assistant" && (m as unknown as { content: unknown[] }).content.some(isToolCallBlock),
    );
    expect(historyAssistant).toBeDefined();
    const tc = (historyAssistant as unknown as { content: unknown[] }).content.find(isToolCallBlock);
    expect(tc).toMatchObject({ id: "tu_1", name: "read" });
    const tr = out.find((m) => roleOf(m) === "toolResult");
    expect(tr).toBeDefined();
    expect((tr as unknown as { toolCallId: string }).toolCallId).toBe("tu_1");
    // No summary text appears anywhere (no leaf pass ran).
    const anyFallback = out.some((m) =>
      JSON.stringify((m as unknown as { content?: unknown }).content ?? "").includes("[lcd-leaf-fallback]"),
    );
    expect(anyFallback).toBe(false);
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
