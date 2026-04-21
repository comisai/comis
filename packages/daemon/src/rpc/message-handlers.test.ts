// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMessageHandlers, type MessageHandlerDeps } from "./message-handlers.js";
import { ok } from "@comis/shared";
import type { ChannelPort, AttachmentPayload, ChannelPluginPort, ChannelCapability } from "@comis/core";

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
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as MessageHandlerDeps["logger"],
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
      chatTypes: ["dm", "group"],
      features: {
        reactions: true,
        editMessages: true,
        deleteMessages: true,
        fetchHistory: false,
        attachments: true,
        threads: false,
        mentions: false,
        formatting: [],
        buttons: false,
        cards: false,
        effects: false,
        ...featuresOverride,
      },
      limits: { maxMessageChars: 4096 },
      streaming: { supported: false, throttleMs: 300, method: "none" },
      threading: { supported: false, threadType: "none" },
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

  it("falls through when channelPlugins is undefined (backward compat)", async () => {
    const deps = createMockDeps(workspaceDir);
    // channelPlugins is not set — default undefined
    const handlers = createMessageHandlers(deps);

    // fetchMessages mock returns ok([]), so this succeeds despite Telegram not supporting fetch
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
