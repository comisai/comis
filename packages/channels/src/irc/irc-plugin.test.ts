import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "irc",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./irc-adapter.js", () => ({
  createIrcAdapter: vi.fn(() => mockAdapter),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createIrcPlugin } from "./irc-plugin.js";
import type { IrcAdapterDeps } from "./irc-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): IrcAdapterDeps {
  return {
    host: "irc.libera.chat",
    nick: "comis-bot",
    logger: createMockLogger(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIrcPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createIrcPlugin(makeDeps());

    expect(plugin.id).toBe("channel-irc");
    expect(plugin.name).toBe("IRC Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("irc");
  });

  it("has capabilities with expected chatTypes", () => {
    const plugin = createIrcPlugin(makeDeps());

    expect(plugin.capabilities.chatTypes).toContain("dm");
    expect(plugin.capabilities.chatTypes).toContain("channel");
  });

  it("has no streaming support", () => {
    const plugin = createIrcPlugin(makeDeps());

    expect(plugin.capabilities.streaming?.supported).toBe(false);
  });

  it("has 512 char message limit", () => {
    const plugin = createIrcPlugin(makeDeps());

    expect(plugin.capabilities.limits.maxMessageChars).toBe(512);
  });

  it("register() returns ok", () => {
    const plugin = createIrcPlugin(makeDeps());

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createIrcPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(mockAdapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createIrcPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createIrcPlugin(makeDeps());

    expect(plugin.adapter).toBe(mockAdapter);
    expect(plugin.adapter.channelType).toBe("irc");
  });
});
