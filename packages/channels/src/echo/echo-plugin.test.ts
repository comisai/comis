import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "echo",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./echo-adapter.js", () => {
  return {
    EchoChannelAdapter: class MockEchoChannelAdapter {
      channelType = mockAdapter.channelType;
      start = mockAdapter.start;
      stop = mockAdapter.stop;
      sendMessage = mockAdapter.sendMessage;
      onMessage = mockAdapter.onMessage;
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createEchoPlugin } from "./echo-plugin.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEchoPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createEchoPlugin();

    expect(plugin.id).toBe("channel-echo");
    expect(plugin.name).toBe("Echo Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("echo");
  });

  it("has capabilities with minimal features", () => {
    const plugin = createEchoPlugin();

    expect(plugin.capabilities.chatTypes).toEqual(["dm"]);
    expect(plugin.capabilities.features.reactions).toBe(false);
    expect(plugin.capabilities.features.attachments).toBe(false);
  });

  it("has no streaming support", () => {
    const plugin = createEchoPlugin();

    expect(plugin.capabilities.streaming?.supported).toBe(false);
  });

  it("register() returns ok", () => {
    const plugin = createEchoPlugin();

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createEchoPlugin();
    const adapter = plugin.adapter as any;
    const expected = { ok: true as const, value: undefined };
    adapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(adapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createEchoPlugin();
    const adapter = plugin.adapter as any;
    const expected = { ok: true as const, value: undefined };
    adapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(adapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createEchoPlugin();

    expect(plugin.adapter).toBeDefined();
    expect(plugin.adapter.channelType).toBe("echo");
  });
});
