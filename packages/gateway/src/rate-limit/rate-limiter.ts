// SPDX-License-Identifier: Apache-2.0
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Rate limiter configuration.
 */
export interface RateLimiterConfig {
  /** Time window in milliseconds (default: 60_000) */
  readonly windowMs: number;
  /** Maximum requests per window per client (default: 100) */
  readonly maxRequests: number;
  /** Trusted proxy IPs. Only these IPs' X-Forwarded-For headers are trusted. Empty = trust none (default). */
  readonly trustedProxies?: readonly string[];
}

/**
 * Extract the real client IP from the request context.
 *
 * When `trustedProxies` is empty (default), X-Forwarded-For is never trusted
 * and the TCP socket remote address is used directly.
 *
 * In production, the address comes from the Node.js socket via getConnInfo().
 * In test environments (no real socket), falls back to x-real-ip header.
 *
 * When `trustedProxies` contains IPs, X-Forwarded-For is only parsed if
 * the direct connection IP matches a trusted proxy. The leftmost IP in
 * X-Forwarded-For is returned as the client IP.
 */
export function getClientIp(c: Context, trustedProxies: readonly string[]): string {
  // Get the actual TCP socket remote address (not spoofable)
  let directIp: string;
  try {
    const info = getConnInfo(c);
    directIp = info.remote.address ?? "unknown";
  } catch {
    // Fallback for test environments where socket info may not be available
    directIp = c.req.header("x-real-ip") ?? "unknown";
  }

  // Only trust X-Forwarded-For if the direct connection is from a trusted proxy
  if (trustedProxies.length > 0 && trustedProxies.includes(directIp)) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      // The leftmost IP in X-Forwarded-For is the client
      const clientIp = xff.split(",")[0]?.trim();
      if (clientIp) return clientIp;
    }
  }

  return directIp;
}

/**
 * Create a per-client rate limiting middleware for the gateway.
 *
 * Keys rate limiting by clientId from the auth context (set by token auth).
 * Falls back to client IP if no clientId is available.
 *
 * When trustedProxies is configured, X-Forwarded-For is only trusted from
 * those proxy IPs. Otherwise, the direct connection IP is used.
 *
 * Returns JSON-RPC formatted error response on rate limit exceeded (HTTP 429).
 */
export function createRateLimiter(
  config: RateLimiterConfig,
  rateLimitLogger?: { warn(obj: Record<string, unknown>, msg: string): void },
): MiddlewareHandler {
  const trustedProxies = config.trustedProxies ?? [];

  return rateLimiter({
    windowMs: config.windowMs,
    limit: config.maxRequests,
    keyGenerator: (c: Context) => {
      // Use clientId from auth context if available, otherwise fall back to IP
      const clientId = c.get("clientId") as string | undefined;
      return clientId ?? getClientIp(c, trustedProxies);
    },
    handler: (c: Context) => {
      if (rateLimitLogger) {
        const clientIp = getClientIp(c, trustedProxies);
        rateLimitLogger.warn(
          {
            clientIp,
            method: c.req.method,
            path: c.req.path,
            requestCount: config.maxRequests,
            hint: `Client exceeded ${config.maxRequests} requests in ${config.windowMs}ms window`,
            errorKind: "resource" as const,
          },
          "Rate limit exceeded",
        );
      }

      // Return JSON-RPC error format for rate limit exceeded
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Rate limit exceeded",
          },
          id: null,
        },
        429,
      );
    },
  });
}
