import type { Attachment } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createSignalResolver, type SignalResolverDeps } from "./signal-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<SignalResolverDeps> = {}): SignalResolverDeps {
  return {
    ssrfFetcher: {
      fetch: vi.fn().mockResolvedValue(
        ok({
          buffer: Buffer.from("signal-audio"),
          mimeType: "audio/ogg",
          sizeBytes: 4096,
          resolvedIp: "10.0.0.1",
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
  return { type: "audio", url, ...(sizeBytes != null && { sizeBytes }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signal-resolver / createSignalResolver", () => {
  it("has schemes = ['http', 'https']", () => {
    const resolver = createSignalResolver(mockDeps());
    expect(resolver.schemes).toEqual(["http", "https"]);
  });

  it("resolves a Signal attachment URL to buffer with correct mimeType and sizeBytes", async () => {
    const deps = mockDeps();
    const resolver = createSignalResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("http://localhost:8080/api/v1/attachments/abc-123"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(Buffer.from("signal-audio"));
      expect(result.value.mimeType).toBe("audio/ogg");
      expect(result.value.sizeBytes).toBe(4096);
    }

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "signal", sizeBytes: 4096 }),
      "Signal media resolved",
    );
  });

  it("returns err when sizeBytes exceeds maxBytes", async () => {
    const deps = mockDeps({ maxBytes: 1000 });
    const resolver = createSignalResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("http://localhost:8080/api/v1/attachments/big", 5000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have attempted download
    expect(deps.ssrfFetcher.fetch).not.toHaveBeenCalled();
  });

  it("skips pre-check when sizeBytes is not provided", async () => {
    const deps = mockDeps();
    const resolver = createSignalResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("http://localhost:8080/api/v1/attachments/unknown-size"),
    );

    expect(result.ok).toBe(true);
    expect(deps.ssrfFetcher.fetch).toHaveBeenCalled();
  });

  it("returns err when SSRF fetcher fails", async () => {
    const deps = mockDeps({
      ssrfFetcher: {
        fetch: vi.fn().mockResolvedValue(err(new Error("Connection refused"))),
      },
    });
    const resolver = createSignalResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("http://localhost:8080/api/v1/attachments/abc"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Connection refused/);
    }
  });
});
