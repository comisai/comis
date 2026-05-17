// SPDX-License-Identifier: Apache-2.0
import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createCompositeResolver, type CompositeResolverDeps } from "./composite-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(
  schemes: string[],
  resolveFn?: (att: Attachment) => Promise<Result<ResolvedMedia, Error>>,
): MediaResolverPort {
  return {
    schemes,
    resolve:
      resolveFn ??
      vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from(`resolved-by-${schemes[0]}`),
          mimeType: "application/octet-stream",
          sizeBytes: 100,
        }),
      ),
  };
}

function mockDeps(overrides: Partial<CompositeResolverDeps> = {}): CompositeResolverDeps {
  return {
    resolvers: [],
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from("ssrf-fetched"),
          mimeType: "image/png",
          sizeBytes: 200,
          resolvedIp: "1.2.3.4",
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
  return { type: "file", url, ...(sizeBytes != null && { sizeBytes }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composite-resolver / createCompositeResolver", () => {
  it("routes tg-file:// to the Telegram resolver", async () => {
    const tgResolver = makeResolver(["tg-file"]);
    const deps = mockDeps({ resolvers: [tgResolver] });
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(makeAttachment("tg-file://abc123"));

    expect(result.ok).toBe(true);
    expect(tgResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "tg-file://abc123" }),
    );

    // routing log
    expect(deps.logger.debug).toHaveBeenCalledWith(
      { scheme: "tg-file", resolverFound: true, attachmentType: "file", attachmentSizeBytes: null },
      "CompositeResolver routing",
    );
  });

  it("routes wa-file:// to the WhatsApp resolver", async () => {
    const waResolver = makeResolver(["wa-file"]);
    const deps = mockDeps({ resolvers: [waResolver] });
    const composite = createCompositeResolver(deps);

    await composite.resolve(makeAttachment("wa-file://msg-001"));

    expect(waResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wa-file://msg-001" }),
    );
  });

  it("routes slack-file:// to the Slack resolver", async () => {
    const slackResolver = makeResolver(["slack-file"]);
    const deps = mockDeps({ resolvers: [slackResolver] });
    const composite = createCompositeResolver(deps);

    await composite.resolve(makeAttachment("slack-file://F123"));

    expect(slackResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "slack-file://F123" }),
    );
  });

  it("routes line-content:// to the LINE resolver", async () => {
    const lineResolver = makeResolver(["line-content"]);
    const deps = mockDeps({ resolvers: [lineResolver] });
    const composite = createCompositeResolver(deps);

    await composite.resolve(makeAttachment("line-content://msg-abc"));

    expect(lineResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "line-content://msg-abc" }),
    );
  });

  it("routes file:// to the iMessage resolver", async () => {
    const fileResolver = makeResolver(["file"]);
    const deps = mockDeps({ resolvers: [fileResolver] });
    const composite = createCompositeResolver(deps);

    await composite.resolve(makeAttachment("file:///Users/test/Library/Messages/Attachments/photo.jpg"));

    expect(fileResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "file:///Users/test/Library/Messages/Attachments/photo.jpg" }),
    );
  });

  it("falls back to SSRF fetcher for https:// URLs with no registered resolver", async () => {
    const deps = mockDeps(); // No resolvers registered
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(
      makeAttachment("https://cdn.discordapp.com/attachments/123/456/image.png"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.from("ssrf-fetched"));
      expect(result.value.mimeType).toBe("image/png");
    }

    expect(deps.ssrfFetcher.fetch).toHaveBeenCalledWith(
      "https://cdn.discordapp.com/attachments/123/456/image.png",
    );

    // routing log shows no resolver found
    expect(deps.logger.debug).toHaveBeenCalledWith(
      { scheme: "https", resolverFound: false, attachmentType: "file", attachmentSizeBytes: null },
      "CompositeResolver routing",
    );
  });

  it("falls back to SSRF fetcher for http:// URLs", async () => {
    const deps = mockDeps();
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(
      makeAttachment("http://localhost:8080/api/v1/attachments/abc"),
    );

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalled();
  });

  it("returns err for unknown URI scheme", async () => {
    const deps = mockDeps();
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(
      makeAttachment("ftp://server.example.com/file.zip"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/No resolver for URI scheme: ftp/);
    }
  });

  it("returns err when attachment.sizeBytes exceeds maxBytes", async () => {
    const deps = mockDeps({ maxBytes: 1000 });
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(
      makeAttachment("tg-file://file1", 5000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have routed to any resolver
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("skips global pre-check when sizeBytes is not provided", async () => {
    const tgResolver = makeResolver(["tg-file"]);
    const deps = mockDeps({ resolvers: [tgResolver] });
    const composite = createCompositeResolver(deps);

    await composite.resolve(makeAttachment("tg-file://file1")); // No sizeBytes

    expect(tgResolver.resolve).toHaveBeenCalled();
  });

  it("returns err when URL has no scheme", async () => {
    const composite = createCompositeResolver(mockDeps());

    const result = await composite.resolve(makeAttachment("no-scheme-url"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no scheme found/);
    }
  });

  it("collects schemes from all registered resolvers plus http/https", () => {
    const tgResolver = makeResolver(["tg-file"]);
    const waResolver = makeResolver(["wa-file"]);
    const composite = createCompositeResolver(
      mockDeps({ resolvers: [tgResolver, waResolver] }),
    );

    expect(composite.schemes).toContain("tg-file");
    expect(composite.schemes).toContain("wa-file");
    expect(composite.schemes).toContain("http");
    expect(composite.schemes).toContain("https");
  });

  it("propagates resolver errors as err results", async () => {
    const failingResolver = makeResolver(["tg-file"], async () =>
      err(new Error("Telegram API timeout")),
    );
    const deps = mockDeps({ resolvers: [failingResolver] });
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(makeAttachment("tg-file://fail"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Telegram API timeout/);
    }
  });

  it("propagates SSRF fetcher errors as err results", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(err(new Error("SSRF blocked: private IP"))),
      },
    });
    const composite = createCompositeResolver(deps);

    const result = await composite.resolve(
      makeAttachment("https://10.0.0.1/internal"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/SSRF blocked/);
    }
  });
});
