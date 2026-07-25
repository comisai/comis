// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramResolver, type TelegramResolverDeps } from "./telegram-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function depsBot(token: string): ReturnType<TelegramResolverDeps["getBot"]> {
  return {
    token,
    api: {
      getFile: vi.fn().mockResolvedValue({
        file_id: "test-file-id",
        file_unique_id: "unique",
        file_path: "photos/file_0.jpg",
        file_size: 1024,
      }),
    },
  } as unknown as ReturnType<TelegramResolverDeps["getBot"]>;
}

function mockDeps(overrides: Partial<TelegramResolverDeps> = {}): TelegramResolverDeps {
  const bot = depsBot("123456:ABC-DEF1234");
  return {
    getBot: () => bot,
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

  it("does not resolve media when no connected Telegram Bot is available", async () => {
    const deps = mockDeps({ getBot: () => undefined });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(false);
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
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
    expect(deps.getBot().api.getFile).toHaveBeenCalledWith("abc123");

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

  it("uses the Bot owned by the latest polling generation", async () => {
    const firstGetFile = vi.fn();
    const secondGetFile = vi.fn().mockResolvedValue({
      file_id: "test-file-id",
      file_unique_id: "unique",
      file_path: "photos/file_0.jpg",
      file_size: 1024,
    });
    let activeBot = {
      token: "123:first-token",
      api: { getFile: firstGetFile },
    } as unknown as ReturnType<TelegramResolverDeps["getBot"]>;
    const deps = mockDeps({ getBot: () => activeBot });
    const resolver = createTelegramResolver(deps);
    activeBot = {
      token: "123:second-token",
      api: { getFile: secondGetFile },
    } as unknown as ReturnType<TelegramResolverDeps["getBot"]>;

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    expect(firstGetFile).not.toHaveBeenCalled();
    expect(secondGetFile).toHaveBeenCalledWith("abc123");
  });

  it("uses the credential paired with the latest polling generation", async () => {
    const firstBot = depsBot("123:first-token");
    const secondBot = depsBot("123:second-token");
    let activeBot = firstBot;
    const deps = mockDeps({ getBot: () => activeBot });
    const resolver = createTelegramResolver(deps);
    activeBot = secondBot;

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123:second-token/photos/file_0.jpg",
    );
  });

  it("constructs the download URL from apiRoot when set (local Bot API server / emulator)", async () => {
    // A resolver that hardcodes `https://api.telegram.org/file/...` and
    // IGNORES apiRoot means `getFile` honors the custom apiRoot (grammy client) but the file DOWNLOAD
    // 404s against real Telegram. Media-INPUT (photo/voice/doc/video) would be dead through ANY custom
    // apiRoot — the emulator AND a self-hosted local Bot API server (Telegram's documented large-file
    // / privacy deployment). The download base must follow apiRoot, exactly as getFile does.
    const deps = mockDeps({ apiRoot: "http://127.0.0.1:38411" });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:38411/file/bot123456:ABC-DEF1234/photos/file_0.jpg",
    );
  });

  it("returns err when file size exceeds maxBytes", async () => {
    const deps = mockDeps({
      getBot: () => ({
        token: "123456:ABC-DEF1234",
        api: {
          getFile: vi.fn().mockResolvedValue({
            file_id: "big-file",
            file_unique_id: "ubig",
            file_path: "docs/big.pdf",
            file_size: 20 * 1024 * 1024, // 20 MB
          }),
        },
      }) as unknown as ReturnType<TelegramResolverDeps["getBot"]>,
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
      getBot: () => ({
        token: "123456:ABC-DEF1234",
        api: {
          getFile: vi.fn().mockRejectedValue(new Error("Telegram API error")),
        },
      }) as unknown as ReturnType<TelegramResolverDeps["getBot"]>,
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
      getBot: () => depsBot(botToken),
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
      getBot: () => ({
        token: botToken,
        api: {
          getFile: vi.fn().mockRejectedValue(
            new Error(`Request to https://api.telegram.org/bot${botToken}/getFile failed: 401 Unauthorized`),
          ),
        },
      }) as unknown as ReturnType<TelegramResolverDeps["getBot"]>,
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
      getBot: () => ({
        token: "123456:ABC-DEF1234",
        api: {
          getFile: vi.fn().mockResolvedValue({
            file_id: "no-path",
            file_unique_id: "unp",
          }),
        },
      }) as unknown as ReturnType<TelegramResolverDeps["getBot"]>,
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://no-path"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no file_path/);
    }
  });

  it("returns the VERIFIED (sniffed) MIME type — overrides a mislabeled declared type", async () => {
    // Telegram's `.jpg` file_path / image/jpeg header can mislabel PNG bytes,
    // and the model vision API 400s on a declared type that mismatches the bytes. The port contract
    // specifies a sniffed type — the resolver must report image/png for PNG bytes regardless of the
    // declared image/jpeg.
    // A real 1×1 PNG (so file-type's magic-byte sniff recognizes it), declared as image/jpeg below.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(
          ok({ buffer: pngBytes, mimeType: "image/jpeg", sizeBytes: pngBytes.length, resolvedIp: "1.2.3.4" }),
        ),
      },
    });
    const resolver = createTelegramResolver(deps);

    const result = await resolver.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("image/png"); // sniffed wins over the declared image/jpeg
    }
  });
});
