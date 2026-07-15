// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createSlackAdapter (slack-adapter.ts).
 *
 * Targets uncovered branches: editMessage/reactToMessage/removeReaction/
 * deleteMessage/fetchMessages/sendAttachment success+failure paths, voice
 * note attachment path, apiRoot E2E seam, action callback handler,
 * stop() with no app.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventHandlers = new Map<string, (...args: any[]) => void>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actionHandler: ((...args: any[]) => void) | null = null;

const mockAppStart = vi.fn();
const mockAppStop = vi.fn();
const mockPostMessage = vi.fn();
const mockChatUpdate = vi.fn();
const mockChatDelete = vi.fn();
const mockReactionsAdd = vi.fn();
const mockReactionsRemove = vi.fn();
const mockConversationsHistory = vi.fn();
const mockFilesUploadV2 = vi.fn();
let lastAppConfig: Record<string, unknown> = {};

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    lastAppConfig = config;
    return {
      _config: config,
      event(name: string, handler: (...args: unknown[]) => void) {
        eventHandlers.set(name, handler);
      },
      action(_pattern: unknown, handler: (...args: unknown[]) => void) {
        actionHandler = handler;
      },
      start: mockAppStart,
      stop: mockAppStop,
      client: {
        chat: {
          postMessage: mockPostMessage,
          update: mockChatUpdate,
          delete: mockChatDelete,
        },
        reactions: {
          add: mockReactionsAdd,
          remove: mockReactionsRemove,
        },
        conversations: {
          history: mockConversationsHistory,
        },
        files: {
          uploadV2: mockFilesUploadV2,
        },
      },
    };
  }),
}));

vi.mock("./credential-validator.js", () => ({
  validateSlackCredentials: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapSlackToNormalized: vi.fn(),
}));

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateSlackCredentials } from "./credential-validator.js";
import { createSlackAdapter, type SlackAdapterDeps } from "./slack-adapter.js";

function makeDeps(overrides?: Partial<SlackAdapterDeps>): SlackAdapterDeps {
  return {
    botToken: "xoxb-test-token",
    mode: "socket",
    appToken: "xapp-1-test-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  actionHandler = null;
  mockAppStart.mockResolvedValue(undefined);
  mockAppStop.mockResolvedValue(undefined);
  vi.mocked(validateSlackCredentials).mockResolvedValue(
    ok({ userId: "U1", teamId: "T1", botId: "B1" }),
  );
});

// ---------------------------------------------------------------------------
// apiRoot E2E seam
// ---------------------------------------------------------------------------

describe("createSlackAdapter apiRoot seam", () => {
  it("forwards apiRoot to Bolt App clientOptions.slackApiUrl when set on socket mode deps", async () => {
    const adapter = createSlackAdapter(
      makeDeps({ apiRoot: "http://127.0.0.1:54321" }),
    );
    await adapter.start();

    expect(lastAppConfig).toMatchObject({
      socketMode: true,
      clientOptions: { slackApiUrl: "http://127.0.0.1:54321" },
    });
  });

  it("forwards apiRoot via clientOptions for HTTP mode", async () => {
    const adapter = createSlackAdapter(
      makeDeps({
        mode: "http",
        signingSecret: "secret",
        appToken: undefined,
        apiRoot: "http://127.0.0.1:54322",
      }),
    );
    await adapter.start();

    expect(lastAppConfig).toMatchObject({
      signingSecret: "secret",
      clientOptions: { slackApiUrl: "http://127.0.0.1:54322" },
    });
  });

  it("omits clientOptions entirely when apiRoot is not provided", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();

    expect(lastAppConfig).not.toHaveProperty("clientOptions");
  });

  it("uses isAppTokenError hint when error message mentions socket mode", async () => {
    vi.mocked(validateSlackCredentials).mockResolvedValue(
      err(new Error("Socket Mode requires appToken to be set")),
    );
    const deps = makeDeps();
    const adapter = createSlackAdapter(deps);

    await adapter.start();

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("SLACK_APP_TOKEN"),
      }),
      "Adapter start failed",
    );
  });

  it("uses generic bot-token hint when error message does not mention socket mode", async () => {
    vi.mocked(validateSlackCredentials).mockResolvedValue(
      err(new Error("Token validation failed: invalid_auth")),
    );
    const deps = makeDeps();
    const adapter = createSlackAdapter(deps);

    await adapter.start();

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("SLACK_BOT_TOKEN"),
      }),
      "Adapter start failed",
    );
  });
});

// ---------------------------------------------------------------------------
// sendMessage failure path
// ---------------------------------------------------------------------------

describe("createSlackAdapter sendMessage failure path", () => {
  it("returns err and logs warning when chat.postMessage throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();

    mockPostMessage.mockRejectedValue(new Error("channel_not_found"));

    const result = await adapter.sendMessage("C123", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("channel_not_found");
    }
  });

  it("rethrows non-Error throwable from chat.postMessage by wrapping in Error", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();

    mockPostMessage.mockRejectedValue("string-error");

    const result = await adapter.sendMessage("C123", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("string-error");
    }
  });
});

// ---------------------------------------------------------------------------
// editMessage / reactToMessage / removeReaction / deleteMessage
// ---------------------------------------------------------------------------

describe("createSlackAdapter editMessage", () => {
  it("calls chat.update with text and ts", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockChatUpdate.mockResolvedValue(undefined);

    const result = await adapter.editMessage("C123", "msg-ts", "new text");

    expect(result.ok).toBe(true);
    expect(mockChatUpdate).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg-ts",
      text: "new text",
    });
  });

  it("returns err with descriptive message when chat.update throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockChatUpdate.mockRejectedValue(new Error("permission_denied"));

    const result = await adapter.editMessage("C123", "msg-ts", "text");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("permission_denied");
    }
  });
});

describe("createSlackAdapter reactToMessage", () => {
  it("strips leading and trailing colons from emoji short name", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockReactionsAdd.mockResolvedValue(undefined);

    await adapter.reactToMessage("C123", "msg-ts", ":thumbsup:");

    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "msg-ts",
      name: "thumbsup",
    });
  });

  it("returns err when reactions.add throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockReactionsAdd.mockRejectedValue(new Error("invalid_name"));

    const result = await adapter.reactToMessage("C123", "msg-ts", "👍");

    expect(result.ok).toBe(false);
  });
});

describe("createSlackAdapter removeReaction", () => {
  it("strips colons and calls reactions.remove", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockReactionsRemove.mockResolvedValue(undefined);

    const result = await adapter.removeReaction("C123", "msg-ts", ":fire:");

    expect(result.ok).toBe(true);
    expect(mockReactionsRemove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "msg-ts",
      name: "fire",
    });
  });

  it("returns err when reactions.remove throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockReactionsRemove.mockRejectedValue(new Error("no_reaction"));

    const result = await adapter.removeReaction("C123", "msg-ts", "fire");

    expect(result.ok).toBe(false);
  });
});

describe("createSlackAdapter deleteMessage", () => {
  it("returns ok and calls chat.delete with ts", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockChatDelete.mockResolvedValue(undefined);

    const result = await adapter.deleteMessage("C123", "msg-ts");

    expect(result.ok).toBe(true);
    expect(mockChatDelete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "msg-ts",
    });
  });

  it("returns err when chat.delete throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockChatDelete.mockRejectedValue(new Error("message_not_found"));

    const result = await adapter.deleteMessage("C123", "msg-ts");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchMessages
// ---------------------------------------------------------------------------

describe("createSlackAdapter fetchMessages", () => {
  it("maps Slack history into FetchedMessage[] with derived timestamp", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockConversationsHistory.mockResolvedValue({
      messages: [
        { ts: "1700000000.000100", user: "U1", text: "first" },
        { ts: "1700000010.000200", bot_id: "B2", text: "second" },
      ],
    });

    const result = await adapter.fetchMessages("C123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toMatchObject({
        id: "1700000000.000100",
        senderId: "U1",
        text: "first",
      });
      expect(result.value[1]).toMatchObject({
        id: "1700000010.000200",
        senderId: "B2",
      });
    }
  });

  it("passes options.limit and options.before to conversations.history", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockConversationsHistory.mockResolvedValue({ messages: [] });

    await adapter.fetchMessages("C123", {
      limit: 50,
      before: "1700000050.000",
    });

    expect(mockConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        latest: "1700000050.000",
      }),
    );
  });

  it("uses default limit=20 when not specified", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockConversationsHistory.mockResolvedValue({ messages: [] });

    await adapter.fetchMessages("C123");

    expect(mockConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("handles missing messages field by returning empty array", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockConversationsHistory.mockResolvedValue({});

    const result = await adapter.fetchMessages("C123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("returns err when conversations.history throws", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockConversationsHistory.mockRejectedValue(new Error("not_in_channel"));

    const result = await adapter.fetchMessages("C123");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendAttachment
// ---------------------------------------------------------------------------

describe("createSlackAdapter sendAttachment", () => {
  it("uploads file via files.uploadV2 and returns file id", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockFilesUploadV2.mockResolvedValue({ file: { id: "F123" } });

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/image.png",
      type: "image",
      mimeType: "image/png",
      fileName: "image.png",
      caption: "look",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("F123");
    }
    expect(mockFilesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123",
        filename: "image.png",
        initial_comment: "look",
      }),
    );
  });

  it("logs voice-send-started and voice-send-complete bookends when attachment is a voice note", async () => {
    const deps = makeDeps();
    const adapter = createSlackAdapter(deps);
    await adapter.start();
    mockFilesUploadV2.mockResolvedValue({ file: { id: "VOICE-1" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/voice.ogg",
      type: "audio",
      mimeType: "audio/ogg",
      isVoiceNote: true,
      durationSecs: 5,
      fileName: undefined,
    } as never);

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "slack",
        durationSecs: 5,
      }),
      "Voice send started",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "slack",
        messageId: "VOICE-1",
      }),
      "Voice send complete",
    );
  });

  it("defaults voice-note filename to voice-message.ogg when fileName is undefined", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockFilesUploadV2.mockResolvedValue({ file: { id: "V" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/voice.ogg",
      type: "audio",
      mimeType: "audio/ogg",
      isVoiceNote: true,
      durationSecs: 5,
    } as never);

    expect(mockFilesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "voice-message.ogg" }),
    );
  });

  it("defaults non-voice filename to 'file' when fileName is undefined", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockFilesUploadV2.mockResolvedValue({ file: { id: "F" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/doc.pdf",
      type: "document",
      mimeType: "application/pdf",
    } as never);

    expect(mockFilesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "file" }),
    );
  });

  it("returns err and logs warning when files.uploadV2 throws", async () => {
    const deps = makeDeps();
    const adapter = createSlackAdapter(deps);
    await adapter.start();
    mockFilesUploadV2.mockRejectedValue(new Error("file_too_large"));

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/big.zip",
      type: "document",
      mimeType: "application/zip",
      fileName: "big.zip",
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "slack",
        hint: expect.stringContaining("files:write"),
      }),
      "Send attachment failed",
    );
  });

  it("keeps attachment captions and filenames out of outbound logs", async () => {
    const privateCaption = "PRIVATE-SLACK-CAPTION-DO-NOT-LOG";
    const privateFileName = "PRIVATE-SLACK-FILENAME-DO-NOT-LOG.xlsx";
    const deps = makeDeps();
    const adapter = createSlackAdapter(deps);
    await adapter.start();
    mockFilesUploadV2.mockResolvedValue({ file: { id: "F-PRIVATE" } });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-caption.xlsx",
      type: "file",
      fileName: privateFileName,
      caption: privateCaption,
    });
    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-filename.xlsx",
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
// stop() with no app
// ---------------------------------------------------------------------------

describe("createSlackAdapter stop()", () => {
  it("returns ok when stop() is called before start() (no app yet)", async () => {
    const adapter = createSlackAdapter(makeDeps());
    const result = await adapter.stop();

    expect(result.ok).toBe(true);
    expect(mockAppStop).not.toHaveBeenCalled();
  });

  it("returns err when app.stop() throws after a successful start", async () => {
    const adapter = createSlackAdapter(makeDeps());
    await adapter.start();
    mockAppStop.mockRejectedValue(new Error("stop-failed"));

    const result = await adapter.stop();

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("createSlackAdapter getStatus", () => {
  it("reports connectionMode 'socket' on socket mode and 'webhook' on http mode", async () => {
    const socketAdapter = createSlackAdapter(makeDeps({ mode: "socket" }));
    expect(socketAdapter.getStatus()).toMatchObject({
      connectionMode: "socket",
    });
    const httpAdapter = createSlackAdapter(
      makeDeps({ mode: "http", signingSecret: "x", appToken: undefined }),
    );
    expect(httpAdapter.getStatus()).toMatchObject({
      connectionMode: "webhook",
    });
  });

  it("reports connected:true after successful start and connected:false initially", async () => {
    const adapter = createSlackAdapter(makeDeps());
    expect(adapter.getStatus().connected).toBe(false);

    await adapter.start();

    expect(adapter.getStatus().connected).toBe(true);
  });
});
