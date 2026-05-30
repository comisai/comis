// SPDX-License-Identifier: Apache-2.0
/**
 * Broker activation seam types for tool assembly (INTEG-03).
 *
 * Extracted from setup-tools.ts to keep setup-tools.ts under 800 lines.
 * Re-exported from setup-tools.ts for backward compatibility.
 *
 * Phase 9 follow-on: per-command token issuance will expand this module with
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
