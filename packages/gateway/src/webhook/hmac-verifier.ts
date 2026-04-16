import type { MiddlewareHandler, Env } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hono environment type for webhook HMAC middleware.
 * Declares the rawBody variable stored after successful verification.
 */
export interface HmacEnv extends Env {
  Variables: {
    rawBody: string;
  };
}

/**
 * Supported HMAC algorithms for webhook signature verification.
 */
export type HmacAlgorithm = "sha256" | "sha384" | "sha512";

/**
 * Configuration for the HMAC verification middleware.
 */
export interface HmacMiddlewareConfig {
  /** The shared secret used to compute HMAC signatures */
  readonly secret: string;
  /** Header name containing the signature (default: "x-webhook-signature") */
  readonly headerName?: string;
  /** HMAC algorithm (default: "sha256") */
  readonly algorithm?: HmacAlgorithm;
  /** Header name containing the timestamp (default: "x-webhook-timestamp") */
  readonly timestampHeaderName?: string;
  /** Maximum age in seconds for timestamp freshness (default: 300 = 5 min) */
  readonly maxAgeSec?: number;
  /**
   * When true, webhooks without a timestamp header are rejected with 401.
   * This prevents replay attacks at the cost of incompatibility with
   * providers that don't include timestamps. Default: false.
   */
  readonly requireTimestamp?: boolean;
}

/**
 * Verify an HMAC signature against a body using constant-time comparison.
 *
 * Uses crypto.timingSafeEqual to prevent timing-based signature enumeration.
 * Handles length mismatch safely by returning false (not throwing).
 *
 * @param secret - The shared secret
 * @param signature - The hex-encoded signature to verify
 * @param body - The raw body bytes to verify against
 * @param algorithm - Hash algorithm (default: "sha256")
 * @returns true if the signature is valid
 */
export function verifyHmacSignature(
  secret: string,
  signature: string,
  body: string | Buffer,
  algorithm: HmacAlgorithm = "sha256",
): boolean {
  const expected = createHmac(algorithm, secret).update(body).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf-8");
  const signatureBuf = Buffer.from(signature, "utf-8");

  // timingSafeEqual requires equal-length buffers.
  // If lengths differ, the signature cannot be valid.
  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * Create Hono middleware that verifies HMAC signatures on incoming requests.
 *
 * Reads the raw body, computes the expected HMAC, and compares it against
 * the value in the configured header (default: x-webhook-signature).
 *
 * On success, stores the raw body string on the Hono context as "rawBody"
 * for downstream handlers. On failure, returns 401 Unauthorized.
 *
 * @param config - HMAC middleware configuration
 * @returns Hono middleware handler
 */
export function createHmacMiddleware(config: HmacMiddlewareConfig): MiddlewareHandler<HmacEnv> {
  const {
    secret,
    headerName = "x-webhook-signature",
    algorithm = "sha256",
    timestampHeaderName = "x-webhook-timestamp",
    maxAgeSec = 300,
    requireTimestamp = false,
  } = config;

  return async (c, next) => {
    // Timestamp freshness check (replay prevention)
    const tsHeader = c.req.header(timestampHeaderName);
    if (tsHeader) {
      const ts = parseInt(tsHeader, 10);
      const nowSec = Math.floor(Date.now() / 1000);
      if (Number.isNaN(ts) || Math.abs(nowSec - ts) > maxAgeSec) {
        return c.json({ error: "Webhook timestamp expired or invalid" }, 401);
      }
    } else if (requireTimestamp) {
      // Mandatory timestamp enforcement for replay prevention
      return c.json({ error: "Missing required webhook timestamp" }, 401);
    }
    // If no timestamp header present and requireTimestamp is false, allow
    // (some providers don't include it). The HMAC signature itself still
    // provides tamper protection.

    const signature = c.req.header(headerName);

    if (!signature) {
      return c.json({ error: "Missing webhook signature" }, 401);
    }

    // Read raw body for HMAC verification
    const rawBody = await c.req.text();

    if (!verifyHmacSignature(secret, signature, rawBody, algorithm)) {
      return c.json({ error: "Invalid webhook signature" }, 401);
    }

    // Store raw body on context for downstream handlers
    c.set("rawBody", rawBody);

    await next();
  };
}
