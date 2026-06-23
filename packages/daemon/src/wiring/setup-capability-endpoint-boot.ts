// SPDX-License-Identifier: Apache-2.0
/**
 * `constructCapabilityLayer` — the daemon-wide capability-lease construction +
 * ACTIVATION (Phase 211 ENDPOINT-01/03 → Phase 212 Plan 05 dormancy activation),
 * extracted from `daemon.ts`'s boot WITHOUT adding a net line to daemon.ts
 * (line-cap ≤ 3000, arch invariant — the daemon-side wiring all lives here).
 *
 * Mirrors the credential broker's conditional construction (gated on
 * `executor.broker`): construct ONE daemon-wide `LeaseManager` + the loopback
 * capability endpoint when ANY agent resolves to an autonomy-bearing profile.
 * The endpoint validates the lease + dispatches through the SAME `rpcCall` sink
 * (so deny-by-origin + requireCapability + the unknown-method `!handler` throw
 * all fire automatically).
 *
 * Phase 212 (the dormancy activation — Gap 3) flips the layer from constructed-
 * but-DORMANT to ACTIVE, all inside this helper so daemon.ts only KEEPS the
 * returned handle:
 *   1. The daemon-side `tool.invoke` executor (`createToolInvokeExecutor`, Plan
 *      02) is constructed HERE from the injected shipped cores (read/grep/find/
 *      ls/jq + web_search) + the agent workspace resolver + the Plan-03 ResultRef
 *      `materialize` writer, and injected into `createCapabilityEndpoint` via its
 *      deps — MIRRORING how the `LeaseManager` is constructed-and-injected. NOT a
 *      mutable setter on the handle: construction-time injection keeps the lease-
 *      gated endpoint immutable once built (the executor IS the security-relevant
 *      dispatch target).
 *   2. `endpoint.startSocket(capSocketPath)` is called ONCE (the daemon-wide 0600
 *      socket; the lease is per-spawn) — the boot log now reports `active: true`.
 * The returned handle's `endpoint.stopSocket` is threaded into `setupShutdown`
 * (mirrors the broker teardown). The bwrap per-jail bind is the orchestrate
 * runner's (Plan 04) — this helper owns the daemon-wide socket lifecycle.
 *
 * @module
 */

import {
  resolveAutonomy,
  safePath,
  createOutputGuard,
  type PerAgentConfig,
  type ClockPort,
  type ResultRef,
  type OutputGuardPort,
  type ComisLogger,
} from "@comis/core";
import { createLeaseManager, type LeaseManager, type LeaseManagerDeps } from "@comis/infra";
import { namespacePreflight, type NamespacePreflightResult } from "@comis/skills";
import {
  createOrchestrateExecutorCores,
  createResultRefStore,
  type ResultRefStore,
} from "@comis/skills/tools";
import { createCapabilityEndpoint, type CapabilityEndpoint } from "./setup-capability-endpoint.js";
import { createToolInvokeExecutor, type ExecuteToolInvoke } from "./setup-tool-invoke-executor.js";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { LoggingResult } from "./setup-logging.js";

/** The web-search API keys the daemon-side autonomous search reads (from the secret store). */
export interface CapabilityWebSearchKeys {
  get: (name: string) => string | undefined;
}

/** Deps for {@link constructCapabilityLayer} — the subset boot closes over. */
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
  /**
   * The skills-scoped logger threaded into the shipped executor cores (file
   * builtins + web_search). Optional so the 211 boot-gate unit tests can construct
   * the layer without activating the executor.
   */
  skillsLogger?: ComisLogger;
  /**
   * Per-agent workspace dirs — the executor's `resolveWorkspace(agentId)` maps a
   * lease's agentId to the jailed workspace its file builtins run under. Optional
   * (the boot-gate tests omit it; the executor is then absent).
   */
  workspaceDirs?: Map<string, string>;
  /** The default agent's workspace dir — the `resolveWorkspace` fallback. */
  defaultWorkspaceDir?: string;
  /**
   * The secret store the daemon-side `web_search` reads provider keys from
   * (SEARCH_API_KEY / PERPLEXITY_API_KEY / …), mirroring the in-process tool's
   * config. Optional — absent → the keyless/default provider chain.
   */
  webSearchKeys?: CapabilityWebSearchKeys;
}

/** The constructed capability layer handle (undefined when no autonomy agent). */
export interface CapabilityLayerHandle {
  leaseManager: LeaseManager;
  endpoint: CapabilityEndpoint;
  /** The cap socket path (under the data dir) — bound per jail by the orchestrate runner. */
  capSocketPath: string;
  /**
   * The daemon-wide OutputGuard the lease mint registers each bearer in (Pitfall 1
   * — ENDPOINT-03). `setup-tools.ts` reads it from the handle to build the
   * `CapabilityMintDeps`, so the bearer is added to the redaction set at mint.
   */
  outputGuard: OutputGuardPort;
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

/** The shipped web-search provider keys, read from the secret store (or none). */
function buildWebSearchConfig(
  keys: CapabilityWebSearchKeys | undefined,
): Parameters<typeof createOrchestrateExecutorCores>[0]["webSearchConfig"] {
  if (!keys) return undefined;
  // Mirror the in-process tool's key sourcing (tool-bridge.ts) so the autonomous
  // search uses the SAME providers the operator configured.
  return {
    apiKey: keys.get("SEARCH_API_KEY"),
    perplexity: { apiKey: keys.get("PERPLEXITY_API_KEY") },
    tavily: { apiKey: keys.get("TAVILY_API_KEY") },
    exa: { apiKey: keys.get("EXA_API_KEY") },
    jina: { apiKey: keys.get("JINA_API_KEY") },
    grok: { apiKey: keys.get("XAI_API_KEY") },
  };
}

/**
 * Construct the daemon-side `tool.invoke` executor (Plan 02) from the shipped
 * cores + the workspace resolver + the ResultRef store (Plan 05). Returns
 * `undefined` when the activation inputs (skillsLogger + workspaceDirs +
 * defaultWorkspaceDir) are not all supplied (the 211 boot-gate unit tests) — the
 * endpoint then has NO executor and an executor-route call throws a clear wiring
 * error (never a silent no-op).
 *
 * The `materialize` writer bridges the executor's `(payload, toolName, lease)`
 * call to the store's `(payload, toolName, ctx)`: the lease's `agentId` resolves
 * the offloading agent's workspace, so an over-threshold daemon-side return
 * (e.g. a large `web_fetch`) is written to THAT agent's `results/` and the jailed
 * script slices it in-jail via `jq`/`read` over the ref (REF-01/02). A per-call
 * `runId` scopes the on-disk basename; the orchestrate runner's `gcRun`/
 * `cleanupRun` reaps the agent's `results/` on its run end (REF-03).
 */
function buildToolInvokeExecutor(
  deps: CapabilityLayerDeps,
  resultRefStore: ResultRefStore,
): ExecuteToolInvoke | undefined {
  const { skillsLogger, workspaceDirs, defaultWorkspaceDir, daemonLogger } = deps;
  if (!skillsLogger || !workspaceDirs || defaultWorkspaceDir === undefined) return undefined;
  const now = deps.clock.now;
  const resolveWorkspace = (agentId: string): string =>
    workspaceDirs.get(agentId) ?? defaultWorkspaceDir;
  // The shipped read/grep/find/ls/jq + web_search cores (skills) — the real cores
  // Plan 02 left injected. Built ONCE (the web-search cache is factory-shared).
  const cores = createOrchestrateExecutorCores({
    logger: skillsLogger,
    webSearchConfig: buildWebSearchConfig(deps.webSearchKeys),
  });
  return createToolInvokeExecutor({
    resolveWorkspace,
    fileExecutors: cores.fileExecutors,
    webSearch: cores.webSearch,
    // Phase 213 meters the cost-bearing web pair; in M1 it is a no-op seam.
    budgetHook: () => {},
    // Over-threshold returns offload to the OFFLOADING agent's workspace
    // results/ (REF-01) — the lease (threaded by the executor) gives the agentId.
    materialize: async (payload, toolName, lease): Promise<ResultRef | undefined> => {
      const workspacePath = resolveWorkspace(lease.agentId);
      const runId = `tinvoke-${now().toString(36)}`;
      const result = await resultRefStore.materialize(payload, toolName, {
        workspacePath,
        runId,
        nowMs: now(),
      });
      // The store returns a ResultRef on success, a content-free { error } on an
      // over-cap refuse, or undefined on a failed write — the executor inlines on
      // anything that is not a ResultRef.
      return result !== undefined && "ref" in result ? result : undefined;
    },
    logger: daemonLogger,
  });
}

/**
 * Construct the daemon-wide capability layer (gated on an autonomy-bearing
 * profile, mirroring how the broker is gated on `executor.broker`), ACTIVATE it
 * (inject the executor + start the 0600 socket — Phase 212 Gap 3), AND run the
 * JAIL-03 host namespace preflight once at boot. The cap handle is `undefined`
 * when no agent is autonomy-bearing (so the lease layer + cap.sock are absent);
 * the preflight runs unconditionally (it is a host capability check).
 *
 * Async because socket activation (`startSocket`) binds the unix socket before
 * boot proceeds — daemon.ts `await`s this (net-zero: the call was already one line).
 */
export async function constructCapabilityLayer(
  deps: CapabilityLayerDeps,
): Promise<CapabilityLayerResult> {
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
  // The daemon-wide OutputGuard the mint registers each bearer in (Pitfall 1 —
  // ENDPOINT-03). setup-tools reads it off the handle for the CapabilityMintDeps.
  const outputGuard = createOutputGuard();
  // The Plan-03 ResultRef store the executor offloads over-threshold returns to.
  const resultRefStore = createResultRefStore({ logger: deps.skillsLogger ?? daemonLogger });
  // The cap socket path lives under the data dir, mirroring broker.sock's
  // ephemeral lifecycle. The orchestrate runner binds it per jail; the daemon-
  // wide endpoint listens on it once (activated below).
  // Phase 212 Gap 3: ACTIVATE the cap layer. A cap-socket setup failure (an
  // unusable dataDir, or the unix socket cannot bind) must NOT crash the daemon
  // boot — autonomy is an add-on, so it degrades HONESTLY (no cap layer + a loud
  // WARN; the absent handle downshifts the surface) while the daemon keeps serving
  // channels. The safe direction is LESS capability, never a half-built endpoint.
  try {
    const capSocketPath = safePath(dataDir, "cap.sock");
    // Step 1: construct the daemon-side tool.invoke executor and inject it into the
    // endpoint — mirroring how the LeaseManager is constructed-and-injected here
    // (NOT a mutable setter on a security boundary).
    const toolInvokeExecutor = buildToolInvokeExecutor(deps, resultRefStore);
    // Thread the daemon logger so the socket boundary is observable (WR-02): a
    // post-listen server error and per-connection errors are logged with the
    // canonical err/errorKind/hint rather than silently swallowed.
    const endpoint = createCapabilityEndpoint({ leaseManager, rpcCall, logger: daemonLogger, toolInvokeExecutor });
    // Step 2: ACTIVATE — start the daemon-wide 0600 socket ONCE. 211 left this
    // DORMANT (no startSocket; active:false). Now the cap surface is LIVE: a jailed
    // orchestrate child reaches the endpoint over the bound socket.
    await endpoint.startSocket(capSocketPath);
    daemonLogger.info(
      { submodule: "capability-endpoint", capSocketPath, active: true },
      "Capability lease layer ACTIVE (0600 socket listening; executor wired; lease minted per spawn)",
    );
    return {
      capEndpointHandle: { leaseManager, endpoint, capSocketPath, outputGuard },
      capEndpointStop: () => endpoint.stopSocket(),
      namespacePreflightOk,
    };
  } catch (err) {
    daemonLogger.warn(
      {
        submodule: "capability-endpoint",
        err,
        errorKind: "config" as const,
        hint: "autonomy cap-socket activation failed (the data dir must be an absolute, writable path); orchestrate is unavailable this boot — the daemon continues without the autonomy surface",
      },
      "Capability lease layer DEGRADED — cap-socket activation failed; autonomy surface unavailable (daemon continues serving channels)",
    );
    return { capEndpointHandle: undefined, capEndpointStop: undefined, namespacePreflightOk };
  }
}
