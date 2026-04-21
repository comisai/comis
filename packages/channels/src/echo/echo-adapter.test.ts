// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { NormalizedMessage } from "@comis/core";
import { EchoChannelAdapter } from "./echo-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "echo-test",
    channelType: "cli",
    senderId: "user-1",
    text: "Hello from test",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EchoChannelAdapter", () => {
  let adapter: EchoChannelAdapter;

  beforeEach(() => {
    adapter = new EchoChannelAdapter();
  });

  describe("constructor", () => {
    it("uses default channelId and channelType", () => {
      expect(adapter.channelId).toBe("echo-test");
      expect(adapter.channelType).toBe("echo");
    });

    it("accepts custom channelId and channelType", () => {
      const custom = new EchoChannelAdapter({
        channelId: "custom-id",
        channelType: "custom-type",
      });
      expect(custom.channelId).toBe("custom-id");
      expect(custom.channelType).toBe("custom-type");
    });
  });

  describe("lifecycle", () => {
    it("start() sets running to true", async () => {
      expect(adapter.isRunning()).toBe(false);
      const result = await adapter.start();
      expect(result.ok).toBe(true);
      expect(adapter.isRunning()).toBe(true);
    });

    it("stop() sets running to false", async () => {
      await adapter.start();
      expect(adapter.isRunning()).toBe(true);

      const result = await adapter.stop();
      expect(result.ok).toBe(true);
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("stores message and returns ok with ID", async () => {
      const result = await adapter.sendMessage("ch-1", "Hello world");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("echo-msg-0");
      }

      const sent = adapter.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.channelId).toBe("ch-1");
      expect(sent[0]!.text).toBe("Hello world");
    });

    it("increments message counter for each send", async () => {
      const r1 = await adapter.sendMessage("ch-1", "First");
      const r2 = await adapter.sendMessage("ch-1", "Second");

      expect(r1.ok && r1.value).toBe("echo-msg-0");
      expect(r2.ok && r2.value).toBe("echo-msg-1");
      expect(adapter.getSentMessages()).toHaveLength(2);
    });

    it("stores options when provided", async () => {
      await adapter.sendMessage("ch-1", "Reply", { replyTo: "msg-42" });

      const sent = adapter.getSentMessages();
      expect(sent).toHaveLength(1);
    });
  });

  describe("editMessage", () => {
    it("stores edit and returns ok", async () => {
      const result = await adapter.editMessage("ch-1", "msg-1", "Updated text");

      expect(result.ok).toBe(true);
      expect(adapter.getEditedMessages().get("msg-1")).toBe("Updated text");
    });

    it("overwrites previous edit for same message", async () => {
      await adapter.editMessage("ch-1", "msg-1", "Edit 1");
      await adapter.editMessage("ch-1", "msg-1", "Edit 2");

      expect(adapter.getEditedMessages().get("msg-1")).toBe("Edit 2");
    });
  });

  describe("reactToMessage", () => {
    it("stores reaction and returns ok", async () => {
      const result = await adapter.reactToMessage("ch-1", "msg-1", "thumbsup");

      expect(result.ok).toBe(true);
      const reaction = adapter.getReactions().get("msg-1");
      expect(reaction).toEqual({ emoji: "thumbsup", channelId: "ch-1" });
    });
  });

  describe("deleteMessage", () => {
    it("stores deletion and returns ok", async () => {
      const result = await adapter.deleteMessage("ch-1", "msg-1");

      expect(result.ok).toBe(true);
      expect(adapter.getDeletedMessages().has("msg-1")).toBe(true);
    });

    it("handles multiple deletions", async () => {
      await adapter.deleteMessage("ch-1", "msg-1");
      await adapter.deleteMessage("ch-1", "msg-2");

      expect(adapter.getDeletedMessages().size).toBe(2);
    });
  });

  describe("fetchMessages", () => {
    it("returns stored messages for the specified channel", async () => {
      await adapter.sendMessage("ch-1", "Message A");
      await adapter.sendMessage("ch-2", "Message B");
      await adapter.sendMessage("ch-1", "Message C");

      const result = await adapter.fetchMessages("ch-1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]!.text).toBe("Message A");
        expect(result.value[1]!.text).toBe("Message C");
      }
    });

    it("respects limit option", async () => {
      await adapter.sendMessage("ch-1", "A");
      await adapter.sendMessage("ch-1", "B");
      await adapter.sendMessage("ch-1", "C");

      const result = await adapter.fetchMessages("ch-1", { limit: 2 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it("returns empty array when no messages match", async () => {
      const result = await adapter.fetchMessages("nonexistent");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });

  describe("sendAttachment", () => {
    it("stores as message with attachment info and returns ok", async () => {
      const result = await adapter.sendAttachment("ch-1", {
        type: "image",
        url: "https://example.com/pic.png",
        fileName: "pic.png",
        caption: "A picture",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("echo-msg-0");
      }

      const sent = adapter.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toBe("[image:pic.png] A picture");
    });

    it("uses URL when fileName is not provided", async () => {
      await adapter.sendAttachment("ch-1", {
        type: "file",
        url: "https://example.com/doc.pdf",
      });

      const sent = adapter.getSentMessages();
      expect(sent[0]!.text).toBe("[file:https://example.com/doc.pdf]");
    });
  });

  describe("platformAction", () => {
    it("returns echoed action with params", async () => {
      const result = await adapter.platformAction("custom_action", { key: "value" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          action: "custom_action",
          params: { key: "value" },
          echoed: true,
        });
      }
    });
  });

  describe("onMessage + injectMessage", () => {
    it("handler receives injected messages", async () => {
      const received: NormalizedMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
      });

      const msg = makeMessage({ text: "Injected!" });
      await adapter.injectMessage(msg);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Injected!");
    });

    it("multiple handlers all receive the message", async () => {
      let count = 0;
      adapter.onMessage(() => {
        count++;
      });
      adapter.onMessage(() => {
        count++;
      });

      await adapter.injectMessage(makeMessage());

      expect(count).toBe(2);
    });

    it("async handlers are awaited", async () => {
      const order: number[] = [];
      adapter.onMessage(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      });
      adapter.onMessage(async () => {
        order.push(2);
      });

      await adapter.injectMessage(makeMessage());

      expect(order).toEqual([1, 2]);
    });
  });

  describe("reset", () => {
    it("clears all state", async () => {
      // Populate state
      await adapter.start();
      await adapter.sendMessage("ch-1", "Hello");
      await adapter.editMessage("ch-1", "msg-1", "Edited");
      await adapter.reactToMessage("ch-1", "msg-1", "thumbsup");
      await adapter.deleteMessage("ch-1", "msg-2");
      adapter.onMessage(() => {});

      // Reset
      adapter.reset();

      // Verify all cleared
      expect(adapter.isRunning()).toBe(false);
      expect(adapter.getSentMessages()).toHaveLength(0);
      expect(adapter.getEditedMessages().size).toBe(0);
      expect(adapter.getReactions().size).toBe(0);
      expect(adapter.getDeletedMessages().size).toBe(0);

      // Counter should be reset - new message gets echo-msg-0 again
      const result = await adapter.sendMessage("ch-1", "After reset");
      expect(result.ok && result.value).toBe("echo-msg-0");
    });
  });
});
