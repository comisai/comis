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
import { ensureLcdTables } from "./schema-lcd.js";
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

// ── WR-02 (R4) cross-agent fixtures: the REAL shared-(tenant,user,channel) case ──
// `formatSessionKey` omits agentId, so two agents legitimately share ONE
// conversation_id + tenantId + sessionKey, distinguished ONLY by agentId. Reads
// must filter on agent_id (and tenant_id) so agent A can never recover agent B's
// compressed history. Same conv/tenant/session, DIFFERENT agentId.
const SHARED_CONV = "conv-shared";
const SHARED_TENANT = "tenant_shared";
const SHARED_SESSION = "sess-shared";

const SCOPE_AGENT_A: ContextStoreScope = {
  conversationId: SHARED_CONV,
  tenantId: SHARED_TENANT,
  agentId: "agent-a",
  sessionKey: SHARED_SESSION,
};

const SCOPE_AGENT_B: ContextStoreScope = {
  conversationId: SHARED_CONV,
  tenantId: SHARED_TENANT,
  agentId: "agent-b",
  sessionKey: SHARED_SESSION,
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

    const messages = store.getMessages(SCOPE_A);

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

    const messages = store.getMessages(SCOPE_A);
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

    const [reconstructedRow] = store.getMessages(SCOPE_A);
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

    const a = store.getMessages(SCOPE_A);
    const b = store.getMessages(SCOPE_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.conversationId).toBe("conv-a");
    expect(b[0]!.conversationId).toBe("conv-b");

    // Empty for an unknown conversation.
    expect(store.getMessages({ ...SCOPE_A, conversationId: "conv-nonexistent" })).toHaveLength(0);
  });

  it("graceful degrade — corrupt metadata JSON does NOT throw on read (safeParse)", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });

    // Manually corrupt the metadata column of the text part.
    db.prepare("UPDATE lcd_message_parts SET metadata = ? WHERE kind = 'text'").run("{not valid json");

    // getMessages must NOT throw — the corrupt part degrades its raw to undefined.
    expect(() => store.getMessages(SCOPE_A)).not.toThrow();
    const messages = store.getMessages(SCOPE_A);
    expect(messages).toHaveLength(1);
    const text = messages[0]!.parts.find((p) => p.kind === "text");
    expect(text).toBeDefined();
    expect(text!.metadata.raw).toBeUndefined(); // degraded, not thrown.
  });

  it("isError true — a tool_result with isError:true round-trips true", () => {
    store.append({ scope: SCOPE_A, seq: 1, role: "assistant", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: assistantParts() });
    store.append({ scope: SCOPE_A, seq: 2, role: "toolResult", tokenCount: 1, createdAt: FIXED_CREATED_AT, parts: toolResultParts(true) });

    const messages = store.getMessages(SCOPE_A);
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

    expect(() => store.getMessages(SCOPE_A)).not.toThrow();
    const messages = store.getMessages(SCOPE_A);
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

    expect(() => store.getMessages(SCOPE_A)).not.toThrow();
    const messages = store.getMessages(SCOPE_A);
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
    expect(store.getMessages(SCOPE_A)[0]!.seq).toBe(99);
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

  /** The message ids of a scope, in seq order. */
  function messageIdsInSeqOrder(scope: ContextStoreScope): string[] {
    return store.getMessages(scope).map((m) => m.id);
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
    const ids = messageIdsInSeqOrder(SCOPE_A);

    const items = store.getContextItems(SCOPE_A);

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items.every((i) => i.refKind === "message")).toBe(true);
    // Each ref points at the corresponding message id, in seq order.
    expect(items.map((i) => i.refId)).toEqual(ids);
  });

  it("getContextItems is stable across calls — a second read returns the same seeded view, not a re-seed/duplication", () => {
    seedMessages(2);
    const first = store.getContextItems(SCOPE_A);
    const second = store.getContextItems(SCOPE_A);

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
    expect(store.getContextItems({ ...SCOPE_A, conversationId: "conv-empty" })).toHaveLength(0);
  });

  it("appendLeafSummary range-replaces [start,end] with ONE summary-ref; ordinals stay dense, gap-free and ordered", () => {
    seedMessages(5); // ordinals 0..4, all message-refs
    store.getContextItems(SCOPE_A); // seed

    // Replace the middle run [1,3] (m1,m2,m3) with one summary.
    const summaryId = store.appendLeafSummary(summaryInput(1, 3));

    const items = store.getContextItems(SCOPE_A);
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
    store.getContextItems(SCOPE_A);

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
    store.getContextItems(SCOPE_A);
    const idsBefore = messageIdsInSeqOrder(SCOPE_A);

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
    store.getContextItems(SCOPE_A);

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

    const summaries = store.getSummaries(SCOPE_A);
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
    expect(store.getSummaries(SCOPE_A)).toHaveLength(0);

    // A leaf pass on conv-a must not leak into a sibling conversation's read.
    store.getContextItems(SCOPE_A);
    store.appendLeafSummary(summaryInput(0, 1));
    expect(store.getSummaries(SCOPE_A)).toHaveLength(1);
    expect(store.getSummaries(SCOPE_B)).toHaveLength(0);
  });

  it("appendLeafSummary NEVER deletes lcd_messages — getMessages length is unchanged after a leaf pass (losslessness)", () => {
    seedMessages(5);
    store.getContextItems(SCOPE_A);
    expect(store.getMessages(SCOPE_A)).toHaveLength(5);

    store.appendLeafSummary(summaryInput(1, 3));

    // The underlying messages are all still present (FK RESTRICT + no DELETE).
    expect(store.getMessages(SCOPE_A)).toHaveLength(5);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM lcd_messages WHERE conversation_id = 'conv-a'").get() as {
        c: number;
      }).c,
    ).toBe(5);
  });

  it("appendLeafSummary auto-seeds context_items if the conversation has not been read yet (range-replace works without an explicit getContextItems)", () => {
    seedMessages(4); // never call getContextItems first

    const summaryId = store.appendLeafSummary(summaryInput(0, 1));

    const items = store.getContextItems(SCOPE_A);
    // 4 messages → [0,1] collapsed → 3 items (SUMMARY, m2, m3).
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    expect(items[0]!.refKind).toBe("summary");
    expect(items[0]!.refId).toBe(summaryId);
  });

  it("successive leaf passes — a second appendLeafSummary over the now-shorter range range-replaces correctly", () => {
    seedMessages(6); // ordinals 0..5
    store.getContextItems(SCOPE_A);

    // First pass: collapse [0,1] → now items: [S0, m2, m3, m4, m5] (5 items, ordinals 0..4).
    const s0 = store.appendLeafSummary(summaryInput(0, 1));
    let items = store.getContextItems(SCOPE_A);
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2, 3, 4]);

    // Second pass over the now-shorter view: collapse [2,4] (m3,m4,m5) → [S0, m2, S1] (3 items).
    const s1 = store.appendLeafSummary(summaryInput(2, 4));
    items = store.getContextItems(SCOPE_A);
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
    store.getContextItems(SCOPE_A);

    const summaryId = store.appendLeafSummary(summaryInput(1, 1)); // just m1

    const items = store.getContextItems(SCOPE_A);
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
    store.getContextItems(SCOPE_A);

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
    store.getContextItems(SCOPE_A); // seed 3 message-refs (ordinals 0,1,2)

    // Corrupt ONE context_items row on disk: a non-numeric TEXT in the INTEGER
    // `ordinal` column fails the `ordinal: z.number()` row-schema check (a
    // realistic on-disk drift). The read must NOT throw and must keep the other two.
    db.prepare("UPDATE lcd_context_items SET ordinal = ? WHERE ordinal = 1").run("corrupt");

    expect(() => store.getContextItems(SCOPE_A)).not.toThrow();
    const items = store.getContextItems(SCOPE_A);
    // The corrupt middle row is skipped; the two valid siblings survive (not []).
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.ordinal)).toEqual([0, 2]);
  });

  it("scoping/isolation — getContextItems(convA) seeds + returns only convA's items", () => {
    seedMessages(2, SCOPE_A);
    seedMessages(3, SCOPE_B);

    const a = store.getContextItems(SCOPE_A);
    const b = store.getContextItems(SCOPE_B);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);

    // A leaf pass on conv-a does not touch conv-b's view.
    store.appendLeafSummary(summaryInput(0, 1, { scope: SCOPE_A }));
    expect(store.getContextItems(SCOPE_A)).toHaveLength(1);
    expect(store.getContextItems(SCOPE_B)).toHaveLength(3);
  });

  it("AppendSummaryInput type is the compaction write-path contract", () => {
    seedMessages(2);
    store.getContextItems(SCOPE_A);
    const input: AppendSummaryInput = summaryInput(0, 0);
    expect(() => store.appendLeafSummary(input)).not.toThrow();
  });

  // ── DAG-CRIT-2 (260605-m82): the resolved view must TRACK appends, not just
  //    capture the first-read seed. Production interleaves reads and appends —
  //    the seed-once guard froze context_items at the first read while
  //    lcd_messages kept growing, so the trigger's utilization stayed pinned and
  //    the assembler read a stale partial history. The fix maintains the dense
  //    view incrementally inside appendTxn.
  it("INVARIANT (CRIT-2): getContextItems tracks appends — interleaved reads between appends keep context_items dense 1:1 with lcd_messages", () => {
    // Append one message at a time, reading getContextItems BETWEEN each append
    // (the exact production interleave the in-memory stubs never reproduced). The
    // first interleaved read used to seed only message 0; every later append then
    // left the view frozen at length 1.
    for (let seq = 0; seq < 4; seq++) {
      store.append({
        scope: SCOPE_A,
        seq,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + seq * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${seq}` }, rawType: "text" } }],
      });

      const items = store.getContextItems(SCOPE_A);
      const messageIds = messageIdsInSeqOrder(SCOPE_A); // the authority for the expected count
      const expectedCount = messageIds.length; // == seq + 1

      // After EVERY append the view length equals the live message count.
      expect(items).toHaveLength(expectedCount);
      // Ordinals are exactly 0..N-1 — dense, gap-free, ascending.
      expect(items.map((i) => i.ordinal)).toEqual([...Array(expectedCount).keys()]);
      // Every ref is a message-ref (no summaries yet).
      expect(items.every((i) => i.refKind === "message")).toBe(true);
      // refIds equal the message ids in seq order.
      expect(items.map((i) => i.refId)).toEqual(messageIds);
    }
  });

  it("CRIT-2: summary range-replace still works AFTER per-append seeding (no double-seed, delete/shift intact)", () => {
    // Append 5 messages, interleaving a read so the (now no-op) seed path is
    // exercised on an already-maintained view, then collapse [1,3].
    for (let seq = 0; seq < 5; seq++) {
      store.append({
        scope: SCOPE_A,
        seq,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + seq * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${seq}` }, rawType: "text" } }],
      });
      store.getContextItems(SCOPE_A); // interleaved read exercises the incremental backfill (no-op once maintained)
    }
    // Five message-refs maintained by append (ordinals 0..4).
    expect(store.getContextItems(SCOPE_A)).toHaveLength(5);

    const summaryId = store.appendLeafSummary(summaryInput(1, 3));

    const items = store.getContextItems(SCOPE_A);
    // 5 messages → 3 collapsed into 1 summary → 3 items remain.
    expect(items).toHaveLength(3);
    // Dense, gap-free, ordered: 0,1,2.
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    // Shape: [message m0] [summary] [message m4].
    expect(items[0]!.refKind).toBe("message");
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(summaryId);
    expect(items[2]!.refKind).toBe("message");
    // No duplicate context_items rows from a double-seed: total rows == 3.
    const rowCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
        )
        .get(SCOPE_A.conversationId, SCOPE_A.agentId, SCOPE_A.tenantId) as { c: number }
    ).c;
    expect(rowCount).toBe(3);
  });

  it("CRIT-2: incremental backfill seeds a LEGACY conversation (lcd_messages with zero context_items) dense 0..N-1 on first read", () => {
    // Simulate a PRE-EXISTING conversation whose messages predate the per-append
    // context_items insert: write lcd_messages rows DIRECTLY (bypassing append),
    // so the model-facing view starts empty. This is the only path that does real
    // work in seedContextItems now — the live append-maintained path is a no-op.
    const insertLegacyMsg = db.prepare(
      "INSERT INTO lcd_messages (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const legacyIds = ["legacy-0", "legacy-1", "legacy-2"];
    legacyIds.forEach((id, seq) => {
      insertLegacyMsg.run(id, SCOPE_A.conversationId, SCOPE_A.tenantId, SCOPE_A.agentId, SCOPE_A.sessionKey, seq, "user", 1, 1000 + seq * 10);
    });
    // No context_items exist yet for this scope.
    const before = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
        )
        .get(SCOPE_A.conversationId, SCOPE_A.agentId, SCOPE_A.tenantId) as { c: number }
    ).c;
    expect(before).toBe(0);

    // First read triggers the incremental backfill (the seed gate fires on count 0).
    const items = store.getContextItems(SCOPE_A);

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]); // dense, gap-free
    expect(items.every((i) => i.refKind === "message")).toBe(true);
    expect(items.map((i) => i.refId)).toEqual(legacyIds); // seq-ordered message-refs

    // Idempotent: a second read seeds nothing new (no duplication).
    const second = store.getContextItems(SCOPE_A);
    expect(second.map((i) => i.refId)).toEqual(legacyIds);
    const after = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM lcd_context_items WHERE conversation_id = ? AND agent_id = ? AND tenant_id = ?",
        )
        .get(SCOPE_A.conversationId, SCOPE_A.agentId, SCOPE_A.tenantId) as { c: number }
    ).c;
    expect(after).toBe(3);
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
    store.getContextItems(SCOPE_A); // seed the view
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
    const itemsBefore = store.getContextItems(SCOPE_A);
    expect(itemsBefore).toHaveLength(2);
    expect(itemsBefore.every((i) => i.refKind === "summary")).toBe(true);

    // Read the children so we can assert the store's recompute.
    const before = store.getSummaries(SCOPE_A);
    const child0 = before.find((s) => s.summaryId === leaf0)!;
    const child1 = before.find((s) => s.summaryId === leaf1)!;

    const condensedId = store.appendCondensedSummary(
      condensedInput([leaf0, leaf1], 0, 1, { depth: 1 }),
    );

    // The condensed summary round-trips through getSummaries with kind/depth.
    const after = store.getSummaries(SCOPE_A);
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
    const items = store.getContextItems(SCOPE_A);
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
    const condensed = store.getSummaries(SCOPE_A).find((s) => s.summaryId === condensedId);
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
    store.getContextItems(SCOPE_A);

    const leafId = store.appendLeafSummary(leafInput(0, 1));

    const leaf = store.getSummaries(SCOPE_A).find((s) => s.summaryId === leafId);
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

    const items = store.getContextItems(SCOPE_A);
    expect(items).toHaveLength(2); // [leaf0, condensed]
    expect(items.map((i) => i.ordinal)).toEqual([0, 1]);
    expect(items[0]!.refId).toBe(leaf0);
    expect(items[1]!.refKind).toBe("summary");
    expect(items[1]!.refId).toBe(condensedId);
  });

  // ── Losslessness: a condensed pass NEVER deletes the child summary rows ──
  it("appendCondensedSummary NEVER deletes the child lcd_summaries rows — the children survive (losslessness ledger)", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();
    expect(store.getSummaries(SCOPE_A)).toHaveLength(2);

    store.appendCondensedSummary(condensedInput([leaf0, leaf1], 0, 1));

    // Both children + the new condensed summary are all present (3 total).
    const summaries = store.getSummaries(SCOPE_A);
    expect(summaries).toHaveLength(3);
    expect(summaries.some((s) => s.summaryId === leaf0)).toBe(true);
    expect(summaries.some((s) => s.summaryId === leaf1)).toBe(true);
  });

  it("AppendCondensedSummaryInput type is the C2 condensation write-path contract", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves();
    const input: AppendCondensedSummaryInput = condensedInput([leaf0, leaf1], 0, 1);
    expect(() => store.appendCondensedSummary(input)).not.toThrow();
  });

  // ── WR-02: link/range cross-check (mirror the leaf T-129-22 tamper guard) ──
  // The condensed transaction range-replaces [start,end] AND links a child set.
  // It must NOT trust those two inputs to agree: the linked children are DERIVED
  // FROM the summary-refs actually in the replaced range (exactly as the leaf
  // path derives its message links from the read range), so a mismatched
  // childSummaryIds set can never corrupt the losslessness ledger, and a range
  // that still holds a surviving message-ref (which would collapse a raw message
  // into a "condensed" ref linking no message) is rejected.

  it("derives the linked children FROM the in-range summary-refs — a mismatched childSummaryIds set never corrupts the lcd_summary_parents ledger (WR-02)", () => {
    const { leaf0, leaf1 } = seedTwoContiguousLeaves(); // summary-refs at ords [0,1]

    // Pass a childSummaryIds set that does NOT match the range (a caller bug / a
    // future caller): the range [0,1] actually holds leaf0 + leaf1, but the input
    // claims a single bogus child id.
    const condensedId = store.appendCondensedSummary(
      condensedInput(["bogus-child-not-in-range"], 0, 1),
    );

    // The links MUST be the range-derived set (leaf0, leaf1), NOT the bogus input.
    const linkedChildIds = (
      db
        .prepare(
          "SELECT child_summary_id FROM lcd_summary_parents WHERE parent_summary_id = ? ORDER BY child_summary_id",
        )
        .all(condensedId) as Array<{ child_summary_id: string }>
    ).map((r) => r.child_summary_id);
    expect(linkedChildIds.sort()).toEqual([leaf0, leaf1].sort());
    // The bogus id was never linked (it is not a summary-ref in the range).
    expect(linkedChildIds).not.toContain("bogus-child-not-in-range");
  });

  it("rejects a condensed range that still contains a surviving message-ref — never collapses a raw message into a condensed ref (WR-02)", () => {
    seedMessages(3); // view [m0, m1, m2] at ords 0,1,2
    store.getContextItems(SCOPE_A);
    // Collapse only m1 → view [m0, leaf, m2] at ords 0,1,2. The range [0,1] now
    // spans a surviving message-ref (m0) AND a summary-ref (the leaf).
    const leaf = store.appendLeafSummary(leafInput(1, 1));

    const summariesBefore = store.getSummaries(SCOPE_A).length;
    const itemsBefore = store.getContextItems(SCOPE_A);

    // Condensing across the surviving message-ref must throw (a condensed run is
    // summary-refs ONLY — collapsing m0 here would break losslessness for m0,
    // whose links would name no message).
    expect(() => store.appendCondensedSummary(condensedInput([leaf], 0, 1, { depth: 1 }))).toThrow(
      /condensed range\/child mismatch|range/i,
    );

    // The throw rolled back the whole transaction (db.transaction is atomic): no
    // condensed summary persisted, the context view is untouched.
    expect(store.getSummaries(SCOPE_A).length).toBe(summariesBefore);
    const itemsAfter = store.getContextItems(SCOPE_A);
    expect(itemsAfter.map((i) => i.refId)).toEqual(itemsBefore.map((i) => i.refId));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createLcdStore — E1 region walk + FTS5 search (Phase 131, Plan 02)
// ───────────────────────────────────────────────────────────────────────────
// The three E1 read methods on top of the lossless store:
//   - getSummaryChildren  → walks lcd_summary_parents (condensed → child edge)
//   - getSummaryMessages  → walks lcd_summary_messages (leaf → message edge)
//   - searchLcd           → FTS5 MATCH over lcd_summaries_fts / lcd_messages_fts
//                           with a LIKE-scan fallback (the LIKE/boot-safety half
//                           lives in lcd-fts.test.ts), all scoped by conversation.
// Plus the A5 backfill: searchLcd MUST find a summary appended BEFORE the FTS
// index existed (the 'rebuild' idiom over the external-content summaries table).
describe("createLcdStore — E1 region walk + FTS5 search", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
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

  /** Append one message whose single text part carries `text`. Returns its id. */
  function appendTextMessage(text: string, seq: number, scope: ContextStoreScope = SCOPE_A): string {
    store.append({
      scope,
      seq,
      role: "user",
      tokenCount: 1,
      createdAt: 1000 + seq * 10,
      parts: [{ kind: "text", metadata: { raw: { type: "text", text }, rawType: "text" } }],
    });
    // The store assigns ids internally; resolve by seq from the read path.
    const msg = store.getMessages(scope).find((m) => m.seq === seq);
    return msg!.id;
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
      descendantCount: 0,
      earliestAt: 0,
      latestAt: 0,
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

  it("getSummaryChildren returns the condensed summary's immediate child summaries scoped by conversation", () => {
    // m0..m3 → collapse [0,1]→leaf0, [1,2]→leaf1, then condense [0,1]→condensed.
    seedMessages(4);
    store.getContextItems(SCOPE_A);
    const leaf0 = store.appendLeafSummary(leafInput(0, 1));
    const leaf1 = store.appendLeafSummary(leafInput(1, 2));
    const condensedId = store.appendCondensedSummary(condensedInput([leaf0, leaf1], 0, 1, { depth: 1 }));

    const children = store.getSummaryChildren(SCOPE_A, condensedId);
    expect(children.map((c) => c.summaryId).sort()).toEqual([leaf0, leaf1].sort());
    // Every returned child is a full LcdSummary DTO (not just an id).
    expect(children.every((c) => c.kind === "leaf" && typeof c.content === "string")).toBe(true);

    // A DIFFERENT conversation never sees these children.
    expect(store.getSummaryChildren(SCOPE_B, condensedId)).toHaveLength(0);
    // A leaf (no children) returns [].
    expect(store.getSummaryChildren(SCOPE_A, leaf0)).toHaveLength(0);
  });

  it("getSummaryMessages returns the message ids a leaf summary covers in order", () => {
    seedMessages(4); // m0..m3
    const ids = store.getMessages(SCOPE_A).map((m) => m.id); // seq order
    store.getContextItems(SCOPE_A);
    // Collapse [1,3] → covers m1,m2,m3.
    const leafId = store.appendLeafSummary(leafInput(1, 3));

    const covered = store.getSummaryMessages(SCOPE_A, leafId);
    expect(covered).toEqual([ids[1], ids[2], ids[3]]);

    // Unknown summaryId → [].
    expect(store.getSummaryMessages(SCOPE_A, "does-not-exist")).toHaveLength(0);
    // Wrong conversation → [] (scoped).
    expect(store.getSummaryMessages(SCOPE_B, leafId)).toHaveLength(0);
  });

  it("searchLcd finds a summary by full-text content when FTS5 is available", () => {
    seedMessages(2);
    store.getContextItems(SCOPE_A);
    const summaryId = store.appendLeafSummary(
      leafInput(0, 1, { content: "Q3 quarterly revenue grew sharply" }),
    );

    const hits = store.searchLcd(SCOPE_A, "revenue", { limit: 10 });
    const hit = hits.find((h) => h.refId === summaryId);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("summary");
    expect(typeof hit!.rank).toBe("number"); // FTS5 available → BM25 rank present
    expect(hit!.snippet).toContain("revenue");
  });

  it("searchLcd finds a message by rendered part text when FTS5 is available", () => {
    const messageId = appendTextMessage("we should deploy the canary build first", 0);

    const hits = store.searchLcd(SCOPE_A, "canary", { limit: 10, scope: "messages" });
    const hit = hits.find((h) => h.refId === messageId);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("message");
    expect(typeof hit!.rank).toBe("number");
  });

  it("searchLcd scope 'both' unions message and summary hits", () => {
    // A message + a summary that both match "alpha".
    appendTextMessage("the alpha rollout", 0);
    appendTextMessage("unrelated text", 1);
    store.getContextItems(SCOPE_A);
    store.appendLeafSummary(leafInput(1, 1, { content: "alpha summary note" }));

    const both = store.searchLcd(SCOPE_A, "alpha", { limit: 10, scope: "both" });
    const kinds = new Set(both.map((h) => h.kind));
    expect(kinds.has("message")).toBe(true);
    expect(kinds.has("summary")).toBe(true);
  });

  it("searchLcd is scoped by conversation — a second conversation's matching rows are not returned", () => {
    appendTextMessage("shared keyword zebra", 0, SCOPE_A);
    appendTextMessage("shared keyword zebra", 0, SCOPE_B);

    const aHits = store.searchLcd(SCOPE_A, "zebra", { limit: 10, scope: "messages" });
    expect(aHits.length).toBeGreaterThan(0);
    // Every hit belongs to conv-a — none of conv-b's message ids appear.
    const bIds = new Set(store.getMessages(SCOPE_B).map((m) => m.id));
    expect(aHits.some((h) => bIds.has(h.refId))).toBe(false);
  });

  it("A5: searchLcd finds a summary appended BEFORE the FTS index was created (rebuild backfill)", () => {
    // Open a fresh db and create ONLY the base LCD tables — NO FTS index yet.
    const bare = new Database(":memory:");
    bare.pragma("foreign_keys = ON");
    bare.exec(`
      CREATE TABLE lcd_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL, token_count INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE lcd_summaries (
        summary_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_key TEXT NOT NULL, kind TEXT NOT NULL, depth INTEGER NOT NULL,
        earliest_at INTEGER NOT NULL, latest_at INTEGER NOT NULL, descendant_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL, content TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]',
        taint INTEGER NOT NULL DEFAULT 0, fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
    `);
    // Insert a summary row DIRECTLY (the index does not exist yet — this is the
    // pre-index history the rebuild backfill must cover).
    bare.prepare(`
      INSERT INTO lcd_summaries
        (summary_id, conversation_id, tenant_id, agent_id, session_key, kind, depth,
         earliest_at, latest_at, descendant_count, token_count, content, file_ids, taint, fallback, created_at)
      VALUES ('pre1','conv-a','t','a','s','leaf',0,1,1,1,1,'preexisting margin figures','[]',0,0,1)
    `).run();

    // NOW run ensureLcdTables — it must add the FTS tables (incl. agent_id
    // UNINDEXED) AND backfill ('rebuild') the pre-existing summary row, carrying
    // its agent_id, so an agent-scoped searchLcd finds it (R4).
    ensureLcdTables(bare);
    const bareStore = createLcdStore(bare);

    // Scope matches the directly-seeded row (conversation_id 'conv-a', agent_id 'a').
    const preScope: ContextStoreScope = {
      conversationId: "conv-a",
      tenantId: "t",
      agentId: "a",
      sessionKey: "s",
    };
    const hits = bareStore.searchLcd(preScope, "margin", { limit: 10, scope: "summaries" });
    expect(hits.some((h) => h.refId === "pre1")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createLcdStore — WR-03 contentless-FTS populate guard (gate + per-row mapper)
// ───────────────────────────────────────────────────────────────────────────
// The append-path lcd_messages_fts populate must (1) be GATED on
// isFtsAvailable(db) so the EXPECTED FTS5-absent case is a clean conditional skip
// instead of an exception swallowed by an over-broad bare `catch {}`, and (2) read
// the just-inserted rowid through the sanctioned createRowMapper instead of a raw
// `as { rowid: number }` cast. The gate is the testable behavior: when the FTS
// availability probe reports UNAVAILABLE, the append must NOT attempt the
// lcd_messages_fts INSERT at all. The pre-patch code attempted it unconditionally
// (then swallowed any throw), so it MUST fail on the pre-patch tree.
describe("createLcdStore — WR-03 FTS-populate guard", () => {
  /**
   * Wrap a full-schema db in a Proxy that (a) forces the FTS-availability probe
   * (`SELECT rowid FROM lcd_summaries_fts … MATCH`) to THROW so isFtsAvailable()
   * caches `false`, and (b) records every attempted `INSERT INTO lcd_messages_fts`
   * via a spy whose `.run()` is a no-op. Construction still uses the REAL prepares
   * for every other statement, so createLcdStore builds normally. Returns the
   * proxied db plus the populate-attempt counter.
   */
  function ftsUnavailableProbeDb(): { db: Database.Database; ftsInsertAttempts: () => number } {
    const real = new Database(":memory:");
    real.pragma("foreign_keys = ON");
    initSchema(real, 1536); // full schema → lcd_messages_fts EXISTS (construction prepares it)

    let attempts = 0;
    const proxied = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string): unknown => {
            // The isFtsAvailable probe: SELECT rowid … MATCH. Make it throw so the
            // verdict caches FALSE (the FTS5-absent host the gate guards for).
            if (/SELECT\s+rowid/i.test(sql) && /MATCH/i.test(sql)) {
              return { all: () => { throw new Error("no such module: fts5"); } };
            }
            // The contentless-FTS populate INSERT: count + no-op so we can assert
            // the gated path NEVER attempts it when FTS is reported unavailable.
            if (/INSERT\s+INTO\s+lcd_messages_fts/i.test(sql)) {
              return { run: () => { attempts++; return { changes: 0, lastInsertRowid: 0 }; } };
            }
            return target.prepare(sql);
          };
        }
        if (prop === "transaction") {
          // db.transaction(fn) must still wrap against the REAL db so the
          // message+parts write actually commits; bind to target.
          const txn = Reflect.get(target, prop, receiver) as (
            fn: (...a: unknown[]) => unknown,
          ) => (...a: unknown[]) => unknown;
          return txn.bind(target);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Database.Database;

    return { db: proxied, ftsInsertAttempts: () => attempts };
  }

  it("does NOT attempt the lcd_messages_fts populate when the FTS availability probe reports unavailable (gated skip, not a swallowed throw)", () => {
    const { db, ftsInsertAttempts } = ftsUnavailableProbeDb();
    const store = createLcdStore(db);

    // Append a normal message. With FTS reported unavailable the populate must be
    // a clean conditional SKIP — the INSERT is never attempted. (Pre-patch: the
    // INSERT was attempted unconditionally and any throw swallowed by `catch {}`.)
    expect(() =>
      store.append({
        scope: SCOPE_A,
        seq: 0,
        role: "user",
        tokenCount: 1,
        createdAt: FIXED_CREATED_AT,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: "ungated populate?" }, rawType: "text" } }],
      }),
    ).not.toThrow();

    // The gate held: zero FTS populate attempts on an FTS-unavailable host.
    expect(ftsInsertAttempts()).toBe(0);

    // The authoritative base-table write still committed (lossless tables are the
    // source of truth; the contentless index is best-effort only).
    const msgs = store.getMessages(SCOPE_A);
    expect(msgs).toHaveLength(1);
    expect(JSON.stringify(msgs[0]!.parts)).toContain("ungated populate?");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// createLcdStore — R4 cross-agent read isolation (the Phase-131 WR-02 close)
// ───────────────────────────────────────────────────────────────────────────
// Two agents (agent-a, agent-b) legitimately share ONE conversation_id +
// tenantId + sessionKey (formatSessionKey omits agentId). Before R4, every read
// filtered by conversation_id ONLY, so agent A could recover agent B's
// compressed history across EVERY recovery surface. These tests pass the NEW
// scope-carrying signature (`store.getMessages(scope)` etc.) and assert agent A
// never sees agent B's rows within the shared conversation. They MUST fail on the
// pre-patch tree (the conversation-only signature does not even compile, and the
// reads do not filter agent_id/tenant_id). Each surface gets its own test.
describe("createLcdStore — R4 cross-agent read isolation (WR-02)", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Append N user text messages for `scope` at seq base..base+N-1. */
  function seedMessages(scope: ContextStoreScope, count: number, seqBase: number): void {
    for (let i = 0; i < count; i++) {
      store.append({
        scope,
        seq: seqBase + i,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + (seqBase + i) * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `${scope.agentId}-m${i}` }, rawType: "text" } }],
      });
    }
  }

  /** A minimal leaf AppendSummaryInput for `scope` over [start,end]. */
  function leafInput(scope: ContextStoreScope, startOrdinal: number, endOrdinal: number): AppendSummaryInput {
    return {
      scope,
      tokenCount: 5,
      content: `${scope.agentId} leaf summary`,
      descendantCount: 0,
      earliestAt: 0,
      latestAt: 0,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9999,
      startOrdinal,
      endOrdinal,
    };
  }

  it("getMessages scoped to agent A returns only agent A's messages within a shared conversation", () => {
    // Same conversationId, two agents. seq is monotonic per conversation, so use
    // disjoint seq ranges (the UNIQUE (conversation_id, seq) index spans both).
    seedMessages(SCOPE_AGENT_A, 2, 0); // seq 0,1
    seedMessages(SCOPE_AGENT_B, 3, 2); // seq 2,3,4

    const a = store.getMessages(SCOPE_AGENT_A);
    const b = store.getMessages(SCOPE_AGENT_B);

    // Agent A sees ONLY its own 2 messages; agent B's 3 are absent.
    expect(a).toHaveLength(2);
    expect(a.every((m) => m.seq <= 1)).toBe(true);
    // Agent B sees ONLY its own 3.
    expect(b).toHaveLength(3);
    expect(b.every((m) => m.seq >= 2)).toBe(true);
    // No agent A row id appears in agent B's read and vice-versa.
    const aIds = new Set(a.map((m) => m.id));
    expect(b.some((m) => aIds.has(m.id))).toBe(false);
  });

  it("getSummaries scoped to agent A returns only agent A's summaries within a shared conversation", () => {
    seedMessages(SCOPE_AGENT_A, 2, 0);
    seedMessages(SCOPE_AGENT_B, 2, 2);
    // Seed a leaf summary for EACH agent (each scoped to its own agentId).
    store.getContextItems(SCOPE_AGENT_A);
    const aSummary = store.appendLeafSummary(leafInput(SCOPE_AGENT_A, 0, 0));
    store.getContextItems(SCOPE_AGENT_B);
    const bSummary = store.appendLeafSummary(leafInput(SCOPE_AGENT_B, 0, 0));

    const a = store.getSummaries(SCOPE_AGENT_A);
    const b = store.getSummaries(SCOPE_AGENT_B);

    // Agent A sees only its summary, never agent B's.
    expect(a.map((s) => s.summaryId)).toContain(aSummary);
    expect(a.some((s) => s.summaryId === bSummary)).toBe(false);
    expect(b.map((s) => s.summaryId)).toContain(bSummary);
    expect(b.some((s) => s.summaryId === aSummary)).toBe(false);
  });

  it("getContextItems scoped to agent A returns only agent A's context items within a shared conversation", () => {
    seedMessages(SCOPE_AGENT_A, 2, 0);
    seedMessages(SCOPE_AGENT_B, 3, 2);

    const a = store.getContextItems(SCOPE_AGENT_A);
    const b = store.getContextItems(SCOPE_AGENT_B);

    // Each agent's view is seeded 1:1 from ITS OWN messages only.
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
    // A's refIds are A's message ids; none of B's appear.
    const bMsgIds = new Set(store.getMessages(SCOPE_AGENT_B).map((m) => m.id));
    expect(a.some((it) => bMsgIds.has(it.refId))).toBe(false);
  });

  it("getSummaryChildren scoped to agent A cannot reach agent B's condensed children within a shared conversation", () => {
    // Build agent B a condensed summary with two leaf children, all under the
    // shared conversation. Agent A must not be able to walk B's condensed edge.
    seedMessages(SCOPE_AGENT_B, 4, 0);
    store.getContextItems(SCOPE_AGENT_B);
    const bLeaf0 = store.appendLeafSummary(leafInput(SCOPE_AGENT_B, 0, 1));
    const bLeaf1 = store.appendLeafSummary(leafInput(SCOPE_AGENT_B, 1, 2));
    const bCondensed = store.appendCondensedSummary({
      scope: SCOPE_AGENT_B,
      tokenCount: 9,
      content: "agent-b condensed",
      descendantCount: 0,
      earliestAt: 0,
      latestAt: 0,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 5555,
      startOrdinal: 0,
      endOrdinal: 1,
      childSummaryIds: [bLeaf0, bLeaf1],
      depth: 1,
    });

    // Agent B can walk its own condensed → children edge.
    expect(store.getSummaryChildren(SCOPE_AGENT_B, bCondensed).map((c) => c.summaryId).sort()).toEqual(
      [bLeaf0, bLeaf1].sort(),
    );
    // Agent A (SAME conversation, different agentId) CANNOT — the read is
    // agent-scoped, so B's condensed children are unreachable.
    expect(store.getSummaryChildren(SCOPE_AGENT_A, bCondensed)).toHaveLength(0);
  });

  it("getSummaryMessages scoped to agent A cannot reach agent B's covered message ids within a shared conversation", () => {
    seedMessages(SCOPE_AGENT_B, 3, 0);
    store.getContextItems(SCOPE_AGENT_B);
    const bLeaf = store.appendLeafSummary(leafInput(SCOPE_AGENT_B, 0, 2)); // covers all 3 of B's messages

    // Agent B recovers its own covered message ids.
    expect(store.getSummaryMessages(SCOPE_AGENT_B, bLeaf)).toHaveLength(3);
    // Agent A (shared conversation, different agentId) cannot reach B's covered ids.
    expect(store.getSummaryMessages(SCOPE_AGENT_A, bLeaf)).toHaveLength(0);
  });

  it("a cross-tenant read returns nothing within the same conversation (defense-in-depth)", () => {
    // Agent A under the shared tenant seeds messages; a read under a DIFFERENT
    // tenant (but the SAME conversationId/agentId/sessionKey) must see nothing.
    seedMessages(SCOPE_AGENT_A, 2, 0);
    const crossTenant: ContextStoreScope = { ...SCOPE_AGENT_A, tenantId: "tenant_other" };

    expect(store.getMessages(SCOPE_AGENT_A)).toHaveLength(2);
    // tenant_id filter rejects the cross-tenant read even with the same conv+agent.
    expect(store.getMessages(crossTenant)).toHaveLength(0);
  });
});

// =====================================================================
// Phase 164 — cursor (RR1) + deleteConversationLcd (RR4)
//
// Task 1 (RED): tests are written against methods that do NOT exist yet on
// ContextStorePort or createLcdStore. They use type-casts to compile while
// failing at runtime (the method is undefined → TypeError). Task 2 (GREEN)
// adds the DDL + implementations; the casts remain valid after the real
// methods land (no cleanup needed).
// =====================================================================

describe("Phase 164 — cursor + deleteConversationLcd", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  /** Typed helpers via unknown cast — compile without the methods; fail at runtime until GREEN. */
  type CursorMethods = {
    getIngestCursor(scope: ContextStoreScope): { epochAnchor: string; ingestedLiveLen: number } | null;
    upsertIngestCursor(
      scope: ContextStoreScope,
      cursor: { epochAnchor: string; ingestedLiveLen: number },
      updatedAt: number,
    ): void;
    deleteConversationLcd(scope: ContextStoreScope): number;
  };

  function storeWithCursor(): ReturnType<typeof createLcdStore> & CursorMethods {
    return store as unknown as ReturnType<typeof createLcdStore> & CursorMethods;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  // ── Cursor tests (C1–C3) ──────────────────────────────────────────────

  it("Test C1: getIngestCursor returns null for a fresh scope with no cursor row", () => {
    const s = storeWithCursor();
    const result = s.getIngestCursor(SCOPE_A);
    expect(result).toBeNull();
  });

  it("Test C2: upsertIngestCursor then getIngestCursor returns the saved values", () => {
    const s = storeWithCursor();
    const cursor = { epochAnchor: "user:1000:hello", ingestedLiveLen: 5 };
    s.upsertIngestCursor(SCOPE_A, cursor, 999_000);
    const result = s.getIngestCursor(SCOPE_A);
    expect(result).not.toBeNull();
    expect(result!.epochAnchor).toBe("user:1000:hello");
    expect(result!.ingestedLiveLen).toBe(5);
  });

  it("Test C3: second upsertIngestCursor overwrites — getIngestCursor returns the newer values", () => {
    const s = storeWithCursor();
    s.upsertIngestCursor(SCOPE_A, { epochAnchor: "user:1000:hello", ingestedLiveLen: 5 }, 999_000);
    s.upsertIngestCursor(SCOPE_A, { epochAnchor: "user:2000:world", ingestedLiveLen: 9 }, 999_001);
    const result = s.getIngestCursor(SCOPE_A);
    expect(result!.epochAnchor).toBe("user:2000:world");
    expect(result!.ingestedLiveLen).toBe(9);
  });

  // ── deleteConversationLcd tests (D1–D3) ──────────────────────────────

  it("Test D1: deleteConversationLcd returns message count, getMessages/getContextItems return [] and cursor becomes null", () => {
    const s = storeWithCursor();
    // Append 3 messages.
    for (let i = 0; i < 3; i++) {
      store.append({
        scope: SCOPE_A,
        seq: i,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + i * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${i}` }, rawType: "text" } }],
      });
    }
    // Seed a cursor so D1 also verifies cursor deletion.
    s.upsertIngestCursor(SCOPE_A, { epochAnchor: "user:1000:m0", ingestedLiveLen: 3 }, 9000);

    const deleted = s.deleteConversationLcd(SCOPE_A);
    expect(deleted).toBe(3);
    expect(store.getMessages(SCOPE_A)).toHaveLength(0);
    expect(store.getContextItems(SCOPE_A)).toHaveLength(0);
    expect(s.getIngestCursor(SCOPE_A)).toBeNull();
  });

  it("Test D2: deleteConversationLcd does not touch a DIFFERENT conversation's rows", () => {
    const s = storeWithCursor();
    // Populate both SCOPE_A and SCOPE_B.
    for (let i = 0; i < 2; i++) {
      store.append({
        scope: SCOPE_A,
        seq: i,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + i,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `ma${i}` }, rawType: "text" } }],
      });
      store.append({
        scope: SCOPE_B,
        seq: i,
        role: "user",
        tokenCount: 1,
        createdAt: 2000 + i,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `mb${i}` }, rawType: "text" } }],
      });
    }

    // Delete only SCOPE_A.
    s.deleteConversationLcd(SCOPE_A);

    // SCOPE_A is gone.
    expect(store.getMessages(SCOPE_A)).toHaveLength(0);
    // SCOPE_B is intact.
    expect(store.getMessages(SCOPE_B)).toHaveLength(2);
  });

  it("Test D3: deleteConversationLcd with a leaf summary (lcd_summary_messages rows) clears without an FK constraint error", () => {
    const s = storeWithCursor();
    // Append 2 messages and create a leaf summary linking them (creates lcd_summary_messages rows).
    for (let i = 0; i < 2; i++) {
      store.append({
        scope: SCOPE_A,
        seq: i,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + i * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${i}` }, rawType: "text" } }],
      });
    }
    store.getContextItems(SCOPE_A); // seed context_items
    store.appendLeafSummary({
      scope: SCOPE_A,
      tokenCount: 5,
      content: "summary",
      descendantCount: 0,
      earliestAt: 1000,
      latestAt: 1010,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9999,
      startOrdinal: 0,
      endOrdinal: 1,
    });

    // Must NOT throw (the FK RESTRICT on lcd_summary_messages requires deleting
    // lcd_summary_messages rows BEFORE lcd_messages rows).
    expect(() => s.deleteConversationLcd(SCOPE_A)).not.toThrow();
    expect(store.getMessages(SCOPE_A)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EFF-01: bounded working-set reads — getMessagesByIds / getSummariesByIds
// ---------------------------------------------------------------------------

describe("EFF-01: getMessagesByIds / getSummariesByIds", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createLcdStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536);
    store = createLcdStore(db);
  });

  /** Append N messages to a scope, returning their ids in seq order. */
  function appendMessages(scope: ContextStoreScope, n: number): string[] {
    const ids: string[] = [];
    for (let seq = 0; seq < n; seq++) {
      store.append({
        scope,
        seq,
        role: "user",
        tokenCount: 1,
        createdAt: 1000 + seq * 10,
        parts: [{ kind: "text", metadata: { raw: { type: "text", text: `m${seq}` }, rawType: "text" } }],
      });
    }
    return store.getMessages(scope).map((m) => m.id);
  }

  it("EFF-01-S-1: getMessagesByIds returns ONLY the rows whose ids are in the provided list", () => {
    const ids = appendMessages(SCOPE_A, 5);
    // Pick ids at index 0 and 2 (m1 and m3 by 0-based seq).
    const wanted = [ids[0]!, ids[2]!];
    const result = store.getMessagesByIds(SCOPE_A, wanted);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id).sort()).toEqual([...wanted].sort());
  });

  it("EFF-01-S-2: getMessagesByIds with empty ids list returns [] without issuing any DB queries", () => {
    appendMessages(SCOPE_A, 3);
    const result = store.getMessagesByIds(SCOPE_A, []);
    expect(result).toEqual([]);
  });

  it("EFF-01-S-3: getSummariesByIds returns ONLY the summaries whose summaryIds are in the list", () => {
    // Seed 3 messages then create 3 leaf summaries (one per message slot via successive passes).
    appendMessages(SCOPE_A, 3);
    store.getContextItems(SCOPE_A); // seed context_items
    const s1 = store.appendLeafSummary({
      scope: SCOPE_A,
      tokenCount: 5,
      content: "summary-1",
      descendantCount: 0,
      earliestAt: 1000,
      latestAt: 1000,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9000,
      startOrdinal: 0,
      endOrdinal: 0,
    });
    // After first collapse: items = [S, m1, m2]; do second collapse at ordinal 1.
    const s2 = store.appendLeafSummary({
      scope: SCOPE_A,
      tokenCount: 5,
      content: "summary-2",
      descendantCount: 0,
      earliestAt: 1010,
      latestAt: 1010,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9001,
      startOrdinal: 1,
      endOrdinal: 1,
    });
    // After second collapse: items = [S, S, m2]; do third collapse at ordinal 2.
    const s3 = store.appendLeafSummary({
      scope: SCOPE_A,
      tokenCount: 5,
      content: "summary-3",
      descendantCount: 0,
      earliestAt: 1020,
      latestAt: 1020,
      fileIds: [],
      fallback: false,
      taint: false,
      createdAt: 9002,
      startOrdinal: 2,
      endOrdinal: 2,
    });
    void s1; void s3; // suppress unused warning — we only request s2
    const result = store.getSummariesByIds(SCOPE_A, [s2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.summaryId).toBe(s2);
  });

  it("EFF-01-S-4: getMessagesByIds respects R4 scope — messages from a different agentId are excluded", () => {
    // Seed messages for both agents sharing the same conversationId.
    const SCOPE_CROSS_A: ContextStoreScope = {
      conversationId: "conv-cross",
      tenantId: "tenant-cross",
      agentId: "agentA",
      sessionKey: "sess-cross",
    };
    const SCOPE_CROSS_B: ContextStoreScope = {
      conversationId: "conv-cross",
      tenantId: "tenant-cross",
      agentId: "agentB",
      sessionKey: "sess-cross",
    };
    // Append one message to agentB.
    store.append({
      scope: SCOPE_CROSS_B,
      seq: 0,
      role: "user",
      tokenCount: 1,
      createdAt: 1000,
      parts: [{ kind: "text", metadata: { raw: { type: "text", text: "agentB msg" }, rawType: "text" } }],
    });
    const agentBIds = store.getMessages(SCOPE_CROSS_B).map((m) => m.id);
    expect(agentBIds).toHaveLength(1);

    // Looking up agentB's id through agentA's scope must return [].
    const result = store.getMessagesByIds(SCOPE_CROSS_A, agentBIds);
    expect(result).toEqual([]);
  });
});
