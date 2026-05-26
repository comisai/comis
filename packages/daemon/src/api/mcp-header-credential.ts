// SPDX-License-Identifier: Apache-2.0
// @allow-throw: mcp-handlers helper — throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Header-credential lifecycle for mcp.connect and mcp.test.
 *
 * Classifies each (headerName, headerValue) pair in the headers block using
 * `classifyHeaderCredential` from `@comis/core`, then:
 *   - "ref"           → pass through unchanged
 *   - "oauth-bearer"  → throw with [use_oauth_login] + actionable guidance (CRED-06)
 *   - "static-secret" → extract to secretStore, rewrite to ${VAR} ref (CRED-05)
 *                       or throw [plaintext_secret_in_headers] if no store
 *
 * Called from mcp.connect + mcp.test BEFORE contract parse so the mutated
 * headers map (with ${VAR} refs) is what flows into buildPersistedMcpEntry
 * and McpServerConfig. The input `headers` object is MUTATED in place so
 * the caller's pre-parse `userParams` copy sees the rewritten values.
 *
 * When `plaintextOptOut` is true, oauth-bearer still throws unconditionally
 * (the token will expire; the PKCE flow is the correct answer), but
 * static-secret detection logs a WARN and passes through (caller bears risk).
 *
 * @module
 */

import { classifyHeaderCredential } from "@comis/core";
import type { SecretStorePort, ComisLogger } from "@comis/core";

/**
 * Derive a `${VAR}` variable name from a server id + header name.
 * Pattern: `MCP_<SERVERID_UPPER>_<HEADERNAME_UPPER_SLUG>`
 * Non-alphanumeric chars → `_`; leading/trailing `_` stripped; upper-cased.
 *
 * Examples:
 *   buildVarName("higgsfield", "Authorization") → "MCP_HIGGSFIELD_AUTHORIZATION"
 *   buildVarName("context7", "X-Api-Key")       → "MCP_CONTEXT7_X_API_KEY"
 */
export function buildVarName(serverId: string, headerName: string): string {
  const slugify = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")
      .replace(/^_+|_+$/g, "");
  return `MCP_${slugify(serverId)}_${slugify(headerName)}`;
}

/**
 * Options for {@link processHeaderCredentials}.
 */
export interface ProcessHeaderCredentialsOpts {
  /** The mutable headers map from the pre-Zod userParams block. Modified in place. */
  headers: Record<string, string>;
  /** The server name (used in error messages and variable naming). */
  serverName: string;
  /** Encrypted secret store for static-secret extraction. Undefined when COMIS_DISABLE_ENCRYPTED_SECRETS=1. */
  secretStore: SecretStorePort | undefined;
  /** When true, static-secret detection logs WARN and passes through (operator bears risk). OAuth-bearer refusal is NOT affected. */
  plaintextOptOut: boolean;
  /** Logger for WARN on plaintextOptOut path. */
  logger: ComisLogger;
  /** RPC method name for log fields ("mcp.connect" | "mcp.test"). */
  method: string;
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
 * @throws Error with [use_oauth_login] or [plaintext_secret_in_headers] marker
 */
export function processHeaderCredentials(opts: ProcessHeaderCredentialsOpts): void {
  const { headers, serverName, secretStore, plaintextOptOut, logger, method } = opts;

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") continue;

    const { kind } = classifyHeaderCredential(headerName, headerValue);

    if (kind === "ref") {
      // Already ${VAR}-form — pass through, no extraction needed.
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
      continue;
    }

    if (!secretStore) {
      // Fail-safe: no store available → refuse rather than persist plaintext.
      throw new Error(
        `[plaintext_secret_in_headers] headers.${headerName} (server "${serverName}") ` +
        `looks like a plaintext credential and no encrypted secret store is available. ` +
        `Hint: ensure COMIS_DISABLE_ENCRYPTED_SECRETS is not set (or is "0"), or store ` +
        `the secret via secrets_manage and reference it as "\${VAR}".`,
      );
    }

    // Extract: derive var name, call secretStore.set, rewrite header value.
    const varName = buildVarName(serverName, headerName);
    const result = secretStore.set(varName, headerValue);
    if (!result.ok) {
      throw new Error(
        `[plaintext_secret_in_headers] Failed to extract headers.${headerName} ` +
        `(server "${serverName}") to secret store: ${result.error.message}. ` +
        `Hint: fix the secret store, then retry.`,
      );
    }
    // Rewrite the header value in place to the ${VAR} reference.
    // static-secret means NO Bearer scheme in the raw value (classifyHeaderCredential
    // returns "oauth-bearer" for Bearer+secret; "static-secret" is bare value only).
    headers[headerName] = `\${${varName}}`;
  }
}
