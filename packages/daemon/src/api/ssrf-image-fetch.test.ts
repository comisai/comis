// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the shared DNS-pinned SSRF-safe image fetch helper
 * (ssrf-image-fetch.ts).
 *
 * The helper closes the DNS-rebinding TOCTOU SSRF vector shared by the
 * `reference_image` URL branch (image-handlers) and the `image.analyze` url
 * branch (media-handlers): it validates the host with `validateUrl`, then pins
 * the connection to the *validated* IP via an undici Agent passed as the
 * `dispatcher` (so `fetch`'s own DNS lookup cannot re-resolve to an internal IP
 * between check and use).
 *
 * Test seam (mirrors ssrf-fetcher.test.ts): the `undici` MODULE is mocked so
 * `Agent` is a real class (constructor args captured) and `fetch` delegates to
 * `globalThis.fetch` — NEVER the real network. `validateUrl` is mocked from
 * `@comis/core`.
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ValidatedUrl } from "@comis/core";

// Mock @comis/core's validateUrl (preserve other exports the helper imports).
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual, validateUrl: vi.fn() };
});

// Mock undici — Agent must be a real class so `new Agent()` works; the
// constructor args (the pinned-IP lookup config) are captured for assertion.
// `fetch` delegates to globalThis.fetch so the test controls the response.
const { agentCtor, agentClose } = vi.hoisted(() => {
  const agentCtor = vi.fn();
  const agentClose = vi.fn().mockResolvedValue(undefined);
  return { agentCtor, agentClose };
});

vi.mock("undici", () => {
  class MockAgent {
    close = agentClose;
    constructor(args: unknown) {
      agentCtor(args);
    }
  }
  const fetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);
  return { Agent: MockAgent, fetch };
});

import { fetchImageBytesSsrfSafe } from "./ssrf-image-fetch.js";
import { validateUrl } from "@comis/core";
const mockValidateUrl = vi.mocked(validateUrl);

function makeValidatedUrl(over: Partial<ValidatedUrl> = {}): ValidatedUrl {
  return { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/i.png"), ...over };
}

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}): Response {
  const { ok: isOk = true, status = 200, headers = {}, body = null } = opts;
  let stream: ReadableStream<Uint8Array> | null = null;
  if (body !== null) {
    stream = new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }
  return { ok: isOk, status, headers: new Headers(headers), body: stream } as unknown as Response;
}

const MAX = 20 * 1024 * 1024;

describe("fetchImageBytesSsrfSafe (DNS-pinned SSRF-safe fetch)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    agentCtor.mockClear();
    agentClose.mockClear();
    mockValidateUrl.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws SSRF blocked and never fetches when validateUrl rejects", async () => {
    mockValidateUrl.mockResolvedValue({ ok: false, error: new Error("blocked private IP") } as never);

    await expect(fetchImageBytesSsrfSafe("http://169.254.169.254/latest/meta-data", MAX)).rejects.toThrow(
      /SSRF blocked/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("pins DNS to the VALIDATED IP — even when DNS would rebind to an internal IP at fetch time", async () => {
    // validateUrl resolved a PUBLIC ip; the helper MUST pin to it. A bare fetch
    // (no dispatcher) would re-resolve DNS and could hit an internal IP — the
    // rebinding gap this helper closes. Assert the pinned Agent is passed as dispatcher
    // AND constructed with a lookup that returns the validated IP.
    mockValidateUrl.mockResolvedValue({ ok: true, value: makeValidatedUrl({ ip: "93.184.216.34" }) } as never);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) }),
    );

    const res = await fetchImageBytesSsrfSafe("https://example.com/i.png", MAX);

    expect(mockValidateUrl).toHaveBeenCalledWith("https://example.com/i.png");
    // The pinned Agent was constructed (the dispatcher) — proves DNS pinning.
    expect(agentCtor).toHaveBeenCalledTimes(1);
    // The Agent's lookup returns the validated public IP (not a re-resolved one).
    const agentArgs = agentCtor.mock.calls[0]![0] as { connect: { lookup: (...a: unknown[]) => void } };
    const cb = vi.fn();
    agentArgs.connect.lookup("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    // fetch was called with redirect:"error" + the pinned dispatcher.
    const fetchArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchArgs[0]).toBe("https://example.com/i.png");
    expect((fetchArgs[1] as { redirect?: string }).redirect).toBe("error");
    expect((fetchArgs[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(res.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(res.mimeType).toBe("image/png");
    // The agent is closed after use (no socket leak).
    expect(agentClose).toHaveBeenCalled();
  });

  it("rejects when the Content-Length declares a size over the cap (before download)", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: makeValidatedUrl() } as never);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ headers: { "content-length": String(MAX + 1) }, body: new Uint8Array([1]) }),
    );

    await expect(fetchImageBytesSsrfSafe("https://example.com/i.png", MAX)).rejects.toThrow(/exceeds the size limit/);
  });

  it("rejects when the streamed body exceeds the cap (server lied about Content-Length)", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: makeValidatedUrl() } as never);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResponse({ headers: {}, body: new Uint8Array(MAX + 10) }),
    );

    await expect(fetchImageBytesSsrfSafe("https://example.com/i.png", MAX)).rejects.toThrow(/exceeds the size limit/);
  });

  it("throws on a non-ok HTTP status", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: makeValidatedUrl() } as never);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse({ ok: false, status: 404 }));

    await expect(fetchImageBytesSsrfSafe("https://example.com/i.png", MAX)).rejects.toThrow(/HTTP 404/);
  });
});
