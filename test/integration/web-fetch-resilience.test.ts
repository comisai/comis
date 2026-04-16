/**
 * Integration tests for web_fetch error resilience.
 *
 * Validates that the Phase 260 error handling pipeline (body truncation,
 * pattern detection) works correctly through built dist output.
 *
 * TEST-01: Error body truncation to 500 chars for non-2xx responses
 * TEST-02: Error page pattern detection (Cloudflare, CAPTCHA, access-denied,
 *          rate-limit, bot-detection) returns descriptive messages
 *
 * Phase 263, Plan 01: Resilience Integration Tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWebFetchTool, __clearFetchCache } from "@comis/skills";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result));
}

// ---------------------------------------------------------------------------
// Mock response builders
// ---------------------------------------------------------------------------

function mockResponse(body: string, init: { status: number; statusText: string; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init.status,
    statusText: init.statusText,
    headers: new Headers(init.headers ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Test bodies
// ---------------------------------------------------------------------------

const LARGE_ERROR_BODY = "<html><body>" + "X".repeat(2000) + "</body></html>";

const SMALL_ERROR_BODY = "Something went wrong on our end. Please try again later.";

const CLOUDFLARE_BODY = `
<html>
<head><title>Attention Required! | Cloudflare</title></head>
<body>
  <div class="cf-browser-verification">Checking your browser before accessing the site</div>
  <span class="cf-error-details">Performance & security by Cloudflare</span>
  <span>Ray ID: 8abc123def456</span>
</body>
</html>`;

const CAPTCHA_BODY = `
<html>
<head><title>Security Check</title></head>
<body>
  <div class="h-captcha" data-sitekey="abc123"></div>
  <p>Please verify you are human to continue.</p>
</body>
</html>`;

const ACCESS_DENIED_BODY = `
<html>
<head><title>403 Forbidden</title></head>
<body>
  <h1>Access Denied</h1>
  <p>You don't have permission to access this resource on this server.</p>
</body>
</html>`;

const RATE_LIMIT_BODY = `
<html>
<head><title>429 Too Many Requests</title></head>
<body>
  <h1>Rate limit exceeded</h1>
  <p>You have sent too many requests. Please retry after 60 seconds.</p>
</body>
</html>`;

const BOT_DETECTED_BODY = `
<html>
<head><title>Pardon Our Interruption</title></head>
<body>
  <p>Automated access to this resource is not permitted.</p>
  <p>Bot detected - please use a standard browser.</p>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web_fetch error resilience (integration)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __clearFetchCache();
    // Spy on globalThis.fetch so we can intercept outbound requests.
    // The compiled dist code calls the global fetch(), so this intercept works.
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // TEST-01: Error body truncation for non-2xx responses
  // -------------------------------------------------------------------------

  describe("TEST-01: error body truncation", () => {
    it(
      "truncates error body to 500 chars for large non-2xx response",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(LARGE_ERROR_BODY, {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-length": String(LARGE_ERROR_BODY.length) },
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-truncation-large", {
          url: "https://httpbin.org/status/503",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(503);
        expect(parsed.errorBodyTruncated).toBe(true);
        expect(typeof parsed.errorBody).toBe("string");
        expect((parsed.errorBody as string).length).toBeLessThanOrEqual(500);
        expect(parsed.contentLength).toBe(LARGE_ERROR_BODY.length);
      },
      10_000,
    );

    it(
      "does not truncate small error body and marks errorBodyTruncated as false",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(SMALL_ERROR_BODY, {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "content-length": String(SMALL_ERROR_BODY.length) },
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-truncation-small", {
          url: "https://httpbin.org/status/500",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(500);
        expect(parsed.errorBodyTruncated).toBe(false);
        expect(typeof parsed.errorBody).toBe("string");
        expect(parsed.errorBody).toBe(SMALL_ERROR_BODY);
        expect(parsed.contentLength).toBe(SMALL_ERROR_BODY.length);
      },
      10_000,
    );
  });

  // -------------------------------------------------------------------------
  // TEST-02: Error page pattern detection
  // -------------------------------------------------------------------------

  describe("TEST-02: error page pattern detection", () => {
    it(
      "detects Cloudflare DDoS protection page",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(CLOUDFLARE_BODY, {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-length": String(CLOUDFLARE_BODY.length) },
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-cloudflare", {
          url: "https://httpbin.org/status/403",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(403);
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error as string).toContain("Blocked by Cloudflare DDoS protection");
      },
      10_000,
    );

    it(
      "detects CAPTCHA challenge page",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(CAPTCHA_BODY, {
            status: 403,
            statusText: "Forbidden",
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-captcha", {
          url: "https://httpbin.org/status/403",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(403);
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error as string).toContain("Blocked by CAPTCHA challenge");
      },
      10_000,
    );

    it(
      "detects access denied page",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(ACCESS_DENIED_BODY, {
            status: 403,
            statusText: "Forbidden",
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-access-denied", {
          url: "https://httpbin.org/status/403",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(403);
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error as string).toContain("Access denied by server");
      },
      10_000,
    );

    it(
      "detects rate limit page",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(RATE_LIMIT_BODY, {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "content-length": String(RATE_LIMIT_BODY.length) },
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-rate-limit", {
          url: "https://httpbin.org/status/429",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(429);
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error as string).toContain("Rate limited by server");
      },
      10_000,
    );

    it(
      "detects bot detection page",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(BOT_DETECTED_BODY, {
            status: 403,
            statusText: "Forbidden",
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-bot-detection", {
          url: "https://httpbin.org/status/403",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(403);
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error as string).toContain("Blocked by bot detection");
      },
      10_000,
    );

    it(
      "falls back to HTTP status with truncated body when no pattern matches",
      async () => {
        fetchSpy.mockResolvedValueOnce(
          mockResponse(SMALL_ERROR_BODY, {
            status: 500,
            statusText: "Internal Server Error",
          }),
        );

        const tool = createWebFetchTool();
        const result = (await tool.execute("test-no-pattern", {
          url: "https://httpbin.org/status/500",
        })) as ToolResult;

        const parsed = parseResult(result);
        expect(parsed.status).toBe(500);
        expect(typeof parsed.error).toBe("string");
        // Fallback format: "HTTP 500: <truncated body>"
        expect(parsed.error as string).toMatch(/^HTTP 500:/);
        expect(parsed.error as string).toContain("Something went wrong");
      },
      10_000,
    );
  });
});
