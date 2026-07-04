// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import { createSsrfGuardedFetcher } from "./ssrf-fetcher.js";
import type { ValidatedUrl } from "@comis/core";

// Mock @comis/core's validateUrl + validateLocalServerUrl (MEDIA-INPUT-SSRF trusted-origin path)
vi.mock("@comis/core", () => ({
  validateUrl: vi.fn(),
  validateLocalServerUrl: vi.fn(),
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
  // Delegate `fetch` to `globalThis.fetch` so existing tests can keep using
  // `globalThis.fetch = vi.fn()` orchestration. After the undici-fetch + Agent
  // ABI fix the production code imports `fetch` from "undici" directly; the
  // factory must therefore expose a `fetch` export.
  const fetch = (...args: Parameters<typeof globalThis.fetch>) =>
    globalThis.fetch(...args);
  return { Agent: MockAgent, fetch };
});

// Import the mocked version so we can control its return values
import { validateUrl, validateLocalServerUrl } from "@comis/core";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
const mockValidateUrl = vi.mocked(validateUrl);
const mockValidateLocalServerUrl = vi.mocked(validateLocalServerUrl);

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
    mockValidateUrl.mockClear();
    mockValidateLocalServerUrl.mockClear();
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

  // A URL whose ORIGIN matches a configured trusted apiRoot
  // (a self-hosted local Bot API server / the emulator on loopback) is validated leniently
  // (validateLocalServerUrl — loopback permitted) so the file-byte download works; an arbitrary
  // loopback URL (a different port) still goes through strict validateUrl (the SSRF firewall).
  it("a TRUSTED-origin URL is validated via validateLocalServerUrl (loopback allowed)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher(
      { maxBytes: 1024 * 1024, trustedFetchOrigins: ["http://127.0.0.1:38411"] },
      logger,
    );
    mockValidateLocalServerUrl.mockResolvedValue(
      ok(makeValidatedUrl({ hostname: "127.0.0.1", ip: "127.0.0.1", url: new URL("http://127.0.0.1:38411/file/x.jpg") })),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ headers: { "content-type": "image/jpeg" }, body: new Uint8Array([1, 2, 3]) }),
    );

    const result = await fetcher.fetch("http://127.0.0.1:38411/file/x.jpg");

    expect(result.ok).toBe(true);
    expect(mockValidateLocalServerUrl).toHaveBeenCalledWith("http://127.0.0.1:38411/file/x.jpg", ["127.0.0.1"]);
    expect(mockValidateUrl).not.toHaveBeenCalled();
  });

  it("an UNtrusted loopback URL (different port) still uses strict validateUrl (SSRF block preserved)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher(
      { maxBytes: 1024, trustedFetchOrigins: ["http://127.0.0.1:38411"] },
      logger,
    );
    // The gateway port is NOT the trusted apiRoot origin → strict validateUrl rejects it.
    mockValidateUrl.mockResolvedValue(err(new Error("127.0.0.1 is in blocked range (loopback)")));

    const result = await fetcher.fetch("http://127.0.0.1:4766/health");

    expect(result.ok).toBe(false);
    expect(mockValidateUrl).toHaveBeenCalledWith("http://127.0.0.1:4766/health");
    expect(mockValidateLocalServerUrl).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // Opt-in auth header + redirect-hop revalidation (a backward-compatible
  // superset). Passing the second `opts` arg turns on an authenticated,
  // redirect-following path: the auth header rides ONLY a hop whose validated
  // host is on `authAllowHosts`, is DROPPED on a cross-host redirect, and
  // validateUrl re-runs on EVERY hop (per-hop DNS-pin). The no-opts path is
  // unchanged (redirect blocked, no auth) — pinned by the last case below.
  // -------------------------------------------------------------------------

  it("attaches the auth header only when the current-hop host is on the allowlist", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(
      ok(
        makeValidatedUrl({
          hostname: "smba.gbl.botframework.com",
          ip: "13.107.9.1",
          url: new URL("https://smba.gbl.botframework.com/v3/attachments/x"),
        }),
      ),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) }),
    );

    const result = await fetcher.fetch("https://smba.gbl.botframework.com/v3/attachments/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(true);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers).toMatchObject({ authorization: "Bearer T" });
  });

  it("withholds the auth header from a host that is NOT on the allowlist", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(
      ok(
        makeValidatedUrl({
          hostname: "attacker.example.com",
          ip: "203.0.113.5",
          url: new URL("https://attacker.example.com/x"),
        }),
      ),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([1]) }),
    );

    const result = await fetcher.fetch("https://attacker.example.com/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(true);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]![1] as { headers?: Record<string, string> };
    expect((init.headers ?? {}).authorization).toBeUndefined();
  });

  it("DROPS the auth header on a cross-host redirect and re-validates every hop", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl
      .mockResolvedValueOnce(
        ok(
          makeValidatedUrl({
            hostname: "smba.gbl.botframework.com",
            ip: "13.107.9.1",
            url: new URL("https://smba.gbl.botframework.com/v3/attachments/x"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok(
          makeValidatedUrl({
            hostname: "storage.example.net",
            ip: "203.0.113.9",
            url: new URL("https://storage.example.net/blob"),
          }),
        ),
      );
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        createMockResponse({ ok: false, status: 302, headers: { location: "https://storage.example.net/blob" } }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([9, 9, 9]) }),
      );

    const result = await fetcher.fetch("https://smba.gbl.botframework.com/v3/attachments/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(true);
    // per-hop SSRF revalidation: validateUrl ran for the initial URL AND the redirect target
    expect(mockValidateUrl).toHaveBeenCalledTimes(2);
    expect(mockValidateUrl).toHaveBeenNthCalledWith(1, "https://smba.gbl.botframework.com/v3/attachments/x");
    expect(mockValidateUrl).toHaveBeenNthCalledWith(2, "https://storage.example.net/blob");
    // hop 0 (allowlisted) carried the bearer; hop 1 (cross-host) did NOT
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect((calls[0]![1] as { headers?: Record<string, string> }).headers).toMatchObject({
      authorization: "Bearer T",
    });
    expect(((calls[1]![1] as { headers?: Record<string, string> }).headers ?? {}).authorization).toBeUndefined();
  });

  it("rejects a redirect whose target fails SSRF validation (per-hop firewall, never followed)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl
      .mockResolvedValueOnce(
        ok(
          makeValidatedUrl({
            hostname: "smba.gbl.botframework.com",
            ip: "13.107.9.1",
            url: new URL("https://smba.gbl.botframework.com/x"),
          }),
        ),
      )
      .mockResolvedValueOnce(err(new Error("169.254.169.254 is in blocked range (cloud_metadata)")));
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createMockResponse({ ok: false, status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );

    const result = await fetcher.fetch("https://smba.gbl.botframework.com/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked range");
    }
    // the malicious redirect target was validated but NEVER fetched (only the first hop hit the wire)
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
  });

  it("does not treat a look-alike host as an allowlist suffix match (no partial-suffix bypass)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(
      ok(
        makeValidatedUrl({
          hostname: "evilbotframework.com",
          ip: "203.0.113.7",
          url: new URL("https://evilbotframework.com/x"),
        }),
      ),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([1]) }),
    );

    const result = await fetcher.fetch("https://evilbotframework.com/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(true);
    const init = vi.mocked(globalThis.fetch).mock.calls[0]![1] as { headers?: Record<string, string> };
    expect((init.headers ?? {}).authorization).toBeUndefined();
  });

  it("never writes the auth header or the raw URL into a log field (T-5)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);
    const secret = "Bearer super-secret-token";
    const url = "https://smba.gbl.botframework.com/v3/attachments/private?sig=SECRETSIG";

    mockValidateUrl.mockResolvedValue(
      ok(makeValidatedUrl({ hostname: "smba.gbl.botframework.com", ip: "13.107.9.1", url: new URL(url) })),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([1]) }),
    );

    await fetcher.fetch(url, { authHeader: secret, authAllowHosts: [".botframework.com"] });

    const everyLogArg = [logger.debug, logger.warn, logger.error]
      .flatMap((fn) => vi.mocked(fn).mock.calls)
      .map((call) => JSON.stringify(call));
    for (const serialized of everyLogArg) {
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain("SECRETSIG");
    }
  });

  it("caps a redirect chain at maxHops so a redirect loop cannot spin forever", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    // Every hop validates and returns another same-host redirect.
    mockValidateUrl.mockResolvedValue(
      ok(
        makeValidatedUrl({
          hostname: "smba.gbl.botframework.com",
          ip: "13.107.9.1",
          url: new URL("https://smba.gbl.botframework.com/loop"),
        }),
      ),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      createMockResponse({ ok: false, status: 302, headers: { location: "https://smba.gbl.botframework.com/loop" } }),
    );

    const result = await fetcher.fetch("https://smba.gbl.botframework.com/loop", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
      maxHops: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/hop limit/i);
    }
    // maxHops=2 → hops 0,1,2 attempted (3 requests), then the cap trips
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(3);
  });

  it("classifies a malformed redirect Location with a validation hint instead of a bare throw", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl.mockResolvedValue(
      ok(
        makeValidatedUrl({
          hostname: "smba.gbl.botframework.com",
          ip: "13.107.9.1",
          url: new URL("https://smba.gbl.botframework.com/v3/attachments/x"),
        }),
      ),
    );
    // A 3xx whose Location cannot be parsed as a URL (unterminated IPv6 literal).
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createMockResponse({ ok: false, status: 302, headers: { location: "http://[" } }),
    );

    const result = await fetcher.fetch("https://smba.gbl.botframework.com/v3/attachments/x", {
      authHeader: "Bearer T",
      authAllowHosts: [".botframework.com"],
    });

    expect(result.ok).toBe(false);
    // The malformed-Location branch now carries the per-hop classified hint+errorKind
    // (§2.7), not a bare TypeError stripped of which hop failed and why.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hop: 0,
        errorKind: "validation",
        hint: expect.stringContaining("Location"),
      }),
      "SSRF-guarded auth fetch failed — malformed redirect target",
    );
  });

  it("follows a SharePoint 302 to blob storage token-free (a pre-authed downloadUrl carries no bearer on either hop)", async () => {
    const logger = createMockLogger();
    const fetcher = createSsrfGuardedFetcher({ maxBytes: 1024 * 1024 }, logger);

    mockValidateUrl
      .mockResolvedValueOnce(
        ok(
          makeValidatedUrl({
            hostname: "contoso.sharepoint.com",
            ip: "13.107.136.9",
            url: new URL("https://contoso.sharepoint.com/sites/s/download.aspx?x=1"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok(
          makeValidatedUrl({
            hostname: "abc.blob.core.windows.net",
            ip: "20.150.34.4",
            url: new URL("https://abc.blob.core.windows.net/c/blob"),
          }),
        ),
      );
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 302,
          headers: { location: "https://abc.blob.core.windows.net/c/blob" },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([7, 7, 7]) }),
      );

    // The Teams default auth allowlist is Connector hosts only — SharePoint and blob
    // are both OFF it, so the bearer is withheld on BOTH hops even though one is passed.
    const result = await fetcher.fetch("https://contoso.sharepoint.com/sites/s/download.aspx?x=1", {
      authHeader: "Bearer T",
      authAllowHosts: ["smba.trafficmanager.net", ".botframework.com"],
    });

    expect(result.ok).toBe(true);
    // Both hops were followed + SSRF-revalidated, and NEITHER carried the bearer.
    expect(mockValidateUrl).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(((calls[0]![1] as { headers?: Record<string, string> }).headers ?? {}).authorization).toBeUndefined();
    expect(((calls[1]![1] as { headers?: Record<string, string> }).headers ?? {}).authorization).toBeUndefined();
  });
});
