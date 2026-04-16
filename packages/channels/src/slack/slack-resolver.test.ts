import type { Attachment } from "@comis/core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSlackResolver, type SlackResolverDeps } from "./slack-resolver.js";

// ---------------------------------------------------------------------------
// Mock fetchWithSlackAuth
// ---------------------------------------------------------------------------

vi.mock("./media-handler.js", () => ({
  fetchWithSlackAuth: vi.fn(),
}));

import { fetchWithSlackAuth } from "./media-handler.js";
const mockFetchWithSlackAuth = vi.mocked(fetchWithSlackAuth);

// ---------------------------------------------------------------------------
// Mock global fetch (for files.info)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeps(overrides: Partial<SlackResolverDeps> = {}): SlackResolverDeps {
  return {
    botToken: "xoxb-test-token",
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

function stubFilesInfoResponse(file: Record<string, unknown>): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ ok: true, file }),
  });
}

function stubDownloadResponse(data: Buffer, mimeType = "application/pdf"): void {
  mockFetchWithSlackAuth.mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    headers: new Headers({ "content-type": mimeType }),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("slack-resolver / createSlackResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has schemes = ['slack-file']", () => {
    const resolver = createSlackResolver(mockDeps());
    expect(resolver.schemes).toEqual(["slack-file"]);
  });

  it("resolves a slack-file:// URL to buffer with correct mimeType and sizeBytes", async () => {
    const fileData = Buffer.from("pdf-content");
    stubFilesInfoResponse({
      url_private_download: "https://files.slack.com/files-pri/T123/doc.pdf",
      size: fileData.length,
      mimetype: "application/pdf",
    });
    stubDownloadResponse(fileData);

    const deps = mockDeps();
    const resolver = createSlackResolver(deps);

    const result = await resolver.resolve(makeAttachment("slack-file://F123ABC"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toEqual(fileData);
      expect(result.value.mimeType).toBe("application/pdf");
      expect(result.value.sizeBytes).toBe(fileData.length);
    }

    // Verify files.info was called
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/files.info",
      expect.objectContaining({
        method: "POST",
        body: "file=F123ABC",
      }),
    );

    // Verify fetchWithSlackAuth was called with the download URL
    expect(mockFetchWithSlackAuth).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T123/doc.pdf",
      "xoxb-test-token",
    );

    // Debug log was emitted
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "slack", fileId: "F123ABC", sizeBytes: fileData.length }),
      "Slack media resolved",
    );
  });

  it("returns err when file size exceeds maxBytes", async () => {
    stubFilesInfoResponse({
      url_private_download: "https://files.slack.com/big.zip",
      size: 20 * 1024 * 1024,
    });

    const deps = mockDeps({ maxBytes: 10 * 1024 * 1024 });
    const resolver = createSlackResolver(deps);

    const result = await resolver.resolve(makeAttachment("slack-file://F_BIG"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/exceeds limit/);
    }

    // Should NOT have attempted download
    expect(mockFetchWithSlackAuth).not.toHaveBeenCalled();
  });

  it("returns err when files.info fails", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: "file_not_found" }),
    });

    const resolver = createSlackResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("slack-file://F_MISSING"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/file_not_found/);
    }
  });

  it("returns err when files.info HTTP request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const resolver = createSlackResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("slack-file://F_ERR"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/HTTP 500/);
    }
  });

  it("returns err when download fails", async () => {
    stubFilesInfoResponse({
      url_private_download: "https://files.slack.com/file.pdf",
      size: 1024,
    });
    mockFetchWithSlackAuth.mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    const resolver = createSlackResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("slack-file://F_DENIED"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/HTTP 403/);
    }
  });

  it("falls back to url_private when url_private_download is missing", async () => {
    const fileData = Buffer.from("fallback-content");
    stubFilesInfoResponse({
      url_private: "https://files.slack.com/files-pri/T123/fallback.txt",
      size: fileData.length,
    });
    stubDownloadResponse(fileData, "text/plain");

    const resolver = createSlackResolver(mockDeps());

    const result = await resolver.resolve(makeAttachment("slack-file://F_FALLBACK"));

    expect(result.ok).toBe(true);
    expect(mockFetchWithSlackAuth).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T123/fallback.txt",
      expect.any(String),
    );
  });
});
