// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent runner module.
 * Manages async sub-agent spawning with:
 * - Non-blocking spawn returning runId immediately
 * - Allowlist enforcement for agent IDs
 * - Auto-archive of completed sessions after retention period
 * - Stats line in announcements (runtime, tokens, cost, session key)
 * - Graceful shutdown with active run draining
 * Extracted from daemon.ts inline session.spawn handler for testability.
 * @module
 */

import {
  formatSessionKey,
  parseFormattedSessionKey,
  runWithContext,
  type SessionKey,
  type TypedEventBus,
  type AgentToAgentConfig,
  type DeliveryOrigin,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
  type DurableRunPort,
  type AgentCapability,
  SUB_AGENT_TOOL_DENYLIST,
  toolReachableGroups,
  RequiredToolsUnreachableError,
  type UnreachableToolEntry,
  type SubAgentSpawnRejectedEvent,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { sanitizeAssistantResponse } from "../provider/response/sanitize-pipeline.js";
import { randomUUID } from "node:crypto";
import type { AnnouncementBatcher, AnnouncementDeadLetterQueue } from "./announcement-ports.js";
import type { DeliveryDedup } from "./announce-key.js";
import {
  classifyAbortReason,
  buildAnnouncementMessage,
  deliverAnnouncement,
  deliverFailureNotification,
  validateOutputs,
  sweepResultFiles,
  persistFailureRecord,
  type AbortClassification,
  type ValidationResult,
} from "./sub-agent-result-processor.js";
import { comparePosture, type SandboxPosture } from "./sandbox-posture.js";
import { steerRun as steerRunHelper, type SteerRunDeps, type SteerableRun } from "./steer-run.js";
import type { RunHandle } from "../executor/active-run-registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for announceToParent calls at all call sites (300 seconds / 5 minutes).
 *  Parent agents may call slow tools (image generation at 120s, web search, etc.)
 *  in response to announcements. 30s caused premature fallback + duplicate delivery. */
export const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;

/**
 * Build the composite-key triple from a SubAgentRun for resolver lookups.
 * MUST compose (via BackgroundSessionResolver.formatComposite) to the EXACT key
 * the executor registers the live handle under (pi-executor.ts:1152-1156):
 *
 *   formatSessionKey({ tenantId: agentId ?? "default",
 *                      channelId: `${originChannelType}:${msg.channelId}`,
 *                      userId: msg.channelId })
 *
 * where for a sub-agent run `originChannelType = deliveryOrigin?.channelType ??
 * channelType ?? "gateway"` and `msg.channelId = subSessionKey.channelId` (the
 * executor ALWAYS receives subSessionKey -- line 1289). So:
 *   - agentId    -> run.agentId
 *   - channelType-> run.announceChannelType ?? "gateway"  (announce runs
 *                   propagate announceChannelType into ALS as deliveryOrigin
 *                   -- line 1267/1286; no-announce runs default to "gateway")
 *   - channelId  -> parseFormattedSessionKey(run.sessionKey)?.channelId
 *                   ?? run.sessionKey  (the PARSED sub-session channelId, NOT
 *                   run.announceChannelId -- the executor keys on
 *                   subSessionKey.channelId, never the announce channelId; the
 *                   last-resort raw key keeps the resolver's empty-field guard
 *                   from tripping)
 *
 * WR-01 (175-REVIEW.md): the prior formula used "sub-agent" for channelType and
 * `run.announceChannelId ?? parsed?.channelId` for channelId, which DIVERGED
 * from the registration key. For steer (steer-run.ts) that miss was FATAL
 * (the inject's whole purpose is to reach the live handle); for the kill /
 * ghost-sweep / watchdog aborts below it was a silent best-effort no-op
 * (latent). Aligning the formula fixes steer AND makes those aborts actually
 * reach the handle. Keep this BYTE-IDENTICAL to steer-run.ts:deriveCompositeForRun
 * -- the 175-00 spike fails loudly on drift.
 */
function deriveCompositeForRun(run: SubAgentRun): {
  agentId: string;
  channelType: string;
  channelId: string;
} {
  const parsed = parseFormattedSessionKey(run.sessionKey);
  return {
    agentId: run.agentId,
    channelType: run.announceChannelType ?? "gateway",
    channelId: parsed?.channelId ?? run.sessionKey,
  };
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

// @optional-field-count: 13 — SubAgentRun is the per-run flight-record state; its
// optionals are independent, lifecycle-populated facets of ONE run (result/error
// set at completion; requesterOrigin/announce* at spawn; graphId/nodeId/abortGroup
// for graph routing; parentLeaseId/ceilingSlotAcquired for the Phase-213 ceiling/
// cascade). They are not a cluster-split candidate — every field describes the
// SAME run and is read by the runner's own lifecycle, not handed to a sub-service.
export interface SubAgentRun {
  runId: string;
  status: "running" | "completed" | "failed" | "queued";
  agentId: string;
  task: string;
  sessionKey: string;
  startedAt: number;
  completedAt?: number;
  /** Timestamp when this run was placed in the spawn queue. */
  queuedAt?: number;
  result?: {
    response: string;
    tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number };
    cost: { total: number; cacheSaved?: number };
    finishReason: string;
    stepsExecuted: number;
  };
  error?: string;
  /** Originating channel context from the spawning request */
  requesterOrigin?: DeliveryOrigin;
  /** Spawn depth in the chain (0 = first child, 1 = grandchild, etc.). */
  depth: number;
  /** Tree-stable run identity (CEIL-01/REVOKE-03). Every run belongs to exactly one
   *  spawn tree; the root mints this id and descendants inherit it. The unified
   *  semaphore keys on it and killByRootRun enumerates a whole tree by it. */
  rootRunId: string;
  /** Lease that authorized this spawn (REVOKE-02 cascade correlation); undefined for the root. */
  parentLeaseId?: string;
  /** Session key of the caller agent, used for active children counting. */
  callerSessionKey?: string;
  /** Announce channel type for failure notifications (stored at spawn for ghost sweep access). */
  announceChannelType?: string;
  /** Announce channel ID for failure notifications (stored at spawn for ghost sweep access). */
  announceChannelId?: string;
  /** Graph ID for kill cascade routing. */
  graphId?: string;
  /** Graph node ID for kill cascade routing. */
  nodeId?: string;
  /** Abort/cleanup group key. Graph spawns: `graph:${graphId}`. Regular: callerSessionKey. */
  abortGroup?: string;
  /** Phase 213 CR-02: true when this run reserved a tree-wide ceiling slot
   *  (`checkSpawnCeiling` returned ok). The slot is released EXACTLY ONCE on the
   *  run's first terminal transition (`releaseCeilingSlotOnce` clears the flag),
   *  so a kill→later-settle or a double-fired completion never double-releases
   *  (which would steal a sibling's slot under a shared root). A promoted queued
   *  run never sets this (it never acquired) so it never releases. */
  ceilingSlotAcquired?: boolean;
}

/** Minimal pino-compatible logger for sub-agent runner diagnostics. */
export interface SubAgentRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface SubAgentRunnerDeps {
  sessionStore: {
    save(key: SessionKey, messages: unknown[], metadata: Record<string, unknown>): void;
    delete(key: SessionKey): void;
  };
  executeAgent: (
    agentId: string,
    sessionKey: SessionKey,
    task: string,
    maxSteps?: number,
    callerAgentId?: string,
    overrides?: { graphId?: string; nodeId?: string; reuseSessionKey?: string; graphNodeDepth?: number },
    /** Per-spawn token budget — becomes the child's BudgetGuard per-execution cap (BUDGET-01). */
    tokenBudget?: number,
  ) => Promise<{
    response: string;
    tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number };
    cost: { total: number; cacheSaved?: number };
    finishReason: string;
    stepsExecuted: number;
    toolCallHistory?: string[];
    errorContext?: {
      errorType: string;
      retryable: boolean;
      originalError?: string;
      failingTool?: string;
    };
  }>;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { threadId?: string }) => Promise<boolean>;
  /** Optional callback to inject announcement into parent session for agent rewriting.
   *  When provided, used instead of sendToChannel for completion announcements.
   *  Falls back to sendToChannel if not provided or if call fails. */
  announceToParent?: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ) => Promise<void>;
  eventBus: TypedEventBus;
  config: AgentToAgentConfig;
  tenantId: string;
  /**
   * Resolve an agent's sandbox posture from its per-agent skills config
   * (SANDBOX-01) for the fail-closed no-downgrade gate (SANDBOX-02). Injected by
   * the daemon wiring (which holds `container.config.agents`); the runner stays a
   * `@comis/agent` leaf with no full-config import — it never reaches
   * `config.agents[...]` itself. The two-arg form mirrors the daemon's
   * `effectiveAgentId` inherit-caller fallback: a child with no dedicated config
   * inherits the caller's posture, so the gate compares the posture the child
   * will actually run under. **Absent ⇒ the gate is inert** (no posture to
   * compare; older test wiring). The daemon ALWAYS wires it in production.
   */
  resolvePosture?: (agentId: string, callerAgentId?: string) => SandboxPosture;
  /**
   * Tree-wide spawn ceiling consult (CEIL-01). Called at the spawn chokepoint —
   * the SINGLE convergence point `session.spawn`, `graph.*`, AND the in-process
   * agent loop ALL hit (they all call `runner.spawn`) — so a `for(;;) spawn()`
   * fork-bomb is bounded tree-wide where the per-caller depth/fanout gates cannot
   * (RESEARCH anti-pattern: "a semaphore that only sees the cap-endpoint path
   * misses the in-process path"). Receives the run's tree-stable `rootRunId`, the
   * `depth`, and the active-children `fanout`. On `{ ok:false }` the spawn is
   * rejected EXACTLY like the depth/children gates (event + WARN + no run/session
   * created). **Absent ⇒ inert** (non-daemon constructions / older test wiring);
   * the daemon wires it to `boundedAutonomy.tryAcquireSpawn`.
   */
  checkSpawnCeiling?: (
    rootRunId: string,
    depth: number,
    fanout: number,
  ) => { ok: true } | { ok: false; reason: string };
  /**
   * Symmetric release of a slot reserved by {@link checkSpawnCeiling} (Phase 213
   * CR-02). Called 1:1 with every successful acquire on EVERY terminal transition
   * of the run that reserved it — the run-completion `finally` and the queue-
   * timeout fail path. Without it the per-`rootRunId` `active` counter only ever
   * increments and a tree is bricked after `maxConcurrentSelfAgents` spawns
   * (a permanent spawn brick, masked pre-CR-01 only because roots never shared).
   * Idempotent at the sink (the semaphore floors `active` at 0). **Absent ⇒
   * inert** (older/non-daemon wiring); the daemon wires it to
   * `boundedAutonomy.releaseSpawn`.
   */
  releaseSpawnCeiling?: (rootRunId: string) => void;
  /** Optional structured logger for lifecycle diagnostics. */
  logger?: SubAgentRunnerLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: {
      id: string;
      tenantId: string;
      agentId: string;
      userId: string;
      content: string;
      trustLevel: "system" | "learned" | "external";
      source: { who: string; channel?: string; sessionKey?: string };
      tags: string[];
      createdAt: number;
      sourceType?: "system" | "conversation" | "tool" | "web" | "api" | "unknown";
    }): Promise<{ ok: boolean }>;
  };
  /** Optional announcement batcher for coalescing near-simultaneous completions. */
  batcher?: AnnouncementBatcher;
  /** Optional dead-letter queue for persisting failed announcement deliveries */
  deadLetterQueue?: AnnouncementDeadLetterQueue;
  /**
   * WR-02: shared, bounded delivered-key store, forwarded to deliverAnnouncement
   * + deliverFailureNotification so the failure-path dedup is correct whether or
   * not a batcher is wired. The daemon injects the SAME instance the batcher uses.
   */
  deliveryDedup?: DeliveryDedup;
  /** Optional active run registry for aborting in-flight SDK sessions on kill. */
  activeRunRegistry?: {
    get(sessionKey: string): { abort(): Promise<void> } | undefined;
  };
  /**
   * Optional composite-key resolver. When provided, supersedes
   * `activeRunRegistry.get(sessionKey)` for production aborts: the resolver
   * accepts `{ agentId, channelType, channelId }` so multi-agent /
   * multi-channel sessions are distinguishable. Locally re-declared to a
   * structural minimum (avoids a daemon -> agent type-only import cycle in
   * this leaf module). The daemon wires it via
   * `createBackgroundSessionResolver({activeRunRegistry})`.
   */
  sessionResolver?: {
    resolveActiveSession(key: { agentId: string; channelType: string; channelId: string }): { abort(): Promise<void> } | undefined;
  };
  /** Optional result condenser for compressing subagent output */
  resultCondenser?: {
    condense(params: {
      fullResult: string;
      task: string;
      runId: string;
      sessionKey: string;
      agentId: string;
      model?: unknown;
      apiKey?: string;
      // Enriched metadata for offline analysis (Findings 17, 20)
      parentTraceId?: string;
      graphId?: string;
      nodeId?: string;
      activeToolNames?: string[];
      deferredCount?: number;
      toolCallHistory?: string[];
      guidesDelivered?: string[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheSavedUsd?: number; cacheEffectiveness?: number };
      // Error context for non-successful executions
      errorContext?: { errorType: string; retryable: boolean; originalError?: string; failingTool?: string };
    }): Promise<{
      level: 1 | 2 | 3;
      result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[]; actionableItems?: string[]; errors?: string[]; keyData?: Record<string, unknown>; confidence?: number };
      originalTokens: number;
      condensedTokens: number;
      compressionRatio: number;
      diskPath: string;
    }>;
  };
  /** Model object for result condensation (resolved by daemon wiring). */
  condenserModel?: unknown;
  /** API key for result condensation model. */
  condenserApiKey?: string;
  /** Optional narrative caster for tagging condensed results */
  narrativeCaster?: {
    cast(params: {
      condensedResult: {
        level: 1 | 2 | 3;
        result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[]; actionableItems?: string[]; errors?: string[]; keyData?: Record<string, unknown>; confidence?: number };
        originalTokens: number;
        condensedTokens: number;
        compressionRatio: number;
        diskPath: string;
      };
      task: string;
      label?: string;
      runtimeMs: number;
      stepsExecuted: number;
      tokensUsed: number;
      cost: number;
      sessionKey: string;
    }): string;
  };
  /** Base data directory for locating subagent-results (e.g., ~/.comis). Optional — caller may omit. */
  dataDir?: string;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. Sweep-interval + watchdog setTimeout + shutdown-timeout setTimeout. */
  timers: TimerPort;
  /**
   * Phase 216 (DUR-01 / HB-01): the durable-run checkpoint store. OPTIONAL — when
   * present (the daemon wires it ONLY when `autonomy.durability.enabled` AND an
   * autonomy agent is configured), `spawn()` writes a per-root checkpoint at the
   * spawn boundary + refreshes a keep-alive heartbeat on the injected timer, and
   * marks the run completed on terminal settle. **Absent ⇒ inert** (no checkpoint,
   * no heartbeat — the default, byte-identical path). A store error is WARN-logged
   * (hint + errorKind) but NEVER crashes the run (durability is a recovery aid,
   * not a correctness gate on the live run).
   */
  durableRuns?: DurableRunPort;
  /**
   * Phase 216 (HB-01): the keep-alive cadence + lapsed threshold (from
   * `autonomy.durability`). `keepAliveMs` drives the heartbeat-refresh interval
   * (independent of step/spawn completion so a long-running child never looks
   * stale — Pitfall 4). Optional alongside {@link durableRuns}; defaults applied
   * when absent.
   */
  durability?: { keepAliveMs: number; staleHeartbeatMs: number };
  /**
   * Phase 216 (DUR-01): resolve the durable-checkpoint facts for a tree root —
   * the ATTENUATED caps the run was minted with (the lease's caps), the correlated
   * `leaseIds` (BoundedAutonomy.leaseIdsForRoot), and the consumed budget (the
   * budget `snapshot`). Injected by the daemon wiring (which holds the
   * LeaseManager + BoundedAutonomy); the runner stays a `@comis/agent` leaf with
   * no daemon import. **Absent ⇒ the checkpoint records empty caps/leaseIds +
   * zero budget** (still a valid, resumable record — a resume re-mints the
   * persisted caps verbatim, so an empty set is a safe degrade, never an
   * over-grant).
   */
  durableRunFacts?: (
    rootRunId: string,
    agentId: string,
  ) => { caps: readonly AgentCapability[]; leaseIds: readonly string[]; budgetConsumed: number } | undefined;
  /** Optional lifecycle hooks for spawn preparation and completion */
  lifecycleHooks?: {
    prepareSpawn(params: {
      runId: string;
      parentSessionKey: string;
      childSessionKey: string;
      agentId: string;
      task: string;
      depth: number;
      maxDepth: number;
    }): Promise<{ rollback: () => Promise<void> } | undefined>;
    onEnded(params: {
      runId: string;
      agentId: string;
      parentSessionKey: string;
      childSessionKey: string;
      endReason: "completed" | "failed" | "killed" | "watchdog_timeout" | "ghost_sweep";
      condensedResult?: { level: 1 | 2 | 3; condensedTokens?: number };
      runtimeMs: number;
      tokensUsed: number;
      cost: number;
    }): Promise<void>;
  };
}

export interface SpawnParams {
  task: string;
  agentId: string;
  callerSessionKey?: string;
  callerAgentId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  model?: string;
  max_steps?: number;
  /** Per-spawn token budget — becomes the child's BudgetGuard per-execution cap (BUDGET-01).
   *  Threaded SpawnParams -> ExecuteSubAgentFn -> ExecutionOverrides -> resetExecution(cap).
   *  When absent, the child enforces config.perExecution exactly as today. */
  tokenBudget?: number;
  expected_outputs?: string[];
  /** Originating channel context for default announcement routing */
  requesterOrigin?: DeliveryOrigin;
  /** Current spawn depth in the chain (0 = top-level agent spawning its first child). */
  depth?: number;
  /** Maximum allowed spawn depth from config. */
  maxDepth?: number;
  /** Tree-stable run identity (CEIL-01/REVOKE-03). Established ONCE at the root spawn
   *  (depth 0) and propagated to every descendant so the tree-wide semaphore (Plan 04)
   *  and kill-by-root primitive see one id per spawn tree. When absent, spawn() mints
   *  one (the root); a child MUST pass its parent's id down — a fresh id per child would
   *  escape the parent's ceiling (RESEARCH Pitfall 1 — the silent under-count). */
  rootRunId?: string;
  /** Lease that authorized this spawn (REVOKE-02 cascade correlation). Recorded on the
   *  run so a future revoke-by-root can map runs to leases; omitted for the root. */
  parentLeaseId?: string;
  /**
   * Phase 216 (MED-4 cronOrigin): the REAL cron signal carried from the cron-fire
   * turn metadata (`metadata.isCronAgentTurn` — see prompt-assembly.ts:676). When
   * a sub-agent is spawned during a cron-fired turn, the caller threads this from
   * the turn metadata so the durable checkpoint records a non-null `cronOrigin`
   * (the jobId). A non-cron spawn leaves it false → cronOrigin = null. There is NO
   * `cronOrigin` string at HEAD — the runner DERIVES it from this flag + jobId.
   */
  isCronAgentTurn?: boolean;
  /** Phase 216 (MED-4): the firing cron job's id — the cronOrigin value when `isCronAgentTurn`. */
  jobId?: string;
  /** Phase 216 (MED-4): the firing cron job's name — the cronOrigin fallback when jobId is absent. */
  jobName?: string;
  /**
   * Phase 216 (DUR-01): the ATTENUATED caps this run was minted with (the lease's
   * caps). Threaded from the spawn caller (the cap layer / cron-fire mint) so the
   * durable checkpoint records the exact caps a resume must re-mint VERBATIM
   * (never re-attenuated). When absent, `durableRunFacts` (deps) is consulted; if
   * both are absent the checkpoint records an empty set (a safe degrade).
   */
  caps?: readonly AgentCapability[];
  /** Caller type for GraphCoordinator bypass of children limit. */
  callerType?: "agent" | "graph";
  /** File paths for the sub-agent to reference. */
  artifactRefs?: string[];
  /** Objective statement that survives context compaction. */
  objective?: string;
  /** Domain knowledge entries for the sub-agent. */
  domainKnowledge?: string[];
  /** Tool group names for sub-agent tool filtering. */
  toolGroups?: string[];
  /** Inherited reply language (DET-02 tag) from the parent ALS; persisted into child
   *  session metadata as `language` so it survives the spawn round-trip (GEN-03). */
  resolvedLanguage?: string;
  /** Optional list of tool names that must be reachable by the sub-agent.
   *  Validated at spawn time against the daemon-provided reachableToolNames set.
   *  If any tool is unreachable, spawn() throws RequiredToolsUnreachableError
   *  before creating the runId or session.
   *  On both the immediate and queued spawn paths, the gate fires before any runId is created. */
  requiredTools?: string[];
  /**
   * Effective reachable tool set computed by the daemon caller (spawn-gate parity).
   *
   * The daemon's session-mutate.ts computes this set by expanding the effective tool groups
   * (config default already applied) through both SUB_AGENT_TOOL_PROFILES and TOOL_GROUPS —
   * the same logic as setup-tools.ts:588-607. Passing this set here gives the spawn gate
   * true parity with the runtime ceiling, avoiding both:
   *   (a) false-passes: a tool that looks valid but is stripped at runtime
   *   (b) false-denies: a tool reachable via TOOL_GROUPS but not in profiles
   *
   * When absent (e.g. older callers), the gate fails-open to runtime enforcement.
   * The daemon path MUST provide this field for gate correctness.
   */
  reachableToolNames?: ReadonlySet<string>;
  /** Parent context inclusion mode. */
  includeParentHistory?: "none" | "summary";
  /** Shared directory path for graph pipeline inter-node data sharing */
  graphSharedDir?: string;
  /** Graph-level trace ID for correlated logging across all nodes in a graph run. */
  graphTraceId?: string;
  /** Graph ID for sub-agent log correlation and result metadata */
  graphId?: string;
  /** Graph node ID for sub-agent log correlation and result metadata */
  nodeId?: string;
  /** Discovered deferred tool names inherited from parent agent. */
  discoveredDeferredTools?: string[];
  /** Sorted tool name superset for graph sub-agent cache prefix sharing. */
  graphToolNames?: string[];
  /** Reuse an existing session key for multi-round driver spawns. */
  reuseSessionKey?: string;
  /** Graph node depth: 0 = root node (dependsOn=[]), 1+ = downstream.
   *  Used for depth-aware cache retention in setup-cross-session. */
  graphNodeDepth?: number;
  /** True when this graph node is a leaf (no other node depends on it).
   *  Leaf nodes use "short" (5m) cache retention instead of the 1h default
   *  because their cache prefix has no downstream consumers. */
  isLeafNode?: boolean;
}

// ---------------------------------------------------------------------------
// Spawn-time required_tools gate helpers
// ---------------------------------------------------------------------------

/**
 * Classify a single required tool as "outside_profile" or "denylist".
 * Uses toolReachableGroups from @comis/core — no @comis/skills import needed.
 */
function classifyRequiredTool(
  toolName: string,
  activeGroups: string[],
): UnreachableToolEntry {
  if (SUB_AGENT_TOOL_DENYLIST.has(toolName)) {
    return {
      toolName,
      reason: "denylist",
      hint: `Tool '${toolName}' is denied to ALL sub-agents — the parent must perform this step.`,
    };
  }
  const broader = toolReachableGroups(toolName).filter((p) => !activeGroups.includes(p));
  // When no profile contains the tool, suggest only 'full' — 'supervisor' does not
  // contain generic tools like web_fetch/browser/sessions_spawn, so it would fail again.
  const suggestion = broader.length > 0 ? broader.join("' | '") : "full";
  return {
    toolName,
    reason: "outside_profile",
    hint: `Tool '${toolName}' is outside this sub-agent's profile. Re-spawn with tool_groups:['${suggestion}'].`,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubAgentRunner(deps: SubAgentRunnerDeps) {
  const { clock, timers } = deps;
  const runs = new Map<string, SubAgentRun>();
  const activePromises = new Set<Promise<void>>();

  // -------------------------------------------------------------------------
  // Phase 216 (DUR-01 / HB-01): durable checkpoint + keep-alive heartbeat.
  // Inert when `deps.durableRuns` is absent (the default install). The
  // heartbeat timer is tracked per runId so the terminal `finally` clears it
  // (no leaked interval). Store calls are best-effort — a write error is
  // WARN-logged but NEVER crashes the live run (durability is a recovery aid).
  // -------------------------------------------------------------------------
  const heartbeatTimers = new Map<string, TimerHandle>();
  const DURABLE_KEEPALIVE_MS = deps.durability?.keepAliveMs ?? 30_000;

  /**
   * Derive the MED-4 `cronOrigin` from the REAL cron signal threaded onto the
   * spawn params (`isCronAgentTurn` + `jobId`/`jobName`). A cron-fired turn's
   * sub-agent records the firing job's id; a non-cron spawn records null. There
   * is NO `cronOrigin` string at HEAD — this IS the derivation.
   */
  function deriveCronOrigin(params: SpawnParams): string | null {
    return params.isCronAgentTurn === true ? (params.jobId ?? params.jobName ?? "cron") : null;
  }

  /**
   * Write the initial durable checkpoint at the SPAWN BOUNDARY (DUR-01) and start
   * the keep-alive heartbeat (HB-01). `stepIndex` starts at -1 (the never-sent
   * sentinel — the outward counter is owned by allocateOutwardStep, NOT here).
   * Inert when no store is wired. Never throws.
   */
  function startDurableCheckpoint(run: SubAgentRun, params: SpawnParams): void {
    const store = deps.durableRuns;
    if (!store) return;
    const rootRunId = run.rootRunId;
    const facts = deps.durableRunFacts?.(rootRunId, params.agentId);
    // Caps: explicit spawn param wins (the lease's minted caps), else the
    // injected facts resolver, else an empty set (a safe degrade — a resume
    // re-mints the persisted caps VERBATIM, so empty is zero-authority, never
    // an over-grant).
    const caps = params.caps ?? facts?.caps ?? [];
    const leaseIds = facts?.leaseIds ?? (params.parentLeaseId ? [params.parentLeaseId] : []);
    const budgetConsumed = facts?.budgetConsumed ?? 0;
    const cronOrigin = deriveCronOrigin(params);
    void store
      .upsertCheckpoint({
        rootRunId,
        spawnTree: [rootRunId],
        // Copy into mutable arrays — DurableRunRecord's caps/leaseIds are mutable
        // (the Zod-inferred shape); the deps/params surfaces are readonly.
        caps: [...caps],
        leaseIds: [...leaseIds],
        budgetConsumed,
        cronOrigin,
        stepIndex: -1,
        status: "running",
        lastHeartbeatAt: clock.now(),
      })
      .then((r) => {
        if (!r.ok) {
          deps.logger?.warn(
            { rootRunId, err: r.error, hint: "durable checkpoint upsert failed — the run still proceeds; it will not be resumable after a crash", errorKind: "internal" as const },
            "Durable checkpoint: upsert failed (run continues)",
          );
        }
      })
      .catch((err: unknown) => {
        deps.logger?.warn(
          { rootRunId, err, hint: "durable checkpoint upsert threw — the run still proceeds", errorKind: "internal" as const },
          "Durable checkpoint: upsert threw (run continues)",
        );
      });

    // HB-01: a keep-alive that fires INDEPENDENT of step/spawn completion so a
    // long-running child never trips the watchdog's stale threshold (Pitfall 4).
    // One interval per run, cleared on terminal settle (no leaked timer).
    if (!heartbeatTimers.has(run.runId)) {
      const handle = timers.setInterval(() => {
        void store
          .touchHeartbeat(rootRunId, clock.now())
          .then((r) => {
            if (!r.ok) {
              deps.logger?.debug(
                { rootRunId, err: r.error, hint: "durable heartbeat touch failed; the watchdog may orphan-sweep this run if it persists", errorKind: "internal" as const },
                "Durable heartbeat: touch failed",
              );
            }
          })
          .catch(() => { /* best-effort heartbeat; never propagate */ });
      }, DURABLE_KEEPALIVE_MS);
      handle.unref();
      heartbeatTimers.set(run.runId, handle);
    }
  }

  /**
   * Terminal seam (DUR-01): mark the run completed + clear its keep-alive
   * heartbeat. Fires on EVERY terminal settle of a started run (completion,
   * failure, kill/ghost/watchdog — the underlying executeAgent promise still
   * settles), so the interval is reclaimed and the durable record stops being
   * resumable. Inert + idempotent when no store / no timer. Never throws.
   */
  function finishDurableCheckpoint(run: SubAgentRun): void {
    const handle = heartbeatTimers.get(run.runId);
    if (handle) {
      handle.cancel();
      heartbeatTimers.delete(run.runId);
    }
    const store = deps.durableRuns;
    if (!store) return;
    void store
      .markCompleted(run.rootRunId)
      .then((r) => {
        if (!r.ok) {
          deps.logger?.warn(
            { rootRunId: run.rootRunId, err: r.error, hint: "durable markCompleted failed — the watchdog will eventually orphan-sweep the stale record (no live impact)", errorKind: "internal" as const },
            "Durable checkpoint: markCompleted failed",
          );
        }
      })
      .catch(() => { /* best-effort terminal mark; never propagate */ });
  }

  // WR-02: make the fail-OPEN observable. The sandbox no-downgrade gate (below)
  // silently no-ops when `resolvePosture` is absent — a P0 security control that
  // does nothing. Production composition (setup-cross-session-runtime.ts) ALWAYS
  // injects the resolver (a daemon-wiring test pins this), but a future second
  // construction path could omit it and ship an inert gate. Emit a one-time
  // construction WARN so the fail-open surfaces in the logs rather than silently.
  if (deps.config.sandboxNoDowngrade !== false && !deps.resolvePosture) {
    deps.logger?.warn({
      hint:
        "sandboxNoDowngrade is on but no posture resolver was injected — the no-downgrade gate is INERT; " +
        "wire resolvePosture into createSubAgentRunner (see setup-cross-session-runtime.ts) or set security.agentToAgent.sandboxNoDowngrade:false",
      errorKind: "config" as const,
    }, "Sandbox no-downgrade gate is INERT: no posture resolver injected");
  }

  // ---------------------------------------------------------------------
  // In-flight spawn dedup:
  //   Maps `(callerSessionKey + agentId + task)` triples to in-flight runIds.
  //   Populated when a non-graph session-spawn starts (running OR queued)
  //   and removed at terminal status transitions. A spawn() call whose
  //   dedup key already maps to an in-flight run short-circuits and returns
  //   the existing runId AND records `lastDedupHit` for the calling RPC
  //   handler to surface `deduped: true, existingRunId, ageMs` to the LLM.
  // Skipped for:
  //   - top-level spawns (no callerSessionKey) — scoped dedup requires a
  //     known caller identity, otherwise CLI/scheduler spawns would collide.
  //   - graph-marked spawns (callerType === "graph") — graph coordinator
  //     owns its own dedup via `runIdToNode`; matching by task would break
  //     graph parallelism when two nodes coincidentally share task wording.
  // ---------------------------------------------------------------------
  const inFlightByDedupKey = new Map<string, string>();
  let lastDedupHit: { existingRunId: string; ageMs: number } | undefined;

  function computeDedupKey(
    callerSessionKey: string,
    task: string,
    agentId: string,
  ): string {
    // NUL byte separator: cannot appear in JSON-source session keys or
    // agent IDs and is vanishingly unlikely in task prose. The map is
    // in-process only and never serialized — collisions are not
    // attacker-controlled.
    return `${callerSessionKey}\x00${agentId}\x00${task}`;
  }

  function isDedupEligible(params: { callerSessionKey?: string; callerType?: string }): boolean {
    return params.callerSessionKey !== undefined && params.callerType !== "graph";
  }

  function removeDedupEntry(run: SubAgentRun): void {
    if (!run.callerSessionKey) return;
    // Graph-marked runs were never registered.
    if (run.graphId !== undefined) return;
    const dedupKey = computeDedupKey(run.callerSessionKey, run.task, run.agentId);
    // Only delete if the slot still points at THIS runId — defensive against
    // a re-spawn that already won the slot after our terminal transition.
    if (inFlightByDedupKey.get(dedupKey) === run.runId) {
      inFlightByDedupKey.delete(dedupKey);
    }
  }

  // Late-binding ref for graph coordinator (created after sub-agent runner in daemon.ts)
  let graphCoordinatorRef: { notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void } | undefined;

  // -------------------------------------------------------------------------
  // Queue data structure for spawn queuing
  // -------------------------------------------------------------------------

  interface QueuedSpawn {
    runId: string;
    params: SpawnParams;
    queuedAt: number;
  }
  /** FIFO queue per caller session key. */
  const spawnQueue = new Map<string, QueuedSpawn[]>();

  /**
   * Count active (running) children spawned by a specific caller session.
   * Used to enforce maxChildrenPerAgent.
   */
  function countActiveChildren(callerSessionKey: string | undefined): number {
    if (!callerSessionKey) return 0;
    let count = 0;
    for (const run of runs.values()) {
      if (run.status === "running" && run.callerSessionKey === callerSessionKey) {
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Proxy typing stop helper (avoids repeating guard+emit in 5 paths)
  // -------------------------------------------------------------------------

  /**
   * Release a run's reserved tree-wide ceiling slot EXACTLY ONCE (Phase 213
   * CR-02). Pairs 1:1 with the `checkSpawnCeiling` acquire recorded on the run.
   * Clearing `ceilingSlotAcquired` first makes this idempotent across the several
   * terminal paths a single run can traverse (kill marks failed, then the
   * underlying executeAgent promise later settles and fires `execPromise.finally`
   * — both must not double-release, which would steal a sibling slot under a
   * shared root since `releaseSpawn` floors at 0 but cannot tell whose slot it is).
   */
  function releaseCeilingSlotOnce(run: SubAgentRun): void {
    if (!run.ceilingSlotAcquired) return;
    run.ceilingSlotAcquired = false;
    deps.releaseSpawnCeiling?.(run.rootRunId);
  }

  function emitProxyStop(
    run: SubAgentRun,
    runId: string,
    reason: "completed" | "failed" | "killed" | "ghost_sweep" | "watchdog_timeout",
  ): void {
    if (!run.announceChannelType || !run.announceChannelId) return;
    deps.eventBus.emit("typing:proxy_stop", {
      runId,
      channelType: run.announceChannelType,
      channelId: run.announceChannelId,
      reason,
      durationMs: (run.completedAt ?? clock.now()) - run.startedAt,
      timestamp: clock.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Auto-archive sweep (every 5 minutes)
  // -------------------------------------------------------------------------

  const SWEEP_INTERVAL_MS = 300_000;
  const MAX_RUNS = 1000;

  // WR-01: DLQ recovery sink — when a dead-lettered announcement is finally
  // re-delivered on drain(), record its idempotency key in the shared
  // deliveredKeys set so a later failure sweep (deliverFailureNotification)
  // does not double-notify the same run. No-op when no shared dedup is wired.
  const markRecoveredDelivered = (idempotencyKey: string): void => {
    deps.deliveryDedup?.mark(idempotencyKey);
    deps.batcher?.markDelivered(idempotencyKey);
  };

  const sweepInterval = timers.setInterval(() => {
    const now = clock.now();
    const retentionMs = deps.config.subAgentRetentionMs;

    for (const [runId, run] of runs) {
      if (
        (run.status === "completed" || run.status === "failed") &&
        run.completedAt !== undefined &&
        now - run.completedAt > retentionMs
      ) {
        // Parse session key back to components for deletion
        const parts = run.sessionKey.split(":");
        if (parts.length >= 3) {
          const sessionKey: SessionKey = {
            tenantId: parts[0]!,
            userId: parts[1]!,
            channelId: parts[2]!,
          };
          deps.sessionStore.delete(sessionKey);
        }

        deps.eventBus.emit("session:sub_agent_archived", {
          runId,
          sessionKey: run.sessionKey,
          ageMs: now - run.completedAt,
          timestamp: now,
        });

        deps.logger?.debug({ runId, ageMs: now - run.completedAt }, "Sub-agent run auto-archived");
        // Belt-and-suspenders: terminal-transition sites already remove the
        // dedup entry, but archive is the last chance to evict if those missed.
        removeDedupEntry(run);
        runs.delete(runId);
      }
    }

    // Size cap: prune oldest completed runs if over limit
    if (runs.size > MAX_RUNS) {
      const completedRuns = [...runs.entries()]
        .filter(([, r]) => r.status === "completed" || r.status === "failed")
        .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));

      const toRemove = runs.size - MAX_RUNS;
      for (let i = 0; i < toRemove && i < completedRuns.length; i++) {
        const [pruneRunId, pruneRun] = completedRuns[i]!;
        removeDedupEntry(pruneRun);
        runs.delete(pruneRunId);
      }
    }

    // Queue timeout sweep -- fail queued spawns that exceeded queueTimeoutMs
    const queueTimeoutMs = deps.config.subagentContext?.queueTimeoutMs ?? 120_000;
    for (const [callerKey, queue] of spawnQueue) {
      const timedOut: string[] = [];
      for (let i = queue.length - 1; i >= 0; i--) {
        const entry = queue[i]!;
        if (now - entry.queuedAt > queueTimeoutMs) {
          queue.splice(i, 1);
          timedOut.push(entry.runId);

          const run = runs.get(entry.runId);
          if (run && run.status === "queued") {
            run.status = "failed";
            run.error = `Queue timeout: waited ${queueTimeoutMs}ms for an execution slot`;
            run.completedAt = now;
            removeDedupEntry(run);

            deps.eventBus.emit("session:sub_agent_spawn_rejected", {
              parentSessionKey: callerKey,
              agentId: run.agentId,
              task: run.task,
              reason: "queue_timeout",
              currentDepth: run.depth,
              maxDepth: 0,
              currentChildren: 0,
              maxChildren: 0,
              timestamp: now,
            });

            deps.logger?.warn({
              runId: entry.runId,
              agentId: run.agentId,
              parentSessionKey: callerKey,
              queueTimeoutMs,
              hint: "Queued spawn timed out; increase queueTimeoutMs or reduce concurrent spawns",
              errorKind: "resource" as const,
            }, "Queued spawn timed out");
          }
        }
      }
      if (queue.length === 0) {
        spawnQueue.delete(callerKey);
      }
    }

    // Disk sweep for expired result files
    if (deps.dataDir) {
      const resultRetentionMs = deps.config.subagentContext?.resultRetentionMs ?? 86_400_000;
      suppressError(
        sweepResultFiles(deps.dataDir, resultRetentionMs, deps.logger ?? undefined),
        "result-file-sweep",
      );
    }

    // Ghost run sweep -- defense-in-depth for stuck runs
    const ghostGraceMs = (deps.config.subagentContext?.maxRunTimeoutMs ?? 600_000) + 120_000;
    for (const [runId, run] of runs) {
      if (run.status !== "running") continue;

      const runningDurationMs = now - run.startedAt;
      if (runningDurationMs <= ghostGraceMs) continue;

      deps.logger?.error({
        runId, agentId: run.agentId,
        runtimeMs: runningDurationMs,
        graceMs: ghostGraceMs,
        hint: "Run stuck in 'running' past grace period; force-failing as ghost run",
        errorKind: "timeout" as const,
      }, "Ghost run detected and force-failed");

      run.status = "failed";
      run.completedAt = now;
      run.error = `Ghost run: stuck in 'running' for ${(runningDurationMs / 1000).toFixed(0)}s (grace: ${(ghostGraceMs / 1000).toFixed(0)}s)`;
      removeDedupEntry(run);

      // Persist failure record
      if (deps.dataDir) {
        suppressError(
          persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: run.sessionKey,
            runId,
            task: run.task,
            error: run.error,
            endReason: "ghost_sweep",
            runtimeMs: runningDurationMs,
          }, deps.logger),
          "ghost-sweep-failure-record",
        );
      }

      // Abort SDK session (best-effort, composite-key resolver)
      if (deps.sessionResolver) {
        const handle = deps.sessionResolver.resolveActiveSession(deriveCompositeForRun(run));
        if (handle) {
          // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
          handle.abort().catch(() => { /* best-effort */ });
        }
      }

      // Emit completion event
      deps.eventBus.emit("session:sub_agent_completed", {
        runId, agentId: run.agentId, success: false,
        runtimeMs: runningDurationMs, tokensUsed: 0, cost: 0, timestamp: now,
      });

      // Stop proxy typing on ghost sweep
      emitProxyStop(run, runId, "ghost_sweep");

      // Deliver failure notification using stored announce channel
      if (run.announceChannelType && run.announceChannelId) {
        deliverFailureNotification({
          channelType: run.announceChannelType,
          channelId: run.announceChannelId,
          task: run.task,
          runtimeMs: runningDurationMs,
          runId,
          callerSessionKey: run.callerSessionKey,  // DELIVERY-03: shared dedup key
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        }, deps).catch(() => { /* deliverFailureNotification already handles errors internally */ });
      }

      // Lifecycle hook (fire-and-forget)
      if (deps.lifecycleHooks) {
        deps.lifecycleHooks.onEnded({
          runId,
          agentId: run.agentId,
          parentSessionKey: run.callerSessionKey ?? "unknown",
          childSessionKey: run.sessionKey,
          endReason: "ghost_sweep",
          runtimeMs: runningDurationMs,
          tokensUsed: 0,
          cost: 0,
        }).catch((hookErr) => {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "onSubagentEnded hook failed in ghost sweep path",
            errorKind: "internal" as const,
          }, "Lifecycle hook onEnded failed");
        });
      }
    }

    // Dead-letter queue periodic drain
    if (deps.deadLetterQueue) {
      suppressError(
        deps.deadLetterQueue.drain(deps.sendToChannel, markRecoveredDelivered),
        "dead-letter-sweep-drain",
      );
    }
  }, SWEEP_INTERVAL_MS);

  sweepInterval.unref();

  // Event-driven DLQ drain on provider recovery
  if (deps.deadLetterQueue) {
    deps.eventBus.on("provider:recovered", () => {
      suppressError(
        deps.deadLetterQueue!.drain(deps.sendToChannel, markRecoveredDelivered),
        "dead-letter-recovery-drain",
      );
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function spawn(params: SpawnParams): string {
    // Reset dedup signal at the start of every call so a non-deduped spawn
    // does not see a stale hit from the previous invocation.
    lastDedupHit = undefined;

    // 0. Resolve depth and config values for limit enforcement
    const currentDepth = params.depth ?? 0;
    const maxDepth = params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;
    const isGraphSpawn = params.callerType === "graph";

    // Establish the tree-stable rootRunId (CEIL-01/REVOKE-03 foundation). The root
    // (the first caller with no rootRunId) mints one; every descendant MUST pass its
    // parent's id down via params.rootRunId. We mint whenever it is absent — regardless
    // of depth — so a missing id never silently splits a tree into per-spawn ids that
    // each escape the parent's ceiling (RESEARCH Pitfall 1). Uses the injected
    // ClockPort (never the wall-clock global — the globals.test.ts arch-gate).
    const rootRunId = params.rootRunId ?? `root-${params.agentId}-${clock.now().toString(36)}`;

    // Depth check (applies to ALL spawns including graph)
    if (currentDepth >= maxDepth) {
      deps.eventBus.emit("session:sub_agent_spawn_rejected", {
        parentSessionKey: params.callerSessionKey ?? "unknown",
        agentId: params.agentId,
        task: params.task,
        reason: "depth_exceeded",
        currentDepth,
        maxDepth,
        currentChildren: 0,
        maxChildren: 0,
        timestamp: clock.now(),
      });
      deps.logger?.warn({
        agentId: params.agentId,
        parentSessionKey: params.callerSessionKey ?? "unknown",
        reason: "depth_exceeded",
        currentDepth,
        maxDepth,
        hint: "Spawn rejected: depth limit exceeded; reduce spawn nesting or increase maxSpawnDepth config",
        errorKind: "resource" as const,
      }, "Subagent spawn rejected");
      // @allow-throw: spawn() consumed exclusively by daemon RPC handlers (subagent-handlers, session-handlers, graph-*); these handlers are @allow-throw boundaries — rpc-dispatch.ts wraps and converts to JSON-RPC error response.
      throw new Error(
        `Spawn rejected: depth limit exceeded (current: ${currentDepth}, max: ${maxDepth}). This sub-agent cannot spawn further children at this nesting level.`,
      );
    }

    // In-flight dedup check. A duplicate same-caller-same-task spawn
    // returns the existing runId rather than starting a parallel run. Placed
    // AFTER the depth throw (depth violations must always reject) but BEFORE
    // the children-limit / queue / allowlist logic — a deduped spawn does NOT
    // consume a child slot or create a new run; the existing run was already
    // validated by these gates when it was first started.
    if (isDedupEligible(params)) {
      const dedupKey = computeDedupKey(params.callerSessionKey!, params.task, params.agentId);
      const existingRunId = inFlightByDedupKey.get(dedupKey);
      if (existingRunId !== undefined) {
        const existing = runs.get(existingRunId);
        if (existing && (existing.status === "running" || existing.status === "queued")) {
          const startRef = existing.startedAt || existing.queuedAt || clock.now();
          const ageMs = clock.now() - startRef;
          lastDedupHit = { existingRunId, ageMs };
          deps.logger?.debug({
            runId: existingRunId,
            existingRunId,
            taskLength: params.task.length,
            callerSessionKey: params.callerSessionKey,
            ageMs,
            hint: "Duplicate spawn deduped against in-flight run",
          }, "Sub-agent spawn deduped");
          return existingRunId;
        }
        // Stale entry — the prior run reached terminal status without cleanup.
        // Drop it so we don't keep returning a dead runId.
        inFlightByDedupKey.delete(dedupKey);
      }
    }

    // Spawn-time required_tools gate.
    // Validates that each declared required tool is reachable by the sub-agent
    // BEFORE creating a runId or session — fires on BOTH the immediate and queued paths.
    //
    // Uses the daemon-provided reachableToolNames set (params.reachableToolNames), which the
    // daemon's session-mutate.ts computes via computeReachableToolNames() after applying the
    // config default tool groups and expanding both TOOL_PROFILES and TOOL_GROUPS. This gives
    // TRUE parity with the runtime ceiling (setup-tools.ts:588-607).
    //
    // When reachableToolNames is absent (older callers), the gate fails-open so the runtime
    // denylist+ceiling enforcement still applies. The daemon path MUST provide this field.
    if (params.requiredTools && params.requiredTools.length > 0) {
      const reachableSet = params.reachableToolNames;
      const effectiveGroups = params.toolGroups ?? [];
      const unreachable: UnreachableToolEntry[] = [];
      for (const tool of params.requiredTools) {
        // Denylisted tools are unreachable regardless of profile or reachableToolNames (check first)
        if (SUB_AGENT_TOOL_DENYLIST.has(tool)) {
          unreachable.push(classifyRequiredTool(tool, effectiveGroups));
        } else if (reachableSet !== undefined && !reachableSet.has(tool)) {
          // reachableSet is provided → use it for membership check (profile/group parity)
          unreachable.push(classifyRequiredTool(tool, effectiveGroups));
          // reachableSet is undefined → fail-open (runtime boundary still enforces)
        }
      }
      if (unreachable.length > 0) {
        deps.logger?.warn({
          agentId: params.agentId,
          requiredTools: params.requiredTools,
          toolGroups: params.toolGroups,
          unreachableTools: unreachable.map((e) => ({ toolName: e.toolName, reason: e.reason })),
          hint: "Spawn rejected: required_tools unreachable in sub-agent profile; see unreachableTools for re-spawn guidance",
          errorKind: "validation" as const,
        }, "Sub-agent spawn rejected: required tools unreachable");
        // @allow-throw: spawn() consumed exclusively by daemon RPC handlers.
        throw new RequiredToolsUnreachableError(unreachable);
      }
    }

    // Sandbox no-downgrade gate (SANDBOX-02). The single fail-closed posture
    // check at the spawn chokepoint: a spawned child may never be LESS confined
    // than its spawner. Placed AFTER the required_tools gate and BEFORE the
    // children/queue branch, so ONE check fires before any `runs.set` / runId /
    // session on BOTH the immediate (line ~1019) and queued (line ~949) paths —
    // satisfying "refuse before any child run/session is created".
    //
    // Gated by the typed `config.sandboxNoDowngrade` field (default true;
    // `undefined !== false` ⇒ active, so an explicit `false` is the ONLY off
    // state). Inert when `resolvePosture` is absent (older test wiring) or for a
    // top-level spawn (no parent posture to compare against). Posture is resolved
    // via the INJECTED `deps.resolvePosture` dep — the runner never reaches
    // `config.agents[...]` (D-RESOLVEDEP).
    //
    // ORDERING (IN-02, intentional): this fail-closed gate runs BEFORE the
    // children/queue branch and the allowlist check (line ~1051). A spawn that is
    // BOTH a downgrade AND not-allowlisted is therefore attributed to the
    // downgrade refusal. We keep this order on purpose: both branches refuse the
    // spawn (no security difference — only the reason/event differs), and moving
    // the allowlist earlier would hoist it above the queue SIDE-EFFECT branch
    // too, perturbing the load-bearing "refuse before any run/session/queue"
    // placement that the queued-path gate test pins. Security placement wins over
    // reason attribution.
    const sandboxNoDowngrade = deps.config.sandboxNoDowngrade;
    if (sandboxNoDowngrade !== false && deps.resolvePosture && params.callerAgentId) {
      const parentPosture = deps.resolvePosture(params.callerAgentId);
      const childPosture = deps.resolvePosture(params.agentId, params.callerAgentId);
      const cmp = comparePosture(parentPosture, childPosture);
      if (cmp.isDowngrade) {
        const violated = cmp.violatedDimensions.join(", ");
        deps.logger?.warn({
          agentId: params.agentId,
          parentAgentId: params.callerAgentId,
          childAgentId: params.agentId,
          // Enum labels only — never posture values/paths/hosts (§2.7).
          violatedDimensions: cmp.violatedDimensions,
          hint:
            `Spawn refused: child sandbox posture is less confined than its spawner on ${violated}; ` +
            "align the child's skills sandbox config or set security.agentToAgent.sandboxNoDowngrade:false to disable",
          errorKind: "precondition" as const,
        }, "Sub-agent spawn refused: sandbox downgrade");
        // Typed refusal event (SANDBOX-03): both postures as enum TUPLES + the
        // violated dimension labels + the two agent ids — labels only, NO
        // paths/hosts/uid-numbers/credential values (§2.7 / T-172-01f). Fires
        // here, before the throw, at the exact point a run/session would
        // otherwise be created. comparePosture's violatedDimensions feeds it.
        deps.eventBus.emit("security:sandbox_downgrade_refused", {
          timestamp: clock.now(),
          parentAgentId: params.callerAgentId,
          childAgentId: params.agentId,
          violatedDimensions: cmp.violatedDimensions,
          parentPosture,
          childPosture,
        });
        // @allow-throw: spawn() consumed exclusively by daemon RPC handlers; @allow-throw boundary.
        throw new Error(
          `Spawn refused: child "${params.agentId}" sandbox posture is less confined than parent "${params.callerAgentId}" on: ${violated}.`,
        );
      }
    }

    // Children check (bypassed for graph spawns)
    if (!isGraphSpawn && params.callerSessionKey) {
      const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
      const activeChildren = countActiveChildren(params.callerSessionKey);
      if (activeChildren >= maxChildren) {
        const maxQueuedPerAgent = deps.config.subagentContext?.maxQueuedPerAgent ?? 10;

        // maxQueuedPerAgent === 0 means queuing is disabled -- preserve old throw behavior
        if (maxQueuedPerAgent === 0) {
          deps.eventBus.emit("session:sub_agent_spawn_rejected", {
            parentSessionKey: params.callerSessionKey,
            agentId: params.agentId,
            task: params.task,
            reason: "children_exceeded",
            currentDepth,
            maxDepth,
            currentChildren: activeChildren,
            maxChildren,
            timestamp: clock.now(),
          });
          deps.logger?.warn({
            agentId: params.agentId,
            parentSessionKey: params.callerSessionKey,
            reason: "children_exceeded",
            activeChildren,
            maxChildren,
            hint: "Spawn rejected: active children limit exceeded; wait for existing sub-agents to complete",
            errorKind: "resource" as const,
          }, "Subagent spawn rejected");
          // @allow-throw: spawn() consumed exclusively by daemon RPC handlers; @allow-throw boundary.
          throw new Error(
            `Spawn rejected: active children limit exceeded (current: ${activeChildren}, max: ${maxChildren}). Wait for existing sub-agents to complete before spawning more.`,
          );
        }

        // Check queue capacity
        const queueSize = spawnQueue.get(params.callerSessionKey)?.length ?? 0;
        if (queueSize >= maxQueuedPerAgent) {
          deps.eventBus.emit("session:sub_agent_spawn_rejected", {
            parentSessionKey: params.callerSessionKey,
            agentId: params.agentId,
            task: params.task,
            reason: "queue_full",
            currentDepth,
            maxDepth,
            currentChildren: activeChildren,
            maxChildren,
            timestamp: clock.now(),
          });
          deps.logger?.warn({
            agentId: params.agentId,
            parentSessionKey: params.callerSessionKey,
            reason: "queue_full",
            activeChildren,
            maxChildren,
            queueSize,
            maxQueuedPerAgent,
            hint: "Spawn rejected: queue full; wait for queued or active sub-agents to complete",
            errorKind: "resource" as const,
          }, "Subagent spawn rejected");
          // @allow-throw: spawn() consumed exclusively by daemon RPC handlers; @allow-throw boundary.
          throw new Error(
            `Spawn rejected: queue full (queued: ${queueSize}, max: ${maxQueuedPerAgent}). Wait for existing sub-agents to complete before spawning more.`,
          );
        }

        // Queue the spawn
        const queuedRunId = randomUUID();
        const now = clock.now();
        const queuedRun: SubAgentRun = {
          runId: queuedRunId,
          status: "queued",
          agentId: params.agentId,
          task: params.task,
          sessionKey: "",
          startedAt: 0,
          queuedAt: now,
          requesterOrigin: params.requesterOrigin,
          depth: currentDepth,
          rootRunId,
          ...(params.parentLeaseId !== undefined ? { parentLeaseId: params.parentLeaseId } : {}),
          callerSessionKey: params.callerSessionKey,
          announceChannelType: params.announceChannelType,
          announceChannelId: params.announceChannelId,
          graphId: params.graphId,
          nodeId: params.nodeId,
          abortGroup: params.callerType === "graph" && params.graphId
            ? `graph:${params.graphId}`
            : params.callerSessionKey,
        };
        runs.set(queuedRunId, queuedRun);

        // Register dedup entry for the queued run so a second same-caller-same-task
        // spawn at children-limit returns the queued runId rather than starting another.
        if (isDedupEligible(params)) {
          const dedupKey = computeDedupKey(params.callerSessionKey, params.task, params.agentId);
          inFlightByDedupKey.set(dedupKey, queuedRunId);
        }

        const callerQueue = spawnQueue.get(params.callerSessionKey) ?? [];
        callerQueue.push({ runId: queuedRunId, params, queuedAt: now });
        spawnQueue.set(params.callerSessionKey, callerQueue);

        deps.eventBus.emit("session:sub_agent_spawn_queued", {
          runId: queuedRunId,
          parentSessionKey: params.callerSessionKey,
          agentId: params.agentId,
          task: params.task,
          queuePosition: callerQueue.length,
          activeChildren,
          maxChildren,
          timestamp: now,
        });

        deps.logger?.debug({
          runId: queuedRunId,
          agentId: params.agentId,
          parentSessionKey: params.callerSessionKey,
          queuePosition: callerQueue.length,
          activeChildren,
          maxChildren,
        }, "Sub-agent spawn queued");

        return queuedRunId;
      }
    }

    // 1. Allowlist check.
    // WR-03 (213-REVIEW): hoisted ABOVE the ceiling acquire below. The allowlist
    // check has NO side effects and can throw; if it ran AFTER the ceiling
    // reserve (the prior order), a not-allowlisted spawn would reserve a slot and
    // then throw with no run ever created — so no completion `finally` would ever
    // release it (a slot leak the instant CR-02's release landed). Refusing here,
    // before any reserve, keeps the acquire the LAST gate before run creation so
    // every successful acquire is paired 1:1 with a run that will release it.
    if (
      deps.config.allowAgents.length > 0 &&
      !deps.config.allowAgents.includes(params.agentId)
    ) {
      // `callerAgentId` is `string | undefined` -- a top-level spawn call
      // (no parent agent in flight) omits it. Use the same "unknown" sentinel
      // as the success-path log line at the bottom of this function so failure
      // records and observability payloads don't grep for the literal "undefined".
      const callerLabel = params.callerAgentId ?? "unknown";
      // @allow-throw: spawn() consumed exclusively by daemon RPC handlers.
      throw new Error(
        `Agent "${callerLabel}" is not allowed to spawn "${params.agentId}". Allowed: ${deps.config.allowAgents.join(", ")}`,
      );
    }

    // Tree-wide spawn ceiling (CEIL-01). The SINGLE consult both session.spawn
    // AND graph.* AND the in-process agent loop hit (they all reach here via
    // runner.spawn), keyed on the tree-stable rootRunId — so a for(;;) spawn()
    // is bounded across the whole tree, not just one caller. Placed AFTER the
    // per-caller depth/children/queue gates AND the allowlist (WR-03) and BEFORE
    // any runId/session is created, so it rejects with the SAME shape as the
    // depth/children gates (event + WARN + no run/session) and is the LAST gate
    // before run creation (every acquire pairs 1:1 with a releasing run). The
    // fanout arg is the caller's active children (0 for a top-level / graph spawn
    // with no callerSessionKey). Inert when the callback is absent (older/non-
    // daemon wiring).
    let ceilingSlotAcquired = false;
    if (deps.checkSpawnCeiling) {
      const ceilingFanout = countActiveChildren(params.callerSessionKey);
      const ceiling = deps.checkSpawnCeiling(rootRunId, currentDepth, ceilingFanout);
      if (ceiling.ok) {
        // The consult RESERVED a slot (tryAcquireSpawn increments on ok). Record
        // it so the run's terminal transition releases it 1:1 (CR-02). This is the
        // last gate before run creation, so a successful acquire is always paired
        // with a run that will release.
        ceilingSlotAcquired = true;
      }
      if (!ceiling.ok) {
        // Map the ceiling's reason (concurrency/depth/fanout) to the closed
        // event union's tree-wide `ceiling_*` member; an unknown reason folds to
        // ceiling_concurrency (the catch-all bound). Keeps the event distinct
        // from the per-caller depth_exceeded/children_exceeded gates.
        const eventReason: SubAgentSpawnRejectedEvent["reason"] =
          ceiling.reason === "depth"
            ? "ceiling_depth"
            : ceiling.reason === "fanout"
              ? "ceiling_fanout"
              : "ceiling_concurrency";
        deps.eventBus.emit("session:sub_agent_spawn_rejected", {
          parentSessionKey: params.callerSessionKey ?? "unknown",
          agentId: params.agentId,
          task: params.task,
          reason: eventReason,
          currentDepth,
          maxDepth,
          currentChildren: ceilingFanout,
          maxChildren: deps.config.subagentContext?.maxChildrenPerAgent ?? 5,
          timestamp: clock.now(),
        });
        deps.logger?.warn({
          agentId: params.agentId,
          parentSessionKey: params.callerSessionKey ?? "unknown",
          reason: ceiling.reason,
          rootRunId,
          currentDepth,
          hint: "Spawn rejected: tree-wide autonomy ceiling reached; the spawn tree hit its concurrency/depth/fanout bound (autonomy.spawn.*). Wait for sibling sub-agents to finish or raise the bound.",
          errorKind: "resource" as const,
        }, "Subagent spawn rejected");
        // @allow-throw: spawn() consumed exclusively by daemon RPC handlers; @allow-throw boundary — rpc-dispatch.ts converts to a JSON-RPC error.
        throw new Error(
          `Spawn rejected: tree-wide spawn ceiling reached (reason: ${ceiling.reason}). This spawn tree is at its concurrency/depth/fanout bound.`,
        );
      }
    }

    // Normal (non-queued) path: create run and start execution
    const runId = randomUUID();
    const run: SubAgentRun = {
      runId, status: "running", agentId: params.agentId,
      task: params.task, sessionKey: "", startedAt: clock.now(),
      requesterOrigin: params.requesterOrigin,
      depth: currentDepth,
      rootRunId,
      ...(params.parentLeaseId !== undefined ? { parentLeaseId: params.parentLeaseId } : {}),
      callerSessionKey: params.callerSessionKey,
      announceChannelType: params.announceChannelType,
      announceChannelId: params.announceChannelId,
      graphId: params.graphId,
      nodeId: params.nodeId,
      abortGroup: params.callerType === "graph" && params.graphId
        ? `graph:${params.graphId}`
        : params.callerSessionKey,
      ...(ceilingSlotAcquired ? { ceilingSlotAcquired: true } : {}),
    };
    runs.set(runId, run);

    // Register dedup entry for the just-started run so duplicate spawns
    // arriving while it is in flight short-circuit to this runId.
    if (isDedupEligible(params)) {
      const dedupKey = computeDedupKey(params.callerSessionKey!, params.task, params.agentId);
      inFlightByDedupKey.set(dedupKey, runId);
    }

    startExecution(runId, run, params, currentDepth, maxDepth);

    // 6. Return runId immediately (non-blocking)
    return runId;
  }

  /**
   * Start execution for a run: create session, emit events, launch async execution.
   * Called for both normal spawns and promoted queued spawns.
   */
  function startExecution(
    runId: string,
    run: SubAgentRun,
    params: SpawnParams,
    currentDepth: number,
    maxDepth: number,
  ): void {
    // Create sub-agent session
    let subSessionKey: SessionKey;
    let formattedKey: string;

    if (params.reuseSessionKey) {
      // Reuse existing persistent session -- skip session creation.
      // The session already has prior round conversation history on disk.
      const parsed = parseFormattedSessionKey(params.reuseSessionKey);
      if (!parsed) {
        deps.logger?.error(
          { runId, reuseSessionKey: params.reuseSessionKey, hint: "Invalid reuseSessionKey format, falling back to new session", errorKind: "validation" as const },
          "Failed to parse reuseSessionKey",
        );
        // Fall through to normal session creation
        subSessionKey = { tenantId: deps.tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` };
        formattedKey = formatSessionKey(subSessionKey);
        deps.sessionStore.save(subSessionKey, [], {
          parentSessionKey: params.callerSessionKey,
          spawnedByAgent: params.callerAgentId,
          spawnedAt: clock.now(),
          taskDescription: params.task,
          runId,
          modelOverride: params.model,
          spawnDepth: currentDepth + 1,
          maxSpawnDepth: maxDepth,
          artifactRefs: params.artifactRefs ?? [],
          objective: params.objective ?? "",
          language: params.resolvedLanguage,
          domainKnowledge: params.domainKnowledge ?? [],
          toolGroups: params.toolGroups ?? [],
          includeParentHistory: params.includeParentHistory ?? "none",
          graphSharedDir: params.graphSharedDir ?? "",
          discoveredDeferredTools: params.discoveredDeferredTools ?? [],
          graphToolNames: params.graphToolNames ?? [],
          graphNodeDepth: params.graphNodeDepth,
          isLeafNode: params.isLeafNode ?? false,
        });
      } else {
        formattedKey = params.reuseSessionKey;
        subSessionKey = { tenantId: parsed.tenantId, userId: parsed.userId, channelId: parsed.channelId };
        deps.logger?.info(
          { runId, reuseSessionKey: params.reuseSessionKey, agentId: params.agentId },
          "Reusing persistent session for multi-round driver",
        );
        // Do NOT call sessionStore.save -- session already exists with prior messages
      }
    } else {
      // Normal path: create new session
      subSessionKey = { tenantId: deps.tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` };
      formattedKey = formatSessionKey(subSessionKey);
      deps.sessionStore.save(subSessionKey, [], {
        parentSessionKey: params.callerSessionKey,
        spawnedByAgent: params.callerAgentId,
        spawnedAt: clock.now(),
        taskDescription: params.task,
        runId,
        modelOverride: params.model,
        spawnDepth: currentDepth + 1,
        maxSpawnDepth: maxDepth,
        artifactRefs: params.artifactRefs ?? [],
        objective: params.objective ?? "",
        language: params.resolvedLanguage,
        domainKnowledge: params.domainKnowledge ?? [],
        toolGroups: params.toolGroups ?? [],
        includeParentHistory: params.includeParentHistory ?? "none",
        graphSharedDir: params.graphSharedDir ?? "",
        discoveredDeferredTools: params.discoveredDeferredTools ?? [],
        graphToolNames: params.graphToolNames ?? [],
        graphNodeDepth: params.graphNodeDepth,
        isLeafNode: params.isLeafNode ?? false,
      });
    }

    // Update run with session info and running status
    run.sessionKey = formattedKey;
    run.status = "running";
    run.startedAt = clock.now();

    // Phase 216 (DUR-01 / HB-01): the SPAWN BOUNDARY — the run is now registered
    // + running, so write the initial durable checkpoint (stepIndex -1) + start
    // the keep-alive heartbeat. Inert when no durable store is wired. The keep-
    // alive is cleared + the record marked completed in the terminal `finally`.
    startDurableCheckpoint(run, params);

    deps.logger?.info({
      runId, agentId: params.agentId,
      callerAgentId: params.callerAgentId ?? "unknown",
      parentSessionKey: params.callerSessionKey ?? "unknown",
      task: params.task.slice(0, 200),
      maxSteps: params.max_steps ?? deps.config.subAgentMaxSteps,
      toolProfile: deps.config.subAgentToolGroups,
    }, "Sub-agent spawn initiated");

    // Emit spawn event
    deps.eventBus.emit("session:sub_agent_spawned", {
      runId, parentSessionKey: params.callerSessionKey ?? "unknown",
      agentId: params.agentId, task: params.task, timestamp: clock.now(),
    });

    // Async execution
    const execPromise = (async () => {
      // Lifecycle hook - prepareSpawn
      let rollbackHandle: { rollback: () => Promise<void> } | undefined;
      if (deps.lifecycleHooks) {
        try {
          rollbackHandle = await deps.lifecycleHooks.prepareSpawn({
            runId,
            parentSessionKey: params.callerSessionKey ?? "unknown",
            childSessionKey: formattedKey,
            agentId: params.agentId,
            task: params.task,
            depth: currentDepth,
            maxDepth,
          });
        } catch (hookErr) {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "prepareSubagentSpawn hook failed; proceeding with legacy spawn",
            errorKind: "internal" as const,
          }, "Lifecycle hook prepareSpawn failed");
        }
      }

      // Hoist traceId for availability in catch block (failure record correlation)
      const traceId = params.graphTraceId ?? randomUUID();

      try {
        deps.logger?.info({
          runId, agentId: params.agentId,
          ...(params.graphId ? { graphId: params.graphId } : {}),
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
        }, "Sub-agent execution started");
        const parsed = parseFormattedSessionKey(formattedKey);

        // Propagate delivery origin into ALS so sub-agent tool calls
        // (e.g. pipeline execute -> graph.execute RPC) include announce channel fields.
        // Without this, setup-tools.ts cannot inject _callerChannelType/_callerChannelId.
        const subDeliveryOrigin = run.announceChannelType && run.announceChannelId
          ? {
              channelType: run.announceChannelType,
              channelId: run.announceChannelId,
              userId: parsed?.userId ?? "sub-agent",
              tenantId: parsed?.tenantId ?? deps.tenantId,
            }
          : undefined;

        const result = await runWithContext(
          {
            traceId,
            tenantId: parsed?.tenantId ?? deps.tenantId,
            userId: parsed?.userId ?? "sub-agent",
            sessionKey: formattedKey,
            startedAt: clock.now(),
            trustLevel: "admin",
            // Propagate channel context for downstream tool RPC injection
            ...(run.announceChannelType && { channelType: run.announceChannelType }),
            ...(subDeliveryOrigin && { deliveryOrigin: subDeliveryOrigin }),
          },
          () => deps.executeAgent(
            params.agentId, subSessionKey, params.task, params.max_steps, params.callerAgentId,
            params.graphId && params.nodeId
              ? { graphId: params.graphId, nodeId: params.nodeId, reuseSessionKey: params.reuseSessionKey, graphNodeDepth: params.graphNodeDepth }
              : params.reuseSessionKey
                ? { reuseSessionKey: params.reuseSessionKey }
                : undefined,
            params.tokenBudget,
          ),
        );

        // Guard: if already killed, skip completion logic
        if (run.status === "failed") return;

        const completedAt = clock.now();
        run.status = "completed";
        run.completedAt = completedAt;
        run.result = result;
        removeDedupEntry(run);

        // Populate run.error for non-successful completions so graph coordinator
        // and downstream consumers see a meaningful error instead of "Unknown error".
        if (result.finishReason !== "stop" && result.finishReason !== "end_turn") {
          run.error = result.errorContext?.originalError
            ?? `Execution completed with finishReason: ${result.finishReason}`;
        }

        // Warn on empty response — may indicate prompt or context issues
        if (!result.response || result.response.trim().length === 0) {
          deps.logger?.warn({
            runId, agentId: params.agentId, finishReason: result.finishReason,
            hint: "Sub-agent returned empty response; check task prompt clarity and model context limits",
            errorKind: "internal" as const,
          }, "Sub-agent produced empty output");
        }

        const runtimeMs = completedAt - run.startedAt;

        // Compute cache effectiveness before condense() for disk persistence.
        // Formula: cacheRead/(cacheRead+cacheWrite), 0 when no cache activity.
        const cacheRead = result.tokensUsed.cacheRead ?? 0;
        const cacheWrite = result.tokensUsed.cacheWrite ?? 0;
        const cacheable = cacheRead + cacheWrite;
        const cacheEffectiveness = cacheable > 0 ? cacheRead / cacheable : 0;

        // Result condensation pipeline
        let condensedResult: { level: 1 | 2 | 3; result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[] }; originalTokens: number; condensedTokens: number; compressionRatio: number; diskPath: string } | undefined;
        if (deps.resultCondenser) {
          try {
            condensedResult = await deps.resultCondenser.condense({
              fullResult: result.response,
              task: params.task,
              runId,
              sessionKey: formattedKey,
              agentId: params.agentId,
              model: deps.condenserModel,
              apiKey: deps.condenserApiKey,
              // Parent trace correlation for cross-session diagnostics
              parentTraceId: traceId,
              // Graph context propagation (graphId/nodeId now available via SpawnParams)
              graphId: params.graphId,
              nodeId: params.nodeId,
              // Token/cost usage breakdown; cache fields for post-mortem analysis
              usage: {
                totalTokens: result.tokensUsed.total,
                costUsd: result.cost.total,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                cacheSavedUsd: result.cost.cacheSaved ?? 0,
                cacheEffectiveness: Number(cacheEffectiveness.toFixed(3)),
              },
              // Error context for non-successful executions
              errorContext: result.errorContext,
              // Tool metadata plumbed from executor via bridge
              toolCallHistory: result.toolCallHistory,
            });

            deps.eventBus.emit("session:sub_agent_result_condensed", {
              runId,
              agentId: params.agentId,
              level: condensedResult.level,
              originalTokens: condensedResult.originalTokens,
              condensedTokens: condensedResult.condensedTokens,
              compressionRatio: condensedResult.compressionRatio,
              taskComplete: condensedResult.result.taskComplete,
              diskPath: condensedResult.diskPath,
              timestamp: clock.now(),
            });

            deps.logger?.debug({
              runId, agentId: params.agentId,
              level: condensedResult.level,
              originalTokens: condensedResult.originalTokens,
              condensedTokens: condensedResult.condensedTokens,
              compressionRatio: condensedResult.compressionRatio,
            }, "Result condensation completed");
          } catch (condensErr) {
            deps.logger?.warn({
              runId, err: condensErr,
              hint: "Result condensation failed; using raw response for announcement",
              errorKind: "internal" as const,
            }, "ResultCondenser failed");
          }
        }

        // Emit completion event
        const isSuccess = result.finishReason === "stop" || result.finishReason === "end_turn";
        deps.eventBus.emit("session:sub_agent_completed", {
          runId, agentId: params.agentId, success: isSuccess,
          runtimeMs, tokensUsed: result.tokensUsed.total,
          cost: result.cost.total, timestamp: completedAt,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        });

        // Post-execution output validation (best-effort, never blocks)
        let validationResults: ValidationResult[] | undefined;
        if (params.expected_outputs && params.expected_outputs.length > 0) {
          try {
            validationResults = await validateOutputs(params.expected_outputs);
            const missing = validationResults.filter((v) => !v.exists);
            if (missing.length > 0) {
              deps.logger?.warn({
                runId,
                missingFiles: missing.map((v) => v.path),
                hint: "Sub-agent did not produce all expected output files; check task description clarity",
                errorKind: "validation" as const,
              }, "Sub-agent output validation: missing files");
            }
          } catch (validationErr) {
            deps.logger?.warn({
              runId,
              err: validationErr,
              hint: "Output validation failed unexpectedly; announcement will proceed without validation data",
              errorKind: "internal" as const,
            }, "Sub-agent output validation error");
          }
        }

        // Classify abort if finishReason is abnormal (not stop/end_turn)
        let abortClassification: AbortClassification | undefined;
        if (result.finishReason !== "stop" && result.finishReason !== "end_turn") {
          try {
            abortClassification = classifyAbortReason(result.finishReason);
          } catch { /* classification must never block */ }
        }

        // WARN log for abort events
        if (abortClassification) {
          deps.logger?.warn({
            runId, agentId: params.agentId,
            abortReason: abortClassification.category,
            abortSeverity: abortClassification.severity,
            hint: abortClassification.hint,
            errorKind: "resource" as const,
            finishReason: result.finishReason,
            // Include error context when available for root-cause investigation
            ...(result.errorContext?.errorType && { errorType: result.errorContext.errorType }),
            ...(result.errorContext?.originalError && { errorDetail: result.errorContext.originalError }),
          }, "Sub-agent aborted");
        }

        // Enriched INFO log (after validation so filesCreated is available)
        deps.logger?.info({
          runId, agentId: params.agentId, success: isSuccess, durationMs: runtimeMs,
          finishReason: result.finishReason,
          stepsExecuted: result.stepsExecuted,
          stepCount: result.stepsExecuted,
          tokensUsed: result.tokensUsed.total, cost: result.cost.total,
          responseLength: result.response.length,
          filesCreated: validationResults?.filter((v) => v.exists).length ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          cacheEffectiveness: Number(cacheEffectiveness.toFixed(3)),
          ...(params.graphId ? { graphId: params.graphId } : {}),
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
        }, "Sub-agent execution completed");

        // Persist completion summary to memory for cross-session recall
        if (deps.memoryAdapter) {
          try {
            let status: string;
            if (abortClassification) {
              status = `Halted (${abortClassification.category})`;
            } else if (result.finishReason === "error" && result.errorContext) {
              const retryHint = result.errorContext.retryable ? ", retryable" : "";
              const toolHint = result.errorContext.failingTool ? ` on ${result.errorContext.failingTool}` : "";
              status = `Halted (${result.errorContext.errorType}${toolHint}${retryHint})`;
            } else if (result.finishReason === "error") {
              status = "Halted (error)";
            } else {
              status = "Success";
            }
            const taskSnippet = params.task.length > 500
              ? params.task.slice(0, 497) + "..."
              : params.task;
            const sanitizedResponse = sanitizeAssistantResponse(result.response);
            const resultSnippet = sanitizedResponse.length > 500
              ? sanitizedResponse.slice(0, 497) + "..."
              : sanitizedResponse;
            const content = [
              `Sub-agent task ${status === "Success" ? "completed" : "halted"}.`,
              `Task: ${taskSnippet}`,
              `Status: ${status}`,
              resultSnippet ? `Result: ${resultSnippet}` : null,
              `Runtime: ${(runtimeMs / 1000).toFixed(1)}s | Steps: ${result.stepsExecuted} | Cost: $${result.cost.total.toFixed(4)}`,
              `Session: ${formattedKey}`,
            ].filter(Boolean).join("\n");

            await deps.memoryAdapter.store({
              id: randomUUID(),
              tenantId: deps.tenantId,
              agentId: params.agentId,
              userId: "system",
              content,
              trustLevel: "system",
              source: { who: "sub-agent-runner", sessionKey: formattedKey },
              tags: ["sub-agent-result", "task-completion", ...(abortClassification ? ["aborted"] : [])],
              createdAt: clock.now(),
              sourceType: "tool",
            });

            deps.logger?.debug({ runId, agentId: params.agentId }, "Sub-agent completion persisted to memory");
          } catch (memErr) {
            deps.logger?.warn({
              runId, err: memErr,
              hint: "Failed to persist sub-agent completion to memory; cross-session recall may be incomplete",
              errorKind: "internal" as const,
            }, "Sub-agent memory persistence failed");
          }
        }

        // Route provider_degraded to failure notification path
        // When isDegraded() skips the LLM call, executor returns empty response with
        // finishReason "provider_degraded". Route to deliverFailureNotification instead
        // of deliverAnnouncement to avoid sending an empty/malformed success message.
        if (result.finishReason === "provider_degraded") {
          if (params.announceChannelType && params.announceChannelId) {
            await deliverFailureNotification({
              channelType: params.announceChannelType,
              channelId: params.announceChannelId,
              task: params.task,
              runtimeMs,
              runId,
              callerSessionKey: params.callerSessionKey,  // DELIVERY-03: shared dedup key
            }, deps);
          }
        } else if (params.announceChannelType && params.announceChannelId) {
          // Announce with stats
          if (!result.response.includes("ANNOUNCE_SKIP")) {
            // Use NarrativeCaster for tagged result announcement.
            // Skip NarrativeCaster for error results — buildAnnouncementMessage
            // enriches the status label with errorContext (e.g., "Halted (PromptTimeout, retryable)")
            // which the NarrativeCaster would lose.
            let announcementText: string;
            if (condensedResult && deps.narrativeCaster && result.finishReason !== "error") {
              announcementText = deps.narrativeCaster.cast({
                condensedResult,
                task: params.task,
                runtimeMs,
                stepsExecuted: result.stepsExecuted,
                tokensUsed: result.tokensUsed.total,
                cost: result.cost.total,
                sessionKey: formattedKey,
              });
            } else {
              // Legacy fallback: no condenser or no caster
              announcementText = buildAnnouncementMessage({
                task: params.task,
                status: "completed",
                response: condensedResult
                  ? `${condensedResult.result.summary}\n\nFull result: ${condensedResult.diskPath}`
                  : sanitizeAssistantResponse(result.response),
                runtimeMs,
                stepsExecuted: result.stepsExecuted,
                tokensUsed: result.tokensUsed.total,
                cost: result.cost.total,
                finishReason: result.finishReason,
                sessionKey: formattedKey,
                validation: validationResults,
                abort: abortClassification,
                errorContext: result.errorContext,
              });
            }
            await deliverAnnouncement({
              announcementText,
              announceChannelType: params.announceChannelType,
              announceChannelId: params.announceChannelId,
              callerAgentId: params.callerAgentId,
              callerSessionKey: params.callerSessionKey,
              runId,
            }, deps);
          }
        } else {
          // Log explicit reason when announcement cannot be routed
          deps.logger?.debug({
            runId,
            suppressAnnounceReason: params.requesterOrigin ? "no_channel_params" : "no_origin",
            hasOrigin: !!params.requesterOrigin,
          }, "Sub-agent announcement skipped: no announce channel");
        }

        // Safety-net proxy stop — announceToParent's own finally block handles
        // the announcement-scoped typing. This catches edge cases where announcement was skipped.
        emitProxyStop(run, runId, "completed");

        // Lifecycle hook - onEnded (success path, after condensation/casting/announcement)
        if (deps.lifecycleHooks) {
          try {
            await deps.lifecycleHooks.onEnded({
              runId,
              agentId: params.agentId,
              parentSessionKey: params.callerSessionKey ?? "unknown",
              childSessionKey: formattedKey,
              endReason: "completed",
              condensedResult: condensedResult ? { level: condensedResult.level, condensedTokens: condensedResult.condensedTokens } : undefined,
              runtimeMs,
              tokensUsed: result.tokensUsed.total,
              cost: result.cost.total,
            });
          } catch (hookErr) {
            deps.logger?.warn({
              runId, err: hookErr,
              hint: "onSubagentEnded hook failed; result already delivered",
              errorKind: "internal" as const,
            }, "Lifecycle hook onEnded failed");
          }
        }
      } catch (error: unknown) {
        // Guard: if already killed, skip error handling logic
        if (run.status === "failed") return;

        const completedAt = clock.now();
        run.status = "failed";
        run.completedAt = completedAt;
        removeDedupEntry(run);
        const errorMessage = error instanceof Error ? error.message : String(error);
        run.error = errorMessage;

        const runtimeMs = completedAt - run.startedAt;

        deps.logger?.error({
          runId,
          durationMs: runtimeMs,
          err: error,
          hint: "Sub-agent execution failed; check agent config, model availability, and API key",
          errorKind: "internal" as const,
        }, "Sub-agent execution failed");

        // Persist failure record BEFORE rollback deletes the directory
        if (deps.dataDir) {
          await persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: formattedKey,
            runId,
            task: params.task,
            error: errorMessage,
            endReason: "failed",
            runtimeMs,
            // Parent trace correlation for failure records
            parentTraceId: traceId,
          }, deps.logger);
        }

        // Rollback disk directory on spawn failure
        if (rollbackHandle) {
          try { await rollbackHandle.rollback(); } catch { /* swallow -- rollback has its own WARN logging */ }
        }

        // Classify abort from error context
        let abortClassification: AbortClassification | undefined;
        try {
          const errorCause = error instanceof Error && error.cause
            ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
            : undefined;
          abortClassification = classifyAbortReason("error", errorMessage, errorCause);
        } catch { /* classification must never block */ }

        // WARN log for abort classification in error path
        if (abortClassification) {
          deps.logger?.warn({
            runId, agentId: params.agentId,
            abortReason: abortClassification.category,
            abortSeverity: abortClassification.severity,
            hint: abortClassification.hint,
            errorKind: "resource" as const,
            // Include actual error type for root-cause investigation (not just "unknown")
            ...(error instanceof Error && { errorType: error.constructor.name }),
            ...(error instanceof Error && error.message && { errorDetail: error.message }),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          }, "Sub-agent aborted");
        }

        // Emit failure event
        deps.eventBus.emit("session:sub_agent_completed", {
          runId, agentId: params.agentId, success: false,
          runtimeMs, tokensUsed: 0, cost: 0, timestamp: completedAt,
        });

        // Stop proxy typing before failure notification
        emitProxyStop(run, runId, "failed");

        // Announce failure to channel -- LLM-free direct send
        if (params.announceChannelType && params.announceChannelId) {
          await deliverFailureNotification({
            channelType: params.announceChannelType,
            channelId: params.announceChannelId,
            task: params.task,
            runtimeMs,
            runId,
            callerSessionKey: params.callerSessionKey,  // DELIVERY-03: shared dedup key
          }, deps);
        } else {
          // Log explicit reason when failure announcement cannot be routed
          deps.logger?.debug({
            runId,
            suppressAnnounceReason: params.requesterOrigin ? "no_channel_params" : "no_origin",
            hasOrigin: !!params.requesterOrigin,
          }, "Sub-agent failure announcement skipped: no announce channel");
        }

        // Lifecycle hook - onEnded (failure path)
        if (deps.lifecycleHooks) {
          try {
            await deps.lifecycleHooks.onEnded({
              runId,
              agentId: params.agentId,
              parentSessionKey: params.callerSessionKey ?? "unknown",
              childSessionKey: formattedKey,
              endReason: "failed",
              runtimeMs,
              tokensUsed: 0,
              cost: 0,
            });
          } catch (hookErr) {
            deps.logger?.warn({
              runId, err: hookErr,
              hint: "onSubagentEnded hook failed in error path",
              errorKind: "internal" as const,
            }, "Lifecycle hook onEnded failed");
          }
        }
      }
    })();

    // Per-run watchdog timer
    const subagentCtx = deps.config.subagentContext;
    const perStepMs = subagentCtx?.perStepTimeoutMs ?? 60_000;
    const maxRunMs = subagentCtx?.maxRunTimeoutMs ?? 600_000;
    const runTimeoutMs = params.max_steps
      ? Math.min(params.max_steps * perStepMs, maxRunMs)
      : maxRunMs;

    const watchdogTimer = timers.setTimeout(() => {
      // Guard: if already completed/failed/killed, skip
      if (run.status !== "running") return;

      const completedAt = clock.now();
      const runtimeMs = completedAt - run.startedAt;

      run.status = "failed";
      run.completedAt = completedAt;
      run.error = `Execution timeout: exceeded ${runTimeoutMs}ms wall-clock limit`;
      removeDedupEntry(run);

      deps.logger?.error({
        runId, agentId: run.agentId,
        runtimeMs, timeoutMs: runTimeoutMs,
        hint: "Sub-agent watchdog timeout; increase maxRunTimeoutMs or perStepTimeoutMs if tasks legitimately need more time",
        errorKind: "timeout" as const,
      }, "Sub-agent watchdog timeout");

      // Persist failure record (fire-and-forget)
      if (deps.dataDir) {
        suppressError(
          persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: run.sessionKey,
            runId,
            task: run.task,
            error: run.error,
            endReason: "watchdog_timeout",
            runtimeMs,
          }, deps.logger),
          "watchdog-failure-record",
        );
      }

      // Abort SDK session via composite-key resolver. The
      // previous lookup keyed on the formatted sessionKey only; the
      // resolver makes the `(agentId, channelType, channelId)` triple
      // explicit so multi-agent collisions are distinguishable.
      if (deps.sessionResolver) {
        const handle = deps.sessionResolver.resolveActiveSession(deriveCompositeForRun(run));
        if (handle) {
          handle.abort().catch((abortErr: unknown) => {
            deps.logger?.debug({ runId, err: abortErr }, "Watchdog SDK abort best-effort failed");
          });
        }
      }

      // Emit completion event
      deps.eventBus.emit("session:sub_agent_completed", {
        runId, agentId: run.agentId, success: false,
        runtimeMs, tokensUsed: 0, cost: 0, timestamp: completedAt,
      });

      // Stop proxy typing on watchdog timeout
      emitProxyStop(run, runId, "watchdog_timeout");

      // Deliver failure notification (LLM-free)
      if (params.announceChannelType && params.announceChannelId) {
        deliverFailureNotification({
          channelType: params.announceChannelType,
          channelId: params.announceChannelId,
          task: params.task,
          runtimeMs,
          runId,
          callerSessionKey: params.callerSessionKey,  // DELIVERY-03: shared dedup key
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        }, deps).catch(() => { /* deliverFailureNotification already handles errors internally */ });
      }

      // Lifecycle hook (fire-and-forget)
      if (deps.lifecycleHooks) {
        deps.lifecycleHooks.onEnded({
          runId,
          agentId: run.agentId,
          parentSessionKey: run.callerSessionKey ?? "unknown",
          childSessionKey: run.sessionKey,
          endReason: "watchdog_timeout",
          runtimeMs,
          tokensUsed: 0,
          cost: 0,
        }).catch((hookErr) => {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "onSubagentEnded hook failed in watchdog path",
            errorKind: "internal" as const,
          }, "Lifecycle hook onEnded failed");
        });
      }
    }, runTimeoutMs);

    // Clear watchdog on normal completion/failure
    execPromise.finally(() => watchdogTimer.cancel());

    activePromises.add(execPromise);
    execPromise.finally(() => {
      activePromises.delete(execPromise);
      // CR-02: release the tree-wide ceiling slot this run reserved (idempotent;
      // a no-op for promoted queued runs, which never acquired). This fires for
      // EVERY started run on its terminal settle — completion, failure, AND a
      // kill/ghost/watchdog (those mark the run failed but the underlying
      // executeAgent promise still settles here), so a long-running tree's slots
      // are reclaimed rather than monotonically leaking.
      releaseCeilingSlotOnce(run);
      // Phase 216 (DUR-01 / HB-01): the SAME universal terminal seam — mark the
      // durable record completed + clear its keep-alive heartbeat (no leaked
      // interval). Inert + idempotent when no durable store is wired.
      finishDurableCheckpoint(run);
      // Drain queue when a slot opens (use abortGroup for graph-scoped draining)
      const drainKey = run.abortGroup ?? run.callerSessionKey;
      if (drainKey) {
        drainQueue(drainKey);
      }
    });
  }

  /**
   * Promote queued spawns to running when active children count drops below limit.
   * Called from the .finally() of each execution promise.
   */
  function drainQueue(callerSessionKey: string): void {
    const queue = spawnQueue.get(callerSessionKey);
    if (!queue || queue.length === 0) {
      spawnQueue.delete(callerSessionKey);
      return;
    }

    const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
    let activeChildren = countActiveChildren(callerSessionKey);

    while (activeChildren < maxChildren && queue.length > 0) {
      const next = queue.shift()!;
      const run = runs.get(next.runId);
      if (!run || run.status !== "queued") continue;

      const currentDepth = next.params.depth ?? 0;
      const maxDepth = next.params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;

      startExecution(next.runId, run, next.params, currentDepth, maxDepth);
      activeChildren++;
    }

    if (queue.length === 0) {
      spawnQueue.delete(callerSessionKey);
    }
  }

  function getRunStatus(runId: string): SubAgentRun | undefined {
    return runs.get(runId);
  }

  /**
   * Resolve the running/queued sub-agent run whose child session key equals
   * `sessionKey` (Phase 213 CR-01). When a sub-agent itself calls
   * `sessions_spawn`, the dispatcher injects ITS session key as the spawn's
   * `_callerSessionKey`; that key is exactly the spawning run's `run.sessionKey`.
   * The daemon spawn handler uses this to make a descendant INHERIT its parent
   * run's tree-stable `rootRunId`/`parentLeaseId` instead of minting a fresh root
   * (the fork-bomb-defeating defect). Returns the most-recently-started match
   * among live runs; `undefined` for a top-level (operator) caller whose session
   * is not a sub-agent run. Terminal runs are ignored (a finished parent cannot
   * own a new child).
   */
  function getRunBySessionKey(sessionKey: string): SubAgentRun | undefined {
    if (!sessionKey) return undefined;
    let best: SubAgentRun | undefined;
    for (const run of runs.values()) {
      if (run.sessionKey !== sessionKey) continue;
      if (run.status !== "running" && run.status !== "queued") continue;
      if (!best || run.startedAt > best.startedAt) best = run;
    }
    return best;
  }

  /**
   * List tracked sub-agent runs, optionally filtered by recency.
   * @param recentMinutes - Only include runs started within the last N minutes.
   *   If undefined or 0, all runs are returned.
   * @returns Shallow copies of matching runs sorted by startedAt descending.
   */
  function listRuns(recentMinutes?: number): SubAgentRun[] {
    const cutoff = recentMinutes && recentMinutes > 0
      ? clock.now() - recentMinutes * 60_000
      : 0;

    return [...runs.values()]
      .filter((r) => (r.startedAt || r.queuedAt || 0) >= cutoff)
      .sort((a, b) => (b.startedAt || b.queuedAt || 0) - (a.startedAt || a.queuedAt || 0))
      .map((r) => ({ ...r }));
  }

  /**
   * Kill a running sub-agent by marking it as failed.
   * The in-flight executeAgent promise will eventually complete (or error)
   * and find the run already marked -- it skips its completion logic.
   * @param runId - The run ID to kill
   * @returns Result indicating success or failure with error message
   */
  function killRun(runId: string): { killed: boolean; error?: string } {
    const run = runs.get(runId);
    if (!run) {
      return { killed: false, error: `Unknown run ID: ${runId}` };
    }
    if (run.status !== "running" && run.status !== "queued") {
      return { killed: false, error: `Run ${runId} is not running (status: ${run.status})` };
    }

    run.status = "failed";
    run.completedAt = clock.now();
    removeDedupEntry(run);
    run.error = "Killed by parent agent";

    // Persist failure record for killed runs (fire-and-forget, belt-defense)
    if (deps.dataDir) {
      suppressError(
        persistFailureRecord({
          dataDir: deps.dataDir,
          sessionKey: run.sessionKey,
          runId,
          task: run.task,
          error: run.error!,
          endReason: "killed",
          runtimeMs: run.completedAt! - run.startedAt,
        }, deps.logger),
        "kill-failure-record",
      );
    }

    // Abort the in-flight SDK session via composite-key resolver
    // (best-effort).
    if (deps.sessionResolver) {
      const handle = deps.sessionResolver.resolveActiveSession(deriveCompositeForRun(run));
      if (handle) {
        handle.abort().catch((abortErr: unknown) => {
          deps.logger?.debug(
            { runId, err: abortErr },
            "Sub-agent SDK abort best-effort failed",
          );
        });
      }
    }

    // For graph-owned runs, use direct notification to graph coordinator
    // (bypasses event bus which may have detached listener during session cleanup).
    // CRITICAL: Do NOT emit session:sub_agent_completed AND call notifyNodeFailed --
    // both paths call handleSubAgentCompleted synchronously, causing runningCount to go to -1.
    if (run.graphId && run.nodeId && graphCoordinatorRef) {
      graphCoordinatorRef.notifyNodeFailed(run.graphId, run.nodeId, runId, run.error!);
    } else {
      // Non-graph runs: use existing event bus path
      deps.eventBus.emit("session:sub_agent_completed", {
        runId,
        agentId: run.agentId,
        success: false,
        runtimeMs: run.completedAt! - run.startedAt,
        tokensUsed: 0,
        cost: 0,
        timestamp: run.completedAt!,
      });
    }

    // Stop proxy typing on kill
    emitProxyStop(run, runId, "killed");

    deps.logger?.info({
      runId, agentId: run.agentId,
      durationMs: run.completedAt! - run.startedAt,
      task: run.task.slice(0, 200),
    }, "Sub-agent run killed by parent");

    // Lifecycle hook - onEnded (kill path, fire-and-forget)
    if (deps.lifecycleHooks) {
      deps.lifecycleHooks.onEnded({
        runId,
        agentId: run.agentId,
        parentSessionKey: run.callerSessionKey ?? "unknown",
        childSessionKey: run.sessionKey,
        endReason: "killed",
        runtimeMs: run.completedAt! - run.startedAt,
        tokensUsed: 0,
        cost: 0,
      }).catch((hookErr) => {
        deps.logger?.warn({
          runId, err: hookErr,
          hint: "onSubagentEnded hook failed in kill path",
          errorKind: "internal" as const,
        }, "Lifecycle hook onEnded failed");
      });
    }

    return { killed: true };
  }

  /**
   * REVOKE-03: hard-stop a whole spawn tree. Fans the per-run {@link killRun}
   * (which marks the run failed and aborts its in-flight SDK session) over every
   * running/queued run sharing `rootRunId`, and returns the count killed.
   *
   * Filters STRICTLY on `run.rootRunId === rootRunId` (threat T-213-01-02 — a
   * different tree must be untouched) and on the same status guard killRun uses,
   * so already-terminal runs are skipped. An unknown root is a clean no-op
   * (`{ killed: 0 }`), never a throw — the count return is the contract the
   * daemon-side `run.kill` RPC handler (the @allow-throw boundary, Plan 06)
   * drives; this helper itself raises nothing (the raw-throw.test.ts gate).
   */
  function killByRootRun(rootRunId: string): { killed: number } {
    let killed = 0;
    for (const run of runs.values()) {
      if (
        run.rootRunId === rootRunId &&
        (run.status === "running" || run.status === "queued")
      ) {
        if (killRun(run.runId).killed) killed++;
      }
    }
    return { killed };
  }

  /**
   * STEER-01: inject a steer message into a RUNNING child's live SDK session
   * (mid-flight steering), distinct from killRun. Delegates to the steer-run.ts
   * helper to keep the mechanism OUT of this (already large) file.
   *
   * L2 — widen the resolver/registry surface at the delegation boundary: this
   * runner's `deps.sessionResolver`/`deps.activeRunRegistry` are typed to the
   * narrowed `{ abort(): Promise<void> }` (the kill path only needs abort, and
   * the narrow type avoids a daemon→agent import cycle in those Deps). steerRun
   * needs the FULL RunHandle (steer/followUp/isStreaming/isCompacting). The
   * RUNTIME handle is complete — pi-executor.ts:1161 builds all five and
   * registers it under the SAME key the resolver composes (175-00 spike). So
   * we re-type the lookups to the full RunHandle at this boundary; this is a
   * pure TS surface widening over an object that already has the methods, not
   * a behavior change.
   */
  async function steerRun(
    runId: string,
    message: string,
  ): Promise<{ steered: boolean; mode?: "steer" | "followup"; error?: string }> {
    const steerDeps: SteerRunDeps = {
      // SubAgentRun structurally satisfies SteerableRun (the minimal slice the
      // helper reads); Map is invariant in its value type, so cast at the
      // boundary. steerRun READS only — it never `set`s into the map.
      runs: runs as unknown as Map<string, SteerableRun>,
      // Runtime handle is complete (pi-executor.ts:1161); the narrowed {abort()}
      // Deps type omits steer/followUp/isStreaming/isCompacting that the runtime
      // object carries — re-type to the full RunHandle for the inject delegation.
      sessionResolver: deps.sessionResolver as
        | { resolveActiveSession(key: { agentId: string; channelType: string; channelId: string }): RunHandle | undefined }
        | undefined,
      activeRunRegistry: deps.activeRunRegistry as
        | { get(sessionKey: string): RunHandle | undefined }
        | undefined,
      logger: deps.logger,
    };
    return steerRunHelper(steerDeps, runId, message);
  }

  async function shutdown(): Promise<void> {
    sweepInterval.cancel();

    // Flush any batched announcements before draining active runs
    if (deps.batcher) {
      await deps.batcher.shutdown();
    }

    // Drain dead-letter queue before shutdown
    if (deps.deadLetterQueue) {
      try {
        await deps.deadLetterQueue.drain(deps.sendToChannel, markRecoveredDelivered);
      } catch {
        // Best-effort drain on shutdown
      }
    }

    if (activePromises.size === 0) return;

    // Wait for all active runs with a 30-second timeout
    const timeout = new Promise<void>((resolve) => {
      const timer = timers.setTimeout(resolve, 30_000);
      timer.unref();
    });

    await Promise.race([
      Promise.allSettled([...activePromises]),
      timeout,
    ]);
  }

  /** Late-bind graph coordinator for direct kill cascade notification. */
  function setGraphCoordinator(gc: { notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void }): void {
    graphCoordinatorRef = gc;
  }

  /**
   * Return the most recent dedup hit observed by `spawn()`. Cleared at the
   * start of every `spawn()` call so each invocation surfaces a fresh signal.
   * Used by `session.spawn` RPC handler to set `deduped: true, existingRunId,
   * dedupAgeMs` on the response when an LLM duplicate-spawned the same task.
   */
  function lastSpawnDedupInfo(): { deduped: true; existingRunId: string; ageMs: number } | undefined {
    if (!lastDedupHit) return undefined;
    return { deduped: true, existingRunId: lastDedupHit.existingRunId, ageMs: lastDedupHit.ageMs };
  }

  return { spawn, getRunStatus, getRunBySessionKey, listRuns, killRun, killByRootRun, steerRun, shutdown, setGraphCoordinator, lastSpawnDedupInfo };
}
