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
