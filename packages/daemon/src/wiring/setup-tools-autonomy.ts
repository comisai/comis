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
  type ApprovalGate,
  type ComisLogger,
  type PerAgentConfig,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import type { PlatformToolProvider } from "@comis/skills";
import type { OrchestrateDurableRuns, SandboxProvider } from "@comis/skills/tools";
import { createOrchestrateTool, createResultRefStore } from "@comis/skills/tools";
import type { CapabilityClass, OrchestrateRepairSeam } from "@comis/agent";

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
  /**
   * The assembly event bus. Threaded into the orchestrate runner so each run
   * emits a content-free `orchestrate:run_summary` from the TOOL (where this bus
   * reaches the live per-session trajectory bridge — NOT a daemon graph handler).
   * Absent ⇒ the runner does not emit (no regression to the older wiring).
   */
  readonly eventBus?: TypedEventBus;
  /**
   * The approval gate, threaded into the orchestrate runner's static pre-flight:
   * when present, a run fires ONE approval on its whole capability footprint before
   * spawn. Present ONLY when `config.approvals.enabled` (the daemon threads it from the
   * same `deps.approvalGate` exec uses) — so seam-presence IS "approvals configured".
   * Absent ⇒ no approval fire (no regression to older wiring).
   */
  readonly approvalGate?: ApprovalGate;
  /**
   * The resolved effective capability class (operator override → provider-family →
   * the `small` fail-safe), threaded from setup-tools. The orchestrate runner's
   * one-shot auto-repair is class-gated off it — ON for weaker models (small/nano),
   * OFF for stronger (frontier/mid). No config toggle: the class is the sole control.
   * Absent ⇒ the runner treats it as the fail-safe class where consumed.
   */
  readonly capabilityClass?: CapabilityClass;
  /**
   * The daemon-minted one-shot repair closure, resolved per agent by
   * `buildOrchestrateRepairResolver` ONLY when the class is repair-eligible AND a
   * utility model resolves. Threaded into the orchestrate runner (like {@link mintRunLease})
   * so a recoverable failed script gets ONE utility-model re-prompt + one re-run.
   * Absent ⇒ no repair (frontier/mid, or no resolvable utility model).
   */
  readonly repairSeam?: OrchestrateRepairSeam;
  /**
   * The durable-run store port. The composition root threads it whenever the
   * durable-resume subsystem is constructed (i.e. durability is enabled for some
   * agent); this wiring forwards it into the orchestrate runner ONLY when THIS
   * agent's `autonomy.durability.orchestrateResume` is on (the surface gate,
   * resolved below off the same config path as the capability-endpoint's
   * `orchestrateResumeEnabled` predicate). Forwarded ⇒ the runner registers a
   * resumable row + honors `resumeRunId` + skips cleanupRun on a timeout. Off /
   * absent ⇒ no durable row, normal cleanup (byte-identical to a non-resumable run).
   */
  readonly durableRuns?: OrchestrateDurableRuns;
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
  // The resume surface gate (default-OFF, deny-by-absence): the durable-run store
  // is forwarded into the runner ONLY when THIS agent has opted into resumable
  // orchestrate runs. Reads the SAME config path as the capability endpoint's
  // orchestrateResumeEnabled predicate (`=== true` so an absent/typo'd durability
  // block resolves OFF) — so a store the composition root always threads under a
  // durability-enabled boot goes live in the runner only for an opted-in agent.
  const orchestrateResumeOn =
    input.agentConfig?.autonomy?.durability?.orchestrateResume === true;
  const handle = input.capEndpointHandle;
  // Tree-stable rootRunId: INHERIT the caller's
  // id when this assembly is a sub-agent (so the whole tree shares one id the
  // semaphore/budget/kill key on — a fresh id per sub-agent would silently
  // under-count the tree); mint a fresh root id ONLY when there is no
  // caller id (the tree root). Uses systemNowMs (the sanctioned-root time helper).
  const rootRunId =
    input.callerRootRunId ?? `root-${input.agentId}-${systemNowMs().toString(36)}`;
  // Extract the budget/session refs ONCE so the assembly capMint AND the per-run
  // child-lease seam mint against the SAME accounting refs — a child that drifted
  // onto a different budgetRef/sessionKey would mis-attribute spend and break the
  // audience-bound sessionKey correlation. budgetRef is a per-assembly id.
  const budgetRef = `run-${input.agentId}-${systemNowMs().toString(36)}`;
  const sessionKey = input.sessionKey ? formatSessionKey(input.sessionKey) : input.agentId;
  const capMint: CapabilityMintDeps | undefined =
    handle && resolved.enabled
      ? {
          leaseManager: handle.leaseManager,
          outputGuard: handle.outputGuard,
          capSocketPath: handle.capSocketPath,
          resolvedCaps: resolved.capabilities,
          budgetRef,
          sessionKey,
          rootRunId,
          // Anchor the tree root in the bounded-autonomy service right after the
          // mint (the per-root budget wall-clock + the rootRunId↔leaseId index).
          registerRoot: (rid, leaseId, parentLeaseId) =>
            handle.boundedAutonomy.registerRoot(rid, leaseId, parentLeaseId),
        }
      : undefined;
  const brokerSpawnEnv = buildBrokerSpawnEnv(input.brokerContext, input.agentId, capMint);

  // The per-run child-lease mint seam (D5, EXPLAIN-01) — the correlation
  // keystone. A closure the runner calls ONCE per orchestrate run to mint a
  // short-TTL CHILD lease off the assembly lease: same caps + SAME rootRunId
  // (tree accounting untouched — registerRoot is NOT called, so the per-root
  // budget/semaphore/kill stays keyed on the single registered assembly lease,
  // INV-7), parentLeaseId = the assembly leaseId, and a TTL the RUNNER sizes and
  // passes in (ttlMs === maxTtlMs === the runner-passed ttlMs): the run timeout,
  // or the run timeout + the one-shot-repair budget when auto-repair is enabled,
  // so the single lease outlives the repair-completion await into the repaired
  // re-run. The child bearer is registered in OutputGuard at mint
  // (Pitfall 1 — never logged) BEFORE it leaves the closure. revokeByRootRun still
  // reaches the child (it scans by the inherited rootRunId), so kill is preserved.
  // Built ONLY when an assembly lease exists (brokerSpawnEnv.leaseId present);
  // otherwise undefined → the runner falls back to the assembly bearer (the
  // older/non-autonomy path — never an unauthenticated run). A plain closure so
  // @comis/skills never imports the LeaseManager: the mint is daemon-side, the
  // runner only receives the bearer.
  const assemblyLeaseId = brokerSpawnEnv?.leaseId;
  const mintRunLease:
    | ((runId: string, ttlMs: number) => { leaseId: string; bearer: string })
    | undefined =
    handle && resolved.enabled && assemblyLeaseId !== undefined
      ? (runId, ttlMs) => {
          // runId is the runner's correlator; the child lease minted here is
          // correlated by its OWN fresh leaseId + the inherited rootRunId.
          const issued = handle.leaseManager.mintLease({
            agentId: input.agentId,
            caps: resolved.capabilities,
            budgetRef,
            sessionKey,
            rootRunId,
            parentLeaseId: assemblyLeaseId,
            ttlMs,
            maxTtlMs: ttlMs,
          });
          // Register the child bearer BEFORE it leaves the closure (Pitfall 1 —
          // a NEW bearer that is not registered can leak via a log/model echo).
          handle.outputGuard.registerSecret(issued.bearer);
          // Intentionally NO boundedAutonomy.registerRoot for the child (D5) —
          // the child inherits the assembly's rootRunId, so tree accounting is
          // untouched (INV-7); revokeByRootRun still reaches it.
          return { leaseId: issued.leaseId, bearer: issued.bearer };
        }
      : undefined;

  const orchestrateTool: AgentTool | undefined =
    handle && resolved.enabled && input.sandboxProvider
      ? (createOrchestrateTool({
          logger: input.logger,
          workspaceResolver: () => input.agentWorkspaceDir,
          capSocketPath: handle.capSocketPath,
          sandbox: input.sandboxProvider,
          brokerSpawnEnv, // the SAME minted COMIS_CAP_LEASE/COMIS_ORCH_SOCKET
          mintRunLease, // per-run child bearer overrides the assembly bearer (D5)
          store: createResultRefStore({ logger: input.logger }),
          baseEnv: input.baseEnv ?? {},
          // The static pre-flight's held-cap set: the SAME resolved.capabilities the
          // assembly/child leases are minted with — the advisory pre-spawn cap
          // fail-fast keys on it (the cap-socket endpoint stays the authoritative
          // gate). No drift by construction.
          allowedCaps: resolved.capabilities,
          // The approval gate — threaded ONLY when the daemon wired one
          // (config.approvals.enabled), mirroring the eventBus conditional-spread.
          // Absent ⇒ the runner fires no approval.
          ...(input.approvalGate !== undefined ? { approvalGate: input.approvalGate } : {}),
          // The run_summary emit channel + the self-attribution keys (the
          // daemon-shared bus fans out to every session bridge — the payload
          // carries rootRunId + sessionKey so it lands on the right report).
          ...(input.eventBus !== undefined ? { eventBus: input.eventBus } : {}),
          // The one-shot auto-repair class-gate + the daemon-minted repair closure
          // — conditional-spread like eventBus. capabilityClass gates the runner's
          // repair branch (a pure class-gate off the model profile; no config
          // toggle); repairSeam is the injected one-attempt completion. Both absent
          // for a stronger model / an unresolvable utility model ⇒ the runner does
          // not repair (no regression to older wiring).
          ...(input.capabilityClass !== undefined ? { capabilityClass: input.capabilityClass } : {}),
          ...(input.repairSeam !== undefined ? { repairSeam: input.repairSeam } : {}),
          // The durable-run store — forwarded ONLY when the resume surface is on
          // for this agent (orchestrateResumeOn gates the store the composition
          // root always threads), making the runner resumable. Off ⇒ omitted → the
          // runner writes no durable row + cleans normally (default-off byte-identity).
          ...(input.durableRuns !== undefined && orchestrateResumeOn
            ? { durableRuns: input.durableRuns }
            : {}),
          rootRunId,
          sessionKey,
        }) as unknown as AgentTool)
      : undefined;

  return { brokerSpawnEnv, orchestrateTool };
}
