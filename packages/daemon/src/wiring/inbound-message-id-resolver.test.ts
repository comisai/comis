// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createInboundMessageIdResolver } from "./inbound-message-id-resolver.js";
import type { NormalizedMessage } from "@comis/core";

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "uuid-1",
    channelType: "telegram",
    channelId: "678314278",
    senderId: "678314278",
    text: "hi",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: 123 },
    ...overrides,
  } as NormalizedMessage;
}

describe("createInboundMessageIdResolver", () => {
  it("records and resolves a Telegram inbound by daemon UUID", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg(), "telegram");
    const got = resolver.resolve("uuid-1");
    expect(got).toEqual({ channelType: "telegram", channelId: "678314278", nativeId: "123" });
  });

  it("coerces numeric native ids to strings", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg({ metadata: { telegramMessageId: 42 } }), "telegram");
    expect(resolver.resolve("uuid-1")?.nativeId).toBe("42");
  });

  it("accepts string native ids unchanged", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["slack", "slackTs"]]),
    });
    resolver.record(makeMsg({
      id: "u-2",
      metadata: { slackTs: "1714500000.000100" },
    }), "slack");
    expect(resolver.resolve("u-2")?.nativeId).toBe("1714500000.000100");
  });

  it("returns undefined for unknown UUIDs", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    expect(resolver.resolve("never-recorded")).toBeUndefined();
  });

  it("ignores channels without a registered meta key", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg({ channelType: "discord" }), "discord");
    expect(resolver.resolve("uuid-1")).toBeUndefined();
  });

  it("ignores messages where the meta key is missing", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg({ metadata: {} }), "telegram");
    expect(resolver.resolve("uuid-1")).toBeUndefined();
  });

  it("ignores empty-string native ids", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg({ metadata: { telegramMessageId: "" } }), "telegram");
    expect(resolver.resolve("uuid-1")).toBeUndefined();
  });

  it("expires entries after ttlMs", async () => {
    let now = 1_000_000;
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
      ttlMs: 100,
    });
    // The resolver delegates to TTLCache which uses Date.now by default; we
    // can't inject a clock here, so we just exercise that an expired ttlMs of
    // 1ms produces undefined on a small await.
    void now;
    const r2 = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
      ttlMs: 1,
    });
    r2.record(makeMsg(), "telegram");
    await new Promise((r) => setTimeout(r, 10));
    expect(r2.resolve("uuid-1")).toBeUndefined();
    expect(resolver).toBeDefined();
  });

  it("evicts oldest entry when maxEntries is exceeded", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
      maxEntries: 2,
    });
    resolver.record(makeMsg({ id: "u-A", metadata: { telegramMessageId: 1 } }), "telegram");
    resolver.record(makeMsg({ id: "u-B", metadata: { telegramMessageId: 2 } }), "telegram");
    resolver.record(makeMsg({ id: "u-C", metadata: { telegramMessageId: 3 } }), "telegram");
    expect(resolver.resolve("u-A")).toBeUndefined();
    expect(resolver.resolve("u-B")?.nativeId).toBe("2");
    expect(resolver.resolve("u-C")?.nativeId).toBe("3");
  });

  it("ignores non-string non-number native ids (e.g. boolean)", () => {
    const resolver = createInboundMessageIdResolver({
      metaKeyByChannel: new Map([["telegram", "telegramMessageId"]]),
    });
    resolver.record(makeMsg({ metadata: { telegramMessageId: true as unknown as number } }), "telegram");
    expect(resolver.resolve("uuid-1")).toBeUndefined();
  });
});
