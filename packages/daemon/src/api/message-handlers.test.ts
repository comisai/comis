// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMessageHandlers as createMessageHandlersRaw, type MessageHandlerDeps } from "./message-handlers.js";
import type { RpcHandler } from "./types.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { ok, err } from "@comis/shared";
import {
  createDeliveryService,
  createNoOpDeliveryQueue,
  createRetryEngine,
  DeliveryQueueTransitionError,
  formatSessionKey,
  runWithContext,
  TypedEventBus,
  type AttachmentPayload,
  type ChannelCapability,
  type ChannelPluginPort,
  type ChannelPort,
  type DeliveryService,
  type DeliveryResult,
  type HookRunner,
  type OutwardSendLedgerPort,
  type SessionKey,
} from "@comis/core";
import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";

// The orch:message-gated handlers are message.send/
// reply/react ONLY (the genuinely-outward send subset). They require an injected
// _capabilities (production supplies it via createAgentRpcCall). Wrap the bound
// record so these body-tests reach the handler BODY, not the gate. message.edit/
// delete/fetch/attach are admin-only (deny-by-origin) and carry NO in-handler
// cap gate — the wrapper's injected caps are inert for them.
function createMessageHandlers(deps: MessageHandlerDeps): Record<string, RpcHandler> {
  return withHeldCapabilities(createMessageHandlersRaw(deps));
}

// MessageHandlerDeps requires a DeliveryService. The fake delegates to
// adapter.sendMessage so existing message.send / message.reply assertions on
// adapter.sendMessage stay valid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake
function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string, options?: any) => {
      const sendOpts: any = {};
      if (options?.replyTo) sendOpts.replyTo = options.replyTo;
      if (options?.threadId) sendOpts.threadId = options.threadId;
      if (options?.extra) sendOpts.extra = options.extra;
      const result = await adapter.sendMessage(channelId, text, Object.keys(sendOpts).length > 0 ? sendOpts : undefined);
      return ok({
        chunks: result.ok
          ? [{ status: "accepted" as const, messageId: result.value, charCount: text.length, retried: false }]
          : [{
              status: "rejected" as const,
              error: result.error,
              errorKind: "platform" as const,
              charCount: text.length,
              retried: false,
            }],
        totalChars: text.length,
        platform: result.ok
          ? { status: "accepted" as const, deliveredChunks: 1, settledAtMs: 1, lastMessageId: result.value }
          : {
              status: "rejected" as const,
              errorKind: "platform" as const,
              deliveredChunks: 0,
              failedChunks: 1,
              settledAtMs: 1,
            },
        queueDisposition: "settled" as const,
      });
    }),
    // DeliveryService gained drainInFlight().
    // Default fake returns empty drain telemetry; tests that exercise drain
    // semantics override this field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeQueueTransitionError(messageId = "platform-msg-1"): DeliveryQueueTransitionError {
  const platformResult: DeliveryResult = {
    chunks: [{ status: "accepted", messageId, charCount: 5, retried: false }],
    totalChars: 5,
    platform: { status: "accepted", deliveredChunks: 1, settledAtMs: 1, lastMessageId: messageId },
    queueDisposition: "transition_failed",
  };
  return new DeliveryQueueTransitionError([{
    transition: "ack",
    deliveryId: "entry-1",
    errorKind: "dependency",
    cause: new Error("ack write failed"),
  }], platformResult);
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(): ChannelPort {
  return {
    channelId: "test-ch",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    reactToMessage: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok({
      kind: "tracked",
      messageId: "attach-1",
    })),
    platformAction: vi.fn(async () => ok({})),
    onMessage: vi.fn(),
  };
}

function createMockDeps(workspaceDir: string): MessageHandlerDeps {
  const adapter = createMockAdapter();
  return {
    adaptersByType: new Map([["telegram", adapter]]),
    workspaceDirs: new Map([["agent-1", workspaceDir]]),
    defaultWorkspaceDir: workspaceDir,
    defaultAgentId: "agent-1",
    // channelPlugins is REQUIRED on ChannelsApiDeps. Default to an empty
    // Map; per-test overrides (capability guard suite) replace this with
    // a populated Map. Empty Map maps `assertCapability` to the
    // "unknown channel type → skip" branch (`plugins.get() === undefined`),
    // matching prior behavior of message.send / fetch / etc. in tests that
    // don't exercise the plugin gate.
    channelPlugins: new Map<string, ChannelPluginPort>(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as MessageHandlerDeps["logger"],
    deliveryService: makeFakeDeliveryService(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("message.attach handler", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-"));
    writeFileSync(join(workspaceDir, "output.zip"), "fake-zip-content");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("HTTP URL passes through unchanged to adapter", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "attach-1" },
      channelId: "123",
    });
    expect(adapter.sendAttachment).toHaveBeenCalledWith("123", expect.objectContaining({
      url: "https://example.com/file.pdf",
    }));
  });

  it("file:// URL resolves to local path and calls adapter", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;
    const filePath = join(workspaceDir, "output.zip");

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: `file://${filePath}`,
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "attach-1" },
      channelId: "123",
    });
    expect(adapter.sendAttachment).toHaveBeenCalledWith("123", expect.objectContaining({
      url: filePath,
    }));
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, sizeBytes: expect.any(Number) }),
      "Local file attachment resolved",
    );
  });

  it("absolute path resolves correctly and calls adapter", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;
    const filePath = join(workspaceDir, "output.zip");

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: filePath,
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "attach-1" },
      channelId: "123",
    });
    expect(adapter.sendAttachment).toHaveBeenCalledWith("123", expect.objectContaining({
      url: filePath,
    }));
  });

  it("path outside workspace throws error (path traversal blocked)", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.attach"]({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: "/etc/passwd",
        attachment_type: "file",
      }),
    ).rejects.toThrow("Attachment path blocked");
  });

  it("path traversal with ../ is blocked", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.attach"]({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: `${workspaceDir}/../../etc/passwd`,
        attachment_type: "file",
      }),
    ).rejects.toThrow("Attachment path blocked");
  });

  it("nonexistent file throws 'not found' error", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);
    const missingFile = join(workspaceDir, "nonexistent.pdf");

    await expect(
      handlers["message.attach"]({
        channel_type: "telegram",
        channel_id: "123",
        attachment_url: missingFile,
        attachment_type: "file",
      }),
    ).rejects.toThrow(`Attachment file not found: ${missingFile}`);
  });

  it("file:// URL with encoded spaces resolves correctly", async () => {
    const subDir = join(workspaceDir, "my files");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "report.pdf"), "fake-pdf");

    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;
    const expectedPath = join(subDir, "report.pdf");

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: `file://${expectedPath.replace(/ /g, "%20")}`,
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "attach-1" },
      channelId: "123",
    });
    expect(adapter.sendAttachment).toHaveBeenCalledWith("123", expect.objectContaining({
      url: expectedPath,
    }));
  });

  it("returns delivered-untracked without throwing after a completed send", async () => {
    const deps = createMockDeps(workspaceDir);
    const adapter = deps.adaptersByType.get("telegram")!;
    vi.mocked(adapter.sendAttachment!).mockResolvedValueOnce(ok({
      kind: "delivered_untracked",
    }));
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "delivered_untracked" },
      channelId: "123",
    });
  });

  it("preserves the adapter receiver when invoking a class-style attachment method", async () => {
    const deps = createMockDeps(workspaceDir);
    const adapter = deps.adaptersByType.get("telegram")!;
    adapter.sendAttachment = async function (this: ChannelPort) {
      return ok({
        kind: "tracked" as const,
        messageId: `${this.channelType}-attachment`,
      });
    };
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "telegram-attachment" },
      channelId: "123",
    });
  });
});

// ---------------------------------------------------------------------------
// Gateway attachment tests
// ---------------------------------------------------------------------------

describe("message.attach gateway channel_type", () => {
  let workspaceDir: string;
  let mediaDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-gw-"));
    mediaDir = join(workspaceDir, "media");
    mkdirSync(mediaDir);
    writeFileSync(join(workspaceDir, "photo.png"), "fake-png-content");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("copies media and notifies only the authenticated client for the active session", async () => {
    const sendToClientId = vi.fn(() => true);
    const broadcast = vi.fn(() => true);
    const persistAttachment = vi.fn();
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { sendToClientId, broadcast } as unknown as NonNullable<MessageHandlerDeps["wsConnections"]>;
    deps.mediaDir = mediaDir;
    deps.onGatewayAttachment = persistAttachment;

    const handlers = createMessageHandlers(deps);
    const filePath = join(workspaceDir, "photo.png");
    const requestSessionKey: SessionKey = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      userId: "user_a",
      channelId: "gateway:dashboard-a:web-chat",
      peerId: "user_a",
    };
    const turnScope = {
      conversation: {
        tenantId: "tenant-a",
        agentId: "agent-a",
        partition: {
          kind: "endpoint-conversation-principal" as const,
          endpoint: {
            channelType: "gateway",
            channelInstanceId: "dashboard-a",
            conversationId: "web-chat",
            conversationKind: "direct" as const,
          },
          principalId: "user_a",
        },
      },
      principal: { principalId: "user_a" },
      endpoint: {
        channelType: "gateway",
        channelInstanceId: "dashboard-a",
        conversationId: "web-chat",
        conversationKind: "direct" as const,
      },
    };

    const result = await runWithContext({
      tenantId: requestSessionKey.tenantId,
      userId: requestSessionKey.userId,
      sessionKey: formatSessionKey(requestSessionKey),
      agentId: "agent-a",
      turnScope,
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      startedAt: 1_700_000_000_000,
      trustLevel: "user",
      clientId: "dashboard-a",
    }, () => handlers["message.attach"]({
        channel_type: "gateway",
        channel_id: "gateway:dashboard-a:web-chat",
        attachment_url: filePath,
        attachment_type: "image",
        mime_type: "image/png",
        file_name: "photo.png",
        caption: "A nice photo",
      }));

    // Returns the gateway media ID as a tracked attachment receipt.
    expect(result).toHaveProperty("receipt.kind", "tracked");
    expect(result).toHaveProperty("channelId", "gateway:dashboard-a:web-chat");
    const messageId = (result as {
      receipt: { kind: "tracked"; messageId: string };
    }).receipt.messageId;
    expect(messageId).toMatch(/^[a-f0-9]{16}\.png$/);

    // File was copied to mediaDir
    const copiedPath = join(mediaDir, messageId);
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, "utf-8")).toBe("fake-png-content");

    // Sidecar metadata was written
    const metaPath = `${copiedPath}.meta`;
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.contentType).toBe("image/png");
    expect(meta.size).toBe(Buffer.from("fake-png-content").length);

    expect(sendToClientId).toHaveBeenCalledWith("dashboard-a", "notification.attachment", expect.objectContaining({
      sessionKey: "tenant-a:agent:agent-a:user_a:gateway:dashboard-a:web-chat:peer:user_a",
      channelId: "gateway:dashboard-a:web-chat",
      url: `/media/${messageId}`,
      type: "image",
      mimeType: "image/png",
      fileName: "photo.png",
      caption: "A nice photo",
    }));
    expect(broadcast).not.toHaveBeenCalled();

    expect(persistAttachment).toHaveBeenCalledOnce();
    const [persistedScope, persistedContent] = persistAttachment.mock.calls[0] as [typeof turnScope.conversation, string];
    expect(persistedScope).toEqual(turnScope.conversation);
    const markerMatch = persistedContent.match(/^A nice photo\n\n<!-- attachment:(\{.*\}) -->$/s);
    expect(markerMatch).not.toBeNull();
    expect(JSON.parse(markerMatch![1])).toEqual({
      url: `/media/${messageId}`,
      type: "image",
      mimeType: "image/png",
      fileName: "photo.png",
    });
  });

  it("delivers gateway media without misfiling history when request context is absent", async () => {
    const persistAttachment = vi.fn();
    const sendToClientId = vi.fn(() => true);
    const broadcast = vi.fn(() => true);
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { sendToClientId, broadcast } as unknown as NonNullable<MessageHandlerDeps["wsConnections"]>;
    deps.mediaDir = mediaDir;
    deps.onGatewayAttachment = persistAttachment;
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.attach"]({
      channel_type: "gateway",
      channel_id: "web-chat",
      attachment_url: join(workspaceDir, "photo.png"),
      attachment_type: "image",
      mime_type: "image/png",
      file_name: "photo.png",
    });

    expect(result).toEqual(expect.objectContaining({ channelId: "web-chat" }));
    expect(sendToClientId).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(persistAttachment).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "web-chat",
        hint: expect.any(String),
        errorKind: "precondition",
      }),
      "Gateway attachment delivered without persistent session history",
    );
  });

  it("delivers gateway media without writing into a mismatched request session", async () => {
    const persistAttachment = vi.fn();
    const sendToClientId = vi.fn(() => true);
    const broadcast = vi.fn(() => true);
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { sendToClientId, broadcast } as unknown as NonNullable<MessageHandlerDeps["wsConnections"]>;
    deps.mediaDir = mediaDir;
    deps.onGatewayAttachment = persistAttachment;
    const handlers = createMessageHandlers(deps);
    const otherSession: SessionKey = {
      tenantId: "tenant-a",
      userId: "user_a",
      channelId: "another-chat",
    };

    const result = await runWithContext({
      tenantId: otherSession.tenantId,
      userId: otherSession.userId,
      sessionKey: formatSessionKey(otherSession),
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      startedAt: 1_700_000_000_000,
      trustLevel: "user",
      clientId: "dashboard-a",
    }, () => handlers["message.attach"]({
        channel_type: "gateway",
        channel_id: "web-chat",
        attachment_url: join(workspaceDir, "photo.png"),
        attachment_type: "image",
        mime_type: "image/png",
        file_name: "photo.png",
      }));

    expect(result).toEqual(expect.objectContaining({ channelId: "web-chat" }));
    expect(sendToClientId).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(persistAttachment).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "web-chat", errorKind: "precondition" }),
      "Gateway attachment delivered without persistent session history",
    );
  });

  it("throws when wsConnections is missing for gateway", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.mediaDir = mediaDir;
    // wsConnections is undefined

    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.attach"]({
        channel_type: "gateway",
        channel_id: "web-chat",
        attachment_url: join(workspaceDir, "photo.png"),
        attachment_type: "image",
      }),
    ).rejects.toThrow("Gateway attachment support requires wsConnections and mediaDir");
  });

  it("throws when mediaDir is missing for gateway", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { sendToClientId: vi.fn(() => true) } as unknown as NonNullable<MessageHandlerDeps["wsConnections"]>;
    // mediaDir is undefined

    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.attach"]({
        channel_type: "gateway",
        channel_id: "web-chat",
        attachment_url: join(workspaceDir, "photo.png"),
        attachment_type: "image",
      }),
    ).rejects.toThrow("Gateway attachment support requires wsConnections and mediaDir");
  });

  it("non-gateway channel_type still uses resolveAdapter", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { sendToClientId: vi.fn() } as unknown as NonNullable<MessageHandlerDeps["wsConnections"]>;
    deps.mediaDir = mediaDir;

    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    });

    expect(result).toEqual({
      receipt: { kind: "tracked", messageId: "attach-1" },
      channelId: "123",
    });
    expect(adapter.sendAttachment).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Capability guard tests
// ---------------------------------------------------------------------------

function createMockPlugin(featuresOverride: Partial<ChannelCapability["features"]> = {}): ChannelPluginPort {
  return {
    id: "channel-test",
    name: "Test Channel Plugin",
    version: "1.0.0",
    channelType: "telegram",
    capabilities: {
      features: {
        reactions: true,
        editMessages: true,
        deleteMessages: true,
        fetchHistory: false,
        attachments: true,
        ...featuresOverride,
      },
      limits: { maxMessageChars: 4096 },
    },
    adapter: createMockAdapter(),
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
  };
}

describe("capability guard", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-cap-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("rejects message.fetch when fetchHistory is false", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ fetchHistory: false })]]);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.fetch"]({ channel_type: "telegram", channel_id: "123" }),
    ).rejects.toThrow('Action "fetch" is not supported on telegram');
  });

  it("rejects message.edit when editMessages is false", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ editMessages: false })]]);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.edit"]({ channel_type: "telegram", channel_id: "123", message_id: "m1", text: "hi" }),
    ).rejects.toThrow('Action "edit" is not supported on telegram');
  });

  it("rejects message.delete when deleteMessages is false", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ deleteMessages: false })]]);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.delete"]({ channel_type: "telegram", channel_id: "123", message_id: "m1" }),
    ).rejects.toThrow('Action "delete" is not supported on telegram');
  });

  it("rejects message.react when reactions is false", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ reactions: false })]]);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.react"]({ channel_type: "telegram", channel_id: "123", message_id: "m1", emoji: "👍" }),
    ).rejects.toThrow('Action "react" is not supported on telegram');
  });

  it("rejects message.attach when attachments is false", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ attachments: false })]]);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.attach"]({ channel_type: "telegram", channel_id: "123", attachment_url: "https://x.com/f.pdf" }),
    ).rejects.toThrow('Action "attach" is not supported on telegram');
  });

  it("allows message.fetch when fetchHistory is true", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ fetchHistory: true })]]);
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.fetch"]({ channel_type: "telegram", channel_id: "123" });
    expect(result).toEqual({ messages: [], channelId: "123" });
  });

  it("falls through for unknown channel type not in plugins map", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({ fetchHistory: false })]]);
    // Add an adapter for "custom" but no plugin entry
    deps.adaptersByType.set("custom", createMockAdapter());
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.fetch"]({ channel_type: "custom", channel_id: "123" });
    expect(result).toEqual({ messages: [], channelId: "123" });
  });

  it("message.send always succeeds regardless of capabilities", async () => {
    const deps = createMockDeps(workspaceDir);
    // Even with all features false, send is not gated
    deps.channelPlugins = new Map([["telegram", createMockPlugin({
      reactions: false, editMessages: false, deleteMessages: false,
      fetchHistory: false, attachments: false,
    })]]);
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.send"]({ channel_type: "telegram", channel_id: "123", text: "hello" });
    expect(result).toHaveProperty("messageId");
  });
});

// ---------------------------------------------------------------------------
// Microsoft Teams capability gate (INV-2).
//
// Teams declares reactions:true as an INBOUND-only capability — it exposes no
// bot-reaction SEND API, so the adapter omits reactToMessage. An agent
// message.react therefore passes assertCapability (reactions:true) but must be
// stopped at requireMethod, which throws naming the missing method — a supported
// inbound flag never fabricates a send path. edit/delete are truthfully
// supported (editMessages/deleteMessages:true + the adapter implements them from
// the flipped caps), so they pass the gate and reach the adapter.
// ---------------------------------------------------------------------------

/** A msteams adapter that OMITS reactToMessage (no bot-reaction send API) while
 *  implementing editMessage/deleteMessage — the honest adapter surface. */
function createMsTeamsMockAdapter(): ChannelPort {
  return {
    channelId: "msteams",
    channelType: "msteams",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    platformAction: vi.fn(async () => ok({})),
    onMessage: vi.fn(),
    // reactToMessage is intentionally absent (Teams has no bot-reaction send API).
  } as ChannelPort;
}

/** A msteams plugin with the real capability matrix: reactions:true (inbound
 *  only), editMessages/deleteMessages:true, buttons:"none". */
function createMsTeamsMockPlugin(): ChannelPluginPort {
  return {
    id: "channel-msteams",
    name: "Microsoft Teams Channel Plugin",
    version: "1.0.0",
    channelType: "msteams",
    capabilities: {
      features: {
        reactions: true,
        editMessages: true,
        deleteMessages: true,
        fetchHistory: false,
        attachments: false,
        typing: true,
        threads: true,
        buttons: "none",
      },
      limits: { maxMessageChars: 28_000 },
      replyToMetaKey: "teamsActivityId",
    } as ChannelCapability,
    adapter: createMsTeamsMockAdapter(),
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
  };
}

describe("capability guard — Microsoft Teams (INV-2)", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-msteams-cap-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeMsTeamsDeps(): MessageHandlerDeps {
    const deps = createMockDeps(workspaceDir);
    deps.adaptersByType = new Map([["msteams", createMsTeamsMockAdapter()]]);
    deps.channelPlugins = new Map([["msteams", createMsTeamsMockPlugin()]]);
    return deps;
  }

  it("rejects a msteams message.react at requireMethod because reactToMessage is omitted", async () => {
    // reactions:true clears assertCapability, but the adapter has no reactToMessage
    // (Teams exposes no bot-reaction send API), so requireMethod throws naming the
    // missing method — the honest INV-2 outcome (inbound flag ≠ send path).
    const deps = makeMsTeamsDeps();
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.react"]({ channel_type: "msteams", channel_id: "19:conv", message_id: "m1", emoji: "👍" }),
    ).rejects.toThrow(/does not implement adapter\.reactToMessage/);
  });

  it("permits a msteams message.edit through the gate and reaches the adapter editMessage", async () => {
    // editMessages:true (a truthful capability from the flipped caps) + the adapter
    // implements editMessage → assertCapability + requireMethod both pass.
    const deps = makeMsTeamsDeps();
    const adapter = deps.adaptersByType.get("msteams")!;
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.edit"]({
      channel_type: "msteams", channel_id: "19:conv", message_id: "m1", text: "edited",
    });

    expect(result).toEqual({ edited: true, channelId: "19:conv", messageId: "m1" });
    expect(adapter.editMessage).toHaveBeenCalledWith("19:conv", "m1", expect.any(String));
  });

  it("permits a msteams message.delete through the gate and reaches the adapter deleteMessage", async () => {
    // deleteMessages:true + the adapter implements deleteMessage → the gate passes.
    const deps = makeMsTeamsDeps();
    const adapter = deps.adaptersByType.get("msteams")!;
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.delete"]({
      channel_type: "msteams", channel_id: "19:conv", message_id: "m1",
    });

    expect(result).toEqual({ deleted: true, channelId: "19:conv", messageId: "m1" });
    expect(adapter.deleteMessage).toHaveBeenCalledWith("19:conv", "m1");
  });
});

// ---------------------------------------------------------------------------
// Cross-channel authorization confinement.
//
// Security regression: the per-method channel
// guard once read the dispatcher field `_originChannelId`, which is NEVER injected
// (the agent rpc bridge injects `_callerChannelId` from DeliveryOrigin). With
// the wrong field name, `authorizeChannelAccess(undefined, target, undefined)`
// always hit the "no origin -> allow (daemon-initiated)" branch, so a
// prompt-injected agent could fetch/send on ANY channel the bot can reach,
// not just the one the inbound message arrived on. These tests pin that a
// non-admin caller carrying a `_callerChannelId` is confined to that channel.
// ---------------------------------------------------------------------------

describe("cross-channel authorization confinement", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-authz-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("denies message.send to a channel other than the caller's origin channel", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.send"]({
        channel_type: "telegram",
        channel_id: "channel-B",
        text: "exfiltrated",
        // Injected by createAgentRpcCall from ctx.deliveryOrigin for an inbound
        // message that arrived on channel-A; non-admin (no _trustLevel).
        _callerChannelId: "channel-A",
      }),
    ).rejects.toThrow("Channel access denied");
  });

  it("denies message.fetch from a channel other than the caller's origin channel", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.fetch"]({
        channel_type: "telegram",
        channel_id: "channel-B",
        _callerChannelId: "channel-A",
      }),
    ).rejects.toThrow("Channel access denied");
  });

  it("allows message.send when target equals the caller's origin channel", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.send"]({
      channel_type: "telegram",
      channel_id: "channel-A",
      text: "hi",
      _callerChannelId: "channel-A",
    });

    expect(result).toHaveProperty("channelId", "channel-A");
  });

  it("allows daemon-initiated send (no caller channel) for cron/heartbeat delivery", async () => {
    const deps = createMockDeps(workspaceDir);
    const handlers = createMessageHandlers(deps);

    // No _callerChannelId — a heartbeat/cron turn with no DeliveryOrigin.
    const result = await handlers["message.send"]({
      channel_type: "telegram",
      channel_id: "channel-B",
      text: "scheduled",
    });

    expect(result).toHaveProperty("channelId", "channel-B");
  });
});

// ---------------------------------------------------------------------------
// Inbound UUID -> platform-native message id resolution (production repro
// 2026-04-30 17:04:31Z `message.delete` failed because
// Number("e60f9634-...") -> NaN was passed to Telegram).
// ---------------------------------------------------------------------------

describe("inboundMessageIdResolver integration", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeDepsWithResolver(): MessageHandlerDeps {
    const deps = createMockDeps(workspaceDir);
    const records = new Map<string, { channelType: string; channelId: string; nativeId: string }>();
    deps.inboundMessageIdResolver = {
      record: () => { /* not used in handler tests */ },
      resolve: (uuid: string) => records.get(uuid),
    };
    // Seed: UUID e60f9634 came from telegram chat 678314278 with native id "523".
    records.set("e60f9634-1470-4907-a1c6-ee2b2039331a", {
      channelType: "telegram",
      channelId: "678314278",
      nativeId: "523",
    });
    return deps;
  }

  it("message.delete translates inbound UUID to native id before adapter call", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    const result = await handlers["message.delete"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
    });

    expect(adapter.deleteMessage).toHaveBeenCalledWith("678314278", "523");
    expect(result).toMatchObject({ deleted: true, messageId: "523" });
  });

  it("message.edit translates inbound UUID to native id before adapter call", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.edit"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
      text: "edited",
    });

    expect(adapter.editMessage).toHaveBeenCalledWith("678314278", "523", expect.any(String));
  });

  it("message.react translates inbound UUID to native id before adapter call", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.react"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
      emoji: "👍",
    });

    expect(adapter.reactToMessage).toHaveBeenCalledWith("678314278", "523", "👍");
  });

  it("message.reply translates inbound UUID to native id before delivery", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.reply"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
      text: "reply",
    });

    // deliverToChannel forwards replyTo into adapter.sendMessage's options.
    expect(adapter.sendMessage).toHaveBeenCalled();
    const call = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toMatchObject({ replyTo: "523" });
  });

  it("native id (numeric string) passes through unchanged when not in resolver", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.delete"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "999",  // a Telegram-native id from message.send response
    });

    expect(adapter.deleteMessage).toHaveBeenCalledWith("678314278", "999");
  });

  it("UUID with mismatched channelType passes through unchanged (defensive)", async () => {
    const deps = makeDepsWithResolver();
    // Resolver record is for telegram, but caller asserts a different channel.
    deps.adaptersByType.set("discord", createMockAdapter());
    const handlers = createMessageHandlers(deps);
    const tgAdapter = deps.adaptersByType.get("discord")!;

    await handlers["message.delete"]({
      channel_type: "discord",
      channel_id: "678314278",
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
    });

    expect(tgAdapter.deleteMessage).toHaveBeenCalledWith(
      "678314278",
      "e60f9634-1470-4907-a1c6-ee2b2039331a",
    );
  });

  it("UUID with mismatched channelId passes through unchanged (defensive)", async () => {
    const deps = makeDepsWithResolver();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.delete"]({
      channel_type: "telegram",
      channel_id: "999999",  // not the one the UUID was recorded under
      message_id: "e60f9634-1470-4907-a1c6-ee2b2039331a",
    });

    expect(adapter.deleteMessage).toHaveBeenCalledWith(
      "999999",
      "e60f9634-1470-4907-a1c6-ee2b2039331a",
    );
  });

  it("works without a resolver (backward compat)", async () => {
    const deps = createMockDeps(workspaceDir);
    expect(deps.inboundMessageIdResolver).toBeUndefined();
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await handlers["message.delete"]({
      channel_type: "telegram",
      channel_id: "678314278",
      message_id: "anything",
    });

    expect(adapter.deleteMessage).toHaveBeenCalledWith("678314278", "anything");
  });
});

// ---------------------------------------------------------------------------
// The outward irreversible-action gate. Every agent-
// initiated orch:message send (message.send/reply/react) is gated on the bounded-
// autonomy outward quota AFTER authorizeChannelAccess, BEFORE deliver — origin-
// only + per-target grant + per-hour + volume. A daemon-initiated send (no agent
// origin) is NOT quota-gated (cron/heartbeat delivery).
// ---------------------------------------------------------------------------

/** A BoundedAutonomy stub exposing only the outward gate the message handlers use. */
function makeOutwardStub(tryOutward: BoundedAutonomy["tryOutward"]): BoundedAutonomy {
  return {
    tryAcquireSpawn: () => ({ ok: true }),
    releaseSpawn: () => {},
    tryCall: () => ({ ok: true }),
    tryChurn: () => ({ ok: true }),
    reserveBudget: () => ({ kind: "ok" }) as ReturnType<BoundedAutonomy["reserveBudget"]>,
    tryOutward,
    registerRoot: () => {},
    leaseIdsForRoot: () => new Set<string>(),
    cronCount: () => 0,
    destroy: () => {},
  };
}

describe("outward quota gate", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "comis-test-quota-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("commits outward ledger truth when the platform sent but queue acknowledgement failed", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.deliveryService = {
      deliverToChannel: vi.fn(async () => err(makeQueueTransitionError("platform-msg-7"))),
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
    };
    const ledger: OutwardSendLedgerPort = {
      allocateStep: vi.fn(async () => ok(7)),
      lookup: vi.fn(async () => ok(undefined)),
      begin: vi.fn(async () => ok(undefined)),
      markUnknown: vi.fn(async () => ok(undefined)),
      reclaimPreSend: vi.fn(async () => ok(true)),
      commit: vi.fn(async () => ok(undefined)),
      markFailed: vi.fn(async () => ok(undefined)),
      parkUncertain: vi.fn(async () => ok(true)),
      hasUncertainty: vi.fn(async () => ok(false)),
      listUnreconciled: vi.fn(async () => ok([])),
    };
    deps.outwardLedger = ledger;
    deps.resolveRootRunId = vi.fn(() => ({ ok: true, value: "root-1" }));
    const handlers = createMessageHandlers(deps);

    const result = await handlers["message.send"]({
      channel_type: "telegram",
      channel_id: "ch-A",
      text: "hello",
      _agentId: "agent-1",
      _callerChannelId: "ch-A",
      _callerSessionKey: "default:user_a:ch-A",
      _rootRunId: "root-1",
      _outwardStepIndex: 7,
    });

    expect(result).toEqual({ messageId: "platform-msg-7", channelId: "ch-A" });
    expect(ledger.commit).toHaveBeenCalledWith("root-1", 7, "platform-msg-7");
    expect(ledger.markFailed).not.toHaveBeenCalled();
  });

  it.each(["error result", "thrown exception"])(
    "invokes the adapter once for an ambiguous ledger-protected send: %s",
    async (failureKind) => {
      const deps = createMockDeps(workspaceDir);
      const adapter = deps.adaptersByType.get("telegram")!;
      vi.mocked(adapter.sendMessage).mockImplementation(async () => {
        if (failureKind === "thrown exception") {
          throw new Error("ETIMEDOUT after request write");
        }
        return err(new Error("503 Service Unavailable"));
      });
      const hookRunner = {
        runBeforeDelivery: vi.fn(async () => ({})),
        runAfterDelivery: vi.fn(async () => undefined),
      } as unknown as HookRunner;
      const eventBus = new TypedEventBus();
      const retryEngine = createRetryEngine(
        {
          maxAttempts: 3,
          minDelayMs: 1,
          maxDelayMs: 1,
          jitter: false,
          respectRetryAfter: true,
          markdownFallback: true,
        },
        eventBus,
        deps.logger,
      );
      deps.deliveryService = createDeliveryService({
        hookRunner,
        deliveryQueue: createNoOpDeliveryQueue(),
        logger: deps.logger,
        clock: { now: () => 1 },
        eventBus,
        retryEngine,
      });
      const ledger: OutwardSendLedgerPort = {
        allocateStep: vi.fn(async () => ok(9)),
        lookup: vi.fn(async () => ok(undefined)),
        begin: vi.fn(async () => ok(undefined)),
        markUnknown: vi.fn(async () => ok(undefined)),
        reclaimPreSend: vi.fn(async () => ok(true)),
        commit: vi.fn(async () => ok(undefined)),
        markFailed: vi.fn(async () => ok(undefined)),
        parkUncertain: vi.fn(async () => ok(true)),
        hasUncertainty: vi.fn(async () => ok(false)),
        listUnreconciled: vi.fn(async () => ok([])),
      };
      deps.outwardLedger = ledger;
      deps.resolveRootRunId = vi.fn(() => ({ ok: true, value: "root-ambiguous" }));
      const handlers = createMessageHandlers(deps);

      await expect(handlers["message.send"]({
        channel_type: "telegram",
        channel_id: "ch-A",
        text: "hello",
        _agentId: "agent-1",
        _callerChannelId: "ch-A",
        _callerSessionKey: "default:user_a:ch-A",
        _rootRunId: "root-ambiguous",
        _outwardStepIndex: 9,
      })).rejects.toThrow();

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(ledger.commit).not.toHaveBeenCalled();
      expect(ledger.parkUncertain).toHaveBeenCalledWith("root-ambiguous", 9);
    },
  );

  it("allows an origin send within quota, then denies before deliver when tryOutward returns per_hour", async () => {
    const deps = createMockDeps(workspaceDir);
    const tryOutward = vi.fn().mockReturnValue(ok(undefined));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);
    const deliver = (deps.deliveryService as never as { deliverToChannel: ReturnType<typeof vi.fn> }).deliverToChannel;

    // Within quota → deliver proceeds (origin channel).
    await handlers["message.send"]({
      channel_type: "telegram", channel_id: "ch-A", text: "hi",
      _agentId: "agent-1", _callerChannelId: "ch-A",
    });
    expect(deliver).toHaveBeenCalledTimes(1);

    // Over quota (per_hour) → denied BEFORE deliver.
    tryOutward.mockReturnValue(err({ reason: "per_hour" }));
    await expect(
      handlers["message.send"]({
        channel_type: "telegram", channel_id: "ch-A", text: "again",
        _agentId: "agent-1", _callerChannelId: "ch-A",
      }),
    ).rejects.toThrow();
    expect(deliver).toHaveBeenCalledTimes(1); // NOT called a second time
  });

  it("denies a send to a new (non-origin) target when tryOutward returns no_grant", async () => {
    const deps = createMockDeps(workspaceDir);
    const tryOutward = vi.fn().mockReturnValue(err({ reason: "no_grant" }));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);
    const deliver = (deps.deliveryService as never as { deliverToChannel: ReturnType<typeof vi.fn> }).deliverToChannel;

    await expect(
      handlers["message.send"]({
        channel_type: "telegram", channel_id: "ch-A", text: "spam",
        _agentId: "agent-1", _callerChannelId: "ch-A",
      }),
    ).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
    // tryOutward(agentId, channelId, isOrigin, volume): isOrigin true here
    // (target === caller), so the gate fired on the grant/quota itself.
    const [agentArg, channelId, isOrigin] = tryOutward.mock.calls[0];
    expect(agentArg).toBe("agent-1");
    expect(channelId).toBe("ch-A");
    expect(isOrigin).toBe(true);
  });

  it("denies an admin-origin attachment to a non-origin target without an outward grant", async () => {
    const deps = createMockDeps(workspaceDir);
    const tryOutward = vi.fn().mockReturnValue(err({ reason: "no_grant" }));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    await expect(
      handlers["message.attach"]({
        channel_type: "telegram",
        channel_id: "ch-B",
        attachment_url: "https://example.com/report.csv",
        attachment_type: "file",
        _agentId: "agent-1",
        _callerChannelId: "ch-A",
        _trustLevel: "admin",
      }),
    ).rejects.toThrow();

    expect(tryOutward).toHaveBeenCalledWith("agent-1", "ch-B", false, 1);
    expect(adapter.sendAttachment).not.toHaveBeenCalled();
  });

  it("derives the tryOutward volume from text.length and denies on a volume trip", async () => {
    const deps = createMockDeps(workspaceDir);
    const tryOutward = vi.fn().mockReturnValue(err({ reason: "volume" }));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);

    const big = "x".repeat(9999);
    await expect(
      handlers["message.send"]({
        channel_type: "telegram", channel_id: "ch-A", text: big,
        _agentId: "agent-1", _callerChannelId: "ch-A",
      }),
    ).rejects.toThrow();
    // tryOutward(agentId, channelId, isOrigin, volume): the 4th arg (volume) is
    // derived from text.length.
    const [, , , volume] = tryOutward.mock.calls[0];
    expect(volume).toBe(big.length);
  });

  it("gates message.reply AND message.react through tryOutward, not just send", async () => {
    const deps = createMockDeps(workspaceDir);
    // reactions enabled so message.react reaches the quota gate (not the cap guard).
    deps.channelPlugins = new Map([["telegram", createMockPlugin({
      reactions: true, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false,
    })]]);
    const tryOutward = vi.fn().mockReturnValue(err({ reason: "per_hour" }));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);

    await expect(
      handlers["message.reply"]({
        channel_type: "telegram", channel_id: "ch-A", text: "r", message_id: "m1",
        _agentId: "agent-1", _callerChannelId: "ch-A",
      }),
    ).rejects.toThrow();

    await expect(
      handlers["message.react"]({
        channel_type: "telegram", channel_id: "ch-A", emoji: "👍", message_id: "m1",
        _agentId: "agent-1", _callerChannelId: "ch-A",
      }),
    ).rejects.toThrow();

    // BOTH outward methods consulted the quota.
    expect(tryOutward).toHaveBeenCalledTimes(2);
  });

  it("counts a message.react as ONE volume unit regardless of emoji length", async () => {
    const deps = createMockDeps(workspaceDir);
    deps.channelPlugins = new Map([["telegram", createMockPlugin({
      reactions: true, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false,
    })]]);
    const tryOutward = vi.fn().mockReturnValue(ok(undefined));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);

    // A multi-codepoint emoji (ZWJ sequence) whose .length is > 1 — passing
    // emoji.length (here 7) as the volume would be wrong; it must be 1.
    await handlers["message.react"]({
      channel_type: "telegram", channel_id: "ch-A", emoji: "👨‍👩‍👧", message_id: "m1",
      _agentId: "agent-1", _callerChannelId: "ch-A",
    });

    const [, , , volume] = tryOutward.mock.calls[0];
    expect(volume).toBe(1);
  });

  it("does NOT quota-gate a daemon-initiated send (no agent origin) — cron/heartbeat delivery", async () => {
    const deps = createMockDeps(workspaceDir);
    const tryOutward = vi.fn().mockReturnValue(err({ reason: "per_hour" }));
    deps.boundedAutonomy = makeOutwardStub(tryOutward as never);
    const handlers = createMessageHandlers(deps);
    const deliver = (deps.deliveryService as never as { deliverToChannel: ReturnType<typeof vi.fn> }).deliverToChannel;

    // No _agentId → daemon-initiated (cron/heartbeat). The quota is NOT consulted;
    // the deliver proceeds (mirrors authorizeChannelAccess's daemon-initiated allow).
    await handlers["message.send"]({ channel_type: "telegram", channel_id: "ch-B", text: "scheduled" });
    expect(tryOutward).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
