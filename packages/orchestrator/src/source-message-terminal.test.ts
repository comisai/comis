// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus, type NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import {
  createSourceTerminalScope,
  mergeSourceTerminalScopes,
} from "./source-message-terminal.js";

function makeMessage(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000301",
    channelId: "chat:one",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: 1_000,
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

describe("createSourceTerminalScope", () => {
  it("publishes one exact tuple once even when later boundaries retry", () => {
    const eventBus = new TypedEventBus();
    const observed: string[] = [];
    eventBus.on("message:terminal", (event) => observed.push(event.sourceMessageId));
    const scope = createSourceTerminalScope(
      { eventBus },
      makeMessage(),
      "telegram",
    );

    expect(scope.publish("error", "execution_completed", 2_000)).toBe(1);
    expect(scope.publish("error", "inbound_rejected", 2_001)).toBe(0);

    expect(observed).toEqual([makeMessage().id]);
  });

  it("rejects reentrant publication from a terminal observer", () => {
    const eventBus = new TypedEventBus();
    let scope: ReturnType<typeof createSourceTerminalScope>;
    let reentered = false;
    const observer = vi.fn(() => {
      if (reentered) return;
      reentered = true;
      expect(scope.publish("error", "inbound_rejected", 2_001)).toBe(0);
    });
    eventBus.on("message:terminal", observer);
    scope = createSourceTerminalScope({ eventBus }, makeMessage(), "telegram");

    expect(scope.publish("success", "execution_completed", 2_000)).toBe(1);
    expect(observer).toHaveBeenCalledOnce();
  });

  it("merges queue-owned scopes without treating synthetic provenance as authority", () => {
    const eventBus = new TypedEventBus();
    const observed: string[] = [];
    eventBus.on("message:terminal", (event) => observed.push(event.sourceMessageId));
    const first = makeMessage({
      id: "00000000-0000-0000-0000-000000000321",
    });
    const second = makeMessage({
      id: "00000000-0000-0000-0000-000000000322",
      originalMessages: [{
        id: "00000000-0000-0000-0000-000000000399",
        channelId: "foreign-chat",
        channelType: "slack",
        senderId: "foreign-user",
        text: "must not become lifecycle authority",
        timestamp: 1_999,
      }],
    });
    const scope = mergeSourceTerminalScopes([
      createSourceTerminalScope({ eventBus }, first, "telegram"),
      createSourceTerminalScope({ eventBus }, second, "telegram"),
    ]);

    expect(scope.publish("success", "execution_completed", 2_000)).toBe(2);
    expect(scope.publish("success", "execution_completed", 2_001)).toBe(0);
    expect(observed).toEqual([first.id, second.id]);
  });

  it("links duplicate tuple scopes so later owners cannot republish", () => {
    const eventBus = new TypedEventBus();
    const observed = vi.fn();
    eventBus.on("message:terminal", observed);
    const firstOwner = createSourceTerminalScope(
      { eventBus },
      makeMessage(),
      "telegram",
    );
    const duplicateOwner = createSourceTerminalScope(
      { eventBus },
      makeMessage(),
      "telegram",
    );
    const merged = mergeSourceTerminalScopes([firstOwner, duplicateOwner]);

    expect(merged.publish("success", "execution_completed", 2_000)).toBe(1);
    expect(firstOwner.publish("error", "inbound_rejected", 2_001)).toBe(0);
    expect(duplicateOwner.publish("aborted", "queue_aborted", 2_002)).toBe(0);
    expect(observed).toHaveBeenCalledOnce();
  });

  it("claims every merged tuple before terminal observers run", () => {
    const eventBus = new TypedEventBus();
    const first = makeMessage({ id: "00000000-0000-0000-0000-000000000323" });
    const second = makeMessage({ id: "00000000-0000-0000-0000-000000000324" });
    let merged: ReturnType<typeof mergeSourceTerminalScopes>;
    const outcomes: string[] = [];
    let reentrantResult: number | undefined;
    eventBus.on("message:terminal", (event) => {
      outcomes.push(`${event.sourceMessageId}:${event.outcome}`);
      if (event.sourceMessageId === first.id) {
        reentrantResult = merged.publish("error", "inbound_rejected", 2_001);
      }
    });
    merged = mergeSourceTerminalScopes([
      createSourceTerminalScope({ eventBus }, first, "telegram"),
      createSourceTerminalScope({ eventBus }, second, "telegram"),
    ]);

    expect(merged.publish("success", "execution_completed", 2_000)).toBe(2);
    expect(reentrantResult).toBe(0);
    expect(outcomes).toEqual([
      `${first.id}:success`,
      `${second.id}:success`,
    ]);
  });

  it("keeps partial synthetic provenance persistence-only", () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const observed: string[] = [];
    eventBus.on("message:terminal", (event) => observed.push(event.sourceMessageId));
    const first = "00000000-0000-0000-0000-000000000311";
    const second = "00000000-0000-0000-0000-000000000312";
    const message = makeMessage({
      originalMessages: [
        {
          id: first,
          channelId: "chat:one",
          channelType: "telegram",
          senderId: "user-1",
          text: "one",
          timestamp: 1_000,
        },
        {
          id: second,
          channelId: "chat:one",
          channelType: "telegram",
          senderId: "user-1",
          text: "two",
          timestamp: 1_001,
        },
        {
          id: first,
          channelId: "chat:one",
          channelType: "telegram",
          senderId: "user-1",
          text: "duplicate",
          timestamp: 1_002,
        },
        {
          id: "00000000-0000-0000-0000-000000000313",
          channelId: "other-chat",
          channelType: "telegram",
          senderId: "user-1",
          text: "foreign",
          timestamp: 1_003,
        },
      ],
    });

    const emitted = createSourceTerminalScope(
      { eventBus, logger },
      message,
      "telegram",
    ).publish("success", "execution_completed", 2_000);

    expect(emitted).toBe(1);
    expect(observed).toEqual([message.id]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects an invalid top-level ingress identity without adopting provenance", () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const observed = vi.fn();
    eventBus.on("message:terminal", observed);
    const message = makeMessage({
      channelType: "slack",
      originalMessages: [{
        id: "00000000-0000-0000-0000-000000000314",
        channelId: "chat:one",
        channelType: "telegram",
        senderId: "user-1",
        text: "must remain persistence-only",
        timestamp: 1_000,
      }],
    });

    const scope = createSourceTerminalScope(
      { eventBus, logger },
      message,
      "telegram",
    );

    expect(scope.publish("error", "inbound_rejected", 2_000)).toBe(0);
    expect(scope.isPublished).toBe(false);
    expect(observed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "validation", rejectedCount: 1 }),
      "Rejected mismatched source-message terminal identity",
    );
  });

  it("contains one throwing observer and still notifies later observers", () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    const later = vi.fn();
    eventBus.on("message:terminal", () => {
      throw new Error("observer payload must remain contained");
    });
    eventBus.on("message:terminal", later);

    expect(createSourceTerminalScope(
      { eventBus, logger },
      makeMessage(),
      "telegram",
    ).publish("filtered", "gate_skipped", 2_000)).toBe(1);

    expect(later).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "message:terminal",
        subscriberFailurePhase: "sync",
        subscriberFailureCount: 1,
        firstListenerIndex: 0,
        errorKind: "internal",
      }),
      "Observational event subscriber failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "observer payload must remain contained",
    );
  });

  it("reports a rejected async terminal observer without an unhandled rejection", async () => {
    const eventBus = new TypedEventBus();
    const logger = createMockLogger();
    eventBus.on("message:terminal", async () => {
      await Promise.resolve();
      throw new Error("async terminal observer failed");
    });

    createSourceTerminalScope(
      { eventBus, logger },
      makeMessage(),
      "telegram",
    ).publish("success", "execution_completed", 2_000);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "message:terminal",
          subscriberFailurePhase: "async",
          subscriberFailureCount: 1,
          firstListenerIndex: 0,
          errorKind: "internal",
        }),
        "Observational event subscriber failed",
      );
    });
  });
});
