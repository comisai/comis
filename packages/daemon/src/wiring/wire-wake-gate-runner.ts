// SPDX-License-Identifier: Apache-2.0
/**
 * Assemble {@link WakeGateRunnerDeps} from the daemon's capability layer + boot
 * context. Extracted from the composition root so daemon.ts stays thin; the
 * populate itself (`createWakeGateRunner(...)` behind the `capEndpointHandle`
 * guard) stays in daemon.ts where the boot-order guard reads it.
 *
 * The runner's tool reach is bounded by each agent's RESOLVED autonomy caps
 * enforced at the cap socket — the caps ride the fresh per-fire lease the runner
 * mints, NOT a job tool policy. This builder only threads the collaborators: the
 * lease manager / output guard / cap socket / registerRoot all come from the SAME
 * `capEndpointHandle` the cron-fire mint uses.
 * @module
 */
import type { ComisLogger, PerAgentConfig, TypedEventBus } from "@comis/core";
import type { SandboxProvider } from "@comis/skills/tools";

import type { WakeGateRunnerDeps } from "./wake-gate-runner.js";
import type { CapabilityLayerHandle } from "./setup-capability-endpoint-boot.js";

// Re-exported so the composition root threads the runner through a single import.
export { createWakeGateRunner } from "./wake-gate-runner.js";
export type { WakeGateRunner } from "./wake-gate-runner.js";

/** The boot-context fields the wake-gate runner is assembled from (a structural
 *  cut of BootContext — the daemon `handle` satisfies it). */
export interface WakeGateRunnerBootInputs {
  readonly skillsLogger: ComisLogger;
  readonly workspaceDirs: Map<string, string>;
  readonly defaultWorkspaceDir: string;
  readonly agentsConfig: Record<string, PerAgentConfig>;
  readonly execToolEnv: Record<string, string | undefined>;
  /**
   * The daemon container — its `eventBus` is the SAME bus the socket cap
   * chokepoint emits `capability:audited` on, so the runner scope-counts a fire's
   * allow-decision cap-calls (`toolCalls`) off it.
   */
  readonly container: { readonly eventBus: TypedEventBus };
}

/** Build the {@link WakeGateRunnerDeps} from the boot context + the built cap layer. */
export function buildWakeGateRunnerDeps(
  boot: WakeGateRunnerBootInputs,
  capEndpointHandle: CapabilityLayerHandle,
  sandbox: SandboxProvider,
  namespacePreflightOk: boolean,
): WakeGateRunnerDeps {
  return {
    logger: boot.skillsLogger,
    leaseManager: capEndpointHandle.leaseManager,
    outputGuard: capEndpointHandle.outputGuard,
    capSocketPath: capEndpointHandle.capSocketPath,
    registerRoot: (rootRunId, leaseId, parentLeaseId) =>
      capEndpointHandle.boundedAutonomy.registerRoot(rootRunId, leaseId, parentLeaseId),
    sandbox,
    resolveWorkspace: (agentId) => boot.workspaceDirs.get(agentId) ?? boot.defaultWorkspaceDir,
    agents: boot.agentsConfig,
    baseEnv: boot.execToolEnv,
    namespacePreflightOk,
    // The bus the socket cap chokepoint emits `capability:audited` on — the runner
    // scope-counts a fire's own allow-decisions off it (toolCalls).
    eventBus: boot.container.eventBus,
  };
}
