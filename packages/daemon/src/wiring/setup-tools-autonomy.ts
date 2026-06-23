// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-autonomy` — the Phase-212 Gap-3 dormancy-activation tool wiring,
 * extracted from `setup-tools.ts` to keep it under the 800-line cap (mirrors the
 * `setup-broker-activation` / `setup-terminal-tools` / `setup-context-tools`
 * extractions). It owns the per-assembly cap-lease MINT + the `orchestrate` tool
 * assembly for an autonomy-bearing agent — the daemon-side half of "make the
 * surface LIVE":
 *
 *   - {@link buildCapabilityMint}: from the KEPT cap-layer handle
 *     (`constructCapabilityLayer`) + the agent's resolved autonomy caps, build the
 *     `CapabilityMintDeps` that `buildBrokerSpawnEnv`'s 3rd arg consumes (mints the
 *     per-spawn lease, registers the bearer in OutputGuard — Pitfall 1, injects
 *     `COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`). `undefined` for a non-autonomy agent
 *     (or no handle) → `buildBrokerSpawnEnv`'s 2-arg behavior holds (no regression).
 *   - {@link maybeBuildOrchestrateTool}: assemble the Surface-2 `orchestrate` runner
 *     (Plan 04) when the agent is autonomy-bearing AND a sandbox provider exists
 *     (the jail is buildable). The autonomy resolver IS the gate — no speculative
 *     `builtinTools.orchestrate` flag (AGENTS §2.3). The runner gets the cap socket,
 *     the SAME minted `brokerSpawnEnv` (so its jailed SDK authenticates), and a
 *     per-run ResultRef store.
 *
 * @module
 */
import {
  resolveAutonomy,
  systemNowMs,
  formatSessionKey,
  type ComisLogger,
  type PerAgentConfig,
  type SessionKey,
} from "@comis/core";
import type { PlatformToolProvider } from "@comis/skills";
import type { SandboxProvider } from "@comis/skills/tools";
import { createOrchestrateTool, createResultRefStore } from "@comis/skills/tools";

/** The daemon tool-assembly array element type (an `AgentTool`), derived via skills
 *  (mirrors setup-context-tools.ts / setup-terminal-tools.ts) so this file does not
 *  type-import `@earendil-works/pi-agent-core` directly (which @comis/daemon does not declare). */
type AgentTool = ReturnType<PlatformToolProvider>[number];
import {
  buildBrokerSpawnEnv,
  type BrokerContextDeps,
  type BrokerSpawnEnv,
  type CapabilityMintDeps,
} from "./setup-broker-activation.js";
import type { CapabilityLayerHandle } from "./setup-capability-endpoint-boot.js";

/** Inputs {@link buildAutonomyToolWiring} reads (a narrowed slice of the assembly context). */
export interface AutonomyToolInputs {
  /** The agent's config (its `autonomy` block is resolved for the gate + caps). */
  readonly agentConfig: PerAgentConfig | undefined;
  /** The agent id the lease/tool are scoped to. */
  readonly agentId: string;
  /** The agent's jailed workspace root (the orchestrate runner's writable root). */
  readonly agentWorkspaceDir: string;
  /** The KEPT cap-layer handle (lease + cap socket + outputGuard), or undefined. */
  readonly capEndpointHandle: CapabilityLayerHandle | undefined;
  /** The HTTPS-proxy broker context (independent of the cap lease), or undefined. */
  readonly brokerContext: BrokerContextDeps | undefined;
  /** The OS sandbox provider — REQUIRED for the orchestrate jail; absent ⇒ no orchestrate tool. */
  readonly sandboxProvider: SandboxProvider | undefined;
  /** The session key the lease is minted for, or undefined (heartbeat/cron). */
  readonly sessionKey: SessionKey | undefined;
  /** The skills-scoped logger (instrument the runner + the store). */
  readonly logger: ComisLogger;
  /** The filtered inherited env the runner scrubs (ORCH-02); the lease vars ride placeholders. */
  readonly baseEnv: Record<string, string | undefined> | undefined;
}

/** The wiring {@link buildAutonomyToolWiring} returns: the minted env + the orchestrate tool. */
export interface AutonomyToolWiring {
  /** The exec/orchestrate spawn-env: broker proxy (if wired) + the minted cap lease (if autonomy). */
  readonly brokerSpawnEnv: BrokerSpawnEnv | undefined;
  /** The orchestrate tool, or undefined (non-autonomy agent / no handle / no sandbox). */
  readonly orchestrateTool: AgentTool | undefined;
}

/**
 * The Phase-212 Gap-3 autonomy tool wiring for one agent assembly: mint the
 * per-spawn lease ONCE (the SAME env feeds exec + orchestrate, one lease per
 * assembly — mirrors the broker token's per-assembly lifecycle) and assemble the
 * `orchestrate` tool when the agent is autonomy-bearing AND a sandbox provider
 * exists (the jail is buildable). `capMint`/`orchestrateTool` are `undefined` for
 * a non-autonomy agent, no handle, or no sandbox → `buildBrokerSpawnEnv`'s 2-arg
 * behavior + NO orchestrate tool (never an unjailed run; no regression — 211-06
 * covered both broker paths). The autonomy resolver IS the gate (no speculative
 * `builtinTools.orchestrate` flag — AGENTS §2.3); the runner's `resolveJailNode`
 * honest-degrade is the second line behind the sandbox gate.
 */
export function buildAutonomyToolWiring(input: AutonomyToolInputs): AutonomyToolWiring {
  const resolved = resolveAutonomy(input.agentConfig?.autonomy);
  const handle = input.capEndpointHandle;
  const capMint: CapabilityMintDeps | undefined =
    handle && resolved.enabled
      ? {
          leaseManager: handle.leaseManager,
          outputGuard: handle.outputGuard,
          capSocketPath: handle.capSocketPath,
          resolvedCaps: resolved.capabilities,
          // budgetRef is the Phase-213 budget seam; an M1 per-assembly id.
          budgetRef: `run-${input.agentId}-${systemNowMs().toString(36)}`,
          sessionKey: input.sessionKey ? formatSessionKey(input.sessionKey) : input.agentId,
          rootRunId: `root-${input.agentId}-${systemNowMs().toString(36)}`,
        }
      : undefined;
  const brokerSpawnEnv = buildBrokerSpawnEnv(input.brokerContext, input.agentId, capMint);

  const orchestrateTool: AgentTool | undefined =
    handle && resolved.enabled && input.sandboxProvider
      ? (createOrchestrateTool({
          logger: input.logger,
          workspaceResolver: () => input.agentWorkspaceDir,
          capSocketPath: handle.capSocketPath,
          sandbox: input.sandboxProvider,
          brokerSpawnEnv, // the SAME minted COMIS_CAP_LEASE/COMIS_ORCH_SOCKET
          store: createResultRefStore({ logger: input.logger }),
          baseEnv: input.baseEnv ?? {},
        }) as unknown as AgentTool)
      : undefined;

  return { brokerSpawnEnv, orchestrateTool };
}
