// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from "@comis/core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createIMessageResolver, type IMessageResolverDeps } from "./imessage-resolver.js";

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from "node:fs/promises";
const mockStat = vi.mocked(fs.stat);
const mockReadFile = vi.mocked(fs.readFile);

// ---------------------------------------------------------------------------
// Mock @comis/core safePath
// ---------------------------------------------------------------------------

vi.mock("@comis/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@comis/core")>();
  return {
    ...original,
    safePath: vi.fn(),
  };
});

import { safePath } from "@comis/core";
const mockSafePath = vi.mocked(safePath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<IMessageResolverDeps> = {}): IMessageResolverDeps {
  return {
    allowedBasePaths: ["/Users/test/Library/Messages/Attachments"],
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

describe("imessage-resolver / createIMessageResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has schemes = ['file']", () => {
    const resolver = createIMessageResolver(mockDeps());
    expect(resolver.schemes).toEqual(["file"]);
  });

  it("resolves a file:// URL to buffer with correct mimeType and sizeBytes", async () => {
    const fileContent = Buffer.from("imessage-photo");
    mockSafePath.mockReturnValue(
      "/Users/test/Library/Messages/Attachments/ab/cd/photo.jpg",
    );
    mockStat.mockResolvedValue({ size: fileContent.length } as Awaited<ReturnType<typeof fs.stat>>);
    mockReadFile.mockResolvedValue(fileContent);

    const deps = mockDeps();
    const resolver = createIMessageResolver(deps);

    const result = await resolver.resolve(
      makeAttachment(
        "file:///Users/test/Library/Messages/Attachments/ab/cd/photo.jpg",
        "image/jpeg",
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(fileContent);
      expect(result.value.mimeType).toBe("image/jpeg");
      expect(result.value.sizeBytes).toBe(fileContent.length);
    }

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "imessage", sizeBytes: fileContent.length }),
      "iMessage media resolved",
    );
  });

  it("rejects path traversal attempts (../../etc/passwd)", async () => {
    // safePath throws on traversal attempts
    mockSafePath.mockImplementation(() => {
      throw new Error('Path traversal blocked: "../../etc/passwd" escapes base');
    });

    const resolver = createIMessageResolver(mockDeps());

    const result = await resolver.resolve(
      makeAttachment("file://../../etc/passwd"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/does not resolve within any allowed base/);
    }

    // Should NOT have attempted file read
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns err when file size exceeds maxBytes", async () => {
    mockSafePath.mockReturnValue(
      "/Users/test/Library/Messages/Attachments/big-file.zip",
    );
    mockStat.mockResolvedValue({ size: 20 * 1024 * 1024 } as Awaited<ReturnType<typeof fs.stat>>);

    const deps = mockDeps({ maxBytes: 10 * 1024 * 1024 });
    const resolver = createIMessageResolver(deps);

    const result = await resolver.resolve(
      makeAttachment("file:///Users/test/Library/Messages/Attachments/big-file.zip"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have attempted file read
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns err when file does not exist", async () => {
    mockSafePath.mockReturnValue(
      "/Users/test/Library/Messages/Attachments/missing.jpg",
    );
    mockStat.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const resolver = createIMessageResolver(mockDeps());

    const result = await resolver.resolve(
      makeAttachment("file:///Users/test/Library/Messages/Attachments/missing.jpg"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/ENOENT/);
    }
  });

  it("uses attachment mimeType when provided", async () => {
    mockSafePath.mockReturnValue(
      "/Users/test/Library/Messages/Attachments/voice.m4a",
    );
    mockStat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockReadFile.mockResolvedValue(Buffer.from("audio-data"));

    const resolver = createIMessageResolver(mockDeps());

    const result = await resolver.resolve(
      makeAttachment("file:///Users/test/Library/Messages/Attachments/voice.m4a", "audio/mp4"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("audio/mp4");
    }
  });

  it("defaults to application/octet-stream when no mimeType in attachment", async () => {
    mockSafePath.mockReturnValue(
      "/Users/test/Library/Messages/Attachments/unknown.bin",
    );
    mockStat.mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof fs.stat>>);
    mockReadFile.mockResolvedValue(Buffer.from("binary-data"));

    const resolver = createIMessageResolver(mockDeps());

    const result = await resolver.resolve(
      makeAttachment("file:///Users/test/Library/Messages/Attachments/unknown.bin"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("application/octet-stream");
    }
  });
});
