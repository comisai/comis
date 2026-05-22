// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createRateLimiter, getClientIp } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Mock @hono/node-server/conninfo (getConnInfo throws by default, simulating no TCP socket in app.request()).
// Individual tests can override via mockGetConnInfo.
// ---------------------------------------------------------------------------

const mockGetConnInfo = vi.fn<[], { remote: { address?: string } }>(() => {
  throw new Error("No socket available in test");
});

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...(args as [])),
}));

afterEach(() => {
  mockGetConnInfo.mockReset();
  // Restore default: throw (simulating no TCP socket)
  mockGetConnInfo.mockImplementation(() => {
    throw new Error("No socket available in test");
  });
});

/**
 * Helper to create a Hono app with rate limiting for testing.
 *
 * The synthetic auth middleware that set clientId from a query param has been
 * deleted along with the dead `c.get("clientId")` derivation in the rate
 * limiter; tests drive key variation through `mockGetConnInfo` instead.
 */
function createTestApp(
  maxRequests: number,
  windowMs = 60_000,
  trustedProxies?: string[],
  logger?: { warn(obj: Record<string, unknown>, msg: string): void },
) {
  const app = new Hono();

  // Apply rate limiter
  app.use("*", createRateLimiter({ windowMs, maxRequests, trustedProxies }, logger));

  // Test endpoint
  app.post("/rpc", (c) => c.json({ result: "ok" }));

  return app;
}

describe("createRateLimiter", () => {
  it("allows requests under the limit", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });
    const app = createTestApp(5);

    const res = await app.request("/rpc", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result).toBe("ok");
  });

  it("returns 429 when limit is exceeded for a single IP", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.2" } });
    const app = createTestApp(2);

    // First two requests should succeed
    const res1 = await app.request("/rpc", { method: "POST" });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/rpc", { method: "POST" });
    expect(res2.status).toBe(200);

    // Third request should be rate limited
    const res3 = await app.request("/rpc", { method: "POST" });
    expect(res3.status).toBe(429);

    const body = await res3.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe("Rate limit exceeded");
    expect(body.id).toBeNull();
  });

  it("tracks different IPs independently", async () => {
    const app = createTestApp(1);

    // IP A uses their 1 allowed request
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.10" } });
    const resA = await app.request("/rpc", { method: "POST" });
    expect(resA.status).toBe(200);

    // IP A is now rate limited
    const resA2 = await app.request("/rpc", { method: "POST" });
    expect(resA2.status).toBe(429);

    // IP B should still have their own quota
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.20" } });
    const resB = await app.request("/rpc", { method: "POST" });
    expect(resB.status).toBe(200);
  });

  it("falls back to 'unknown' key when no IP is resolvable", async () => {
    // mockGetConnInfo throws by default (see afterEach); no x-real-ip header.
    const app = createTestApp(1);

    const res1 = await app.request("/rpc", { method: "POST" });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/rpc", { method: "POST" });
    expect(res2.status).toBe(429);
  });

  it("logs WARN when rate limit is exceeded with logger provided", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.3" } });
    const mockLogger = { warn: vi.fn() };
    const app = createTestApp(1, 60_000, undefined, mockLogger);

    // First request succeeds
    await app.request("/rpc", { method: "POST" });

    // Second request triggers rate limit
    const res = await app.request("/rpc", { method: "POST" });
    expect(res.status).toBe(429);

    // Verify logger.warn was called with expected fields
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientIp: "10.0.0.3",
        requestCount: 1,
        hint: expect.stringContaining("1 requests"),
        errorKind: "resource",
      }),
      "Rate limit exceeded",
    );
  });

  it("does not throw when rate limit exceeded without logger", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.4" } });
    const app = createTestApp(1);

    // First request succeeds
    await app.request("/rpc", { method: "POST" });

    // Second request triggers rate limit — should not throw despite no logger
    const res = await app.request("/rpc", { method: "POST" });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error.message).toBe("Rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// getClientIp (fallback path: no TCP socket in test environment)
// ---------------------------------------------------------------------------

describe("getClientIp", () => {
  function createIpTestApp(trustedProxies: string[] = []) {
    const app = new Hono();

    app.get("/ip", (c) => {
      const ip = getClientIp(c, trustedProxies);
      return c.json({ ip });
    });

    return app;
  }

  it("falls back to x-real-ip in test environment (no TCP socket)", async () => {
    // mockGetConnInfo throws by default, simulating no TCP socket
    const app = createIpTestApp([]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "192.168.1.100, 10.0.0.1",
      },
    });

    const json = await res.json();
    // X-Forwarded-For should be ignored -- fallback x-real-ip is used
    expect(json.ip).toBe("10.0.0.1");
  });

  it("ignores x-forwarded-for when no trusted proxies configured", async () => {
    const app = createIpTestApp([]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "192.168.1.100",
      },
    });

    const json = await res.json();
    expect(json.ip).toBe("10.0.0.1");
  });

  it("returns unknown when no IP headers present and no trusted proxies", async () => {
    const app = createIpTestApp([]);

    const res = await app.request("/ip");

    const json = await res.json();
    expect(json.ip).toBe("unknown");
  });

  it("parses x-forwarded-for when direct IP matches trusted proxy", async () => {
    const app = createIpTestApp(["10.0.0.1"]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "192.168.1.100, 10.0.0.1",
      },
    });

    const json = await res.json();
    // Should extract the leftmost IP from X-Forwarded-For
    expect(json.ip).toBe("192.168.1.100");
  });

  it("ignores x-forwarded-for when direct IP does NOT match trusted proxy", async () => {
    const app = createIpTestApp(["10.0.0.99"]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "192.168.1.100, 10.0.0.1",
      },
    });

    const json = await res.json();
    // Direct IP does not match trusted proxy, so XFF is not trusted
    expect(json.ip).toBe("10.0.0.1");
  });

  it("extracts leftmost IP from multiple IPs in x-forwarded-for", async () => {
    const app = createIpTestApp(["10.0.0.1"]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "203.0.113.50, 198.51.100.10, 10.0.0.1",
      },
    });

    const json = await res.json();
    // Leftmost IP is the original client
    expect(json.ip).toBe("203.0.113.50");
  });

  it("falls back to direct IP when trusted proxy has no x-forwarded-for", async () => {
    const app = createIpTestApp(["10.0.0.1"]);

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.1",
        // No x-forwarded-for header
      },
    });

    const json = await res.json();
    expect(json.ip).toBe("10.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// getClientIp with mocked getConnInfo (TCP socket address)
// ---------------------------------------------------------------------------

describe("getClientIp with getConnInfo", () => {
  it("uses TCP socket address from getConnInfo when available", async () => {
    mockGetConnInfo.mockReturnValue({
      remote: { address: "192.168.1.50" },
    });

    const app = new Hono();
    app.get("/ip", (c) => {
      const ip = getClientIp(c, []);
      return c.json({ ip });
    });

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "SPOOFED-IP",
        "x-forwarded-for": "10.0.0.1",
      },
    });

    const json = await res.json();
    // Should use the TCP socket address, NOT the spoofed x-real-ip
    expect(json.ip).toBe("192.168.1.50");
  });

  it("ignores x-forwarded-for when socket IP is not a trusted proxy", async () => {
    mockGetConnInfo.mockReturnValue({
      remote: { address: "192.168.1.50" },
    });

    const app = new Hono();
    app.get("/ip", (c) => {
      // Trusted proxy is 10.0.0.1, but socket IP is 192.168.1.50
      const ip = getClientIp(c, ["10.0.0.1"]);
      return c.json({ ip });
    });

    const res = await app.request("/ip", {
      headers: {
        "x-forwarded-for": "ATTACKER-IP",
      },
    });

    const json = await res.json();
    // Socket IP doesn't match trusted proxy, so XFF is ignored
    expect(json.ip).toBe("192.168.1.50");
  });

  it("trusts x-forwarded-for when socket IP matches trusted proxy", async () => {
    mockGetConnInfo.mockReturnValue({
      remote: { address: "10.0.0.1" },
    });

    const app = new Hono();
    app.get("/ip", (c) => {
      const ip = getClientIp(c, ["10.0.0.1"]);
      return c.json({ ip });
    });

    const res = await app.request("/ip", {
      headers: {
        "x-forwarded-for": "203.0.113.50, 10.0.0.1",
      },
    });

    const json = await res.json();
    // Socket IP matches trusted proxy, so XFF is parsed
    expect(json.ip).toBe("203.0.113.50");
  });

  it("falls back to x-real-ip when getConnInfo throws", async () => {
    // Default mock already throws, but be explicit
    mockGetConnInfo.mockImplementation(() => {
      throw new Error("No socket available");
    });

    const app = new Hono();
    app.get("/ip", (c) => {
      const ip = getClientIp(c, []);
      return c.json({ ip });
    });

    const res = await app.request("/ip", {
      headers: {
        "x-real-ip": "10.0.0.5",
      },
    });

    const json = await res.json();
    expect(json.ip).toBe("10.0.0.5");
  });
});
