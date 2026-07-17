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

import type {
  SessionManager,
  IssuedSession,
  LeaseManager,
  IssuedLease,
  MintLeaseInput,
} from "@comis/infra";
import { attenuateCaps, type AgentCapability, type DeliveryOrigin, type OutputGuardPort, type UserTrustLevel } from "@comis/core";

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
 * Capability-lease mint deps. Threaded from
 * daemon.ts for an AUTONOMY-BEARING agent so {@link buildBrokerSpawnEnv} mints
 * an attenuated lease, registers the bearer in OutputGuard, and injects
 * `COMIS_CAP_LEASE` + `COMIS_ORCH_SOCKET`. Absent for a non-autonomy agent (no
 * lease minted). Independent of {@link BrokerContextDeps}: the cap socket is the
 * loopback capability endpoint, NOT the HTTPS-proxy broker — so an autonomy
 * agent gets the lease vars EVEN WHEN no broker is configured.
 */
export interface CapabilityMintDeps {
  /** The daemon-wide LeaseManager — mints the per-spawn lease. */
  leaseManager: LeaseManager;
  /** The OutputGuard the bearer is registered in at mint (Pitfall 1 — never logged). */
  outputGuard: OutputGuardPort;
  /** The cap socket path injected as COMIS_ORCH_SOCKET (the endpoint's 0600 socket). */
  capSocketPath: string;
  /** The agent's resolved autonomy caps (resolveAutonomy(...).capabilities). */
  resolvedCaps: readonly AgentCapability[];
  /** Budget ref recorded on the lease (budget enforcement reads it). */
  budgetRef: string;
  /** The session key the lease is minted for. */
  sessionKey: string;
  /** Exact authenticated trust captured for the lease. */
  trustLevel: UserTrustLevel;
  /** Immutable requester route captured beside the session principal. */
  deliveryOrigin?: DeliveryOrigin;
  /** The root-run id the lease is scoped to. */
  rootRunId: string;
  /**
   * The PARENT lease's caps, for a child spawn. When supplied (with
   * {@link requestedCaps}), the minted caps are `attenuateCaps(parentCaps,
   * requestedCaps)` — the child can never broaden beyond the parent.
   * Absent for a root spawn (the caps are then `resolvedCaps`).
   */
  parentCaps?: readonly AgentCapability[];
  /** The caps the child requested — intersected with {@link parentCaps} at mint. */
  requestedCaps?: readonly AgentCapability[];
  /** The parent lease id, recorded for the revoke cascade. */
  parentLeaseId?: string;
  /**
   * Anchor the tree root in the bounded-autonomy service right after
   * the mint. Called with the SAME tree-stable `rootRunId` the lease is minted
   * with + the freshly-minted `leaseId` (+ parentLeaseId) so the per-root budget
   * wall-clock deadline anchors and the rootRunId↔leaseId correlation builds (the
   * audit/kill fan-out). Optional — absent ⇒ no anchor (older/non-autonomy wiring).
   */
  registerRoot?: (rootRunId: string, leaseId: string, parentLeaseId?: string) => void;
}

/** The env object {@link buildBrokerSpawnEnv} returns (broker fields optional). */
export interface BrokerSpawnEnv {
  // HTTP_PROXY intentionally omitted — broker is CONNECT-only (HTTPS). The
  // broker handles TLS-CONNECT tunnels; plain HTTP via HTTP_PROXY is
  // unsupported and would produce unexpected routing behavior.
  HTTPS_PROXY?: string;
  NODE_EXTRA_CA_CERTS?: string;
  placeholders: Record<string, string>;
  /**
   * The assembly leaseId — the `parentLeaseId` for per-run orchestrate child
   * leases (D5). Set only when a capability lease was minted (`capMint` present);
   * the exec/terminal consumers ignore it. The autonomy wiring reads it to mint
   * each orchestrate run's short-TTL child lease off this assembly lease.
   */
  leaseId?: string;
}

/**
 * Build the spawn-env for an agent's exec tool. Two independent concerns merge
 * into the `placeholders` slot (which `buildExecEnv` merges LAST, so these
 * daemon-injected vars survive the existing exec/terminal scrub):
 *
 *   1. BROKER (when `brokerContext` present): issues a single-use proxy token
 *      and adds HTTPS_PROXY + CA + `COMIS_BROKER_TOKEN` (placeholder values only;
 *      real secrets are resolved by the broker per-request).
 *   2. CAPABILITY LEASE (when `capMint` present — an autonomy-bearing agent):
 *      mints an attenuated lease, registers the bearer in OutputGuard (so it is
 *      never logged — Pitfall 1), and adds `COMIS_CAP_LEASE` (the bearer) +
 *      `COMIS_ORCH_SOCKET` (the cap socket path). Independent of the broker — an
 *      autonomy agent gets the lease vars EVEN WHEN no broker is configured.
 *
 * Returns `undefined` only when NEITHER concern applies (the default
 * open-network, non-autonomy path; no regression).
 *
 * Subtle correctness: the workspace-`.env` `COMIS_` block
 * applies ONLY to the untrusted workspace-loaded source — never to
 * these daemon-injected `COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET` placeholders.
 *
 * FIXME: the broker token is issued once per assembleToolsForAgent call
 * (per assembly, not per exec). The first exec consumes it; later calls in the
 * same assembly receive 407 from the broker. Path to per-command issuance:
 * thread sessionManager into ExecToolDeps and call issueToken() inside
 * execute() — tracked as follow-on work.
 */
export function buildBrokerSpawnEnv(
  brokerContext: BrokerContextDeps | undefined,
  agentId: string,
  capMint?: CapabilityMintDeps,
): BrokerSpawnEnv | undefined {
  // Neither broker nor capability lease → no spawn-env changes (no regression).
  if (!brokerContext && !capMint) return undefined;

  // placeholders contain ONLY placeholder strings / daemon-injected tokens
  // (never real secret values).
  const placeholders: Record<string, string> = { ...(brokerContext?.placeholders ?? {}) };
  const result: BrokerSpawnEnv = { placeholders };

  if (brokerContext) {
    const issued: IssuedSession = brokerContext.sessionManager.issueToken(agentId);
    result.HTTPS_PROXY = `http://127.0.0.1:${brokerContext.tcpPort}`;
    result.NODE_EXTRA_CA_CERTS = brokerContext.caPath;
    placeholders.COMIS_BROKER_TOKEN = issued.proxyToken; // single-use token
  }

  if (capMint) {
    // Child caps = parent ∩ requested when a child spawn supplies both; else the
    // agent's resolved caps (root spawn). attenuateCaps NEVER broadens.
    const caps =
      capMint.parentCaps !== undefined && capMint.requestedCaps !== undefined
        ? attenuateCaps(capMint.parentCaps, capMint.requestedCaps)
        : capMint.resolvedCaps;
    const mintInput: MintLeaseInput = {
      agentId,
      caps,
      budgetRef: capMint.budgetRef,
      sessionKey: capMint.sessionKey,
      trustLevel: capMint.trustLevel,
      ...(capMint.deliveryOrigin !== undefined ? { deliveryOrigin: capMint.deliveryOrigin } : {}),
      rootRunId: capMint.rootRunId,
      ...(capMint.parentLeaseId !== undefined ? { parentLeaseId: capMint.parentLeaseId } : {}),
    };
    const issued: IssuedLease = capMint.leaseManager.mintLease(mintInput);
    const bearer = issued.bearer;
    // Expose the assembly leaseId so the autonomy wiring can mint each
    // orchestrate run's short-TTL child lease with parentLeaseId = this lease
    // (D5). Additive — no existing exec/terminal consumer reads it.
    result.leaseId = issued.leaseId;
    // Register the bearer BEFORE it leaves this function so any later log/model
    // output that echoes it is redacted (Pitfall 1 — never logged).
    capMint.outputGuard.registerSecret(bearer);
    // Anchor the tree root in the bounded-autonomy service with the
    // SAME rootRunId the lease was minted with + the freshly-minted leaseId (so
    // the per-root budget wall-clock anchors and the rootRunId↔leaseId index is
    // built for the audit/kill fan-out).
    capMint.registerRoot?.(capMint.rootRunId, issued.leaseId, capMint.parentLeaseId);
    placeholders.COMIS_CAP_LEASE = bearer;
    placeholders.COMIS_ORCH_SOCKET = capMint.capSocketPath;
  }

  return result;
}
