// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSessionStore, initSchema } from "@comis/memory";
import type { SessionKey } from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createGatewayAttachmentPersister } from "./gateway-attachment-persistence.js";

describe("createGatewayAttachmentPersister", () => {
  it("persists the marker under the exact request session identity", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const sessionStore = createSessionStore(db);
    const requestedSession: SessionKey = {
      tenantId: "tenant-a",
      userId: "rpc-client",
      channelId: "web-chat",
    };
    const sameChannelWrongUser: SessionKey = {
      tenantId: "tenant-a",
      userId: "default",
      channelId: "web-chat",
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

      expect(sessionStore.load(requestedSession)?.messages).toEqual([{
        role: "assistant",
        content: marker,
        timestamp: 1_700_000_000_000,
      }]);
      expect(sessionStore.load(requestedSession)?.metadata).toEqual({ label: "Pinned chat" });
      expect(sessionStore.load(sameChannelWrongUser)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("preserves repeated sends of the same media in one session", () => {
    const db = new Database(":memory:");
    initSchema(db, 384);
    const sessionStore = createSessionStore(db);
    const sessionKey: SessionKey = {
      tenantId: "tenant-a",
      userId: "user_a",
      channelId: "web-chat",
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

      expect(sessionStore.load(sessionKey)?.messages).toEqual([
        expect.objectContaining({ content: marker }),
        expect.objectContaining({ content: marker }),
      ]);
    } finally {
      db.close();
    }
  });

  it("emits a system error when session history persistence fails", () => {
    const sessionKey: SessionKey = {
      tenantId: "tenant-a",
      userId: "user_a",
      channelId: "web-chat",
    };
    const logger = createMockLogger();
    const emitSystemError = vi.fn();
    const persist = createGatewayAttachmentPersister({
      sessionStore: {
        load: vi.fn(() => {
          throw new Error("database unavailable");
        }),
        save: vi.fn(),
      },
      clock: createFakeClock(1_700_000_000_000),
      logger,
      emitSystemError,
    });

    expect(() => persist(sessionKey, "<!-- attachment:{} -->")).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "Check SQLite session storage health and available disk space",
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
