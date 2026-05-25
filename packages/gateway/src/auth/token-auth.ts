// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";

/**
 * Per-MCP-client config block surfaced on a verified TokenClient when the
 * token's GatewayTokenSchema entry includes an `mcpClient` block (Phase 69
 * SERVE-02). Shape mirrors the Zod schema at
 * `packages/core/src/config/schema-gateway.ts:46-56`.
 *
 * Only meaningful when `scopes` includes `"mcp-client"`. The fields are
 * carried through opaquely by the token store — the gateway endpoint
 * (`mcp-server-endpoint.ts`) consults them for the default-deny filter.
 */
export interface McpClientConfig {
  /** Tool names this MCP client may invoke when `mcpExportPolicy` is
   *  `"permission-gated"`. Empty array = only `"safe"` tools exposed. */
  readonly allowlist: readonly string[];
  /** Session keys this MCP client may read via `resources/*` (SERVE-06). */
  readonly sessionAllowlist: readonly string[];
  /** Per-tool rate-limit override (calls/min). Falls back to the
   *  30-calls/min/tool default in SERVE-07. */
  readonly toolRateLimit: Readonly<Record<string, number>>;
}

/**
 * Authenticated client identity resolved from a bearer token.
 */
export interface TokenClient {
  /** Unique identifier for this client / API key */
  readonly id: string;
  /** Allowed scopes for this client (e.g., ["rpc", "ws", "admin"]) */
  readonly scopes: readonly string[];
  /** Per-MCP-client config block (Phase 69 SERVE-02). Present iff the
   *  GatewayTokenSchema entry declared an `mcpClient` block; usually only
   *  meaningful when `scopes` includes `"mcp-client"`. */
  readonly mcpClient?: McpClientConfig;
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
  /** Optional per-MCP-client config block (Phase 69 SERVE-02). */
  readonly mcpClient?: McpClientConfig;
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
    mcpClient: t.mcpClient,
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
          return entry.mcpClient
            ? { id: entry.id, scopes: entry.scopes, mcpClient: entry.mcpClient }
            : { id: entry.id, scopes: entry.scopes };
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
