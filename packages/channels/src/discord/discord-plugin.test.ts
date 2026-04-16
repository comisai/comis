import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "discord",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./discord-adapter.js", () => ({
  createDiscordAdapter: vi.fn(() => mockAdapter),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createDiscordPlugin } from "./discord-plugin.js";
import type { DiscordAdapterDeps } from "./discord-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): DiscordAdapterDeps {
  return { botToken: "test-discord-token", logger: createMockLogger() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiscordPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createDiscordPlugin(makeDeps());

    expect(plugin.id).toBe("channel-discord");
    expect(plugin.name).toBe("Discord Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("discord");
  });

  it("has capabilities with expected chatTypes", () => {
    const plugin = createDiscordPlugin(makeDeps());

    expect(plugin.capabilities.chatTypes).toContain("dm");
    expect(plugin.capabilities.chatTypes).toContain("group");
    expect(plugin.capabilities.chatTypes).toContain("thread");
  });

  it("has streaming support via edit method", () => {
    const plugin = createDiscordPlugin(makeDeps());

    expect(plugin.capabilities.streaming?.supported).toBe(true);
    expect(plugin.capabilities.streaming?.method).toBe("edit");
  });

  it("register() returns ok", () => {
    const plugin = createDiscordPlugin(makeDeps());

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createDiscordPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(mockAdapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createDiscordPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createDiscordPlugin(makeDeps());

    expect(plugin.adapter).toBe(mockAdapter);
    expect(plugin.adapter.channelType).toBe("discord");
  });
});
