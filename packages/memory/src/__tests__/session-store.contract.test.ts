// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test: memory's `createSessionStore` runtime implementation
 * structurally satisfies the `SessionStorePort` contract declared in
 * `@comis/core/src/ports/session-store.ts`.
 *
 * Without this gate, the local return-type swap in
 * `packages/memory/src/session-store.ts` could silently drift (e.g. a method
 * could be dropped from the runtime impl without a TypeScript error if the
 * caller never narrowed via the port type). The compile-time
 * `expectTypeOf<ReturnType<typeof createSessionStore>>().toExtend<SessionStorePort>()`
 * proves assignability, and the round-trip assertions prove the runtime row
 * shapes match the `SessionData` / `SessionDetailedEntry` DTO contracts that
 * now live in core.
 *
 * Mirrors the analog pattern at
 * `packages/infra/src/logging/__tests__/logger-contract.test.ts`. `.toExtend`
 * is the canonical non-deprecated matcher; `toMatchTypeOf` is deprecated
 * since expect-type@1.2.0.
 *
 * @module
 */

import Database from "better-sqlite3";
import {
  type ConversationScope,
  type SessionStorePort,
  type SessionData,
  type SessionDetailedEntry,
} from "@comis/core";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { initSchema } from "../schema.js";
import { createSessionStore } from "../session-store.js";

describe("createSessionStore — SessionStorePort contract", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  function scope(tenantId: string, agentId: string, principalId: string): ConversationScope {
    return { tenantId, agentId, partition: { kind: "principal", principalId } };
  }

  it("returns a value structurally compatible with SessionStorePort", () => {
    const store = createSessionStore(db);
    expectTypeOf<ReturnType<typeof createSessionStore>>().toExtend<SessionStorePort>();

    // Runtime structural check — guards against a future refactor that
    // deletes a method from the impl without a corresponding port change.
    const expectedMethods: ReadonlyArray<keyof SessionStorePort> = [
      "save",
      "load",
      "loadByRef",
      "list",
      "delete",
      "deleteByRef",
      "deleteStale",
      "listDetailed",
    ];
    for (const m of expectedMethods) {
      expect(
        typeof (store as Record<string, unknown>)[m],
        `expected method ${m} on createSessionStore result`,
      ).toBe("function");
    }
  });

  it("save → load round-trip preserves the SessionData DTO shape (createdAt, updatedAt, messages, metadata)", () => {
    const store = createSessionStore(db);
    const key = scope("t-1", "agent-1", "u-1");
    const messages = [{ role: "user", content: "hello" }];
    const metadata = { source: "contract-test" };
    expect(store.save(key, messages, metadata).ok).toBe(true);

    const loadedResult = store.load(key);
    expect(loadedResult.ok).toBe(true);
    if (!loadedResult.ok) return;
    const loaded: SessionData | undefined = loadedResult.value;
    expect(loaded).toBeDefined();
    for (const field of [
      "messages",
      "metadata",
      "createdAt",
      "updatedAt",
    ] as const) {
      expect(loaded, `SessionData must expose ${field}`).toHaveProperty(field);
    }
    expect(loaded!.messages).toEqual(messages);
    expect(loaded!.metadata).toEqual(metadata);
    expect(typeof loaded!.createdAt).toBe("number");
    expect(typeof loaded!.updatedAt).toBe("number");
  });

  it("listDetailed returns rows shaped as SessionDetailedEntry from @comis/core", () => {
    const store = createSessionStore(db);
    const key = scope("t-2", "agent-2", "u-2");
    expect(store.save(key, [{ role: "user", content: "x" }], {}).ok).toBe(true);

    const detailedResult = store.listDetailed({ tenantId: "t-2", agentId: "agent-2" });
    expect(detailedResult.ok).toBe(true);
    if (!detailedResult.ok) return;
    const detailed: SessionDetailedEntry[] = detailedResult.value;
    expect(detailed.length).toBeGreaterThan(0);
    for (const field of [
      "conversationRef",
      "conversationScope",
      "tenantId",
      "agentId",
      "metadata",
      "createdAt",
      "updatedAt",
      "messageCount",
    ] as const) {
      expect(
        detailed[0],
        `SessionDetailedEntry must expose ${field}`,
      ).toHaveProperty(field);
    }
    expect(detailed[0]!.tenantId).toBe("t-2");
    expect(detailed[0]!.agentId).toBe("agent-2");
    expect(detailed[0]!.conversationScope).toEqual(key);
    expect(typeof detailed[0]!.messageCount).toBe("number");
  });
});
