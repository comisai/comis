// SPDX-License-Identifier: Apache-2.0
/**
 * Port-backed MCP token store adapter.
 *
 * Wraps the existing `createTokenStore` (chokidar watch + 0600 fs-safe substrate
 * preserved). Syncs the OAuth token triple (access/refresh/expires) to the
 * `OAuthCredentialStorePort` on every `saveTokens` call, unifying MCP OAuth
 * tokens onto the same credential store used for provider tokens.
 *
 * LOCATION INVARIANT: This file MUST live in `packages/daemon/src/wiring/`.
 * The adapter is constructed in daemon wiring — never in packages/skills
 * (skills→memory is a forbidden edge in the architecture graph).
 * See architecture-graph.test.ts: daemon = { ..., skills, memory, ... }.
 *
 * SECURITY:
 * - No AES-at-rest: the disk-backed createTokenStore owns 0o600 perms + the
 *   fs-safe substrate. AES-at-rest for MCP tokens is deferred to a later phase.
 * - Port write failure is NON-FATAL: the disk store is authoritative.
 *   A port.set failure is silently suppressed (non-fatal) to preserve the
 *   existing MCP OAuth flow; callers must not rely on the port for read-back.
 * - Token values are NEVER logged (Pino redaction is a safety net, not a
 *   license to log them).
 *
 * INVARIANTS:
 * - `startWatch()` and `close()` delegate to the underlying createTokenStore
 *   verbatim — the chokidar disk-watch refresh rotation survives port wrapping.
 * - The adapter does NOT introduce a new token-file path; it reuses exactly the
 *   tokensDir passed to createTokenStore deps.
 *
 * @module
 */

import type { OAuthCredentialStorePort, OAuthProfile } from "@comis/core";
import {
  createTokenStore,
  type TokenStore,
  type TokenStoreDeps,
} from "@comis/skills";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Provider identifier for MCP OAuth profiles stored in OAuthCredentialStorePort.
 * Using "mcp-oauth" as the provider makes it easy to filter MCP tokens via
 * `port.list({ provider: "mcp-oauth" })`.
 */
const MCP_OAUTH_PROVIDER = "mcp-oauth" as const;

/**
 * Compose the profileId for a given MCP server name.
 * Format: "mcp-oauth:<serverName>" — matches the OAuthProfile.profileId convention
 * of "<provider>:<identity>".
 */
function mcpProfileId(serverName: string): string {
  return `${MCP_OAUTH_PROVIDER}:${serverName}`;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a port-backed MCP token store.
 *
 * Returns a `TokenStore` that:
 * 1. Delegates ALL methods to the underlying `createTokenStore` (disk-backed,
 *    chokidar watch, 0o600 perms, 0o700 dir — all preserved).
 * 2. On every `saveTokens` call, additionally writes the token triple
 *    (access/refresh/expires) to the injected `OAuthCredentialStorePort`.
 *
 * The port write is best-effort (non-fatal): a failure does NOT interrupt the
 * token save or throw to the caller. The disk store remains authoritative.
 *
 * @param port - The unified OAuth credential store port (injection from daemon).
 * @param deps - Dependencies forwarded verbatim to `createTokenStore`.
 */
export function createPortBackedMcpTokenStore(
  port: OAuthCredentialStorePort,
  deps: TokenStoreDeps,
): TokenStore {
  const inner = createTokenStore(deps);

  return {
    tokens(server: string) {
      return inner.tokens(server);
    },

    async saveTokens(server: string, sdkTokens): Promise<void> {
      // Write to disk first (disk store is authoritative).
      await inner.saveTokens(server, sdkTokens);

      // Sync to the unified credential port — best-effort, non-fatal.
      // The token triple is the minimum needed for cross-store visibility.
      // The `expires` field: the inner store computes an absolute expiresAt
      // from sdkTokens.expires_in; we replicate the same arithmetic here so
      // the port receives the same absolute epoch-ms value.
      const now = deps.now ?? Date.now;
      const SENTINEL_TTL_SEC = 10 * 365 * 24 * 60 * 60;
      const ttlSec = sdkTokens.expires_in ?? SENTINEL_TTL_SEC;
      const expiresAtMs = now() + ttlSec * 1000;

      const profileId = mcpProfileId(server);
      const profile: OAuthProfile = {
        provider: MCP_OAUTH_PROVIDER,
        profileId,
        access: sdkTokens.access_token,
        refresh: sdkTokens.refresh_token ?? "",
        expires: expiresAtMs,
        version: 1,
      };

      // Non-fatal: suppress port write errors. The disk store is authoritative.
      // We do NOT use suppressError from @comis/shared to avoid a circular dep
      // concern — a simple .then/catch is explicit and self-contained here.
      await port.set(profileId, profile).then(
        () => undefined,
        () => undefined,
      );
    },

    saveClientInformation(server: string, info) {
      return inner.saveClientInformation(server, info);
    },

    clientInformation(server: string) {
      return inner.clientInformation(server);
    },

    saveDiscoveryState(server: string, state) {
      return inner.saveDiscoveryState(server, state);
    },

    discoveryState(server: string) {
      return inner.discoveryState(server);
    },

    deleteAll(server: string) {
      return inner.deleteAll(server);
    },

    // CRITICAL: startWatch and close MUST delegate to the inner store.
    // The chokidar disk-watch (atomic:100 debounce + cache-invalidation) lives
    // in the inner createTokenStore. Overriding these would break cross-process
    // refresh rotation.
    startWatch() {
      return inner.startWatch();
    },

    close() {
      return inner.close();
    },
  };
}
