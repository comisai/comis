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
  type AppendMessageInput,
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
