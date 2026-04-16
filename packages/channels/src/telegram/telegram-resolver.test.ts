import type { Attachment } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramResolver, type TelegramResolverDeps } from "./telegram-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<TelegramResolverDeps> = {}): TelegramResolverDeps {
  return {
    bot: {
      api: {
        getFile: vi.fn().mockResolvedValue({
          file_id: "test-file-id",
          file_unique_id: "unique",
          file_path: "photos/file_0.jpg",
          file_size: 1024,
        }),
      },
    } as unknown as TelegramResolverDeps["bot"],
    botToken: "123456:ABC-DEF1234",
    maxBytes: 10 * 1024 * 1024, // 10 MB
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from("image-data"),
          mimeType: "image/jpeg",
          sizeBytes: 1024,
          resolvedIp: "1.2.3.4",
        }),
      ),
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function makeAttachment(url: string): Attachment {
  return { type: "image", url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telegram-resolver / createTelegramResolver", () => {
  it("has schemes = ['tg-file']", () => {
    const resolver = createTelegramResolver(mockDeps());
    expect(resolver.schemes).toEqual(["tg-file"]);
  });

  it("resolves a tg-file:// URL to buffer with correct mimeType and sizeBytes", async () => {
    const deps = mockDeps();
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.from("image-data"));
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.sizeBytes).toBe(1024);
    }

    // Verify getFile was called with the extracted fileId
    expect(deps.bot.api.getFile).toHaveBeenCalledWith("abc123");

    // Verify SSRF fetcher was called with constructed download URL
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123456:ABC-DEF1234/photos/file_0.jpg",
    );

    // getFile result debug log
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "abc123", filePath: "photos/file_0.jpg", fileSize: 1024 }),
      "Telegram getFile result",
    );

    // Debug log was emitted with filePath
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "telegram", fileId: "abc123", filePath: "photos/file_0.jpg", sizeBytes: 1024 }),
      "Telegram media resolved",
    );
  });

  it("returns err when file size exceeds maxBytes", async () => {
    const deps = mockDeps({
      bot: {
        api: {
          getFile: vi.fn().mockResolvedValue({
            file_id: "big-file",
            file_unique_id: "ubig",
            file_path: "docs/big.pdf",
            file_size: 20 * 1024 * 1024, // 20 MB
          }),
        },
      } as unknown as TelegramResolverDeps["bot"],
      maxBytes: 10 * 1024 * 1024, // 10 MB
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://big-file"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have attempted download
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("returns err when getFile fails", async () => {
    const deps = mockDeps({
      bot: {
        api: {
          getFile: vi.fn().mockRejectedValue(new Error("Telegram API error")),
        },
      } as unknown as TelegramResolverDeps["bot"],
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://bad-id"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Telegram API error/);
    }
  });

  it("returns err and emits WARN when SSRF fetcher fails", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(err(new Error("SSRF blocked"))),
      },
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://file1"));

    expect(result.ok).toBe(false);
    // WARN log should be emitted on fetch failure
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "file1",
        downloadDomain: "api.telegram.org",
        errorKind: "platform",
        hint: expect.stringContaining("Telegram file download failed"),
      }),
      "Telegram media fetch failed",
    );
  });

  it("sanitizes bot token from error messages when SSRF fetch fails", async () => {
    // Use a realistic-length bot token (20+ chars after colon) so sanitizeLogString regex matches
    const botToken = "123456789:AABBCCDDEEFFGGHHIIJJkkll";
    const deps = mockDeps({
      botToken,
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          err(new Error(`Failed to fetch https://api.telegram.org/file/bot${botToken}/photos/file.jpg: connection refused`)),
        ),
      },
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://file1"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The raw bot token should NOT appear in the error message
      expect(result.error.message).not.toContain(botToken);
      expect(result.error.message).toContain("[REDACTED_BOT_TOKEN]");
    }
  });

  it("sanitizes bot token from Grammy API errors", async () => {
    // Use a realistic-length bot token (20+ chars after colon) so sanitizeLogString regex matches
    const botToken = "123456789:AABBCCDDEEFFGGHHIIJJkkll";
    const deps = mockDeps({
      botToken,
      bot: {
        api: {
          getFile: vi.fn().mockRejectedValue(
            new Error(`Request to https://api.telegram.org/bot${botToken}/getFile failed: 401 Unauthorized`),
          ),
        },
      } as unknown as TelegramResolverDeps["bot"],
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://bad-id"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The raw bot token should NOT appear in the error message
      expect(result.error.message).not.toContain(botToken);
      expect(result.error.message).toContain("[REDACTED_BOT_TOKEN]");
    }
  });

  it("returns err when getFile returns no file_path", async () => {
    const deps = mockDeps({
      bot: {
        api: {
          getFile: vi.fn().mockResolvedValue({
            file_id: "no-path",
            file_unique_id: "unp",
          }),
        },
      } as unknown as TelegramResolverDeps["bot"],
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://no-path"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no file_path/);
    }
  });
});
