// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for overflow policy application.
 *
 * Verifies that each overflow policy (drop-old, drop-new, summarize)
 * behaves correctly and that events are emitted for observability.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  TypedEventBus,
  type NormalizedMessage,
  type SessionKey,
  type OverflowConfig,
} from "@comis/core";
import { applyOverflowPolicy } from "./overflow.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMessage(
  text: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user1",
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

const SESSION_KEY: SessionKey = {
  tenantId: "default",
  userId: "user1",
  channelId: "test-channel",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyOverflowPolicy", () => {
  it("returns all messages unchanged when under maxDepth", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    const config: OverflowConfig = { maxDepth: 20, policy: "drop-old" };
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages); // same reference
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("drop-old: removes oldest messages to bring count within maxDepth", () => {
    const messages = Array.from({ length: 25 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    const config: OverflowConfig = { maxDepth: 20, policy: "drop-old" };
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    expect(result.dropped).toBe(5);
    expect(result.messages).toHaveLength(20);
    // The remaining messages should be the newest 20 (indices 5-24)
    expect(result.messages[0]!.text).toBe("msg-5");
    expect(result.messages[19]!.text).toBe("msg-24");
  });

  it("drop-new: removes the last message (newest) to maintain maxDepth", () => {
    // 21 messages with maxDepth=20 triggers overflow
    const messages = Array.from({ length: 21 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    const config: OverflowConfig = { maxDepth: 20, policy: "drop-new" };
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(20);
    // First 20 messages preserved, the 21st dropped
    expect(result.messages[0]!.text).toBe("msg-0");
    expect(result.messages[19]!.text).toBe("msg-19");
  });

  it("summarize: concatenates all messages into a single synthetic message", () => {
    const messages = Array.from({ length: 25 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    const config: OverflowConfig = { maxDepth: 20, policy: "summarize" };
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    expect(result.dropped).toBe(24); // 25 messages -> 1 synthetic = 24 dropped
    expect(result.messages).toHaveLength(1);

    const synthetic = result.messages[0]!;
    expect(synthetic.text).toContain("[Summarized from 25 messages]:");
    // All message texts joined with "---" separator
    expect(synthetic.text).toContain("msg-0");
    expect(synthetic.text).toContain("msg-24");
    expect(synthetic.text).toContain("---");

    // Verify the format: texts joined with \n---\n
    const expectedTexts = messages.map((m) => m.text).join("\n---\n");
    expect(synthetic.text).toBe(
      `[Summarized from 25 messages]:\n${expectedTexts}`,
    );
  });

  it("emits queue:overflow event with correct payload", () => {
    const messages = Array.from({ length: 25 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    const config: OverflowConfig = { maxDepth: 20, policy: "drop-old" };
    const eventBus = createMockEventBus();

    applyOverflowPolicy(messages, config, eventBus, SESSION_KEY, "telegram");

    expect(eventBus.emit).toHaveBeenCalledOnce();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "queue:overflow",
      expect.objectContaining({
        sessionKey: SESSION_KEY,
        channelType: "telegram",
        policy: "drop-old",
        droppedCount: 5,
      }),
    );
  });

  it("reports rejected async overflow observers after preserving mutation", async () => {
    const eventBus = new TypedEventBus();
    const onEventError = vi.fn();
    eventBus.on("queue:overflow", async () => {
      await Promise.resolve();
      throw new Error("async overflow observer failed");
    });
    const messages = [createMockMessage("one"), createMockMessage("two")];

    const result = applyOverflowPolicy(
      messages,
      { maxDepth: 1, policy: "drop-new" },
      eventBus,
      SESSION_KEY,
      "telegram",
      onEventError,
    );

    expect(result.messages).toEqual([messages[0]]);
    await vi.waitFor(() => {
      expect(onEventError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "async overflow observer failed" }),
      );
    });
  });

  it("does not emit event when no overflow occurs", () => {
    const messages = [createMockMessage("hello")];
    const config: OverflowConfig = { maxDepth: 20, policy: "drop-old" };
    const eventBus = createMockEventBus();

    applyOverflowPolicy(messages, config, eventBus, SESSION_KEY, "telegram");

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("summarize: merges metadata and concatenates attachments", () => {
    const messages = [
      createMockMessage("first", {
        metadata: { key1: "val1", shared: "old" },
        attachments: [
          { type: "image", url: "https://example.com/a.png" },
        ],
      }),
      createMockMessage("second", {
        metadata: { key2: "val2", shared: "new" },
        attachments: [
          { type: "file", url: "https://example.com/b.pdf" },
        ],
      }),
    ];
    const config: OverflowConfig = { maxDepth: 1, policy: "summarize" };
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    const synthetic = result.messages[0]!;
    expect(synthetic.metadata).toEqual({
      key1: "val1",
      key2: "val2",
      shared: "new", // later overrides earlier
    });
    expect(synthetic.attachments).toHaveLength(2);
  });

  it("summarize preserves physical inbound provenance instead of the synthetic body", () => {
    const first = createMockMessage("first exact body", {
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: 1_750_000_000_001,
    });
    const second = createMockMessage("second exact body", {
      id: "22222222-2222-4222-8222-222222222222",
      timestamp: 1_750_000_000_002,
    });
    const eventBus = createMockEventBus();

    const result = applyOverflowPolicy(
      [first, second],
      { maxDepth: 1, policy: "summarize" },
      eventBus,
      SESSION_KEY,
      "telegram",
    );

    expect(result.messages[0]!.originalMessages?.map(({ id, text, timestamp }) => ({
      id,
      text,
      timestamp,
    }))).toEqual([
      { id: first.id, text: first.text, timestamp: first.timestamp },
      { id: second.id, text: second.text, timestamp: second.timestamp },
    ]);
  });

  it("keeps exactly maxDepth messages without invoking any overflow policy", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      createMockMessage(`msg-${i}`),
    );
    for (const policy of ["drop-old", "drop-new", "summarize"] as const) {
      const eventBus = createMockEventBus();
      const result = applyOverflowPolicy(
        messages,
        { maxDepth: 20, policy },
        eventBus,
        SESSION_KEY,
        "telegram",
      );

      expect(result).toEqual({ dropped: 0, messages });
      expect(eventBus.emit).not.toHaveBeenCalled();
    }
  });
});
