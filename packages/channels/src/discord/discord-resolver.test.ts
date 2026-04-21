// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createDiscordResolver, type DiscordResolverDeps } from "./discord-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<DiscordResolverDeps> = {}): DiscordResolverDeps {
  return {
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from("discord-image"),
          mimeType: "image/png",
          sizeBytes: 2048,
          resolvedIp: "5.6.7.8",
        }),
      ),
    },
    maxBytes: 10 * 1024 * 1024,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function makeAttachment(url: string, sizeBytes?: number): Attachment {
  return { type: "image", url, ...(sizeBytes != null && { sizeBytes }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discord-resolver / createDiscordResolver", () => {
  it("has schemes = ['https']", () => {
    const resolver = createDiscordResolver(mockDeps());
    expect(resolver.schemes).toEqual(["https"]);
  });

  it("resolves a Discord CDN URL to buffer with correct mimeType and sizeBytes", async () => {
    const deps = mockDeps();
    const resolver = createDiscordResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("https://cdn.discordapp.com/attachments/123/456/image.png"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.from("discord-image"));
      expect(result.value.mimeType).toBe("image/png");
      expect(result.value.sizeBytes).toBe(2048);
    }

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "discord", sizeBytes: 2048 }),
      "Discord media resolved",
    );
  });

  it("returns err when sizeBytes exceeds maxBytes", async () => {
    const deps = mockDeps({ maxBytes: 1000 });
    const resolver = createDiscordResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("https://cdn.discordapp.com/attachments/123/456/big.zip", 5000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have attempted download
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("skips pre-check when sizeBytes is not provided in attachment metadata", async () => {
    const deps = mockDeps();
    const resolver = createDiscordResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("https://cdn.discordapp.com/attachments/123/456/file.dat"),
    );

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalled();
  });

  it("returns err when SSRF fetcher fails", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(err(new Error("Network error"))),
      },
    });
    const resolver = createDiscordResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("https://cdn.discordapp.com/attachments/123/456/file.dat"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Network error/);
    }
  });
});
