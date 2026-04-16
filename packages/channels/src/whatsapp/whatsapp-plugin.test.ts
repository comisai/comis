import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAdapter = {
  channelType: "whatsapp",
  start: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  onMessage: vi.fn(),
};

vi.mock("./whatsapp-adapter.js", () => ({
  createWhatsAppAdapter: vi.fn(() => mockAdapter),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createWhatsAppPlugin } from "./whatsapp-plugin.js";
import type { WhatsAppAdapterDeps } from "./whatsapp-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): WhatsAppAdapterDeps {
  return { authDir: "/tmp/wa-auth", logger: createMockLogger() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWhatsAppPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct plugin metadata", () => {
    const plugin = createWhatsAppPlugin(makeDeps());

    expect(plugin.id).toBe("channel-whatsapp");
    expect(plugin.name).toBe("WhatsApp Channel Plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.channelType).toBe("whatsapp");
  });

  it("has capabilities with expected chatTypes", () => {
    const plugin = createWhatsAppPlugin(makeDeps());

    expect(plugin.capabilities.chatTypes).toContain("dm");
    expect(plugin.capabilities.chatTypes).toContain("group");
  });

  it("has streaming support via block method", () => {
    const plugin = createWhatsAppPlugin(makeDeps());

    expect(plugin.capabilities.streaming?.supported).toBe(true);
    expect(plugin.capabilities.streaming?.method).toBe("block");
  });

  it("register() returns ok", () => {
    const plugin = createWhatsAppPlugin(makeDeps());

    const result = plugin.register({} as never);

    expect(result.ok).toBe(true);
  });

  it("activate() delegates to adapter.start()", async () => {
    const plugin = createWhatsAppPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.start.mockResolvedValue(expected);

    const result = await plugin.activate();

    expect(mockAdapter.start).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("deactivate() delegates to adapter.stop()", async () => {
    const plugin = createWhatsAppPlugin(makeDeps());
    const expected = { ok: true as const, value: undefined };
    mockAdapter.stop.mockResolvedValue(expected);

    const result = await plugin.deactivate();

    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it("exposes adapter on plugin", () => {
    const plugin = createWhatsAppPlugin(makeDeps());

    expect(plugin.adapter).toBe(mockAdapter);
    expect(plugin.adapter.channelType).toBe("whatsapp");
  });
});
