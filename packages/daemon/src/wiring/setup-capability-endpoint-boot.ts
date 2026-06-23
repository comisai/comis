// SPDX-License-Identifier: Apache-2.0
/**
 * `constructCapabilityLayer` — the daemon-wide capability-lease construction
 * (Phase 211 ENDPOINT-01/03), extracted from `daemon.ts`'s `bootShutdown`
 * WITHOUT behavior change (daemon.ts line-cap ≤ 3000, arch invariant).
 *
 * Mirrors the credential broker's conditional construction (gated on
 * `executor.broker`): construct ONE daemon-wide `LeaseManager` + the loopback
 * capability endpoint when ANY agent resolves to an autonomy-bearing profile.
 * The endpoint validates the lease + dispatches through the SAME `rpcCall` sink
 * (so deny-by-origin + requireCapability + the unknown-method `!handler` throw
 * all fire automatically); its `0600` socket is bound per jail by Phase 212.
 * For 211 the daemon-wide construction + the socket-server factory is the
 * deliverable. The returned handle's `endpoint.stopSocket` is threaded into
 * `setupShutdown` (mirrors the broker teardown).
 *
 * @module
 */

import { resolveAutonomy, safePath, type PerAgentConfig, type ClockPort } from "@comis/core";
import { createLeaseManager, type LeaseManager, type LeaseManagerDeps } from "@comis/infra";
import { namespacePreflight, type NamespacePreflightResult } from "@comis/skills";
import { createCapabilityEndpoint, type CapabilityEndpoint } from "./setup-capability-endpoint.js";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { LoggingResult } from "./setup-logging.js";

/** Deps for {@link constructCapabilityLayer} — the subset bootShutdown closes over. */
export interface CapabilityLayerDeps {
  /** The daemon's agents config map (only `autonomy` is read for the gate). */
  agents: Record<string, PerAgentConfig>;
  /** The deferred RPC dispatch sink the endpoint routes through. */
  rpcCall: RpcCall;
  /** Wall-clock for lease TTLs (the daemon's system clock). */
  clock: ClockPort;
  /** Absolute data dir — the cap socket path lives under it (cap.sock). */
  dataDir: string;
  /** The module-bound daemon logger for the construction INFO line. */
  daemonLogger: LoggingResult["daemonLogger"];
}

/** The constructed capability layer handle (undefined when no autonomy agent). */
export interface CapabilityLayerHandle {
  leaseManager: LeaseManager;
  endpoint: CapabilityEndpoint;
  /** The cap socket path (under the data dir) — bound per jail by Phase 212. */
  capSocketPath: string;
}

/** Result of {@link constructCapabilityLayer}: the cap handle + the boot preflight boolean. */
export interface CapabilityLayerResult {
  /** Undefined when NO agent resolves to an autonomy-bearing profile. */
  capEndpointHandle: CapabilityLayerHandle | undefined;
  /**
   * Shutdown teardown thunk for the cap endpoint socket (stops + unlinks
   * cap.sock), or `undefined` when no endpoint was constructed. Threaded into
   * `setupShutdown` (mirrors the broker teardown).
   */
  capEndpointStop: (() => Promise<void>) | undefined;
  /**
   * JAIL-03 host namespace preflight result (the unprivileged-userns +
   * `--unshare-net` probe, run once at boot). Fed to the SHIPPED degradeAutonomy
   * via emitAutonomyBootLog — downshift to `assistant` + a doctor WARN when the
   * host cannot build the jail (never a silent unjailed path). On non-Linux the
   * probe honestly returns false. 211 only PRODUCES the boolean; the downshift
   * stays in the shipped core fn.
   */
  namespacePreflightOk: boolean;
}

/**
 * Construct the daemon-wide capability layer (gated on an autonomy-bearing
 * profile, mirroring how the broker is gated on `executor.broker`) AND run the
 * JAIL-03 host namespace preflight once at boot. The cap handle is `undefined`
 * when no agent is autonomy-bearing (so the lease layer + cap.sock are absent);
 * the preflight runs unconditionally (it is a host capability check).
 */
export function constructCapabilityLayer(deps: CapabilityLayerDeps): CapabilityLayerResult {
  const { agents, rpcCall, clock, dataDir, daemonLogger } = deps;
  const preflight: NamespacePreflightResult = namespacePreflight();
  const { namespacePreflightOk } = preflight;

  const anyAutonomyBearing = Object.values(agents).some(
    (a) => resolveAutonomy(a.autonomy).enabled,
  );
  if (!anyAutonomyBearing) {
    return { capEndpointHandle: undefined, capEndpointStop: undefined, namespacePreflightOk };
  }

  const leaseManagerDeps: LeaseManagerDeps = { clock };
  const leaseManager = createLeaseManager(leaseManagerDeps);
  // The cap socket path lives under the data dir, mirroring broker.sock's
  // ephemeral lifecycle. Phase 212 binds it per jail; the daemon-wide endpoint
  // exists so the lease layer is constructed once at boot.
  const capSocketPath = safePath(dataDir, "cap.sock");
  // Thread the daemon logger so the socket boundary is observable (WR-02): a
  // post-listen server error and per-connection errors are logged with the
  // canonical err/errorKind/hint rather than silently swallowed.
  const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, logger: daemonLogger });
  // WR-03: be HONEST that the layer is DORMANT in 211. The endpoint object +
  // the LeaseManager are constructed, but `endpoint.startSocket()` is NOT called
  // here and no lease is minted yet (Phase 212 binds the 0600 socket per jail
  // and mints the lease). An INFO that says "endpoint constructed" without that
  // qualifier reads as "the cap surface is live", misleading an operator. State
  // the dormant-until-212 status explicitly so the log does not over-claim.
  daemonLogger.info(
    { submodule: "capability-endpoint", capSocketPath, active: false },
    "Capability lease layer constructed (dormant — endpoint bound per-jail by Phase 212; no socket listening yet)",
  );
  return {
    capEndpointHandle: { leaseManager, endpoint, capSocketPath },
    capEndpointStop: () => endpoint.stopSocket(),
    namespacePreflightOk,
  };
}
