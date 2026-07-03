// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-autonomy` — the dormancy-activation tool wiring,
 * extracted from `setup-tools.ts` to keep it under the 800-line cap (mirrors the
 * `setup-broker-activation` / `setup-terminal-tools` / `setup-context-tools`
 * extractions). It owns the per-assembly cap-lease MINT + the `orchestrate` tool
 * assembly for an autonomy-bearing agent — the daemon-side half of "make the
 * surface LIVE":
 *
 *   - {@link buildCapabilityMint}: from the KEPT cap-layer handle
 *     (`constructCapabilityLayer`) + the agent's resolved autonomy caps, build the
 *     `CapabilityMintDeps` that `buildBrokerSpawnEnv`'s 3rd arg consumes (mints the
 *     per-spawn lease, registers the bearer in OutputGuard so it is scrubbed from
 *     agent-visible output, injects
 *     `COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`). `undefined` for a non-autonomy agent
 *     (or no handle) → `buildBrokerSpawnEnv`'s 2-arg behavior holds (no regression).
 *   - {@link maybeBuildOrchestrateTool}: assemble the `orchestrate` runner
 *     when the agent is autonomy-bearing AND a sandbox provider exists
 *     (the jail is buildable). The autonomy resolver IS the gate — no speculative
 *     `builtinTools.orchestrate` flag (AGENTS §2.3). The runner gets the cap socket,
 *     the SAME minted `brokerSpawnEnv` (so its jailed SDK authenticates), and a
 *     per-run ResultRef store.
 *
 * @module
 */
import {
  resolveAutonomy,
  degradeAutonomy,
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
  /**
   * The host namespace preflight RESULT (the
   * unprivileged-userns + `--unshare-net` probe `constructCapabilityLayer` runs
   * once at boot). `false` means the jail CANNOT be built on this host, so the
   * autonomy surface must genuinely degrade to `assistant` here (no orchestrate
   * tool, no lease mint) — matching the boot WARN's "surfaces disabled (no silent
   * unjailed fallback)" claim. Defaults to `true` when absent (the daemon always
   * threads the real probe; an omitted value is the Linux happy path) so this is a
   * pure tighten — never a new disable.
   */
  readonly namespacePreflightOk?: boolean;
  /** The session key the lease is minted for, or undefined (heartbeat/cron). */
  readonly sessionKey: SessionKey | undefined;
  /**
   * The CALLER's tree-stable rootRunId, when this
   * assembly is itself a sub-agent whose spawn metadata carried one. When present
   * the minted lease INHERITS it — the whole tree must share one id, or the
   * per-tree budget/semaphore accounting silently under-counts. Absent ⇒ this is
   * a tree root and a fresh id is minted here.
   */
  readonly callerRootRunId?: string;
  /** The skills-scoped logger (instrument the runner + the store). */
  readonly logger: ComisLogger;
  /** The filtered inherited env the runner scrubs; the lease vars ride placeholders. */
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
 * The autonomy tool wiring for one agent assembly: mint the
 * per-spawn lease ONCE (the SAME env feeds exec + orchestrate, one lease per
 * assembly — mirrors the broker token's per-assembly lifecycle) and assemble the
 * `orchestrate` tool when the agent is autonomy-bearing AND a sandbox provider
 * exists (the jail is buildable). `capMint`/`orchestrateTool` are `undefined` for
 * a non-autonomy agent, no handle, or no sandbox → `buildBrokerSpawnEnv`'s 2-arg
 * behavior + NO orchestrate tool (never an unjailed run; both broker paths keep
 * their existing behavior). The autonomy resolver IS the gate (no speculative
 * `builtinTools.orchestrate` flag — AGENTS §2.3); the runner's `resolveJailNode`
 * honest-degrade is the second line behind the sandbox gate.
 */
export function buildAutonomyToolWiring(input: AutonomyToolInputs): AutonomyToolWiring {
  // The honest-degrade must gate the SURFACE, not
  // just the boot log. When the host namespace preflight failed the jail cannot be
  // built, so `degradeAutonomy` downshifts the resolved posture to `assistant`
  // (enabled:false, zero caps) HERE — the SAME shipped single-source-of-truth the
  // boot WARN + the `doctor` finding already consume. Without this the orchestrate
  // tool was still assembled and the per-spawn lease still minted on a host that
  // cannot jail (e.g. macOS, where the child runs network-unrestricted under
  // sandbox-exec), directly contradicting the boot WARN's "surfaces disabled (no
  // silent unjailed fallback)". Defaults to preflight-OK when absent (the Linux
  // happy path / older callers) so this is a pure tighten, never a new disable.
  const resolved = degradeAutonomy(resolveAutonomy(input.agentConfig?.autonomy), {
    namespacePreflightOk: input.namespacePreflightOk ?? true,
  }).resolved;
  const handle = input.capEndpointHandle;
  // Tree-stable rootRunId: INHERIT the caller's
  // id when this assembly is a sub-agent (so the whole tree shares one id the
  // semaphore/budget/kill key on — a fresh id per sub-agent would silently
  // under-count the tree); mint a fresh root id ONLY when there is no
  // caller id (the tree root). Uses systemNowMs (the sanctioned-root time helper).
  const rootRunId =
    input.callerRootRunId ?? `root-${input.agentId}-${systemNowMs().toString(36)}`;
  const capMint: CapabilityMintDeps | undefined =
    handle && resolved.enabled
      ? {
          leaseManager: handle.leaseManager,
          outputGuard: handle.outputGuard,
          capSocketPath: handle.capSocketPath,
          resolvedCaps: resolved.capabilities,
          // budgetRef is the budget-accounting seam; a per-assembly id.
          budgetRef: `run-${input.agentId}-${systemNowMs().toString(36)}`,
          sessionKey: input.sessionKey ? formatSessionKey(input.sessionKey) : input.agentId,
          rootRunId,
          // Anchor the tree root in the bounded-autonomy service right after the
          // mint (the per-root budget wall-clock + the rootRunId↔leaseId index).
          registerRoot: (rid, leaseId, parentLeaseId) =>
            handle.boundedAutonomy.registerRoot(rid, leaseId, parentLeaseId),
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
