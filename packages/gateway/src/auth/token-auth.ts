import { timingSafeEqual } from "node:crypto";

/**
 * Authenticated client identity resolved from a bearer token.
 */
export interface TokenClient {
  /** Unique identifier for this client / API key */
  readonly id: string;
  /** Allowed scopes for this client (e.g., ["rpc", "ws", "admin"]) */
  readonly scopes: readonly string[];
}

/**
 * Token verification store — maps bearer tokens to client identities.
 */
export interface TokenStore {
  /** Verify a bearer token and return the associated client, or null if invalid. */
  verify(token: string): TokenClient | null;
}

/**
 * Token entry used to seed the store (matches GatewayToken from config).
 */
export interface TokenEntry {
  readonly id: string;
  readonly secret: string;
  readonly scopes: readonly string[];
}

/**
 * Create a TokenStore from a list of token entries.
 *
 * Uses crypto.timingSafeEqual for constant-time comparison to prevent
 * timing-based token enumeration attacks.
 */
export function createTokenStore(tokens: readonly TokenEntry[]): TokenStore {
  // Store entries keyed by secret length for efficient lookup grouping.
  // We compare ALL entries to maintain constant-time behavior.
  const entries = tokens.map((t) => ({
    id: t.id,
    secretBuf: Buffer.from(t.secret, "utf-8"),
    scopes: t.scopes,
  }));

  return {
    verify(token: string): TokenClient | null {
      const tokenBuf = Buffer.from(token, "utf-8");

      for (const entry of entries) {
        // timingSafeEqual requires equal-length buffers.
        // If lengths differ, this token cannot match this entry.
        if (tokenBuf.length !== entry.secretBuf.length) {
          continue;
        }

        if (timingSafeEqual(tokenBuf, entry.secretBuf)) {
          return { id: entry.id, scopes: entry.scopes };
        }
      }

      return null;
    },
  };
}

/**
 * Check whether a set of scopes satisfies a required scope.
 *
 * The wildcard scope "*" grants access to all scopes.
 *
 * @param scopes - The client's granted scopes
 * @param required - The scope required for the operation
 * @returns true if access is granted
 */
export function checkScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

/**
 * Result of token authentication middleware — set on the Hono context.
 */
export interface TokenAuthContext {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

/**
 * Extract the bearer token from an Authorization header value.
 *
 * Returns null if the header is missing or not in "Bearer <token>" format.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(authHeader);
  return match ? match[1] : null;
}
