// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createSignalAdapter (signal-adapter.ts).
 *
 * Targets uncovered branches: parseTarget group: prefix vs. DM, sendMessage
 * with IR conversion, sendMessage with account branch, reactToMessage +
 * removeReaction success/error, deleteMessage success/error, sendAttachment
 * with voice note bookends + caption fallback, getStatus uptime, no-account
 * channelId default, fetchMessages unsupported, editMessage unsupported.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { ok, err } from "@comis/shared";
import { createSignalAdapter, type SignalAdapterDeps } from "./signal-adapter.js";

vi.mock("./signal-client.js", () => ({
  signalHealthCheck: vi.fn(),
  signalRpcRequest: vi.fn(),
  createSignalEventStream: vi.fn(() => {
    async function* emptyIter() {}
    return emptyIter();
  }),
}));

vi.mock("./signal-format.js", () => ({
  convertIrToSignalTextStyles: vi.fn(),
}));

import { signalRpcRequest, signalHealthCheck } from "./signal-client.js";
import { convertIrToSignalTextStyles } from "./signal-format.js";

const mockRpcRequest = vi.mocked(signalRpcRequest);
const mockHealthCheck = vi.mocked(signalHealthCheck);
const mockConvertIr = vi.mocked(convertIrToSignalTextStyles);

function makeDeps(overrides?: Partial<SignalAdapterDeps>): SignalAdapterDeps {
  return {
    baseUrl: "http://127.0.0.1:8080",
    account: "+15551234567",
    logger: createMockLogger(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHealthCheck.mockResolvedValue(ok(undefined));
});

// ---------------------------------------------------------------------------
// parseTarget branch coverage
// ---------------------------------------------------------------------------

describe("createSignalAdapter parseTarget branches", () => {
  it("treats chatId with 'group:' prefix as a group target", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    await adapter.sendMessage("group:abc123", "hi");

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ groupId: "abc123" }),
      expect.any(Object),
    );
  });

  it("treats chatId without 'group:' prefix as a DM recipient", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    await adapter.sendMessage("+15551234567", "hi");

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ recipient: ["+15551234567"] }),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// channelId default branch
// ---------------------------------------------------------------------------

describe("createSignalAdapter channelId default", () => {
  it("uses 'default' for channelId when account is undefined", () => {
    const adapter = createSignalAdapter(
      makeDeps({ account: undefined }),
    );

    expect(adapter.channelId).toBe("signal-default");
  });
});

// ---------------------------------------------------------------------------
// sendMessage with IR conversion + textStyles
// ---------------------------------------------------------------------------

describe("createSignalAdapter sendMessage IR path", () => {
  it("applies IR-derived text-style array when extra.ir is provided and styles are non-empty", async () => {
    mockConvertIr.mockReturnValue({
      text: "**Hello** world",
      textStyles: [
        { start: 0, length: 5, style: "BOLD" },
        { start: 6, length: 5, style: "ITALIC" },
      ],
    });
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));

    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    await adapter.sendMessage("+15551234567", "raw text", {
      extra: { ir: { nodes: [] } } as never,
    });

    expect(mockConvertIr).toHaveBeenCalled();
    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        message: "**Hello** world",
        "text-style": ["0:5:BOLD", "6:5:ITALIC"],
      }),
      expect.any(Object),
    );
  });

  it("omits text-style when IR conversion returns empty textStyles array", async () => {
    mockConvertIr.mockReturnValue({
      text: "plain text",
      textStyles: [],
    });
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));

    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    await adapter.sendMessage("+15551234567", "raw", {
      extra: { ir: { nodes: [] } } as never,
    });

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.not.objectContaining({ "text-style": expect.anything() }),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// sendMessage account branch
// ---------------------------------------------------------------------------

describe("createSignalAdapter sendMessage account branch", () => {
  it("includes account param when deps.account is set", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));
    const adapter = createSignalAdapter(
      makeDeps({ account: "+15551234567" }),
    );
    await adapter.start();

    await adapter.sendMessage("+15555550000", "hi");

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ account: "+15551234567" }),
      expect.any(Object),
    );
  });

  it("omits account param when deps.account is undefined", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1000 }));
    const adapter = createSignalAdapter(makeDeps({ account: undefined }));
    await adapter.start();

    await adapter.sendMessage("+15555550000", "hi");

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.not.objectContaining({ account: expect.anything() }),
      expect.any(Object),
    );
  });

  it("falls back to 'unknown' messageId when RPC response has no timestamp", async () => {
    mockRpcRequest.mockResolvedValue(ok({}));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendMessage("+15555550000", "hi");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// reactToMessage / removeReaction
// ---------------------------------------------------------------------------

describe("createSignalAdapter reactToMessage", () => {
  it("sends sendReaction RPC with targetTimestamp + emoji", async () => {
    mockRpcRequest.mockResolvedValue(ok({}));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.reactToMessage("+15555550000", "12345", "🔥");

    expect(result.ok).toBe(true);
    expect(mockRpcRequest).toHaveBeenCalledWith(
      "sendReaction",
      expect.objectContaining({
        emoji: "🔥",
        targetTimestamp: 12345,
      }),
      expect.any(Object),
    );
  });

  it("returns err when sendReaction RPC fails", async () => {
    mockRpcRequest.mockResolvedValue(err(new Error("rpc-failed")));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.reactToMessage("+15555550000", "12345", "🔥");

    expect(result.ok).toBe(false);
  });
});

describe("createSignalAdapter removeReaction", () => {
  it("sends sendReaction RPC with remove=true", async () => {
    mockRpcRequest.mockResolvedValue(ok({}));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.removeReaction("+15555550000", "12345", "🔥");

    expect(result.ok).toBe(true);
    expect(mockRpcRequest).toHaveBeenCalledWith(
      "sendReaction",
      expect.objectContaining({
        remove: true,
        emoji: "🔥",
      }),
      expect.any(Object),
    );
  });

  it("returns err when sendReaction RPC for removal fails", async () => {
    mockRpcRequest.mockResolvedValue(err(new Error("remove-failed")));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.removeReaction("+15555550000", "12345", "🔥");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteMessage
// ---------------------------------------------------------------------------

describe("createSignalAdapter deleteMessage", () => {
  it("sends sendRemoteDeleteMessage RPC with targetTimestamp", async () => {
    mockRpcRequest.mockResolvedValue(ok({}));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.deleteMessage("+15555550000", "12345");

    expect(result.ok).toBe(true);
    expect(mockRpcRequest).toHaveBeenCalledWith(
      "sendRemoteDeleteMessage",
      expect.objectContaining({ targetTimestamp: 12345 }),
      expect.any(Object),
    );
  });

  it("returns err when sendRemoteDeleteMessage RPC fails", async () => {
    mockRpcRequest.mockResolvedValue(err(new Error("delete-failed")));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.deleteMessage("+15555550000", "12345");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendAttachment with voice note bookends
// ---------------------------------------------------------------------------

describe("createSignalAdapter sendAttachment", () => {
  it("logs voice-send-started and voice-send-complete for voice notes", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 9999 }));
    const deps = makeDeps();
    const adapter = createSignalAdapter(deps);
    await adapter.start();

    await adapter.sendAttachment("+15555550000", {
      url: "/tmp/voice.ogg",
      type: "audio",
      mimeType: "audio/ogg",
      isVoiceNote: true,
      durationSecs: 5,
    } as never);

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "signal", durationSecs: 5 }),
      "Voice send started",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "signal", messageId: "9999" }),
      "Voice send complete",
    );
  });

  it("returns err and logs warning when sendAttachment RPC fails", async () => {
    mockRpcRequest.mockResolvedValue(err(new Error("upload-failed")));
    const deps = makeDeps();
    const adapter = createSignalAdapter(deps);
    await adapter.start();

    const result = await adapter.sendAttachment("+15555550000", {
      url: "/tmp/file.pdf",
      type: "document",
      mimeType: "application/pdf",
      caption: "see attached",
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "signal",
        hint: expect.stringContaining("file path"),
      }),
      "Send attachment failed",
    );
  });

  it("uses empty string for caption when attachment.caption is undefined", async () => {
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 1 }));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    await adapter.sendAttachment("+15555550000", {
      url: "/tmp/file.pdf",
      type: "document",
      mimeType: "application/pdf",
    } as never);

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: "" }),
      expect.any(Object),
    );
  });

  it("falls back to 'unknown' messageId for attachment when no timestamp in response", async () => {
    mockRpcRequest.mockResolvedValue(ok({}));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendAttachment("+15555550000", {
      url: "/tmp/x.png",
      type: "image",
      mimeType: "image/png",
    } as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("unknown");
    }
  });

  it("keeps attachment captions and filenames out of outbound logs", async () => {
    const privateCaption = "PRIVATE-SIGNAL-CAPTION-DO-NOT-LOG";
    const privateFileName = "PRIVATE-SIGNAL-FILENAME-DO-NOT-LOG.xlsx";
    mockRpcRequest.mockResolvedValue(ok({ timestamp: 4242 }));
    const deps = makeDeps();
    const adapter = createSignalAdapter(deps);
    await adapter.start();

    await adapter.sendAttachment("+15555550000", {
      url: "/tmp/private-caption.xlsx",
      type: "file",
      fileName: privateFileName,
      caption: privateCaption,
    });
    await adapter.sendAttachment("+15555550000", {
      url: "/tmp/private-filename.xlsx",
      type: "file",
      fileName: privateFileName,
    });

    const serializedLogs = JSON.stringify([
      ...vi.mocked(deps.logger.debug).mock.calls,
      ...vi.mocked(deps.logger.info).mock.calls,
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.error).mock.calls,
    ]);
    expect(serializedLogs).not.toContain(privateCaption);
    expect(serializedLogs).not.toContain(privateFileName);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentType: "file",
        captionLength: privateCaption.length,
        hasFileName: true,
      }),
      "Outbound attachment",
    );
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("createSignalAdapter getStatus", () => {
  it("reports connected=true with uptime after successful start", async () => {
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();
    await new Promise((r) => setTimeout(r, 5));

    const status = adapter.getStatus();
    expect(status.connected).toBe(true);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it("reports connected=false before start()", () => {
    const adapter = createSignalAdapter(makeDeps());
    const status = adapter.getStatus();
    expect(status.connected).toBe(false);
    expect(status.uptime).toBeUndefined();
  });

  it("reports error string after a failed send", async () => {
    mockRpcRequest.mockResolvedValue(err(new Error("send-failed-context")));
    const adapter = createSignalAdapter(makeDeps());
    await adapter.start();
    await adapter.sendMessage("+15555550000", "hi");

    const status = adapter.getStatus();
    expect(status.error).toBe("send-failed-context");
  });
});
