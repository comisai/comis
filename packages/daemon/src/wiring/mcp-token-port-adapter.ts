// SPDX-License-Identifier: Apache-2.0
// @allow-throw: server-name validator at the wrapper boundary; the throw
// surfaces to the SDK's OAuthClientProvider.saveTokens callback (which has no
// Result-typed surface). Disk + port writes are guarded so a malformed server
// name cannot corrupt either store.
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
 * - Server-name validation is ENFORCED at the wrapper boundary: every method
 *   that uses the server identity to compose a profileId or filename rejects
 *   names that do not match the same /^[a-zA-Z0-9_-]+$/ class enforced by
 *   `McpServerEntrySchema`. This guards against profileId corruption (e.g. a
 *   `:` would split "mcp-oauth:<server>" ambiguously) and against the unsaved/
 *   runtime-only paths that skip the config schema.
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
 * Identifier character class shared with `McpServerEntrySchema` in
 * `packages/core/src/config/schema-skills.ts`. Any server name that flows into
 * the wrapper's filename or profileId composition MUST satisfy this pattern.
 */
const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Assert that a server name is safe to interpolate into both the disk filename
 * (`<server>.json` under `tokensDir`) and the composed profileId
 * (`mcp-oauth:<server>`). Throws: a `:` would split the profileId
 * ambiguously, and a `/` would risk traversal at the inner store's safePath
 * boundary. Schema-validated config names already pass; this guard exists for
 * the unsaved/runtime callers that skip the schema (e.g. mcp.connect with a
 * runtime-only `name`, future SDK lifecycle callbacks).
 */
function assertValidServerName(serverName: string): void {
  if (typeof serverName !== "string" || !MCP_SERVER_NAME_RE.test(serverName)) {
    throw new Error(
      `[invalid_server_name] MCP server name "${String(serverName)}" must match /^[a-zA-Z0-9_-]+$/. ` +
        `This guards against profileId corruption in OAuthCredentialStorePort and traversal at the disk filename.`,
    );
  }
}

/**
 * Compose the profileId for a given MCP server name.
 * Format: "mcp-oauth:<serverName>" — matches the OAuthProfile.profileId convention
 * of "<provider>:<identity>". Callers MUST `assertValidServerName(serverName)`
 * first; this helper does not re-validate.
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
      // Reject malformed server names BEFORE any side effect (disk write
      // OR port write). Schema-validated config names already pass; this guard
      // covers unsaved/runtime callers and future SDK lifecycle callbacks that
      // skip `McpServerEntrySchema`.
      assertValidServerName(server);

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

      // Non-fatal: a port-set failure must NOT interrupt the disk write or
      // throw to the SDK saveTokens caller. But silence is an observability
      // regression: without a log, a persistent port-side error (disk
      // corruption on the credential partition, future schema mismatch, etc.)
      // leaves the disk store and the unified credential port silently
      // desynced. Surface both failure shapes (ok:false Result + thrown
      // rejection) at WARN with the canonical Pino fields so an operator
      // querying port.list({provider:"mcp-oauth"}) has a diagnostic trail.
      let portSetResult: Awaited<ReturnType<typeof port.set>> | undefined;
      let thrown: unknown;
      try {
        portSetResult = await port.set(profileId, profile);
      } catch (err) {
        thrown = err;
      }
      if (thrown !== undefined || (portSetResult !== undefined && !portSetResult.ok)) {
        const errPayload =
          thrown !== undefined
            ? thrown instanceof Error
              ? thrown.message
              : String(thrown)
            : (portSetResult as { ok: false; error: Error }).error.message;
        deps.logger.warn(
          {
            serverName: server,
            provider: MCP_OAUTH_PROVIDER,
            err: errPayload,
            hint: "OAuthCredentialStorePort.set failed; disk-backed MCP token store remains authoritative",
            errorKind: "internal" as const,
            submodule: "mcp-token-port-adapter",
          },
          "MCP OAuth credential-port sync failed (non-fatal)",
        );
      }
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
