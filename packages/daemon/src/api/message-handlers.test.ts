// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMessageHandlers as createMessageHandlersRaw, type MessageHandlerDeps } from "./message-handlers.js";
import type { RpcHandler } from "./types.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { ok } from "@comis/shared";
import type { ChannelPort, AttachmentPayload, ChannelPluginPort, ChannelCapability, DeliveryService } from "@comis/core";

// CAP-03: the gated message.send/reply/react/edit/delete/attach handlers now
// require an injected _capabilities (production supplies it via
// createAgentRpcCall). Wrap the bound record so these body-tests reach the
// handler BODY, not the gate (proven RED-first in the CAP-05 tests).
// message.fetch (read-only) passes through unchanged.
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
        ok: result.ok,
        totalChunks: 1,
        deliveredChunks: result.ok ? 1 : 0,
        failedChunks: result.ok ? 0 : 1,
        chunks: [{
          ok: result.ok,
          messageId: result.ok ? result.value : undefined,
          error: result.ok ? undefined : result.error,
          charCount: text.length,
          retried: false,
        }],
        totalChars: text.length,
      });
    }),
    // DeliveryService gained drainInFlight().
    // Default fake returns empty drain telemetry; tests that exercise drain
    // semantics override this field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
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
    sendAttachment: vi.fn(async () => ok("attach-1")),
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

    expect(result).toEqual({ messageId: "attach-1", channelId: "123" });
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

    expect(result).toEqual({ messageId: "attach-1", channelId: "123" });
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

    expect(result).toEqual({ messageId: "attach-1", channelId: "123" });
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

    expect(result).toEqual({ messageId: "attach-1", channelId: "123" });
    expect(adapter.sendAttachment).toHaveBeenCalledWith("123", expect.objectContaining({
      url: expectedPath,
    }));
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

  it("copies file to mediaDir and broadcasts notification", async () => {
    const mockBroadcast = vi.fn(() => true);
    const deps = createMockDeps(workspaceDir);
    deps.wsConnections = { broadcast: mockBroadcast };
    deps.mediaDir = mediaDir;

    const handlers = createMessageHandlers(deps);
    const filePath = join(workspaceDir, "photo.png");

    const result = await handlers["message.attach"]({
      channel_type: "gateway",
      channel_id: "web-chat",
      attachment_url: filePath,
      attachment_type: "image",
      mime_type: "image/png",
      file_name: "photo.png",
      caption: "A nice photo",
    });

    // Returns mediaId and channelId
    expect(result).toHaveProperty("messageId");
    expect(result).toHaveProperty("channelId", "web-chat");
    const messageId = (result as { messageId: string }).messageId;
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

    // WebSocket broadcast was called with correct params
    expect(mockBroadcast).toHaveBeenCalledWith("notification.attachment", expect.objectContaining({
      url: `/media/${messageId}`,
      type: "image",
      mimeType: "image/png",
      fileName: "photo.png",
      caption: "A nice photo",
    }));
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
    deps.wsConnections = { broadcast: vi.fn(() => true) };
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
    deps.wsConnections = { broadcast: vi.fn() };
    deps.mediaDir = mediaDir;

    const handlers = createMessageHandlers(deps);
    const adapter = deps.adaptersByType.get("telegram")!;

    const result = await handlers["message.attach"]({
      channel_type: "telegram",
      channel_id: "123",
      attachment_url: "https://example.com/file.pdf",
      attachment_type: "file",
    });

    expect(result).toEqual({ messageId: "attach-1", channelId: "123" });
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
// Cross-channel authorization confinement.
//
// Security regression for the v2.20 review finding: the per-method channel
// guard read the dispatcher field `_originChannelId`, which is NEVER injected
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
