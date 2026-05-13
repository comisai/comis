// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test (MEM-CTX-PORTS-06): memory's `createSessionStore` runtime
 * implementation structurally satisfies the `SessionStorePort` contract
 * declared in `@comis/core/src/ports/session-store.ts`.
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
 * Mirrors the Phase 28 analog pattern at
 * `packages/infra/src/logging/__tests__/logger-contract.test.ts` (`.toExtend`
 * is the canonical non-deprecated matcher per RES-STK-2; `toMatchTypeOf` is
 * deprecated since expect-type@1.2.0).
 *
 * @module
 */

import Database from "better-sqlite3";
import {
  type SessionKey,
  type SessionStorePort,
  type SessionData,
  type SessionDetailedEntry,
} from "@comis/core";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { initSchema } from "../schema.js";
import { createSessionStore } from "../session-store.js";

describe("createSessionStore — SessionStorePort contract (MEM-CTX-PORTS-06)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 1536);
  });

  it("returns a value structurally compatible with SessionStorePort", () => {
    const store = createSessionStore(db);
    expectTypeOf<ReturnType<typeof createSessionStore>>().toExtend<SessionStorePort>();

    // Runtime structural check — guards against a future refactor that
    // deletes a method from the impl without a corresponding port change.
    const expectedMethods: ReadonlyArray<keyof SessionStorePort> = [
      "save",
      "load",
      "list",
      "delete",
      "deleteStale",
      "loadByFormattedKey",
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
    const key: SessionKey = {
      tenantId: "t-1",
      userId: "u-1",
      channelId: "c-1",
    };
    const messages = [{ role: "user", content: "hello" }];
    const metadata = { source: "contract-test" };
    store.save(key, messages, metadata);

    const loaded: SessionData | undefined = store.load(key);
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
    const key: SessionKey = {
      tenantId: "t-2",
      userId: "u-2",
      channelId: "c-2",
    };
    store.save(key, [{ role: "user", content: "x" }], {});

    const detailed: SessionDetailedEntry[] = store.listDetailed("t-2");
    expect(detailed.length).toBeGreaterThan(0);
    for (const field of [
      "sessionKey",
      "tenantId",
      "userId",
      "channelId",
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
    expect(detailed[0]!.userId).toBe("u-2");
    expect(detailed[0]!.channelId).toBe("c-2");
    expect(typeof detailed[0]!.messageCount).toBe("number");
  });
});
