// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createLcdStore — the SQLite adapter implementing ContextStorePort
 * (the LCD lossless store). Mirrors session-store.test.ts (in-memory db +
 * initSchema) and the entity-store scoping-isolation pattern.
 *
 * Drives F1 (faithful persistence of every block field) + F2 (faithful
 * reconstruction through the @comis/core codec seam) + F3 (reasoning rides as a
 * marked part, token_count survives) at the STORE level: a message appended
 * then read back through SQLite round-trips losslessly.
 */
import {
  type AppendCondensedSummaryInput,
  type AppendMessageInput,
  type AppendSummaryInput,
  type ContextStoreScope,
  type LcdMessagePart,
  messageToParts,
  partsToMessage,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { initSchema } from "./schema.js";
import { createLcdStore } from "./lcd-store.js";

const FIXED_CREATED_AT = 1000; // injected clock — no Date.now() in expectations

const SCOPE_A: ContextStoreScope = {
  conversationId: "conv-a",
  tenantId: "tenant_a",
  agentId: "agent_a",
  sessionKey: "sess-a",
};

const SCOPE_B: ContextStoreScope = {
  conversationId: "conv-b",
  tenantId: "tenant_b",
  agentId: "agent_b",
  sessionKey: "sess-b",
};

/** Build the assistant message's parts directly (DTO shape, codec-internal-independent). */
function assistantParts(): LcdMessagePart[] {
  return [
    {
      kind: "tool_use",
      toolCallId: "call_x",
      toolName: "read",
      toolInput: { path: "/a" },
      metadata: { raw: { type: "toolCall", id: "call_x", name: "read", arguments: { path: "/a" } }, rawType: "toolCall" },
    },
    {
      kind: "reasoning",
      metadata: { raw: { type: "thinking", thinking: "let me read it" }, rawType: "thinking", topLevelReasoningOnly: true },
    },
    {
      kind: "text",
      metadata: { raw: { type: "text", text: "done" }, rawType: "text" },
    },
  ];
}

/** Build a paired tool_result message's single part (DTO shape). */
function toolResultParts(isError: boolean): LcdMessagePart[] {
  return [
    {
      kind: "tool_result",
      toolCallId: "call_x",
      toolName: "read",
      toolOutput: [{ type: "text", text: "file contents" }],
      isError,
      metadata: {
        raw: {
          role: "toolResult",
          toolCallId: "call_x",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError,
          timestamp: FIXED_CREATED_AT,
        },
        rawType: "toolResult",
      },
    },
  ];
}

describe("createLcdStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON"); // production sets this via openSqliteDatabase (sqlite-adapter-base.ts:52)
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  it("append + getMessages round-trip — F1/F2 store-level: persisted fields survive SQLite", () => {
    store.append({
      scope: SCOPE_A,
      seq: 1,
      role: "assistant",
      tokenCount: 42,
      createdAt: FIXED_CREATED_AT,
      parts: assistantParts(),
    });
    store.append({
      scope: SCOPE_A,
      seq: 2,
      role: "toolResult",
      tokenCount: 7,
      createdAt: FIXED_CREATED_AT,
      parts: toolResultParts(false),
    });

    const messages = store.getMessages("conv-a");

    // Two messages, ordered by seq.
    expect(messages).toHaveLength(2);
    expect(messages[0]!.seq).toBe(1);
    expect(messages[1]!.seq).toBe(2);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[1]!.role).toBe("toolResult");

    // tokenCount survives (F3: counted agent-side, persisted verbatim).
    expect(messages[0]!.tokenCount).toBe(42);
    expect(messages[0]!.createdAt).toBe(FIXED_CREATED_AT);

    // The assistant message's tool_use part carries the persisted typed columns.
    const toolUse = messages[0]!.parts.find((p) => p.kind === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.toolCallId).toBe("call_x");
    expect(toolUse!.toolName).toBe("read");
    expect(toolUse!.toolInput).toEqual({ path: "/a" });
    // metadata.raw (the verbatim canonical block) survives.
    expect(toolUse!.metadata.raw).toEqual({ type: "toolCall", id: "call_x", name: "read", arguments: { path: "/a" } });

    // F3: the reasoning part round-trips with its marker.
    const reasoning = messages[0]!.parts.find((p) => p.kind === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning!.metadata.topLevelReasoningOnly).toBe(true);

    // The tool_result part: isError false survives the 0/1 INTEGER <-> boolean mapping.
    const toolResult = messages[1]!.parts.find((p) => p.kind === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(toolResult!.toolCallId).toBe("call_x");
  });

  it("ordering — parts come back in ordinal order; messages in seq order", () => {
    // Append seq 2 BEFORE seq 1 to prove the read orders by seq, not insert order.
    store.append({ scope: SCOPE_A, seq: 2, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: [{ kind: "text", metadata: { raw: { type: "text", text: "second" }, rawType: "text" } }] });
    store.append({ scope: SCOPE_A, seq: 1, role: "user", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });

    const messages = store.getMessages("conv-a");
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);

    // Parts of the seq-1 message preserve their build order (tool_use, reasoning, text).
    expect(messages[0]!.parts.map((p) => p.kind)).toEqual(["tool_use", "reasoning", "text"]);
  });

  it("codec seam — a real pi-ai Message round-trips append -> getMessages -> partsToMessage", () => {
    // Build parts via messageToParts (exercise the write-side codec seam), append,
    // read back, reconstruct via partsToMessage, and prove the tool id is stable.
    const assistantMsg: Message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_seam", name: "search", arguments: { q: "x" } }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
      timestamp: FIXED_CREATED_AT,
    } as unknown as Message;

    const parts = messageToParts(assistantMsg);
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 5, createdAt: FIXED_CREATED_AT, parts });

    const [reconstructedRow] = store.getMessages("conv-a");
    expect(reconstructedRow).toBeDefined();

    const reconstructed = partsToMessage(reconstructedRow!) as Extract<Message, { role: "assistant" }>;
    expect(reconstructed.role).toBe("assistant");
    // Stable id survives the SQLite round-trip (the F2 pairing invariant).
    const block = (reconstructed.content as Array<{ type: string; id?: string }>).find((b) => b.type === "toolCall");
    expect(block?.id).toBe("call_seam");
  });

  it("cascade — deleting a message removes its parts (ON DELETE CASCADE)", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });

    const msgRow = db.prepare("SELECT id FROM lcd_messages WHERE conversation_id = ?").get("conv-a") as { id: string };
    const beforeParts = (db.prepare("SELECT COUNT(*) AS c FROM lcd_message_parts WHERE message_id = ?").get(msgRow.id) as { c: number }).c;
    expect(beforeParts).toBe(3);

    // The 127 port is append + getMessages only — assert the FK cascade via raw SQL on the same db.
    db.prepare("DELETE FROM lcd_messages WHERE id = ?").run(msgRow.id);
    const afterParts = (db.prepare("SELECT COUNT(*) AS c FROM lcd_message_parts WHERE message_id = ?").get(msgRow.id) as { c: number }).c;
    expect(afterParts).toBe(0);
  });

  it("scoping/isolation — getMessages(convA) returns only convA's messages", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "user", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });
    store.append({ scope: SCOPE_B, seq: 1, role: "user", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });

    const a = store.getMessages("conv-a");
    const b = store.getMessages("conv-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.conversationId).toBe("conv-a");
    expect(b[0]!.conversationId).toBe("conv-b");

    // Empty for an unknown conversation.
    expect(store.getMessages("conv-nonexistent")).toHaveLength(0);
  });

  it("graceful degrade — corrupt metadata JSON does NOT throw on read (safeParse)", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });

    // Manually corrupt the metadata column of the text part.
    db.prepare("UPDATE lcd_message_parts SET metadata = ? WHERE kind = 'text'").run("{not valid json");

    // getMessages must NOT throw — the corrupt part degrades its raw to undefined.
    expect(() => store.getMessages("conv-a")).not.toThrow();
    const messages = store.getMessages("conv-a");
    expect(messages).toHaveLength(1);
    const text = messages[0]!.parts.find((p) => p.kind === "text");
    expect(text).toBeDefined();
    expect(text!.metadata.raw).toBeUndefined(); // degraded, not thrown.
  });

  it("isError true — a tool_result with isError:true round-trips true", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });
    store.append({ scope: SCOPE_A, seq: 2, role: "toolResult", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: toolResultParts(true) });

    const messages = store.getMessages("conv-a");
    const toolResult = messages[1]!.parts.find((p) => p.kind === "tool_result");
    expect(toolResult!.isError).toBe(true);
  });

  it("per-row degrade (WR-02) — one corrupt PART row keeps the message's good sibling parts, not []", () => {
    // An assistant message with three parts (tool_use, reasoning, text); corrupt
    // exactly ONE part row on disk so it fails schema validation. The message
    // must come back with its TWO good parts, NOT an empty body — nulling the
    // whole body would orphan a downstream tool_result (provider rejection).
    store.append({
      scope: SCOPE_A,
      seq: 1,
      role: "assistant",
      tokenCount: 1,
      createdAt: FIXED_CREATED_AT,
      parts: assistantParts(),
    });

    // Corrupt one part row: a non-numeric TEXT in the INTEGER `ordinal` column
    // (SQLite type affinity keeps it TEXT) fails the `ordinal: z.number()`
    // row-schema check — a realistic on-disk drift / corruption.
    db.prepare("UPDATE lcd_message_parts SET ordinal = ? WHERE kind = 'reasoning'").run("corrupt");

    expect(() => store.getMessages("conv-a")).not.toThrow();
    const messages = store.getMessages("conv-a");
    expect(messages).toHaveLength(1);
    // The TWO valid parts survive; only the corrupt reasoning part is skipped.
    const kinds = messages[0]!.parts.map((p) => p.kind);
    expect(kinds).toEqual(["tool_use", "text"]);
  });

  it("per-row degrade (WR-02) — one corrupt MESSAGE row keeps the conversation's good messages, not []", () => {
    // Three messages in the same conversation; corrupt ONE message row so it
    // fails validation. getMessages must return the OTHER TWO, not [] for the
    // whole conversation (total context loss on a single bad sibling row).
    store.append({ scope: SCOPE_A, seq: 1, role: "user", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: [{ kind: "text", metadata: { raw: { type: "text", text: "one" }, rawType: "text" } }] });
    store.append({ scope: SCOPE_A, seq: 2, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: [{ kind: "text", metadata: { raw: { type: "text", text: "two" }, rawType: "text" } }] });
    store.append({ scope: SCOPE_A, seq: 3, role: "user", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: [{ kind: "text", metadata: { raw: { type: "text", text: "three" }, rawType: "text" } }] });

    // Corrupt the seq-2 message row: non-numeric TEXT in the INTEGER `seq`
    // column fails `seq: z.number()`.
    db.prepare("UPDATE lcd_messages SET seq = ? WHERE seq = 2").run("corrupt");

    expect(() => store.getMessages("conv-a")).not.toThrow();
    const messages = store.getMessages("conv-a");
    // The two intact messages survive (seq 1 and 3); only the corrupt one is skipped.
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.seq)).toEqual([1, 3]);
  });

  it("DDL CHECK (IN-01) — an out-of-enum role is rejected by the lcd_messages constraint", () => {
    // Defense-in-depth: the read path casts `row.role as LcdRole` unchecked, so
    // an out-of-set on-disk role (e.g. "system") would flow through
    // partsToMessage as a non-toolResult message. A CHECK (role IN (...))
    // constraint rejects such a value at write time. The typed `append` can
    // never produce one, so we drive a raw out-of-enum INSERT directly.
    const insertBadRole = () =>
      db
        .prepare(
          "INSERT INTO lcd_messages (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m_bad", "conv-a", "tenant_a", "agent_a", "sess-a", 1, "system", 0, FIXED_CREATED_AT);
    expect(insertBadRole).toThrow(/CHECK constraint/i);

    // A valid role still inserts (the constraint is not over-broad).
    const insertGoodRole = () =>
      db
        .prepare(
          "INSERT INTO lcd_messages (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("m_ok", "conv-a", "tenant_a", "agent_a", "sess-a", 2, "assistant", 0, FIXED_CREATED_AT);
    expect(insertGoodRole).not.toThrow();
  });

  it("DDL CHECK (IN-01) — an out-of-enum part kind is rejected by the lcd_message_parts constraint", () => {
    // Seed a valid parent message so the FK is satisfiable.
    db.prepare(
      "INSERT INTO lcd_messages (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("m_parent", "conv-a", "tenant_a", "agent_a", "sess-a", 1, "assistant", 0, FIXED_CREATED_AT);

    const insertBadKind = () =>
      db
        .prepare(
          "INSERT INTO lcd_message_parts (id, message_id, ordinal, kind, metadata) VALUES (?, ?, ?, ?, ?)",
        )
        .run("p_bad", "m_parent", 0, "bogus_kind", "{}");
    expect(insertBadKind).toThrow(/CHECK constraint/i);

    // A valid kind still inserts.
    const insertGoodKind = () =>
      db
        .prepare(
          "INSERT INTO lcd_message_parts (id, message_id, ordinal, kind, metadata) VALUES (?, ?, ?, ?, ?)",
        )
        .run("p_ok", "m_parent", 1, "text", "{}");
    expect(insertGoodKind).not.toThrow();
  });

  it("AppendMessageInput type is the write-path contract", () => {
    // Compile-time anchor: append accepts the AppendMessageInput DTO.
    const input: AppendMessageInput = {
      scope: SCOPE_A,
      seq: 99,
      role: "user",
      tokenCount: 0,
      createdAt: FIXED_CREATED_AT,
      parts: [{ kind: "text", metadata: { raw: { type: "text", text: "hi" }, rawType: "text" } }],
    };
    expect(() => store.append(input)).not.toThrow();
    expect(store.getMessages("conv-a")[0]!.seq).toBe(99);
  });
});

// =====================================================================
// createLcdStore — appendLeafSummary + getContextItems (Phase 129, C3)
//
// context_items is the ordered model-facing view: lazily seeded 1:1 from
// lcd_messages on first read, then range-replaced by appendLeafSummary —
// swapping a contiguous run of message-refs for one summary-ref while keeping
// ordinals DENSE, GAP-FREE and ORDERED. lcd_messages is NEVER deleted (FK
// RESTRICT enforces losslessness; getMessages length is invariant across a
// leaf pass).
// =====================================================================

describe("createLcdStore — appendLeafSummary + getContextItems (C3)", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON"); // production sets this via openSqliteDatabase
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Append N plain user text messages (seq 0..N-1) at distinct createdAt. */
  function seedMessages(count: number, scope: ContextStoreScope = SCOPE_A): void {
    for (let i = 0; i < count; i++) {
      store.append({
        scope,
        seq: i,
        role: "user",
        tokenCount: 1,
        // distinct createdAt per message so earliest/latest are meaningful.
        createdAt: 1000 + i * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${i}` }, rawType: "text" } }],
      });
    }
  }

  /** The message ids of a conversation, in seq order. */
  function messageIdsInSeqOrder(conversationId: string): string[] {
    return store.getMessages(conversationId).map((m) => m.id);
  }

  /** A minimal valid AppendSummaryInput over [start,end]. */
  function summaryInput(
    startOrdinal: number,
    endOrdinal: number,
    overrides: Partial<AppendSummaryInput> = {},
  ): AppendSummaryInput {
    return {
      scope: SCOPE_A,
      tokenCount: 5,
      content: "leaf summary text",
      descendantCount: 0, // the store recomputes from the covered refs
      earliestAt: 0,
      latestAt: 0,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9999,
      startOrdinal,
      endOrdinal,
      ...overrides,
    };
  }

  it("getContextItems lazily seeds 1:1 from lcd_messages on first read (ordinal 0..N-1, message-refs in seq order)", () => {
    seedMessages(3);
    const ids = messageIdsInSeqOrder("conv-a");

    const items = store.getContextItems("conv-a");

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items.every((i) => i.refKind === "message")).toBe(true);
    // Each ref points at the corresponding message id, in seq order.
    expect(items.map((i) => i.refId)).toEqual(ids);
  });

  it("getContextItems is stable across calls — a second read returns the same seeded view, not a re-seed/duplication", () => {
    seedMessages(2);
    const first = store.getContextItems("conv-a");
    const second = store.getContextItems("conv-a");

    expect(second).toHaveLength(2);
    expect(second.map((i) => i.refId)).toEqual(first.map((i) => i.refId));
    // No duplicate context_items rows were written by the second read.
    const rowCount = (
      db.prepare("SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ?").get("conv-a") as {
        c: number;
      }
    ).c;
    expect(rowCount).toBe(2);
  });

  it("getContextItems returns [] for a conversation with no messages (nothing to seed)", () => {
    expect(store.getContextItems("conv-empty")).toHaveLength(0);
  });

  it("appendLeafSummary range-replaces [start,end] with ONE summary-ref; ordinals stay dense, gap-free and ordered", () => {
    seedMessages(5); // ordinals 0..4, all message-refs
    store.getContextItems("conv-a"); // seed

    // Replace the middle run [1,3] (m1,m2,m3) with one summary.
    const summaryId = store.appendLeafSummary(summaryInput(1, 3));

    const items = store.getContextItems("conv-a");
    // 5 messages → 3 collapsed into 1 summary → 3 items remain (m0, SUMMARY, m4).
    expect(items).toHaveLength(3);
    // Ordinals are dense + gap-free + ordered: 0,1,2.
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    // Item shape: [message m0] [summary] [message m4].
    expect(items[0]!.refKind).toBe("message");
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(summaryId);
    expect(items[2]!.refKind).toBe("message");
  });

  it("appendLeafSummary recomputes descendantCount = covered message count and earliest/latest = min/max covered createdAt", () => {
    seedMessages(5); // createdAt: 1000,1010,1020,1030,1040 for m0..m4
    store.getContextItems("conv-a");

    const summaryId = store.appendLeafSummary(summaryInput(1, 3)); // covers m1,m2,m3

    const row = db
      .prepare(
        "SELECT descendant_count, earliest_at, latest_at FROM lcd_summaries WHERE summary_id = ?",
      )
      .get(summaryId) as { descendant_count: number; earliest_at: number; latest_at: number };

    // 3 messages covered.
    expect(row.descendant_count).toBe(3);
    // Time-range = min/max covered createdAt (m1=1010 .. m3=1030).
    expect(row.earliest_at).toBe(1010);
    expect(row.latest_at).toBe(1030);
  });

  it("appendLeafSummary persists the lcd_summaries row (content/tokenCount/fileIds/taint/fallback) + the per-covered-message links in ONE go", () => {
    seedMessages(4);
    store.getContextItems("conv-a");
    const idsBefore = messageIdsInSeqOrder("conv-a");

    const summaryId = store.appendLeafSummary(
      summaryInput(0, 2, {
        content: "the leaf content",
        tokenCount: 77,
        fileIds: ["file-1", "file-2"],
        taint: true,
        fallback: true,
      }),
    );

    const summaryRow = db
      .prepare(
        "SELECT kind, depth, token_count, content, file_ids, taint, fallback FROM lcd_summaries WHERE summary_id = ?",
      )
      .get(summaryId) as {
      kind: string;
      depth: number;
      token_count: number;
      content: string;
      file_ids: string;
      taint: number;
      fallback: number;
    };
    expect(summaryRow.kind).toBe("leaf");
    expect(summaryRow.depth).toBe(0);
    expect(summaryRow.token_count).toBe(77);
    expect(summaryRow.content).toBe("the leaf content");
    expect(JSON.parse(summaryRow.file_ids)).toEqual(["file-1", "file-2"]);
    expect(summaryRow.taint).toBe(1);
    expect(summaryRow.fallback).toBe(1);

    // One link row per covered message id (m0,m1,m2 = the first three).
    const linkedIds = (
      db
        .prepare("SELECT message_id FROM lcd_summary_messages WHERE summary_id = ? ORDER BY message_id")
        .all(summaryId) as Array<{ message_id: string }>
    ).map((r) => r.message_id);
    expect(linkedIds.sort()).toEqual([idsBefore[0]!, idsBefore[1]!, idsBefore[2]!].sort());
  });

  it("getSummaries returns the persisted leaf summary as the LcdSummary DTO (content/tokenCount/fileIds/taint/fallback/kind/depth) — the assembler's summary-ref resolution source", () => {
    seedMessages(4); // createdAt 1000,1010,1020,1030
    store.getContextItems("conv-a");

    const summaryId = store.appendLeafSummary(
      summaryInput(0, 2, {
        content: "the resolvable leaf content",
        tokenCount: 77,
        fileIds: ["file-1", "file-2"],
        taint: true,
        fallback: true,
        createdAt: 4242,
      }),
    );

    const summaries = store.getSummaries("conv-a");
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    // The full DTO the assembler keys by summaryId to resolve a summary-ref into
    // a user-role text message + its token authority (Pitfall 2).
    expect(s.summaryId).toBe(summaryId);
    expect(s.conversationId).toBe("conv-a");
    expect(s.kind).toBe("leaf");
    expect(s.depth).toBe(0);
    expect(s.content).toBe("the resolvable leaf content");
    expect(s.tokenCount).toBe(77); // the budget authority for the summary-ref
    expect(s.fileIds).toEqual(["file-1", "file-2"]);
    expect(s.taint).toBe(true);
    expect(s.fallback).toBe(true);
    expect(s.descendantCount).toBe(3); // recomputed from the covered run (m0,m1,m2)
    expect(s.earliestAt).toBe(1000); // min covered createdAt
    expect(s.latestAt).toBe(1020); // max covered createdAt
    expect(s.createdAt).toBe(4242);
  });

  it("getSummaries returns [] for a conversation with no summaries, and is scoped per conversation", () => {
    seedMessages(3); // messages but NO leaf pass
    expect(store.getSummaries("conv-a")).toHaveLength(0);

    // A leaf pass on conv-a must not leak into a sibling conversation's read.
    store.getContextItems("conv-a");
    store.appendLeafSummary(summaryInput(0, 1));
    expect(store.getSummaries("conv-a")).toHaveLength(1);
    expect(store.getSummaries("conv-b")).toHaveLength(0);
  });

  it("appendLeafSummary NEVER deletes lcd_messages — getMessages length is unchanged after a leaf pass (losslessness)", () => {
    seedMessages(5);
    store.getContextItems("conv-a");
    expect(store.getMessages("conv-a")).toHaveLength(5);

    store.appendLeafSummary(summaryInput(1, 3));

    // The underlying messages are all still present (FK RESTRICT + no DELETE).
    expect(store.getMessages("conv-a")).toHaveLength(5);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM lcd_messages WHERE conversation_id = 'conv-a'").get() as {
        c: number;
      }).c,
    ).toBe(5);
  });

  it("appendLeafSummary auto-seeds context_items if the conversation has not been read yet (range-replace works without an explicit getContextItems)", () => {
    seedMessages(4); // never call getContextItems first

    const summaryId = store.appendLeafSummary(summaryInput(0, 1));

    const items = store.getContextItems("conv-a");
    // 4 messages → [0,1] collapsed → 3 items (SUMMARY, m2, m3).
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(summaryId);
  });

  it("successive leaf passes — a second appendLeafSummary over the now-shorter range range-replaces correctly", () => {
    seedMessages(6); // ordinals 0..5
    store.getContextItems("conv-a");

    // First pass: collapse [0,1] → now items: [S0, m2, m3, m4, m5] (5 items, ordinals 0..4).
    const s0 = store.appendLeafSummary(summaryInput(0, 1));
    let items = store.getContextItems("conv-a");
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2, 3, 4]);

    // Second pass over the now-shorter view: collapse [2,4] (m3,m4,m5) → [S0, m2, S1] (3 items).
    const s1 = store.appendLeafSummary(summaryInput(2, 4));
    items = store.getContextItems("conv-a");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(s0);
    expect(items[1]!.refKind).toBe("message");
    expect(items[2]!.refKind).toBe("summary");
    expect(items[2]!.refId).toBe(s1);

    // The second summary covers exactly the 3 messages it range-replaced.
    expect(
      (db.prepare("SELECT descendant_count FROM lcd_summaries WHERE summary_id = ?").get(s1) as {
        descendant_count: number;
      }).descendant_count,
    ).toBe(3);
  });

  it("appendLeafSummary collapsing a single-message range [k,k] replaces exactly that one ref (boundary)", () => {
    seedMessages(3);
    store.getContextItems("conv-a");

    const summaryId = store.appendLeafSummary(summaryInput(1, 1)); // just m1

    const items = store.getContextItems("conv-a");
    expect(items).toHaveLength(3); // 3 messages → m1 swapped for a summary → still 3 items
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(summaryId);
    expect(
      (db.prepare("SELECT descendant_count FROM lcd_summaries WHERE summary_id = ?").get(summaryId) as {
        descendant_count: number;
      }).descendant_count,
    ).toBe(1);
  });

  it("appendLeafSummary returns a non-empty summaryId that matches the persisted lcd_summaries row", () => {
    seedMessages(2);
    store.getContextItems("conv-a");

    const summaryId = store.appendLeafSummary(summaryInput(0, 0));
    expect(summaryId).toBeTruthy();
    expect(typeof summaryId).toBe("string");

    const row = db
      .prepare("SELECT summary_id FROM lcd_summaries WHERE summary_id = ?")
      .get(summaryId) as { summary_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.summary_id).toBe(summaryId);
  });

  it("getContextItems degrades per-row (WR-02) — a corrupt context_items row is skipped, its siblings survive and never throw", () => {
    seedMessages(3);
    store.getContextItems("conv-a"); // seed 3 message-refs (ordinals 0,1,2)

    // Corrupt ONE context_items row on disk: a non-numeric TEXT in the INTEGER
    // `ordinal` column fails the `ordinal: z.number()` row-schema check (a
    // realistic on-disk drift). The read must NOT throw and must keep the other two.
    db.prepare("UPDATE lcd_context_items SET ordinal = ? WHERE ordinal = 1").run("corrupt");

    expect(() => store.getContextItems("conv-a")).not.toThrow();
    const items = store.getContextItems("conv-a");
    // The corrupt middle row is skipped; the two valid siblings survive (not []).
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.ordinal)).toEqual([0, 2]);
  });

  it("scoping/isolation — getContextItems(convA) seeds + returns only convA's items", () => {
    seedMessages(2, SCOPE_A);
    seedMessages(3, SCOPE_B);

    const a = store.getContextItems("conv-a");
    const b = store.getContextItems("conv-b");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);

    // A leaf pass on conv-a does not touch conv-b's view.
    store.appendLeafSummary(summaryInput(0, 1, { scope: SCOPE_A }));
    expect(store.getContextItems("conv-a")).toHaveLength(1);
    expect(store.getContextItems("conv-b")).toHaveLength(3);
  });

  it("AppendSummaryInput type is the compaction write-path contract", () => {
    seedMessages(2);
    store.getContextItems("conv-a");
    const input: AppendSummaryInput = summaryInput(0, 0);
    expect(() => store.appendLeafSummary(input)).not.toThrow();
  });
});

// =====================================================================
// createLcdStore — appendCondensedSummary (Phase 130, C2 condensed tier)
//
// The depth>0 condensation tier: a CONDENSED summary links its CHILD
// SUMMARIES (via lcd_summary_parents, NOT lcd_summary_messages) and
// range-replaces the contiguous run of SUMMARY-refs it covers with one
// condensed summary-ref — keeping ordinals dense, gap-free and ordered. The
// store recomputes descendantCount = Σ child.descendantCount and the
// time-range = min/max of the children (the store is the authority); the
// agent supplies depth/taint/fallback/tokenCount/content. The green 129
// appendLeafSummary leaf path is unchanged (Test D).
// =====================================================================

describe("createLcdStore — appendCondensedSummary (C2 condensed tier)", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON"); // production sets this via openSqliteDatabase
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Append N plain user text messages (seq 0..N-1) at distinct createdAt. */
  function seedMessages(count: number, scope: ContextStoreScope = SCOPE_A): void {
    for (let i = 0; i < count; i++) {
      store.append({
        scope,
        seq: i,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + i * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${i}` }, rawType: "text" } }],
      });
    }
  }

  /** A minimal valid AppendSummaryInput (leaf) over [start,end]. */
  function leafInput(
    startOrdinal: number,
    endOrdinal: number,
    overrides: Partial<AppendSummaryInput> = {},
  ): AppendSummaryInput {
    return {
      scope: SCOPE_A,
      tokenCount: 5,
      content: "leaf summary text",
      descendantCount: 0,
      earliestAt: 0,
      latestAt: 0,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9999,
      startOrdinal,
      endOrdinal,
      ...overrides,
    };
  }

  /** A minimal valid AppendCondensedSummaryInput over [start,end] linking childSummaryIds. */
  function condensedInput(
    childSummaryIds: string[],
    startOrdinal: number,
    endOrdinal: number,
    overrides: Partial<AppendCondensedSummaryInput> = {},
  ): AppendCondensedSummaryInput {
    return {
      scope: SCOPE_A,
      tokenCount: 9,
      content: "condensed summary text",
      descendantCount: 0, // advisory — the store recomputes from the children
      earliestAt: 0, // advisory
      latestAt: 0, // advisory
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 5555,
      startOrdinal,
      endOrdinal,
      childSummaryIds,
      depth: 1,
      ...overrides,
    };
  }

  /**
   * Seed two CONTIGUOUS depth-0 leaf summary-refs at ordinals [0,1] by
   * appending two leaf summaries over disjoint message runs. After this the
   * context_items view is [summary(leaf0, ord0), summary(leaf1, ord1)]. Returns
   * the two leaf summaryIds.
   */
  function seedTwoContiguousLeaves(): { leaf0: string; leaf1: string } {
    seedMessages(4); // m0..m3, createdAt 1000,1010,1020,1030 → ordinals 0..3
    store.getContextItems("conv-a"); // seed the view
    // Collapse [0,1] (m0,m1) → leaf0 at ord 0; view now [leaf0, m2, m3].
    const leaf0 = store.appendLeafSummary(leafInput(0, 1));
    // Collapse [1,2] (m2,m3) → leaf1 at ord 1; view now [leaf0, leaf1].
    const leaf1 = store.appendLeafSummary(leafInput(1, 2));
    return { leaf0, leaf1 };
  }

  // ── Test A: condensed round-trip through getSummaries + context_items ──
  it("appendCondensedSummary persists a depth-1 condensed summary that round-trips through getSummaries with recomputed descendantCount + time-range", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();

    // The two contiguous leaf summary-refs occupy ordinals [0,1].
    const itemsBefore = store.getContextItems("conv-a");
    expect(itemsBefore).toHaveLength(2);
    expect(itemsBefore.every((i) => i.refKind === "summary")).toBe(true);

    // Read the children so we can assert the store's recompute.
    const before = store.getSummaries("conv-a");
    const child0 = before.find((s) => s.summaryId === leaf0)!;
    const child1 = before.find((s) => s.summaryId === leaf1)!;

    const condensedId = store.appendCondensedSummary(
      condensedInput([leaf0, leaf1], 0, 1, { depth: 1 }),
    );

    // The condensed summary round-trips through getSummaries with kind/depth.
    const after = store.getSummaries("conv-a");
    const condensed = after.find((s) => s.summaryId === condensedId);
    expect(condensed).toBeDefined();
    expect(condensed!.kind).toBe("condensed");
    expect(condensed!.depth).toBe(1);
    // descendantCount = Σ child.descendantCount (store recomputes, advisory input ignored).
    expect(condensed!.descendantCount).toBe(child0.descendantCount + child1.descendantCount);
    // time-range = min/max of the children (store recomputes).
    expect(condensed!.earliestAt).toBe(Math.min(child0.earliestAt, child1.earliestAt));
    expect(condensed!.latestAt).toBe(Math.max(child0.latestAt, child1.latestAt));
    // agent-supplied fields persisted verbatim.
    expect(condensed!.tokenCount).toBe(9);
    expect(condensed!.content).toBe("condensed summary text");

    // context_items: the two summary-refs are replaced by ONE condensed
    // summary-ref at startOrdinal; ordinals stay dense/gap-free.
    const items = store.getContextItems("conv-a");
    expect(items).toHaveLength(1);
    expect(items[0]!.ordinal).toBe(0);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(condensedId);
  });

  // ── Test B: lcd_summary_parents links exactly the two child ids ──
  it("appendCondensedSummary links the condensed summary to each child via lcd_summary_parents (exactly the child ids, not messages)", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();

    const condensedId = store.appendCondensedSummary(
      condensedInput([leaf0, leaf1], 0, 1),
    );

    const linkedChildIds = (
      db
        .prepare(
          "SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ? ORDER BY child_summary_id",
        )
        .all(condensedId) as Array<{ child_summary_id: string }>
    ).map((r) => r.child_summary_id);
    expect(linkedChildIds.sort()).toEqual([leaf0, leaf1].sort());

    // The condensed summary linked NO messages (it links children, not messages).
    const linkedMessageRows = db
      .prepare("SELECT COUNT(*) AS c FROM lcd_summary_messages WHERE summary_id = ?")
      .get(condensedId) as { c: number };
    expect(linkedMessageRows.c).toBe(0);
  });

  // ── Test C: the widened kind CHECK + z.string() row schema accept condensed ──
  it("a persisted condensed row is readable through getSummaries — the widened kind CHECK + row schema accept kind='condensed'", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();

    const condensedId = store.appendCondensedSummary(
      condensedInput([leaf0, leaf1], 0, 1),
    );

    // Reading back through getSummaries proves the widened CHECK accepted the
    // insert AND the z.string() row schema parses kind='condensed' (no drift).
    const condensed = store.getSummaries("conv-a").find((s) => s.summaryId === condensedId);
    expect(condensed).toBeDefined();
    expect(condensed!.kind).toBe("condensed");

    // The raw row carries kind='condensed' on disk.
    const rawKind = db
      .prepare("SELECT kind FROM lcd_summaries WHERE summary_id = ?")
      .get(condensedId) as { kind: string };
    expect(rawKind.kind).toBe("condensed");
  });

  // ── Test D: no regression — the leaf path is unchanged ──
  it("appendLeafSummary still produces a kind='leaf' depth-0 row under the widened union (no regression)", () => {
    seedMessages(3);
    store.getContextItems("conv-a");

    const leafId = store.appendLeafSummary(leafInput(0, 1));

    const leaf = store.getSummaries("conv-a").find((s) => s.summaryId === leafId);
    expect(leaf).toBeDefined();
    expect(leaf!.kind).toBe("leaf");
    expect(leaf!.depth).toBe(0);
  });

  // ── Boundary: a condensed summary is itself a `summary`-ref (single-child run) ──
  it("appendCondensedSummary collapsing a single-summary range [k,k] replaces exactly that one summary-ref", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves(); // view [leaf0, leaf1] at ord 0,1

    // Condense just leaf1 at ordinal 1.
    const condensedId = store.appendCondensedSummary(
      condensedInput([leaf1], 1, 1, { depth: 1 }),
    );

    const items = store.getContextItems("conv-a");
    expect(items).toHaveLength(2); // [leaf0, condensed]
    expect(items.map((i) => i.ordinal)).toEqual([0, 1]);
    expect(items[0]!.refId).toBe(leaf0);
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(condensedId);
  });

  // ── Losslessness: a condensed pass NEVER deletes the child summary rows ──
  it("appendCondensedSummary NEVER deletes the child lcd_summaries rows — the children survive (losslessness ledger)", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();
    expect(store.getSummaries("conv-a")).toHaveLength(2);

    store.appendCondensedSummary(condensedInput([leaf0, leaf1], 0, 1));

    // Both children + the new condensed summary are all present (3 total).
    const summaries = store.getSummaries("conv-a");
    expect(summaries).toHaveLength(3);
    expect(summaries.some((s) => s.summaryId === leaf0)).toBe(true);
    expect(summaries.some((s) => s.summaryId === leaf1)).toBe(true);
  });

  it("AppendCondensedSummaryInput type is the C2 condensation write-path contract", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();
    const input: AppendCondensedSummaryInput = condensedInput([leaf0, leaf1], 0, 1);
    expect(() => store.appendCondensedSummary(input)).not.toThrow();
  });
});
