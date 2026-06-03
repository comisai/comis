// SPDX-License-Identifier: Apache-2.0
/**
 * Broker activation seam types for tool assembly.
 *
 * Extracted from setup-tools.ts to keep setup-tools.ts under 800 lines.
 * setup-tools.ts re-exports BrokerContextDeps so existing call sites that
 * import from setup-tools.js continue to resolve the type.
 *
 * Follow-on: per-command token issuance will expand this module with
 * the full broker-activation wiring (brokerSpawnEnv construction, issueToken
 * lifecycle) currently inlined inside assembleToolsForAgent in setup-tools.ts.
 * @module
 */

import type { SessionManager, IssuedSession } from "@comis/infra";

/**
 * Broker context threaded from daemon bootFoundation into tool assembly.
 * When present: exec tool is assembled with broker-only network isolation,
 * secureCredentialHome, and brokerSpawnEnv (HTTPS_PROXY + placeholder key +
 * single-use token).
 * When absent (undefined): no change to the default open network path (no regression).
 */
export interface BrokerContextDeps {
  /** TCP port the broker is listening on (for HTTPS_PROXY env var). */
  tcpPort: number;
  /** Unix socket path for broker-only egress (brokerSocketPath in SandboxOptions). */
  socketPath: string;
  /** Absolute path to the broker CA cert PEM (NODE_EXTRA_CA_CERTS env var). */
  caPath: string;
  /** Session manager for issuing a single-use token per assembleToolsForAgent call. */
  sessionManager: SessionManager;
  /**
   * Placeholder env vars: mapping of env var name -> placeholder string.
   * e.g. { ANTHROPIC_API_KEY: "comis-broker-placeholder" }
   * NEVER contains the real secret value — resolved by the broker per-request.
   */
  placeholders: Record<string, string>;
}

// Re-export IssuedSession so callers that previously got it transitively do not break.
export type { IssuedSession };

/**
 * Build the broker proxy spawn-env for an agent's exec tool. Issues a
 * single-use proxy token from the broker session manager and returns the
 * HTTPS_PROXY + CA + placeholder env (placeholder values only — real secrets
 * are resolved by the broker per-request). Returns undefined when no broker
 * context is wired (the default open-network path; no regression). Extracted
 * from setup-tools.ts to keep that file under the 800-line cap.
 *
 * FIXME: the token is issued once per assembleToolsForAgent call
 * (per assembly, not per exec). The first exec consumes it; later calls in the
 * same assembly receive 407 from the broker. Path to per-command issuance:
 * thread sessionManager into ExecToolDeps and call issueToken() inside
 * execute() — tracked as follow-on work.
 */
export function buildBrokerSpawnEnv(
  brokerContext: BrokerContextDeps | undefined,
  agentId: string,
):
  | {
      HTTPS_PROXY: string;
      // HTTP_PROXY intentionally omitted — broker is CONNECT-only (HTTPS). The
      // broker handles TLS-CONNECT tunnels; plain HTTP via HTTP_PROXY is
      // unsupported and would produce unexpected routing behavior.
      NODE_EXTRA_CA_CERTS: string;
      placeholders: Record<string, string>;
    }
  | undefined {
  if (!brokerContext) return undefined;
  const issued: IssuedSession = brokerContext.sessionManager.issueToken(agentId);
  return {
    HTTPS_PROXY: `http://127.0.0.1:${brokerContext.tcpPort}`,
    NODE_EXTRA_CA_CERTS: brokerContext.caPath,
    // placeholders contain ONLY placeholder strings (never real secret values).
    placeholders: {
      ...brokerContext.placeholders,
      COMIS_BROKER_TOKEN: issued.proxyToken, // single-use token
    },
  };
}
