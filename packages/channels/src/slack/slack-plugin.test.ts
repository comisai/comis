import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "slack",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./slack-adapter.js", () => ({
  createSlackAdapter: vi.fn(() => mockAdapter),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSlackPlugin } from "./slack-plugin.js";
import type { SlackAdapterDeps } from "./slack-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): SlackAdapterDeps {
  return {
    botToken: "xoxb-test-token",
    mode: "socket",
    appToken: "xapp-test",
    logger: createMockLogger(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSlackPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createSlackPlugin(makeDeps());

    expect(plugin.id).toBe("channel-slack");
    expect(plugin.name).toBe("Slack Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("slack");
  });

  it("has capabilities with expected chatTypes", () => {
    const plugin = createSlackPlugin(makeDeps());

    expect(plugin.capabilities.chatTypes).toContain("dm");
    expect(plugin.capabilities.chatTypes).toContain("group");
    expect(plugin.capabilities.chatTypes).toContain("thread");
    expect(plugin.capabilities.chatTypes).toContain("channel");
  });

  it("has streaming support via edit method", () => {
    const plugin = createSlackPlugin(makeDeps());

    expect(plugin.capabilities.streaming?.supported).toBe(true);
    expect(plugin.capabilities.streaming?.method).toBe("edit");
  });

  it("register() returns ok", () => {
    const plugin = createSlackPlugin(makeDeps());

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createSlackPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(mockAdapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createSlackPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createSlackPlugin(makeDeps());

    expect(plugin.adapter).toBe(mockAdapter);
    expect(plugin.adapter.channelType).toBe("slack");
  });
});
