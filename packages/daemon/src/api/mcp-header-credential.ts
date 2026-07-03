// SPDX-License-Identifier: Apache-2.0
// @allow-throw: mcp-handlers helper — throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Header-credential lifecycle for mcp.connect and mcp.test.
 *
 * Classifies each (headerName, headerValue) pair in the headers block using
 * `classifyHeaderCredential` from `@comis/core`, then:
 *   - "ref"           → pass through unchanged
 *   - "oauth-bearer"  → throw with [use_oauth_login] + actionable guidance
 *   - "static-secret" → extract to secretStore, rewrite to ${VAR} ref
 *                       or throw [plaintext_secret_in_headers] if no store
 *
 * Called from mcp.connect + mcp.test BEFORE contract parse so the mutated
 * headers map (with ${VAR} refs) is what flows into buildPersistedMcpEntry
 * and McpServerConfig. The input `headers` object is MUTATED in place so
 * the caller's pre-parse `userParams` copy sees the rewritten ${VAR} values
 * (for persistence). The returned `resolvedHeaders` map carries the original
 * RAW values so the immediate live connect uses the real credential — not the
 * unresolved `${VAR}` literal.
 *
 * When `plaintextOptOut` is true, oauth-bearer still throws unconditionally
 * (the token will expire; the PKCE flow is the correct answer), but
 * static-secret detection logs a WARN and passes through (caller bears risk).
 *
 * @module
 */

import { classifyHeaderCredential } from "@comis/core";
import type { SecretStorePort, ComisLogger, MutableSecretManager } from "@comis/core";

/**
 * Derive a `${VAR}` variable name from a server id + header name.
 *
 * Pattern: `MCP_<SERVERID_UPPER>__<HEADERNAME_UPPER_SLUG>`
 *
 * The DOUBLE-UNDERSCORE `__` separator prevents collisions between server
 * and header segments. With a single `_` separator,
 * ("foo-bar", "Key") and ("foo", "Bar-Key") both collapse to `MCP_FOO_BAR_KEY`.
 * The double underscore guarantees distinctness because neither segment ever
 * contains `__` after slugification (slugify replaces any non-[A-Z0-9] run
 * with a single `_`).
 *
 * Non-empty sentinels ("SERVER" / "HEADER") guard against all-symbol inputs
 * that would otherwise produce empty segments.
 *
 * Examples:
 *   buildVarName("higgsfield", "Authorization") → "MCP_HIGGSFIELD__AUTHORIZATION"
 *   buildVarName("context7", "X-Api-Key")       → "MCP_CONTEXT7__X_API_KEY"
 *   buildVarName("foo-bar", "Key")              → "MCP_FOO_BAR__KEY"  (distinct from...)
 *   buildVarName("foo", "Bar-Key")              → "MCP_FOO__BAR_KEY"  (...this one)
 */
export function buildVarName(serverId: string, headerName: string): string {
  const slug = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const s = slug(serverId) || "SERVER";
  const h = slug(headerName) || "HEADER";
  return `MCP_${s}__${h}`;
}

/**
 * Options for {@link processHeaderCredentials}.
 */
export interface ProcessHeaderCredentialsOpts {
  /** The mutable headers map from the pre-Zod userParams block. Modified in place. */
  headers: Record<string, string>;
  /** The server name (used in error messages and variable naming). */
  serverName: string;
  /** Encrypted secret store for static-secret extraction. Undefined when security.storage is 'file' or 'env'. */
  secretStore: SecretStorePort | undefined;
  /** When true, static-secret detection logs WARN and passes through (operator bears risk). OAuth-bearer refusal is NOT affected. */
  plaintextOptOut: boolean;
  /** Logger for WARN on plaintextOptOut path. */
  logger: ComisLogger;
  /** RPC method name for log fields ("mcp.connect" | "mcp.test"). */
  method: string;
  /**
   * Optional daemon-owned write handle over the shared SecretManager backing Map.
   * When provided, extracted MCP header secrets are live-applied via upsert after
   * secretStore.set succeeds — so broker/exec observe the value on their next request
   * without a daemon restart (additive writes are live immediately). Optional chaining guards
   * callers and test setups that don't wire the mutable handle.
   */
  mutableSecretManager?: MutableSecretManager;
}

/**
 * Result of {@link processHeaderCredentials}.
 *
 * `resolvedHeaders` carries the original RAW values for extracted static-secret
 * headers (and the unchanged value for ref/oauth/optout headers). Pass this map
 * to the live `manager.connect` so the immediate connection uses the actual
 * credential — not the `${VAR}` literal that is only resolved after daemon restart.
 *
 * The input `headers` map is mutated in place to hold `${VAR}` refs for
 * persistence / buildPersistedMcpEntry / config.yaml — plaintext never persisted.
 */
export interface ProcessHeaderCredentialsResult {
  /**
   * Headers with RESOLVED (raw) values for the live in-memory connect.
   * Static-secret entries carry the original raw value (e.g. "sk-ant-…").
   * Ref entries carry the original `${VAR}` string (already resolved at load
   * time by the config loader; we cannot substitute it here without the store).
   * plaintextOptOut entries carry the original raw value (passed through).
   */
  resolvedHeaders: Record<string, string>;
}

/**
 * Process all headers in `headers` map in place.
 *
 * For each header:
 *   - "ref" → skip (already ${VAR}-form)
 *   - "oauth-bearer" → ALWAYS throw with [use_oauth_login] (no opt-out — OAuth
 *     tokens expire; the PKCE flow is the correct answer)
 *   - "static-secret" + secretStore defined → extract, rewrite to ${VAR}, continue
 *   - "static-secret" + secretStore undefined + !plaintextOptOut → throw [plaintext_secret_in_headers]
 *   - "static-secret" + plaintextOptOut → WARN, pass through (operator bears risk)
 *
 * Returns `{ resolvedHeaders }` — a map of header values for the LIVE connect,
 * where extracted static-secret entries carry the original raw value (not the
 * `${VAR}` ref written into `headers`). This ensures the immediate connect uses
 * the real credential rather than an unresolved `${VAR}` literal.
 *
 * @throws Error with [use_oauth_login] or [plaintext_secret_in_headers] marker
 */
export function processHeaderCredentials(opts: ProcessHeaderCredentialsOpts): ProcessHeaderCredentialsResult {
  const { headers, serverName, secretStore, plaintextOptOut, logger, method } = opts;

  // resolvedHeaders starts as a copy of the input; we update it below
  // where a static-secret extraction would otherwise set ${VAR}.
  const resolvedHeaders: Record<string, string> = { ...headers };

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") continue;

    const { kind } = classifyHeaderCredential(headerName, headerValue);

    if (kind === "ref") {
      // Already ${VAR}-form — pass through, no extraction needed.
      // resolvedHeaders already has the ${VAR} value (copied above).
      continue;
    }

    if (kind === "oauth-bearer") {
      // OAuth bearer refusal is UNCONDITIONAL — no opt-out.
      // The token will expire; auth:"oauth" + comis mcp login is the fix.
      throw new Error(
        `[use_oauth_login] headers.${headerName} (server "${serverName}") ` +
        `contains a short-lived OAuth bearer token that will expire on restart. ` +
        `Remove the header, set auth:"oauth" in the server config, and run ` +
        `"comis mcp login ${serverName}" to authenticate via the PKCE flow.`,
      );
    }

    // kind === "static-secret"
    if (plaintextOptOut) {
      logger.warn(
        {
          method,
          entityId: serverName,
          hint: "disablePlaintextSecretCheck=true — plaintext header passed through",
          errorKind: "config" as const,
        },
        "MCP headers plaintext-secret check disabled per-server",
      );
      // resolvedHeaders already has the raw value (copied above).
      continue;
    }

    if (!secretStore) {
      // Fail-safe: no store available → refuse rather than persist plaintext.
      throw new Error(
        `[plaintext_secret_in_headers] headers.${headerName} (server "${serverName}") ` +
        `looks like a plaintext credential and no encrypted secret store is available. ` +
        `Hint: ensure security.storage is not set to 'file' or 'env' in your config.yaml, or store ` +
        `the secret via secrets_manage and reference it as "\${VAR}".`,
      );
    }

    // Extract: derive var name, call secretStore.set, rewrite header value.
    // resolvedHeaders keeps the raw value (for the live connect).
    // headers[headerName] is rewritten to ${VAR} (for persistence/config.yaml).
    const varName = buildVarName(serverName, headerName);
    const result = secretStore.set(varName, headerValue);
    if (!result.ok) {
      throw new Error(
        `[plaintext_secret_in_headers] Failed to extract headers.${headerName} ` +
        `(server "${serverName}") to secret store: ${result.error.message}. ` +
        `Hint: fix the secret store, then retry.`,
      );
    }
    // Live-apply: upsert into the shared SecretManager Map so broker/exec observe the new
    // value on their next request without a restart (additive writes are live immediately).
    // Optional chaining guards callers (e.g. tests) that don't wire the handle.
    opts.mutableSecretManager?.upsert(varName, headerValue);
    // Rewrite the header value in place to the ${VAR} reference (for persistence).
    // resolvedHeaders already holds the raw value from the initial copy above.
    // static-secret means NO Bearer scheme in the raw value (classifyHeaderCredential
    // returns "oauth-bearer" for Bearer+secret; "static-secret" is bare value only).
    headers[headerName] = `\${${varName}}`;
    // resolvedHeaders[headerName] stays as the original raw value (already set above).
  }

  return { resolvedHeaders };
}
