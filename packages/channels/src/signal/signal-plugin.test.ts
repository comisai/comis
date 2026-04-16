import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "signal",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./signal-adapter.js", () => ({
  createSignalAdapter: vi.fn(() => mockAdapter),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSignalPlugin } from "./signal-plugin.js";
import type { SignalAdapterDeps } from "./signal-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): SignalAdapterDeps {
  return { baseUrl: "http://signal:8080", logger: createMockLogger() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSignalPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createSignalPlugin(makeDeps());

    expect(plugin.id).toBe("channel-signal");
    expect(plugin.name).toBe("Signal Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("signal");
  });

  it("has capabilities with expected chatTypes", () => {
    const plugin = createSignalPlugin(makeDeps());

    expect(plugin.capabilities.chatTypes).toContain("dm");
    expect(plugin.capabilities.chatTypes).toContain("group");
  });

  it("has streaming support via block method", () => {
    const plugin = createSignalPlugin(makeDeps());

    expect(plugin.capabilities.streaming?.supported).toBe(true);
    expect(plugin.capabilities.streaming?.method).toBe("block");
  });

  it("register() returns ok", () => {
    const plugin = createSignalPlugin(makeDeps());

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createSignalPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(mockAdapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createSignalPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createSignalPlugin(makeDeps());

    expect(plugin.adapter).toBe(mockAdapter);
    expect(plugin.adapter.channelType).toBe("signal");
  });
});
