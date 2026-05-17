// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for message coalescing.
 *
 * Verifies that single messages pass through unchanged, multiple messages
 * are formatted with numbered delimiters, metadata is merged, attachments
 * are concatenated, and the latest timestamp is used.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { NormalizedMessage } from "@comis/core";
import { coalesceMessages } from "./coalescer.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coalesceMessages", () => {
  it("returns a single message unchanged", () => {
    const msg = createMockMessage("hello");
    const result = coalesceMessages([msg]);
    expect(result).toBe(msg); // exact same reference
  });

  it("formats two messages with numbered delimiters", () => {
    const msg1 = createMockMessage("first");
    const msg2 = createMockMessage("second");

    const result = coalesceMessages([msg1, msg2]);

    expect(result.text).toBe("[Message 1]: first\n\n[Message 2]: second");
  });

  it("formats three messages with numbered delimiters", () => {
    const msg1 = createMockMessage("alpha");
    const msg2 = createMockMessage("beta");
    const msg3 = createMockMessage("gamma");

    const result = coalesceMessages([msg1, msg2, msg3]);

    expect(result.text).toBe(
      "[Message 1]: alpha\n\n[Message 2]: beta\n\n[Message 3]: gamma",
    );
  });

  it("merges metadata with later values overriding earlier", () => {
    const msg1 = createMockMessage("first", {
      metadata: { key1: "val1", shared: "old" },
    });
    const msg2 = createMockMessage("second", {
      metadata: { key2: "val2", shared: "new" },
    });

    const result = coalesceMessages([msg1, msg2]);

    expect(result.metadata).toEqual({
      key1: "val1",
      key2: "val2",
      shared: "new",
    });
  });

  it("concatenates attachments from all messages", () => {
    const msg1 = createMockMessage("first", {
      attachments: [{ type: "image", url: "https://example.com/a.png" }],
    });
    const msg2 = createMockMessage("second", {
      attachments: [{ type: "file", url: "https://example.com/b.pdf" }],
    });

    const result = coalesceMessages([msg1, msg2]);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments![0]!.url).toBe("https://example.com/a.png");
    expect(result.attachments![1]!.url).toBe("https://example.com/b.pdf");
  });

  it("uses the latest timestamp from all messages", () => {
    const msg1 = createMockMessage("first", { timestamp: 1000 });
    const msg2 = createMockMessage("second", { timestamp: 3000 });
    const msg3 = createMockMessage("third", { timestamp: 2000 });

    const result = coalesceMessages([msg1, msg2, msg3]);

    expect(result.timestamp).toBe(3000);
  });

  it("uses channelId, channelType, and senderId from the last message", () => {
    const msg1 = createMockMessage("first", {
      channelId: "chan-1",
      channelType: "discord",
      senderId: "user-a",
    });
    const msg2 = createMockMessage("second", {
      channelId: "chan-2",
      channelType: "slack",
      senderId: "user-b",
    });

    const result = coalesceMessages([msg1, msg2]);

    expect(result.channelId).toBe("chan-2");
    expect(result.channelType).toBe("slack");
    expect(result.senderId).toBe("user-b");
  });

  it("throws when called with empty array", () => {
    expect(() => coalesceMessages([])).toThrow(
      "coalesceMessages requires at least one message",
    );
  });
});
