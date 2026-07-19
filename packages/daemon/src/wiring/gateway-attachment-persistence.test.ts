// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSessionStore, initSchema } from "@comis/memory";
import { SessionStoreError, type ConversationScope } from "@comis/core";
import { err } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createGatewayAttachmentPersister } from "./gateway-attachment-persistence.js";

describe("createGatewayAttachmentPersister", () => {
  it("persists the marker under the exact request session identity", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const sessionStore = createSessionStore(db);
    const requestedSession: ConversationScope = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "principal", principalId: "rpc-client" },
    };
    const sameChannelWrongUser: ConversationScope = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "principal", principalId: "default" },
    };
    const marker = '<!-- attachment:{"url":"/media/abc123def4567890.png","type":"image","mimeType":"image/png","fileName":"photo.png"} -->';
    const persist = createGatewayAttachmentPersister({
      sessionStore,
      clock: createFakeClock(1_700_000_000_000),
      logger: createMockLogger(),
      emitSystemError: vi.fn(),
    });

    try {
      sessionStore.save(requestedSession, [], { label: "Pinned chat" });
      persist(requestedSession, marker);

      const loaded = sessionStore.load(requestedSession);
      expect(loaded.ok && loaded.value?.messages).toEqual([{
        role: "assistant",
        content: marker,
        timestamp: 1_700_000_000_000,
      }]);
      expect(loaded.ok && loaded.value?.metadata).toEqual({ label: "Pinned chat" });
      expect(sessionStore.load(sameChannelWrongUser)).toEqual(expect.objectContaining({ ok: true, value: undefined }));
    } finally {
      db.close();
    }
  });

  it("preserves repeated sends of the same media in one session", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const sessionStore = createSessionStore(db);
    const sessionKey: ConversationScope = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "principal", principalId: "user_a" },
    };
    const marker = '<!-- attachment:{"url":"/media/abc123def4567890.png","type":"image","mimeType":"image/png","fileName":"photo.png"} -->';
    const persist = createGatewayAttachmentPersister({
      sessionStore,
      clock: createFakeClock(1_700_000_000_000),
      logger: createMockLogger(),
      emitSystemError: vi.fn(),
    });

    try {
      persist(sessionKey, marker);
      persist(sessionKey, marker);

      const loaded = sessionStore.load(sessionKey);
      expect(loaded.ok && loaded.value?.messages).toEqual([
        expect.objectContaining({ content: marker }),
        expect.objectContaining({ content: marker }),
      ]);
    } finally {
      db.close();
    }
  });

  it("emits a system error when session history persistence fails", () => {
    const sessionKey: ConversationScope = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: { kind: "principal", principalId: "user_a" },
    };
    const logger = createMockLogger();
    const emitSystemError = vi.fn();
    const persist = createGatewayAttachmentPersister({
      sessionStore: {
        load: vi.fn(() => err(new SessionStoreError("database unavailable", "resource"))),
        save: vi.fn(() => err(new SessionStoreError("database unavailable", "resource"))),
      },
      clock: createFakeClock(1_700_000_000_000),
      logger,
      emitSystemError,
    });

    expect(() => persist(sessionKey, "<!-- attachment:{} -->")).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "Check SQLite session storage integrity and available disk space.",
      }),
      "Gateway attachment history persistence failed",
    );
    expect(emitSystemError).toHaveBeenCalledOnce();
    expect(emitSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        source: "gateway-attachment-history",
      }),
    );
  });
});
