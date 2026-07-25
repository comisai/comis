// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for /export-trajectory slash command handler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeliverToChannelOptions, NormalizedMessage, SessionKey } from "@comis/core";
import { handleExportTrajectory } from "./export-trajectory.js";
import { parseSlashCommand } from "./command-parser.js";

// Mock isGroupMessage from @comis/channels
vi.mock("@comis/channels", () => ({
  isGroupMessage: vi.fn(),
  evaluateAutoReply: vi.fn(),
  isBotMentioned: vi.fn(),
}));
import { isGroupMessage } from "@comis/channels";

// ---------------------------------------------------------------------------
// Parser-level tests
// ---------------------------------------------------------------------------

describe("parseSlashCommand /export-trajectory", () => {
  it("P1: returns found:true so text never reaches LLM", () => {
    const result = parseSlashCommand("/export-trajectory");
    expect(result.found).toBe(true);
    expect(result.command).toBe("export-trajectory");
  });

  it("P2: ignores extra args (standalone command)", () => {
    const result = parseSlashCommand("/export-trajectory ignored extra text");
    expect(result.found).toBe(true);
    expect(result.command).toBe("export-trajectory");
  });
});

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    channelType: "telegram",
    channelId: "chat-1",
    senderId: "user-1",
    messageId: "m-1",
    text: "/export-trajectory",
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  } as NormalizedMessage;
}

function makeKey(userId: string): SessionKey {
  return {
    userId,
    peerId: userId,
    channelType: "telegram",
    agentId: "a",
  } as SessionKey;
}

function makeAdapter() {
  return { sendMessage: vi.fn(async () => undefined) } as unknown as {
    sendMessage: (chatId: string, text: string) => Promise<unknown>;
  };
}

function makeDeliveryService() {
  return { deliverToChannel: vi.fn(async () => undefined) };
}

function makeDeliveryOptions(): DeliverToChannelOptions {
  return {
    completionMode: "deferred_retry",
    authority: {
      tenantId: "default",
      agentId: "a",
      conversationRef: `cv_${"a".repeat(43)}` as never,
    },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "adapter-1",
      conversationId: "chat-1",
      threadId: "owner-thread",
      conversationKind: "direct",
    },
    threadId: "owner-thread",
    skipChunking: true,
  };
}

function makeLogger() {
  return { error: vi.fn(), info: vi.fn() } as unknown as {
    error: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
  };
}

// ---------------------------------------------------------------------------
// Handler-level tests
// ---------------------------------------------------------------------------

describe("handleExportTrajectory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Test 1: rejects non-owner with 'Access denied' and does NOT export", async () => {
    const msg = makeMsg({ senderId: "intruder-2" });
    const sessionKey = makeKey("owner-1");
    const adapter = makeAdapter();
    const deliveryService = makeDeliveryService();
    const exportSessionBundle = vi.fn(async () => ({ bundlePath: "/should-not-be-called" }));

    const result = await handleExportTrajectory({
      msg,
      sessionKey,
      agentId: "a",
      adapter,
      deliveryService,
      deliveryOptions: makeDeliveryOptions(),
      exportSessionBundle,
      logger: makeLogger(),
    });

    expect(deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      msg.channelId,
      expect.stringContaining("Access denied"),
      expect.anything(),
    );
    expect(exportSessionBundle).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "handled" });
  });

  it("Test 2: DM owner — inline reply contains bundle path + privacy reminder", async () => {
    vi.mocked(isGroupMessage).mockReturnValue(false);
    const msg = makeMsg({ senderId: "owner-1" });
    const sessionKey = makeKey("owner-1");
    const adapter = makeAdapter();
    const deliveryService = makeDeliveryService();
    const exportSessionBundle = vi.fn(async () => ({ bundlePath: "/tmp/bundle-abc" }));

    const result = await handleExportTrajectory({
      msg,
      sessionKey,
      agentId: "a",
      adapter,
      deliveryService,
      deliveryOptions: makeDeliveryOptions(),
      exportSessionBundle,
      logger: makeLogger(),
    });

    expect(exportSessionBundle).toHaveBeenCalled();

    // Inline reply must contain both path and privacy reminder
    const inlineCall = deliveryService.deliverToChannel.mock.calls.find(
      (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes("/tmp/bundle-abc"),
    );
    expect(inlineCall).toBeDefined();
    expect(inlineCall![2]).toMatch(/Contains session data|sensitive|privacy/i);

    // No DM in DM context
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "handled" });
  });

  it("Test 3: group owner — inline says 'Bundle sent to owner DM' (no path); DM contains path", async () => {
    vi.mocked(isGroupMessage).mockReturnValue(true);
    const msg = makeMsg({ senderId: "owner-1", channelId: "group-1" });
    const sessionKey = makeKey("owner-1");
    const adapter = makeAdapter();
    const deliveryService = makeDeliveryService();
    const exportSessionBundle = vi.fn(async () => ({ bundlePath: "/tmp/bundle-xyz" }));

    const result = await handleExportTrajectory({
      msg,
      sessionKey,
      agentId: "a",
      adapter,
      deliveryService,
      deliveryOptions: makeDeliveryOptions(),
      exportSessionBundle,
      logger: makeLogger(),
    });

    // Inline group reply: "Bundle sent to owner DM" — no path
    const inlineCalls = deliveryService.deliverToChannel.mock.calls;
    const inlineTexts = inlineCalls.map((c: unknown[]) => String(c[2]));
    expect(
      inlineTexts.some((t: string) => t === "Bundle sent to owner DM." || t.startsWith("Bundle sent to owner DM")),
    ).toBe(true);

    // CRITICAL: path is NEVER inline in group
    expect(inlineTexts.some((t: string) => t.includes("/tmp/bundle-xyz"))).toBe(false);

    // DM to owner contains the path
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "owner-1",
      expect.stringContaining("/tmp/bundle-xyz"),
    );
    expect(result).toEqual({ action: "handled" });
  });

  it("Test 4: export failure — error sent inline; no DM; result is handled", async () => {
    vi.mocked(isGroupMessage).mockReturnValue(false);
    const msg = makeMsg({ senderId: "owner-1" });
    const sessionKey = makeKey("owner-1");
    const adapter = makeAdapter();
    const deliveryService = makeDeliveryService();
    const exportSessionBundle = vi.fn(async () => {
      throw new Error("session not found");
    });

    const result = await handleExportTrajectory({
      msg,
      sessionKey,
      agentId: "a",
      adapter,
      deliveryService,
      deliveryOptions: makeDeliveryOptions(),
      exportSessionBundle,
      logger: makeLogger(),
    });

    expect(deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      msg.channelId,
      expect.stringContaining("failed"),
      expect.anything(),
    );
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "handled" });
  });

  it("Test 5: group + non-owner — 'Access denied'; no routing logic engaged", async () => {
    vi.mocked(isGroupMessage).mockReturnValue(true);
    const msg = makeMsg({ senderId: "intruder-2", channelId: "group-1" });
    const sessionKey = makeKey("owner-1");
    const adapter = makeAdapter();
    const deliveryService = makeDeliveryService();
    const exportSessionBundle = vi.fn();

    await handleExportTrajectory({
      msg,
      sessionKey,
      agentId: "a",
      adapter,
      deliveryService,
      deliveryOptions: makeDeliveryOptions(),
      exportSessionBundle,
      logger: makeLogger(),
    });

    expect(deliveryService.deliverToChannel).toHaveBeenCalledTimes(1);
    expect(deliveryService.deliverToChannel.mock.calls[0][2]).toMatch(/Access denied/);
    expect(exportSessionBundle).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("Test 6: KNOWN_COMMANDS includes 'export-trajectory' (parser-level)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    // Use import.meta.url to resolve relative to this test file regardless
    // of where vitest is invoked from (workspace root or package root).
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(__dirname, "command-parser.ts"),
      "utf-8",
    );
    expect(src).toMatch(/"export-trajectory"/);
  });
});
