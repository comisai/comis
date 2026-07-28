// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception). ensureGatewayToken throws a named-env-var error that each subcommand's catch converts to error()/process.exit(1).
/**
 * Shared gateway-token resolution for the `comis mcp *` subcommands.
 *
 * Extracted from `mcp.ts` to break the `mcp.ts` ↔ `mcp-oauth.ts` intra-package
 * cycle: `mcp.ts` imports
 * `registerMcpOauth` from `mcp-oauth.ts` (to mount login/logout), and
 * `mcp-oauth.ts` imports `ensureGatewayToken` from `mcp.ts` (every subcommand
 * resolves the token before opening the RPC socket). Hoisting the token helper
 * to this sibling module makes the import graph acyclic — both files depend on
 * `mcp-token.ts`, and `mcp.ts` still imports `mcp-oauth.ts` (single edge, no
 * back-edge). The architecture `no-cycles` test (madge source-mode) is
 * shrink-only by convention — adding a new cycle to the baseline is forbidden,
 * so this extraction lands as the final-gate fix.
 *
 * Token resolution: each subcommand calls `ensureGatewayToken(opts.token)`
 * BEFORE the socket opens so a missing gateway token surfaces a friendly error
 * naming `COMIS_GATEWAY_TOKEN` rather than a generic 401 from the daemon
 * handshake. The `--token` flag overrides the env var (read from
 * `~/.comis/.env`).
 *
 * @module
 */

import { systemGetEnv, loadEnvFile } from "@comis/core";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the gateway bearer token BEFORE `withClient` opens the socket.
 *
 * Resolution order:
 *   1. `--token <t>` flag wins — written through to `process.env` so the
 *      downstream `withClient` resolver (rpc-client.ts) consumes it.
 *   2. else load `~/.comis/.env` (mirrors rpc-client's own lazy load — and
 *      because the helper runs BEFORE withClient, this makes the value
 *      visible to BOTH this check and the socket resolver), then read
 *      `COMIS_GATEWAY_TOKEN` from the environment.
 *   3. miss → throw an explicit error NAMING the env var. The message MUST
 *      NOT interpolate any token value (information-disclosure mitigation).
 *
 * @param flagToken - The `--token` option value, or undefined.
 * @throws Error naming COMIS_GATEWAY_TOKEN when no token can be resolved.
 */
export function ensureGatewayToken(flagToken: string | undefined): void {
  if (flagToken !== undefined && flagToken.length > 0) {
    // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager: thread --token into the env so rpc-client's ${COMIS_GATEWAY_TOKEN} config resolver consumes it
    process.env["COMIS_GATEWAY_TOKEN"] = flagToken;
    return;
  }
  // Load ~/.comis/.env so the env var is visible to this check AND to the
  // withClient socket resolver. loadEnvFile does not override an already-set
  // value, so a process-level COMIS_GATEWAY_TOKEN takes precedence.
  loadEnvFile(join(homedir(), ".comis", ".env"));
  const existing = systemGetEnv("COMIS_GATEWAY_TOKEN");
  if (existing !== undefined && existing.length > 0) return;
  // The old hint said "run `comis init` to generate a gateway token". Under
  // `security.storage: encrypted` — the recommended posture — the token is NOT in
  // `~/.comis/.env` (that file holds only SECRETS_MASTER_KEY); it lives in the
  // encrypted `secrets.db`, which is why the daemon boots fine while this
  // resolver misses. Following that hint on a healthy box ROTATES the live
  // token and breaks the running daemon. Lead with the read-only recovery.
  throw new Error(
    "Missing COMIS_GATEWAY_TOKEN in the environment.\n" +
      "If the daemon is running, a token already exists — it is just not in the environment:\n" +
      "  • encrypted storage (`security.storage: encrypted`): the token is in `secrets.db`, not `~/.comis/.env`.\n" +
      "    Read it and pass it through:  comis --token \"$(comis secrets get COMIS_GATEWAY_TOKEN)\" <command>\n" +
      "  • file storage: export COMIS_GATEWAY_TOKEN, or add it to `~/.comis/.env`.\n" +
      "Only run `comis init` on a box with NO working install — it generates a NEW token and " +
      "will break a daemon that is already serving with the current one.",
  );
}
