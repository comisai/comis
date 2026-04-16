import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPushMessage = vi.fn();
const mockGetMessageContent = vi.fn();

vi.mock("@line/bot-sdk", () => {
  class MockMessagingApiClient {
    pushMessage = mockPushMessage;
  }
  class MockMessagingApiBlobClient {
    getMessageContent = mockGetMessageContent;
  }
  return {
    messagingApi: {
      MessagingApiClient: MockMessagingApiClient,
      MessagingApiBlobClient: MockMessagingApiBlobClient,
    },
    webhook: {},
  };
});

vi.mock("./message-mapper.js", () => ({
  mapLineToNormalized: vi.fn(),
  isMessageEvent: vi.fn(() => false),
}));

vi.mock("./flex-builder.js", () => ({
  buildFlexMessage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createLinePlugin } from "./line-plugin.js";
import type { LineAdapterDeps } from "./line-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<LineAdapterDeps>): LineAdapterDeps {
  return {
    channelAccessToken: "test-channel-access-token",
    channelSecret: "test-channel-secret",
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLinePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an object with a createResolver method", () => {
    const plugin = createLinePlugin(makeDeps());

    expect(plugin).toHaveProperty("createResolver");
    expect(typeof plugin.createResolver).toBe("function");
  });

  it("has correct plugin metadata", () => {
    const plugin = createLinePlugin(makeDeps());

    expect(plugin.id).toBe("channel-line");
    expect(plugin.name).toBe("LINE Channel Plugin");
    expect(plugin.channelType).toBe("line");
  });

  it("createResolver() returns an object with schemes ['line-content'] and a resolve function", () => {
    const plugin = createLinePlugin(makeDeps());

    const resolver = plugin.createResolver({
      maxBytes: 10 * 1024 * 1024,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(resolver.schemes).toEqual(["line-content"]);
    expect(typeof resolver.resolve).toBe("function");
  });

  it("createResolver() produces independent resolvers per call", () => {
    const plugin = createLinePlugin(makeDeps());

    const resolver1 = plugin.createResolver({
      maxBytes: 5 * 1024 * 1024,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const resolver2 = plugin.createResolver({
      maxBytes: 10 * 1024 * 1024,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(resolver1).not.toBe(resolver2);
    expect(resolver1.schemes).toEqual(resolver2.schemes);
  });

  it("LINE adapter getBlobContent is callable via the adapter handle", () => {
    const plugin = createLinePlugin(makeDeps());

    // The adapter exposed via the plugin should have getBlobContent
    // We access it through the adapter property (which is LineAdapterHandle)
    const adapter = plugin.adapter as { getBlobContent?: (id: string) => Promise<Buffer> };

    expect(adapter.getBlobContent).toBeDefined();
    expect(typeof adapter.getBlobContent).toBe("function");
  });

  it("exposes adapter as ChannelPort on plugin", () => {
    const plugin = createLinePlugin(makeDeps());

    expect(plugin.adapter).toBeDefined();
    expect(plugin.adapter.channelType).toBe("line");
  });
});
