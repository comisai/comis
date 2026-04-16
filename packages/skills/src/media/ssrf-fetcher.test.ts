import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import { createSsrfGuardedFetcher } from "./ssrf-fetcher.js";
import type { ValidatedUrl } from "@comis/core";

// Mock @comis/core's validateUrl
vi.mock("@comis/core", () => ({
  validateUrl: vi.fn(),
}));

// Mock undici Agent — must be a real class so `new Agent()` works.
// vi.hoisted runs before vi.mock hoisting, making the ref available in the factory.
const { mockAgentClose } = vi.hoisted(() => {
  const mockAgentClose = vi.fn().mockResolvedValue(undefined);
  return { mockAgentClose };
});

vi.mock("undici", () => {
  class MockAgent {
    close = mockAgentClose;
  }
  return { Agent: MockAgent };
});

// Import the mocked version so we can control its return values
import { validateUrl } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
const mockValidateUrl = vi.mocked(validateUrl);

function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}): Response {
  const { ok: isOk = true, status = 200, headers = {}, body = null } = options;

  const headerMap = new Headers(headers);

  // Create a ReadableStream from the body bytes
  let readableStream: ReadableStream<Uint8Array> | null = null;
  if (body !== null) {
    readableStream = new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }

  return {
    ok: isOk,
    status,
    headers: headerMap,
    body: readableStream,
  } as unknown as Response;
}

function makeValidatedUrl(overrides: Partial<ValidatedUrl> = {}): ValidatedUrl {
  const url = new URL("https://example.com/audio.ogg");
  return {
    hostname: "example.com",
    ip: "93.184.216.34",
    url,
    ...overrides,
  };
}

describe("createSsrfGuardedFetcher", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    mockAgentClose.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects URLs that fail SSRF validation", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 }, logger);

    mockValidateUrl.mockResolvedValue(
      err(new Error("IP 169.254.169.254 is in blocked range")),
    );

    const result = await fetcher.fetch("http://169.254.169.254/latest/meta-data/");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked range");
    }
    // globalThis.fetch should NOT have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // logger.error should have been called with hint and errorKind
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("SSRF validation"),
        errorKind: "validation",
      }),
      expect.stringContaining("URL validation rejected"),
    );
  });

  it("fetches with original URL and undici dispatcher (Agent-based DNS pinning)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);
    const validated = makeValidatedUrl();

    mockValidateUrl.mockResolvedValue(ok(validated));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({
        headers: { "content-type": "audio/ogg" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );

    const result = await fetcher.fetch("https://example.com/audio.ogg");

    expect(result.ok).toBe(true);
    // Verify fetch was called with the ORIGINAL URL (not pinnedUrl)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/audio.ogg",
      expect.objectContaining({
        redirect: "error",
        dispatcher: expect.objectContaining({ close: expect.any(Function) }),
      }),
    );
    // Should NOT have Host header (no longer needed with Agent-based pinning)
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.headers).toBeUndefined();
  });

  it("emits DNS validation DEBUG log after successful validation", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({
        headers: { "content-type": "audio/ogg" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    await fetcher.fetch("https://example.com/audio.ogg");

    expect(logger.debug).toHaveBeenCalledWith(
      { hostname: "example.com", resolvedIp: "93.184.216.34" },
      "SSRF DNS validation passed",
    );
  });

  it("rejects when Content-Length exceeds maxBytes", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 100 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));

    // Create a response with Content-Length > maxBytes but with a cancelable body
    const mockBody = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "500", "content-type": "audio/ogg" }),
      body: mockBody,
    } as unknown as Response);

    const result = await fetcher.fetch("https://example.com/large.ogg");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds limit");
      expect(result.error.message).toContain("500");
      expect(result.error.message).toContain("100");
    }
  });

  it("enforces size limit during streaming even without Content-Length", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 10 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));

    // Create a body that streams more than maxBytes without Content-Length header
    const largeChunk = new Uint8Array(20); // 20 bytes > 10 byte limit
    const mockBody = new ReadableStream({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.close();
      },
    });

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/ogg" }),
      body: mockBody,
    } as unknown as Response);

    const result = await fetcher.fetch("https://example.com/stream.ogg");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeded limit");
      expect(result.error.message).toContain("10");
    }
  });

  it("returns FetchedMedia with buffer, mimeType, sizeBytes, resolvedIp on success", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    const validated = makeValidatedUrl({ ip: "93.184.216.34" });
    mockValidateUrl.mockResolvedValue(ok(validated));

    const audioData = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OGG header bytes
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({
        headers: { "content-type": "audio/ogg" },
        body: audioData,
      }),
    );

    const result = await fetcher.fetch("https://example.com/voice.ogg");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.buffer).toBeInstanceOf(Buffer);
      expect(result.value.buffer.length).toBe(4);
      expect(result.value.mimeType).toBe("audio/ogg");
      expect(result.value.sizeBytes).toBe(4);
      expect(result.value.resolvedIp).toBe("93.184.216.34");
    }
  });

  it("rejects non-ok HTTP responses", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ ok: false, status: 404 }),
    );

    const result = await fetcher.fetch("https://example.com/missing.ogg");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("HTTP 404");
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("publicly accessible"),
        errorKind: "network",
      }),
      expect.stringContaining("HTTP error response"),
    );
  });

  it("blocks redirects and classifies the error", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));

    // When redirect: "error" is set, fetch throws a TypeError on redirect
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new TypeError("fetch failed: redirect mode is set to error"),
    );

    const result = await fetcher.fetch("https://example.com/redirect");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("redirect");
    }
    // Should emit WARN with classified error
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "network",
        hint: expect.stringContaining("redirect"),
      }),
      "SSRF-guarded fetch failed — network error",
    );
  });

  it("classifies TLS errors with appropriate hint", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error("TLS certificate verify failed"),
    );

    const result = await fetcher.fetch("https://example.com/tls-fail");

    expect(result.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "network",
        hint: expect.stringContaining("TLS"),
      }),
      "SSRF-guarded fetch failed — network error",
    );
  });

  it("classifies timeout errors with appropriate hint", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    const result = await fetcher.fetch("https://example.com/slow");

    expect(result.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "timeout",
        hint: expect.stringContaining("timed out"),
      }),
      "SSRF-guarded fetch failed — network error",
    );
  });

  it("cleans up Agent after successful fetch", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(ok(makeValidatedUrl()));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({
        headers: { "content-type": "audio/ogg" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );

    await fetcher.fetch("https://example.com/audio.ogg");

    // Agent.close() should have been called via suppressError
    expect(mockAgentClose).toHaveBeenCalled();
  });
});
