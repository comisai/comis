// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockConfigUse = vi.fn();
const mockGetFile = vi.fn();

vi.mock("grammy", () => {
  class MockBot {
    api = {
      config: { use: mockConfigUse },
      getFile: mockGetFile,
    };
    on() {}
  }
  return { Bot: MockBot, InputFile: vi.fn() };
});

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(() => "auto-retry-transformer"),
}));

vi.mock("@grammyjs/files", () => ({
  hydrateFiles: vi.fn(() => "hydrate-files-transformer"),
}));

vi.mock("./credential-validator.js", () => ({
  validateBotToken: vi.fn(),
  validateWebhookSecret: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapGrammyToNormalized: vi.fn(),
}));

vi.mock("./voice-sender.js", () => ({
  createTelegramVoiceSender: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { err } from "@comis/shared";
import { validateBotToken } from "./credential-validator.js";
import { createTelegramPlugin } from "./telegram-plugin.js";
import type { TelegramAdapterDeps } from "./telegram-adapter/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<TelegramAdapterDeps>): TelegramAdapterDeps {
  return {
    getBotToken: () => "123456:ABC-DEF",
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTelegramPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an object with a createResolver method", () => {
    const plugin = createTelegramPlugin(makeDeps());

    expect(plugin).toHaveProperty("createResolver");
    expect(typeof plugin.createResolver).toBe("function");
  });

  it("has correct plugin metadata", () => {
    const plugin = createTelegramPlugin(makeDeps());

    expect(plugin.id).toBe("channel-telegram");
    expect(plugin.name).toBe("Telegram Channel Plugin");
    expect(plugin.channelType).toBe("telegram");
  });

  it("createResolver() returns an object with schemes ['tg-file'] and a resolve function", () => {
    const plugin = createTelegramPlugin(makeDeps());

    const resolver = plugin.createResolver({
      ssrfFetcher: { fetch: vi.fn() },
      maxBytes: 10 * 1024 * 1024,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(resolver.schemes).toEqual(["tg-file"]);
    expect(typeof resolver.resolve).toBe("function");
  });

  it("createResolver() produces independent resolvers per call", () => {
    const plugin = createTelegramPlugin(makeDeps());

    const logger1 = { debug: vi.fn(), warn: vi.fn() };
    const logger2 = { debug: vi.fn(), warn: vi.fn() };

    const resolver1 = plugin.createResolver({
      ssrfFetcher: { fetch: vi.fn() },
      maxBytes: 5 * 1024 * 1024,
      logger: logger1,
    });

    const resolver2 = plugin.createResolver({
      ssrfFetcher: { fetch: vi.fn() },
      maxBytes: 10 * 1024 * 1024,
      logger: logger2,
    });

    expect(resolver1).not.toBe(resolver2);
    expect(resolver1.schemes).toEqual(resolver2.schemes);
  });

  it("keeps media resolution unavailable after credential validation fails", async () => {
    vi.mocked(validateBotToken).mockResolvedValue(err(new Error("invalid rotated token")));
    mockGetFile.mockResolvedValue({
      file_id: "file-id",
      file_unique_id: "unique-id",
      file_path: "photos/file.jpg",
    });
    const plugin = createTelegramPlugin(makeDeps());
    const resolver = plugin.createResolver({
      ssrfFetcher: { fetch: vi.fn() },
      maxBytes: 10 * 1024 * 1024,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const started = await plugin.adapter.start();
    const resolved = await resolver.resolve({ type: "image", url: "tg-file://file-id" });

    expect(started.ok).toBe(false);
    expect(resolved.ok).toBe(false);
    expect(mockGetFile).not.toHaveBeenCalled();
  });

  it("exposes adapter as ChannelPort on plugin", () => {
    const plugin = createTelegramPlugin(makeDeps());

    expect(plugin.adapter).toBeDefined();
    expect(plugin.adapter.channelType).toBe("telegram");
  });

  it("capabilities declare expected feature flags", () => {
    const plugin = createTelegramPlugin(makeDeps());
    const caps = plugin.capabilities;

    expect(caps.features.reactions).toBe(true);
    expect(caps.features.editMessages).toBe(true);
    expect(caps.features.attachments).toBe(true);
    expect(caps.replyToMetaKey).toBe("telegramMessageId");
  });
});
