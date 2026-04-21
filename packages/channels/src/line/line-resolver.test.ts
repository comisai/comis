// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import { createLineResolver, type LineResolverDeps } from "./line-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<LineResolverDeps> = {}): LineResolverDeps {
  return {
    getBlobContent: vi.fn().mockResolvedValue(Buffer.from("line-image-data")),
    maxBytes: 10 * 1024 * 1024,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function makeAttachment(url: string, mimeType?: string): Attachment {
  return { type: "image", url, ...(mimeType != null && { mimeType }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("line-resolver / createLineResolver", () => {
  it("has schemes = ['line-content']", () => {
    const resolver = createLineResolver(mockDeps());
    expect(resolver.schemes).toEqual(["line-content"]);
  });

  it("resolves a line-content:// URL to buffer with correct mimeType and sizeBytes", async () => {
    const imageData = Buffer.from("line-image-data");
    const deps = mockDeps();
    const resolver = createLineResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("line-content://msg-123", "image/jpeg"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(imageData);
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.sizeBytes).toBe(imageData.length);
    }

    // Verify getBlobContent was called with extracted messageId
    expect(deps.getBlobContent).toHaveBeenCalledWith("msg-123");

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "line", messageId: "msg-123", sizeBytes: imageData.length }),
      "LINE media resolved",
    );
  });

  it("returns err and logs warn on 404 error (expired content)", async () => {
    const deps = mockDeps({
      getBlobContent: vi.fn().mockRejectedValue(new Error("HTTP 404: Not Found")),
    });
    const resolver = createLineResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("line-content://expired-msg"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/404/);
    }

    // Should have logged a WARN about expired content
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "line",
        messageId: "expired-msg",
        hint: "LINE message content may have expired",
        errorKind: "platform",
      }),
      expect.stringContaining("expired"),
    );
  });

  it("returns err and logs warn on 410 error (expired content)", async () => {
    const deps = mockDeps({
      getBlobContent: vi.fn().mockRejectedValue(new Error("HTTP 410: Gone")),
    });
    const resolver = createLineResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("line-content://gone-msg"),
    );

    expect(result.ok).toBe(false);

    // Should have logged a WARN about expired content
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: "LINE message content may have expired" }),
      expect.any(String),
    );
  });

  it("returns err when buffer exceeds maxBytes", async () => {
    const bigData = Buffer.alloc(2000, 0x42);
    const deps = mockDeps({
      getBlobContent: vi.fn().mockResolvedValue(bigData),
      maxBytes: 1000,
    });
    const resolver = createLineResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("line-content://big-msg"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }
  });

  it("defaults to application/octet-stream when no mimeType in attachment", async () => {
    const resolver = createLineResolver(mockDeps());

    const result = await resolver.resolve(
      makeAttachment("line-content://no-mime"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("application/octet-stream");
    }
  });

  it("returns err on generic download failure (non-404/410)", async () => {
    const deps = mockDeps({
      getBlobContent: vi.fn().mockRejectedValue(new Error("Network timeout")),
    });
    const resolver = createLineResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("line-content://timeout-msg"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Network timeout/);
    }

    // Should NOT have logged the expired content warning
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});
