// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test: memory's `createContextStore` runtime implementation
 * structurally satisfies the `ContextStorePort` contract declared in
 * `@comis/core/src/ports/context-store.ts`, AND the row shapes returned by
 * the impl match the `Ctx*Row` DTOs in
 * `@comis/core/src/ports/context-store-types.ts`.
 *
 * Phase 60-02 (REFACTOR-04): ContextStorePort is now an intersection alias
 * `type ContextStorePort = ContextEngineStore & ContextAdminStore`. The
 * contract test gates parity across all three names — the intersection
 * alias AND each half — so a future classification miss (a method moved
 * out of both halves) fails at TypeScript-check time.
 *
 * Mirrors the analog pattern at
 * `packages/infra/src/logging/__tests__/logger-contract.test.ts`. Uses
 * `.toExtend` because `toMatchTypeOf` is deprecated since
 * expect-type@1.2.0.
 *
 * The round-trip fixture body copies the canonical
 * `createConversation` + `insertMessage` pattern from
 * `packages/memory/src/context-store.test.ts` (groups 1-2) so the field-name
 * assertions exercise the real CRUD path through SQLite.
 *
 * @module
 */

import Database from "better-sqlite3";
import {
  type ContextStorePort,
  type ContextEngineStore,
  type ContextAdminStore,
  type CtxConversationRow,
  type CtxMessageRow,
} from "@comis/core";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { createContextStore } from "../context-store.js";

describe("createContextStore — ContextStorePort contract", () => {
  let db: Database.Database;
  let store: ContextStorePort;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    store = createContextStore(db);
  });

  it("returns a value structurally compatible with ContextStorePort (intersection alias)", () => {
    expectTypeOf<ReturnType<typeof createContextStore>>().toExtend<ContextStorePort>();
  });

  it("returns a value structurally compatible with ContextEngineStore (engine half — 34 per-session methods)", () => {
    expectTypeOf<ReturnType<typeof createContextStore>>().toExtend<ContextEngineStore>();
  });

  it("returns a value structurally compatible with ContextAdminStore (admin half — 4 admin/cleanup methods)", () => {
    expectTypeOf<ReturnType<typeof createContextStore>>().toExtend<ContextAdminStore>();
  });

  it("exposes representative methods from both halves at runtime", () => {
    // Sample representative methods across both halves of the split —
    // guards against a future refactor silently dropping a method from
    // the impl. The list MUST include at least 1 Admin-half method to
    // pin coverage across the split per RESEARCH §B.6 risk #3.
    const sampledMethods: ReadonlyArray<keyof ContextStorePort> = [
      "createConversation",       // Engine
      "getConversation",          // Engine
      "insertMessage",            // Engine
      "getMessagesByConversation",// Engine
      "insertSummary",            // Engine
      "getSummary",               // Engine
      "createGrant",              // Engine
      "getActiveGrants",          // Engine
      "listConversations",        // Admin — pins admin-side coverage
      "cleanupExpiredGrants",     // Admin — pins admin-side coverage
    ];
    for (const m of sampledMethods) {
      expect(
        typeof (store as Record<string, unknown>)[m],
        `expected method ${m} on createContextStore result`,
      ).toBe("function");
    }
  });

  it("createConversation → getConversation round-trip exposes CtxConversationRow field shape (snake_case)", () => {
    const id = store.createConversation({
      tenantId: "t-contract",
      agentId: "a-contract",
      sessionKey: "sess-contract",
      title: "Contract round-trip",
    });

    const row: CtxConversationRow | undefined = store.getConversation(id);
    expect(row).toBeDefined();
    // Field names must match the core DTO contract — every key is asserted
    // explicitly so any silent rename in the impl is caught.
    for (const field of [
      "conversation_id",
      "tenant_id",
      "agent_id",
      "session_key",
      "title",
      "created_at",
      "updated_at",
    ] as const) {
      expect(
        row,
        `CtxConversationRow must expose ${field}`,
      ).toHaveProperty(field);
    }
    expect(row!.conversation_id).toBe(id);
    expect(row!.tenant_id).toBe("t-contract");
    expect(row!.agent_id).toBe("a-contract");
    expect(row!.session_key).toBe("sess-contract");
    expect(row!.title).toBe("Contract round-trip");
  });

  it("insertMessage → getMessagesByConversation round-trip exposes CtxMessageRow field shape (snake_case)", () => {
    const convId = store.createConversation({
      tenantId: "t-contract",
      agentId: "a-contract",
      sessionKey: "sess-msg-contract",
    });
    const messageId = store.insertMessage({
      conversationId: convId,
      seq: 1,
      role: "user",
      content: "hello-contract",
      contentHash: "h-contract-1",
      tokenCount: 3,
    });
    expect(messageId).toBeGreaterThan(0);

    const rows: CtxMessageRow[] = store.getMessagesByConversation(convId);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    for (const field of [
      "message_id",
      "conversation_id",
      "seq",
      "role",
      "content",
      "content_hash",
      "token_count",
      "tool_name",
      "tool_call_id",
      "created_at",
    ] as const) {
      expect(
        row,
        `CtxMessageRow must expose ${field}`,
      ).toHaveProperty(field);
    }
    expect(row.message_id).toBe(messageId);
    expect(row.conversation_id).toBe(convId);
    expect(row.seq).toBe(1);
    expect(row.role).toBe("user");
    expect(row.content).toBe("hello-contract");
    expect(row.content_hash).toBe("h-contract-1");
    expect(row.token_count).toBe(3);
    // Optional fields default to null at the SQLite layer
    expect(row.tool_name).toBeNull();
    expect(row.tool_call_id).toBeNull();
  });
});
