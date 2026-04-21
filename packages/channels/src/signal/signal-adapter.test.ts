// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSignalAdapter, type SignalAdapterDeps } from "./signal-adapter.js";

// Mock the signal client module
vi.mock("./signal-client.js", () => ({
  signalHealthCheck: vi.fn(),
  signalRpcRequest: vi.fn(),
  createSignalEventStream: vi.fn(),
}));

// Mock the signal format module
vi.mock("./signal-format.js", () => ({
  convertIrToSignalTextStyles: vi.fn(),
}));

import { signalHealthCheck, signalRpcRequest } from "./signal-client.js";
import { convertIrToSignalTextStyles } from "./signal-format.js";

const mockHealthCheck = vi.mocked(signalHealthCheck);
const mockRpcRequest = vi.mocked(signalRpcRequest);
const mockConvertIr = vi.mocked(convertIrToSignalTextStyles);

function makeDeps(overrides?: Partial<SignalAdapterDeps>): SignalAdapterDeps {
  return {
    baseUrl: "http://127.0.0.1:8080",
    account: "+15551234567",
    logger: createMockLogger(),
    ...overrides,
  };
}

describe("createSignalAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("channelId and channelType", () => {
    it("returns correct channelType", () => {
      const adapter = createSignalAdapter(makeDeps());
      expect(adapter.channelType).toBe("signal");
    });

    it("returns channelId with account", () => {
      const adapter = createSignalAdapter(makeDeps({ account: "+15551234567" }));
      expect(adapter.channelId).toBe("signal-+15551234567");
    });

    it("returns channelId with default when no account", () => {
      const adapter = createSignalAdapter(makeDeps({ account: undefined }));
      expect(adapter.channelId).toBe("signal-default");
    });
  });

  describe("start()", () => {
    it("fails if health check fails", async () => {
      mockHealthCheck.mockResolvedValue({
        ok: false,
        error: new Error("Connection refused"),
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.start();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Connection refused");
      }
    });

    it("succeeds if health check passes", async () => {
      mockHealthCheck.mockResolvedValue({ ok: true, value: undefined });

      // Mock createSignalEventStream to return an empty async generator
      const { createSignalEventStream } = await import("./signal-client.js");
      vi.mocked(createSignalEventStream).mockImplementation(async function* () {
        // Empty stream
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.start();
      expect(result.ok).toBe(true);
    });
  });

  describe("stop()", () => {
    it("stops successfully", async () => {
      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.stop();
      expect(result.ok).toBe(true);
    });
  });

  describe("sendMessage()", () => {
    it("sends to DM recipient", async () => {
      mockRpcRequest.mockResolvedValue({
        ok: true,
        value: { timestamp: 1234567890 },
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.sendMessage(
        "uuid-1234",
        "Hello Signal!",
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("1234567890");
      }

      expect(mockRpcRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          recipient: ["uuid-1234"],
          message: "Hello Signal!",
          account: "+15551234567",
        }),
        expect.objectContaining({ baseUrl: "http://127.0.0.1:8080" }),
      );
    });

    it("sends to group", async () => {
      mockRpcRequest.mockResolvedValue({
        ok: true,
        value: { timestamp: 1234567890 },
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.sendMessage(
        "group:abc123",
        "Hello Group!",
      );

      expect(result.ok).toBe(true);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          groupId: "abc123",
          message: "Hello Group!",
        }),
        expect.any(Object),
      );
    });

    it("converts IR to text styles when IR is provided", async () => {
      mockRpcRequest.mockResolvedValue({
        ok: true,
        value: { timestamp: 1234567890 },
      });
      mockConvertIr.mockReturnValue({
        text: "Hello bold",
        textStyles: [{ start: 6, length: 4, style: "BOLD" }],
      });

      const adapter = createSignalAdapter(makeDeps());
      const fakeIr = { blocks: [], sourceLength: 0 };
      const result = await adapter.sendMessage("uuid-1234", "Hello **bold**", {
        extra: { ir: fakeIr },
      });

      expect(result.ok).toBe(true);
      expect(mockConvertIr).toHaveBeenCalledWith(fakeIr);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          message: "Hello bold",
          "text-style": ["6:4:BOLD"],
        }),
        expect.any(Object),
      );
    });

    it("returns error when RPC fails", async () => {
      mockRpcRequest.mockResolvedValue({
        ok: false,
        error: new Error("RPC failed"),
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.sendMessage("uuid-1234", "Hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("RPC failed");
      }
    });
  });

  describe("editMessage()", () => {
    it("returns not supported error", async () => {
      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.editMessage("chat", "msg", "new text");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not supported");
      }
    });
  });

  describe("fetchMessages()", () => {
    it("returns not supported error", async () => {
      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.fetchMessages("chat");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not supported");
      }
    });
  });

  describe("reactToMessage()", () => {
    it("sends reaction via RPC", async () => {
      mockRpcRequest.mockResolvedValue({ ok: true, value: undefined });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.reactToMessage("uuid-1234", "1234567890", "\u{1F44D}");

      expect(result.ok).toBe(true);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "sendReaction",
        expect.objectContaining({
          emoji: "\u{1F44D}",
          targetTimestamp: 1234567890,
        }),
        expect.any(Object),
      );
    });
  });

  describe("deleteMessage()", () => {
    it("sends remote delete via RPC", async () => {
      mockRpcRequest.mockResolvedValue({ ok: true, value: undefined });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.deleteMessage("uuid-1234", "1234567890");

      expect(result.ok).toBe(true);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "sendRemoteDeleteMessage",
        expect.objectContaining({
          targetTimestamp: 1234567890,
        }),
        expect.any(Object),
      );
    });
  });

  describe("sendAttachment()", () => {
    it("sends attachment via RPC", async () => {
      mockRpcRequest.mockResolvedValue({
        ok: true,
        value: { timestamp: 1234567890 },
      });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.sendAttachment("uuid-1234", {
        type: "image",
        url: "/path/to/image.jpg",
        caption: "A photo",
      });

      expect(result.ok).toBe(true);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          message: "A photo",
          attachments: ["/path/to/image.jpg"],
        }),
        expect.any(Object),
      );
    });
  });

  describe("platformAction()", () => {
    it("sends typing indicator", async () => {
      mockRpcRequest.mockResolvedValue({ ok: true, value: undefined });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.platformAction("sendTyping", {
        chatId: "uuid-1234",
      });

      expect(result.ok).toBe(true);
      expect(mockRpcRequest).toHaveBeenCalledWith(
        "sendTyping",
        expect.objectContaining({ recipient: ["uuid-1234"] }),
        expect.any(Object),
      );
    });

    it("sends reaction via platformAction", async () => {
      mockRpcRequest.mockResolvedValue({ ok: true, value: undefined });

      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.platformAction("sendReaction", {
        chatId: "uuid-1234",
        emoji: "\u{1F44D}",
        messageId: "1234567890",
      });

      expect(result.ok).toBe(true);
    });

    it("returns error for unsupported action", async () => {
      const adapter = createSignalAdapter(makeDeps());
      const result = await adapter.platformAction("unknown", {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported action");
      }
    });
  });

  describe("onMessage()", () => {
    it("registers handler", () => {
      const adapter = createSignalAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      // No error means success -- handlers are invoked by the event loop
    });
  });
});
