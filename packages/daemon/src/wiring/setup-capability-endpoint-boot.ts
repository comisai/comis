// SPDX-License-Identifier: Apache-2.0
/**
 * `constructCapabilityLayer` — the daemon-wide capability-lease construction +
 * ACTIVATION, extracted from `daemon.ts`'s boot WITHOUT adding a net line to
 * daemon.ts (line-cap ≤ 3000, arch invariant — the daemon-side wiring all lives here).
 *
 * Mirrors the credential broker's conditional construction (gated on
 * `executor.broker`): construct ONE daemon-wide `LeaseManager` + the loopback
 * capability endpoint when ANY agent resolves to an autonomy-bearing profile.
 * The endpoint validates the lease + dispatches through the SAME `rpcCall` sink
 * (so deny-by-origin + requireCapability + the unknown-method `!handler` throw
 * all fire automatically).
 *
 * Activation flips the layer from constructed-but-DORMANT to ACTIVE, all inside
 * this helper so daemon.ts only KEEPS the returned handle:
 *   1. The daemon-side `tool.invoke` executor (`createToolInvokeExecutor`) is
 *      constructed HERE from the injected shipped cores (read/grep/find/ls/jq +
 *      web_search) + the agent workspace resolver + the ResultRef
 *      `materialize` writer, and injected into `createCapabilityEndpoint` via its
 *      deps — MIRRORING how the `LeaseManager` is constructed-and-injected. NOT a
 *      mutable setter on the handle: construction-time injection keeps the lease-
 *      gated endpoint immutable once built (the executor IS the security-relevant
 *      dispatch target).
 *   2. `endpoint.startSocket(capSocketPath)` is called ONCE (the daemon-wide 0600
 *      socket; the lease is per-spawn) — the boot log now reports `active: true`.
 * The returned handle's `endpoint.stopSocket` is threaded into `setupShutdown`
 * (mirrors the broker teardown). The bwrap per-jail bind is the orchestrate
 * runner's — this helper owns the daemon-wide socket lifecycle.
 *
 * @module
 */

import {
  resolveAutonomy,
  permitsMcpTool,
  safePath,
  createOutputGuard,
  formatSessionKey,
  type PerAgentConfig,
  type ClockPort,
  type TimerPort,
  type ResultRef,
  type OutputGuardPort,
  type ComisLogger,
  type SessionKey,
  type DurableRunPort,
  type OutwardSendLedgerPort,
} from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import { createLeaseManager, type LeaseManager, type LeaseManagerDeps } from "@comis/infra";
import { createBoundedAutonomy, type BoundedAutonomy } from "../autonomy/bounded-autonomy.js";
// The never-hang control plane the dispatch chokepoint reads — the per-rootRunId
// denial breaker, the evicted-rootRunId set, and the content-free escalate NotifyFn.
// All three are constructed here (alongside BoundedAutonomy) and held on the cap
// handle so daemon.ts threads them onto the dispatch deps.
import { createDenialBreaker, type DenialBreaker } from "../autonomy/denial-breaker.js";
import { createEvictRegistry, type EvictRegistry } from "../autonomy/evict-registry.js";
import type { NotifyFn } from "../autonomy/durable-resume-engine.js";
import { namespacePreflight, type NamespacePreflightResult, type McpClientManager } from "@comis/skills";
import {
  createOrchestrateExecutorCores,
  createResultRefStore,
  CHECKPOINT_TTL_MS,
  type ResultRefStore,
} from "@comis/skills/tools";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createCapabilityEndpoint,
  createReplayRecorder,
  type CapabilityEndpoint,
  type ReplayRecorder,
} from "./setup-capability-endpoint.js";
import type { EmitCapabilityAuditDeps } from "../api/shared/emit-capability-audit.js";
import { createToolInvokeExecutor, type ExecuteToolInvoke } from "./setup-tool-invoke-executor.js";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { LoggingResult } from "./setup-logging.js";

/** The web-search API keys the daemon-side autonomous search reads (from the secret store). */
export interface CapabilityWebSearchKeys {
  get: (name: string) => string | undefined;
}

/**
 * Build the `resolveRootRunId(agentId, sessionKey) → rootRunId` resolver over a late-bound
 * budget holder + an authenticated agent/session→rootRunId index. The
 * resolver is a STABLE closure created EARLY (before setupAgents/setupSchedulers,
 * which hold it) and reads `holder.current` at call time — by the time a turn runs,
 * the cap layer has populated it.
 *
 * Resolution: return the session's already-registered root if present; otherwise
 * mint a SYNTHETIC per-principal root and `registerRoot`
 * it on first use (via the holder). The synthetic fallback is what bounds a
 * TOP-LEVEL (non-spawned) self-spawning loop — the budget's token/wall-clock limbs
 * then key on a stable id for ANY run, not only orchestrate children.
 * A synthetic root has no real lease, so a synthetic leaseId is recorded (the
 * correlation index is content-free; the meter only needs the wall-clock anchor).
 * Idempotent: the same session resolves to the SAME id on every call.
 */
export function createRootRunIdResolver(deps: {
  holder: BoundedAutonomyBudgetHolder;
  index: Map<string, string>;
}): (agentId: string, sessionKey: SessionKey) => string {
  return (agentId: string, sessionKey: SessionKey): string => {
    const formatted = formatSessionKey(sessionKey);
    const principalKey = `${agentId}:${formatted}`;
    const existing = deps.index.get(principalKey);
    if (existing !== undefined) return existing;
    const synthetic = `root-session-${agentId}-${formatted}`;
    deps.index.set(principalKey, synthetic);
    // Anchor the synthetic root in the budget meter on first use (wall-clock
    // deadline + the rootRunId↔leaseId correlation). No real lease for a top-level
    // run → a synthetic leaseId; absent holder ⇒ skip (the resolver still returns
    // a stable id so the bridge can call reserveBudget once `current` is populated).
    deps.holder.current?.registerRoot(synthetic, `lease-${synthetic}`);
    return synthetic;
  };
}

/** Deps for {@link constructCapabilityLayer} — the subset boot closes over. */
export interface CapabilityLayerDeps {
  /** The daemon's agents config map (only `autonomy` is read for the gate). */
  agents: Record<string, PerAgentConfig>;
  /** The deferred RPC dispatch sink the endpoint routes through. */
  rpcCall: RpcCall;
  /** Wall-clock for lease TTLs + the bounded-autonomy budget/rate windows. */
  clock: ClockPort;
  /**
   * Timer port for the bounded-autonomy call-rate limiter's TTL-evict timers.
   * The daemon's TimerPort (`handle.timers`).
   */
  timers: TimerPort;
  /**
   * The per-agent live cron-job count provider.
   * Bound by daemon.ts to `getAgentCronScheduler(agentId).getJobs().length`. The
   * cap endpoint reads it THROUGH `boundedAutonomy.cronCount` for the `cronSelfMax`
   * cap. Optional — absent ⇒ `cronCount` returns 0 (fail-open on that one limb).
   */
  cronJobCount?: (agentId: string) => number;
  /** Absolute data dir — the cap socket path lives under it (cap.sock). */
  dataDir: string;
  /** The module-bound daemon logger for the construction INFO line. */
  daemonLogger: LoggingResult["daemonLogger"];
  /**
   * The skills-scoped logger threaded into the shipped executor cores (file
   * builtins + web_search). Optional so the boot-gate unit tests can construct
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
  /**
   * The daemon-wide LATE-BOUND per-root budget holder,
   * created EARLY in daemon.ts (before setupAgents/setupSchedulers, which hold it)
   * and POPULATED here after `createBoundedAutonomy` with the narrow budget port.
   * Optional — the boot-gate unit tests omit it; the per-root reserve is then
   * never wired (byte-identical).
   */
  boundedAutonomyHolder?: BoundedAutonomyBudgetHolder;
  /**
   * The session→rootRunId index the {@link createRootRunIdResolver} closure reads.
   * Shared by reference with the resolver daemon.ts threads into setupAgents (built
   * EARLY over the SAME holder). Optional — absent ⇒ a local index is used here.
   */
  rootRunIdIndex?: Map<string, string>;
  /**
   * A daemon-supplied LeaseManager, built EARLY in daemon.ts
   * (before setupSchedulers) so the cron-fire mint and this layer share the SAME
   * instance. Optional — absent ⇒ this layer constructs its own (the boot-gate
   * path / older callers).
   */
  leaseManager?: LeaseManager;
  /**
   * The structural deps the socket per-cap audit reads —
   * `eventBus` (for the audit:event + capability:audited emits) + `config.tenantId`.
   * daemon.ts passes the same `AppContainer` the dispatch sink holds (it is
   * structurally assignable). Optional — the boot-gate unit tests omit it, and
   * the socket then emits NO per-cap audit (the endpoint still validates/dispatches;
   * the in-process leg's audit at the dispatch closure is unaffected).
   */
  container?: EmitCapabilityAuditDeps["container"];
  /**
   * The durable-run store — forwarded to the cap endpoint so
   * the jail leg allocates a monotonic `_outwardStepIndex` for an outward message
   * method. Optional; absent ⇒ the endpoint injects no index (pass-through). The
   * daemon builds the store EARLY (before this layer) and threads it here so the
   * chokepoint shares the SAME store the resume engine + message handlers use.
   */
  durableRuns?: DurableRunPort;
  /** Outward ledger and monotonic sequence allocator used by the capability socket. */
  outwardLedger?: OutwardSendLedgerPort;
  /**
   * The daemon-wide MCP client manager (constructed unconditionally by `setupMcp`,
   * in daemon.ts scope). Threaded into the tool-invoke executor's `case "mcp"` so a
   * jailed `mcp.<server>.<tool>()` call dispatches through `callTool` on the DAEMON's
   * network (the jail stays `--unshare-net`). NON-optional on purpose: it compile-forces
   * the single daemon.ts caller to thread the shipped manager — an un-threaded manager
   * makes `executeMcp` honestly degrade to "MCP not available" on a
   * green macOS build. (The executor-leg dep stays OPTIONAL for defense-in-depth.)
   */
  mcpClientManager: McpClientManager;
}

/** The constructed capability layer handle (undefined when no autonomy agent). */
export interface CapabilityLayerHandle {
  leaseManager: LeaseManager;
  endpoint: CapabilityEndpoint;
  /**
   * The daemon-wide bounded-autonomy service — the single chokepoint
   * the spawn ceiling, cap-endpoint rate limit + cron self-ownership,
   * outward quota, and per-root budget meter consult. Constructed alongside the
   * LeaseManager; `destroy()` tears down its rate-limiter timers (threaded into setupShutdown).
   */
  boundedAutonomy: BoundedAutonomy;
  /** The cap socket path (under the data dir) — bound per jail by the orchestrate runner. */
  capSocketPath: string;
  /**
   * The daemon-wide OutputGuard the lease mint registers each bearer in (Pitfall 1).
   * `setup-tools.ts` reads it from the handle to build the
   * `CapabilityMintDeps`, so the bearer is added to the redaction set at mint.
   */
  outputGuard: OutputGuardPort;
  /**
   * The daemon-wide per-rootRunId consecutive denial
   * breaker. The dispatch chokepoint calls `recordDenial` ONLY on a
   * CapabilityDeniedError floor-block and `recordAllow` on the allow branch; on
   * the Nth consecutive floor-block it trips → execution:aborted + killByRootRun.
   * `denialBreakerN` is sourced from the resolved autonomy-bearing config.
   */
  denialBreaker: DenialBreaker;
  /**
   * The daemon-wide evicted-rootRunId set. The
   * `autonomy.evict` admin handler WRITES it (`mark`); the chokepoint READS it
   * (`isEvicted`) at the NEXT gate decision to demote the run's mode to `default`
   * mid-run. The SAME instance is threaded into createAutonomyHandlers via the
   * `...deps` spread, activating the evict handler.
   */
  evictRegistry: EvictRegistry;
  /**
   * The content-free escalate NotifyFn. The chokepoint
   * fires it (NEVER awaited) on an unattended would-ask deny and on a breaker
   * trip — out-of-band + auditable (a WARN with ids/enums/hint, never a body).
   * Synchronous (void) so the deny re-throw is not blocked (the never-hang bar).
   */
  escalate: NotifyFn;
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
   * Host namespace preflight result (the unprivileged-userns +
   * `--unshare-net` probe, run once at boot). Fed to the SHIPPED degradeAutonomy
   * via emitAutonomyBootLog — downshift to `assistant` + a doctor WARN when the
   * host cannot build the jail (never a silent unjailed path). On non-Linux the
   * probe honestly returns false. This layer only PRODUCES the boolean; the
   * downshift stays in the shipped core fn.
   */
  namespacePreflightOk: boolean;
  /**
   * The `resolveRootRunId(agentId, sessionKey)` resolver built
   * over the populated holder + the authenticated principal index. `undefined` when no
   * autonomy agent (no cap layer). daemon.ts ALSO builds an equivalent resolver
   * early (over the SAME holder + index) for setupAgents, which runs before this
   * call — this returned one is the canonical resolver for any later consumer + the
   * boot-test seam.
   */
  resolveRootRunId?: (agentId: string, sessionKey: SessionKey) => string;
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
 * Construct the daemon-side `tool.invoke` executor from the shipped
 * cores + the workspace resolver + the ResultRef store. Returns
 * `undefined` when the activation inputs (skillsLogger + workspaceDirs +
 * defaultWorkspaceDir) are not all supplied (the boot-gate unit tests) — the
 * endpoint then has NO executor and an executor-route call throws a clear wiring
 * error (never a silent no-op).
 *
 * The `materialize` writer bridges the executor's `(payload, toolName, lease)`
 * call to the store's `(payload, toolName, ctx)`: the lease's `agentId` resolves
 * the offloading agent's workspace, so an over-threshold daemon-side return
 * (e.g. a large `web_fetch`) is written to THAT agent's `results/` and the jailed
 * script slices it in-jail via `jq`/`read` over the ref. A per-call
 * `runId` scopes the on-disk basename; the orchestrate runner's `gcRun`/
 * `cleanupRun` reaps the agent's `results/` on its run end.
 */
function buildToolInvokeExecutor(
  deps: CapabilityLayerDeps,
  resultRefStore: ResultRefStore,
  boundedAutonomy: BoundedAutonomy,
): ExecuteToolInvoke | undefined {
  const { skillsLogger, workspaceDirs, defaultWorkspaceDir, daemonLogger } = deps;
  if (!skillsLogger || !workspaceDirs || defaultWorkspaceDir === undefined) return undefined;
  const now = deps.clock.now;
  const resolveWorkspace = (agentId: string): string =>
    workspaceDirs.get(agentId) ?? defaultWorkspaceDir;
  // The shipped read/grep/find/ls/jq + web_search cores (skills).
  // Built ONCE (the web-search cache is factory-shared).
  const cores = createOrchestrateExecutorCores({
    logger: skillsLogger,
    webSearchConfig: buildWebSearchConfig(deps.webSearchKeys),
  });
  return createToolInvokeExecutor({
    resolveWorkspace,
    fileExecutors: cores.fileExecutors,
    webSearch: cores.webSearch,
    // The real per-root meter for the FLAT web $ charge.
    // The cost-bearing web pair (web_fetch/web_search) charges against the tree
    // root's budget — estUsd:0 here (the executor does not price the fetch; the
    // limb that bites is the bridge's per-LLM-call reserve), but the
    // call IS metered (the meter increments / the wall-clock + token limbs still
    // gate it). A lease with no rootRunId (older/test wiring) skips the charge.
    budgetHook: (_estimate, lease) => {
      if (lease.rootRunId === undefined) return;
      boundedAutonomy.reserveBudget(lease.rootRunId, "_web", "_web", 0, 0);
    },
    // Over-threshold returns offload to the OFFLOADING agent's workspace
    // results/ — the lease (threaded by the executor) gives the agentId.
    materialize: async (payload, toolName, lease): Promise<ResultRef | undefined> => {
      const workspacePath = resolveWorkspace(lease.agentId);
      const runId = lease.checkpointId ?? lease.rootRunId ?? `tinvoke-${now().toString(36)}`;
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
    // The daemon-wide MCP manager (threaded from CapabilityLayerDeps via the
    // daemon.ts caller) — the executor's `case "mcp"` dispatches through its
    // `callTool` on the daemon's network (the jail stays `--unshare-net`).
    mcpClientManager: deps.mcpClientManager,
    // The layer-2 inbound MCP allowlist (232-02 `permitsMcpTool`), resolved PER
    // agentId from THAT agent's `autonomy.mcp` block (not a global — D3 per-agent).
    // Prototype-safe lookup: `agentId` crosses from the lease, so iterate own
    // entries rather than indexing the Record with it. Absent autonomy/mcp ⇒
    // `permitsMcpTool` never runs ⇒ deny by absence (the surface stays dark).
    mcpAllowlist: {
      permits: (agentId, server, tool): boolean => {
        const agentCfg = Object.entries(deps.agents).find(([id]) => id === agentId)?.[1];
        const mcpCfg = agentCfg?.autonomy?.mcp;
        return mcpCfg !== undefined && permitsMcpTool(mcpCfg, server, tool);
      },
    },
    // The write SURFACE gate (NG2): `orch:write` is a FLOOR cap (held by every
    // standard/unattended/max agent), and the typed write surface is now ON by
    // default (full capability out of the box) — resolved PER agentId as
    // `autonomy.write !== false` (prototype-safe own-entry lookup, mirroring
    // mcpAllowlist). Only an EXPLICIT `autonomy.write: false` denies the write
    // dispatch (read-only opt-out); absent/true ⇒ the surface is available. The
    // surface is gated here (not via the cap toggle) so it never unions orch:write
    // into a degraded/assistant posture — the deny-by-preflight floor stays zero-cap.
    writeSurfaceEnabled: (agentId): boolean => {
      const agentCfg = Object.entries(deps.agents).find(([id]) => id === agentId)?.[1];
      return agentCfg?.autonomy?.write !== false;
    },
    // The resume surface is disabled by default: checkpoint/
    // resume reuse the orch:write/orch:read FLOOR caps, so the cap is NOT the gate —
    // this predicate is (default-off `autonomy.durability.orchestrateResume`).
    // Resolved PER agentId from THAT agent's nested durability toggle
    // (prototype-safe own-entry lookup, EXACTLY mirroring writeSurfaceEnabled).
    // Absent/false ⇒ the executor denies BOTH arms even though the lease holds the
    // floor cap — deny-by-absence, fail-closed.
    orchestrateResumeEnabled: (agentId): boolean => {
      const agentCfg = Object.entries(deps.agents).find(([id]) => id === agentId)?.[1];
      return agentCfg?.autonomy?.durability?.orchestrateResume === true;
    },
    // The durable-run store — checkpoint stamps checkpointRef onto the run's row
    // (COALESCE-preserve; the store's upsertCheckpoint never writes outward_step) and
    // resume reads the last checkpointRef back. Absent ⇒ checkpoint/resume degrade.
    ...(deps.durableRuns ? { durableRuns: deps.durableRuns } : {}),
    durableBudgetState: (rootRunId) => boundedAutonomy.exportBudgetState(rootRunId),
    // The checkpoint materialize bridge uses a distinguished, longer-TTL
    // (CHECKPOINT_TTL_MS) kind:json ResultRef, keyed on lease.rootRunId so resume
    // finds it after a restart. The SAME per-file (8 MiB) + per-run aggregate caps
    // apply (the store enforces them regardless of TTL). A non-ResultRef return
    // (over-cap refuse / failed write) surfaces as undefined ⇒ the executor refuses
    // the checkpoint content-free.
    materializeCheckpoint: async (stateJson, lease): Promise<ResultRef | undefined> => {
      const workspacePath = resolveWorkspace(lease.agentId);
      const runId = lease.checkpointId ?? `checkpoint-${now().toString(36)}`;
      const result = await resultRefStore.materialize(stateJson, "orchestrate_checkpoint", {
        workspacePath,
        runId,
        nowMs: now(),
        ttlMs: CHECKPOINT_TTL_MS,
      });
      return result !== undefined && "ref" in result ? result : undefined;
    },
    // Load a checkpoint blob back for resume — a workspace-confined read of the
    // recorded ResultRef.ref. safePath refuses any escape; a missing/absent file
    // (expired / GC'd) degrades to undefined ⇒ resume returns null (never a throw).
    loadCheckpoint: async (ref, lease): Promise<string | undefined> => {
      const workspacePath = resolveWorkspace(lease.agentId);
      try {
        const abs = safePath(workspacePath, ref);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined to the agent's workspace; ref is a store-minted results/ path
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    },
    logger: daemonLogger,
  });
}

/**
 * Build the content-free replay recorder over a daemon-owned recording root and
 * the ResultRef store. The recorder is the sole writer of
 * `<dataDir>/replay-recordings/results/<run>/replay.jsonl`; it appends one
 * content-free `{seq, method, paramsDigest, resultDigest} → pointer` line per successful cap
 * dispatch, so a later deterministic replay has recorded results to serve
 * back. Recording is gated per-run on
 * `autonomy.durability.orchestrateResume` (default-off), so a wired-but-disabled
 * agent still records nothing.
 */
function buildReplayRecorder(
  deps: CapabilityLayerDeps,
  resultRefStore: ResultRefStore,
): ReplayRecorder {
  const { daemonLogger } = deps;
  const now = deps.clock.now;
  const recordingRootPath = safePath(deps.dataDir, "replay-recordings");
  const warnedAgents = new Set<string>();

  /** Resolve existing symlink aliases for the bind-vs-recording containment check. */
  const canonicalPath = (path: string): string => {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted configured workspace/data root used only for containment comparison.
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const canonicalRecordingRoot = safePath(canonicalPath(deps.dataDir), "replay-recordings");
  const isAtOrUnder = (candidate: string, parent: string): boolean => {
    const rel = relative(parent, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };

  return createReplayRecorder({
    // Default-OFF per-run gate: record ONLY when orchestrateResume is on for the
    // lease's agent (prototype-safe own-entry lookup, EXACTLY mirroring the
    // executor's orchestrateResumeEnabled predicate). Absent/false ⇒ a full no-op.
    isEnabled: (agentId): boolean => {
      const agentCfg = Object.entries(deps.agents).find(([id]) => id === agentId)?.[1];
      if (agentCfg?.autonomy?.durability?.orchestrateResume !== true) return false;
      const workspacePath = deps.workspaceDirs?.get(agentId) ?? deps.defaultWorkspaceDir;
      const canonicalWorkspace = workspacePath === undefined ? undefined : canonicalPath(workspacePath);
      const recordingWouldBeVisible = canonicalWorkspace === undefined ||
        isAtOrUnder(canonicalRecordingRoot, canonicalWorkspace) ||
        isAtOrUnder(canonicalWorkspace, canonicalRecordingRoot);
      if (!recordingWouldBeVisible) return true;
      if (!warnedAgents.has(agentId)) {
        warnedAgents.add(agentId);
        daemonLogger.warn(
          {
            agentId,
            errorKind: "precondition" as const,
            hint: "Set the agent workspacePath so it does not overlap the daemon replay-recordings directory",
          },
          "Replay recording disabled because the agent jail could access its evidence store",
        );
      }
      return false;
    },
    // This daemon-owned root is deliberately outside every agent workspace and is
    // never mounted into the jail, so live scripts cannot forge replay evidence.
    recordingRootPath,
    // Bind each recorded result to the ResultRef store under a fixed tool name so the
    // bytes live in daemon-owned run-isolated storage under the same caps. A ResultRef maps
    // to its pointer; an over-cap { error } / undefined passes through (honest-degrade).
    materialize: async (payload, ctx) => {
      const result = await resultRefStore.materialize(payload, "orchestrate_replay", {
        workspacePath: ctx.recordingRootPath,
        runId: ctx.runId,
        nowMs: ctx.nowMs,
        ...(ctx.ttlMs !== undefined ? { ttlMs: ctx.ttlMs } : {}),
      });
      return result !== undefined && "ref" in result ? { ref: result.ref } : result;
    },
    nowMs: now,
    // A checkpoint-length TTL so a resumable run stays replayable (mirrors the
    // checkpoint materialize's TTL).
    ttlMs: CHECKPOINT_TTL_MS,
    logger: daemonLogger,
  });
}

/**
 * Construct the daemon-wide capability layer (gated on an autonomy-bearing
 * profile, mirroring how the broker is gated on `executor.broker`), ACTIVATE it
 * (inject the executor + start the 0600 socket), AND run the
 * host namespace preflight once at boot. The cap handle is `undefined`
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

  // The rootRunId resolver over the late-bound holder
  // + the session→rootRunId index. Built whenever a holder is supplied (daemon.ts
  // shares the SAME holder + index it threads into setupAgents early) — the resolver
  // is a stable closure that reads `holder.current` at call time.
  const rootRunIdIndex = deps.rootRunIdIndex ?? new Map<string, string>();
  const resolveRootRunId = deps.boundedAutonomyHolder
    ? createRootRunIdResolver({ holder: deps.boundedAutonomyHolder, index: rootRunIdIndex })
    : undefined;

  // The first autonomy-bearing agent's resolved posture is the daemon-wide
  // bounded-autonomy config source (the bound mechanisms are a single daemon-wide
  // service keyed on rootRunId, mirroring the single daemon-wide LeaseManager —
  // not per-agent). `standard`'s nested bounds are the zero-config default.
  const autonomyBearingConfig = Object.values(agents)
    .map((a) => resolveAutonomy(a.autonomy))
    .find((r) => r.enabled);
  if (!autonomyBearingConfig) {
    return { capEndpointHandle: undefined, capEndpointStop: undefined, namespacePreflightOk };
  }

  // Use the daemon-supplied LeaseManager when provided
  // (built EARLY in daemon.ts so setupSchedulers' cron-fire mint shares the SAME
  // instance — schedulers run before this layer), else construct one here (the
  // boot-gate path / older callers). ONE daemon-wide LeaseManager either way.
  const leaseManagerDeps: LeaseManagerDeps = { clock };
  const leaseManager = deps.leaseManager ?? createLeaseManager(leaseManagerDeps);
  // Construct the daemon-wide BoundedAutonomy service alongside the
  // LeaseManager (the construct-and-inject precedent). The cronJobCount provider
  // (daemon.ts binds it to the per-agent CronScheduler.getJobs().length) is the
  // count source the cap endpoint reaches through `cronCount`.
  const boundedAutonomy = createBoundedAutonomy({
    clock,
    timers: deps.timers,
    leaseManager,
    config: autonomyBearingConfig,
    ...(deps.cronJobCount ? { cronJobCount: deps.cronJobCount } : {}),
    logger: daemonLogger,
    // The pre-trip budget signal: 80% of any per-root limb → the system health view
    // (health_signal row via the persistence wiring) BEFORE the abort wedges
    // the session. Counts + closed labels only. Absent container (boot-gate
    // unit tests) ⇒ no emit — the meter still enforces.
    ...(deps.container !== undefined
      ? {
          onLimbWarning: (w: { rootRunId: string; limb: string; spent: number; cap: number; unit: string }) =>
            deps.container!.eventBus.emitSafely("autonomy:budget_warning", {
              rootRunId: w.rootRunId,
              limb: w.limb,
              spent: w.spent,
              cap: w.cap,
              unit: w.unit,
              fraction: w.cap > 0 ? Math.min(1, w.spent / w.cap) : 1,
              timestamp: clock.now(),
            }),
        }
      : {}),
  });
  // The daemon-wide denial breaker, keyed per
  // rootRunId. denialBreakerN is sourced from the resolved autonomy-bearing config
  // (NOT a non-existent `agents[defaultAgentId]` lookup; this file has no
  // defaultAgentId local). A single daemon-wide breaker is acceptable: it keys
  // per-rootRunId, mirroring the single daemon-wide LeaseManager + BoundedAutonomy.
  const denialBreaker = createDenialBreaker({
    denialBreakerN: autonomyBearingConfig.denialBreakerN,
    logger: daemonLogger,
  });
  // The daemon-wide evicted-rootRunId set. The SAME
  // instance is read by the chokepoint (isEvicted → demote to "default") and
  // written by the autonomy.evict admin handler (mark) — wired via the dispatch
  // deps spread, activating the conditionally-registered evict handler.
  const evictRegistry = createEvictRegistry({ logger: daemonLogger });
  // The content-free escalate NotifyFn. A synchronous
  // WARN (ids/enums/hint only, NEVER a message body) — mirrors the durable-resume
  // notify (setup-durable-resume.ts). The chokepoint fires it fire-and-forget (the
  // deny still re-throws immediately so the run never hangs). No ApprovalGate is in
  // scope at this boot seam, so the WARN + the deny's existing audit emit together
  // meet the out-of-band + auditable bar.
  const escalate: NotifyFn = (opts) =>
    daemonLogger.warn(
      { kind: opts.kind, rootRunId: opts.rootRunId, hint: opts.hint, errorKind: "internal" as const },
      `Autonomy escalation: ${opts.reason}`,
    );
  // POPULATE the late-bound budget holder with the
  // narrow budget port now that the service exists — the seam the bridge reads
  // (the bridge + schedulers were built BEFORE this layer; they hold the holder
  // and read `current` at fire time). reserveBudget/registerRoot are bound to the
  // composite (`this`-free arrow wrappers preserve the closure).
  if (deps.boundedAutonomyHolder) {
    deps.boundedAutonomyHolder.current = {
      reserveBudget: (rootRunId, provider, model, estUsd, estTokens) =>
        boundedAutonomy.reserveBudget(rootRunId, provider, model, estUsd, estTokens),
      registerRoot: (rootRunId, leaseId, parentLeaseId) =>
        boundedAutonomy.registerRoot(rootRunId, leaseId, parentLeaseId),
      // The bridge calls this once per turn to re-anchor an interactive
      // session root's wall-clock + token limbs (a session root acquires no spawn
      // slot, so it would otherwise accumulate across the whole conversation and
      // falsely abort turns after wallClockMs). A no-op when a live spawn shares the
      // root. MUST be wired here or the bridge's `?.evictRootIfIdle` silently no-ops.
      evictRootIfIdle: (rootRunId) => boundedAutonomy.evictRootIfIdle(rootRunId),
    };
  }
  // The daemon-wide OutputGuard the mint registers each bearer in (Pitfall 1).
  // setup-tools reads it off the handle for the CapabilityMintDeps.
  const outputGuard = createOutputGuard();
  // The ResultRef store the executor offloads over-threshold returns to.
  const resultRefStore = createResultRefStore({ logger: deps.skillsLogger ?? daemonLogger });
  // The cap socket path lives under the data dir, mirroring broker.sock's
  // ephemeral lifecycle. The orchestrate runner binds it per jail; the daemon-
  // wide endpoint listens on it once (activated below).
  // ACTIVATE the cap layer. A cap-socket setup failure (an
  // unusable dataDir, or the unix socket cannot bind) must NOT crash the daemon
  // boot — autonomy is an add-on, so it degrades HONESTLY (no cap layer + a loud
  // WARN; the absent handle downshifts the surface) while the daemon keeps serving
  // channels. The safe direction is LESS capability, never a half-built endpoint.
  try {
    const capSocketPath = safePath(dataDir, "cap.sock");
    // Step 1: construct the daemon-side tool.invoke executor and inject it into the
    // endpoint — mirroring how the LeaseManager is constructed-and-injected here
    // (NOT a mutable setter on a security boundary). The bounded-autonomy service
    // backs the executor's real budgetHook (the flat web charge).
    const toolInvokeExecutor = buildToolInvokeExecutor(deps, resultRefStore, boundedAutonomy);
    // Step 1b: build the content-free replay recorder over the SAME workspace
    // resolver + ResultRef store, and inject it below — the SOLE writer of
    // results/replay.jsonl. Without this, recordReplay short-circuits on every
    // dispatch and a later deterministic replay diverges on the first cap call.
    const replayRecorder = buildReplayRecorder(deps, resultRefStore);
    // Thread the daemon logger so the socket boundary is observable: a
    // post-listen server error and per-connection errors are logged with the
    // canonical err/errorKind/hint rather than silently swallowed. The
    // boundedAutonomy service drives the endpoint's rate-limit + cron self-ownership
    // and the resolved autonomy config supplies cronSelfMax.
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall,
      logger: daemonLogger,
      toolInvokeExecutor,
      boundedAutonomy,
      autonomyConfig: autonomyBearingConfig,
      // The socket per-cap audit's bus + tenant scope. Absent in
      // the boot-gate tests ⇒ socket audit is a no-op (honest degrade).
      ...(deps.container ? { container: deps.container } : {}),
      // The durable store — the jail leg allocates a monotonic
      // _outwardStepIndex for an outward message method. Absent ⇒ pass-through.
      ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
      // The content-free replay recorder. Absent (boot-gate tests /
      // no workspace) ⇒ recordReplay is a no-op, byte-identical to today.
      replayRecorder,
    });
    // Step 2: ACTIVATE — start the daemon-wide 0600 socket ONCE. Construction
    // leaves it DORMANT (no startSocket; active:false). Now the cap surface is LIVE:
    // a jailed orchestrate child reaches the endpoint over the bound socket.
    await endpoint.startSocket(capSocketPath);
    daemonLogger.info(
      { submodule: "capability-endpoint", capSocketPath, active: true },
      "Capability lease layer ACTIVE (0600 socket listening; executor wired; lease minted per spawn)",
    );
    return {
      // The never-hang control plane (denialBreaker/evictRegistry/
      // escalate) rides the handle so daemon.ts threads it onto the dispatch deps.
      capEndpointHandle: {
        leaseManager,
        endpoint,
        boundedAutonomy,
        capSocketPath,
        outputGuard,
        denialBreaker,
        evictRegistry,
        escalate,
      },
      // The cap-socket teardown ALSO tears down the bounded-autonomy rate-limiter
      // timers (clean shutdown — the TTL-evict timers).
      capEndpointStop: async () => {
        await endpoint.stopSocket();
        boundedAutonomy.destroy();
      },
      namespacePreflightOk,
      ...(resolveRootRunId ? { resolveRootRunId } : {}),
    };
  } catch (err) {
    // The socket failed to bind — tear down the bounded-autonomy timers we just
    // constructed so the degrade path leaks no scheduled timer.
    boundedAutonomy.destroy();
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
