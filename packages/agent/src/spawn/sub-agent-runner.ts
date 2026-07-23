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
  conversationScopeToSessionKey,
  createConversationLocator,
  createDeliveryOrigin,
  createResolvedRequestContext,
  runWithContext,
  tryGetContext,
  type SessionKey,
  type ConversationLocator,
  type ConversationRef,
  type ConversationScope,
  type ChannelEndpoint,
  type SessionStorePort,
  type TypedEventBus,
  type AgentToAgentConfig,
  type DeliveryOrigin,
  type ClockPort,
  type TimerPort,
  type TimerHandle,
  type DurableRunPort,
  type DurableRunRecord,
  type DurableRunTerminalReason,
  type AgentCapability,
  type ResultRef,
  type ErrorKind,
  AgentExecutionFinishReasonSchema,
  classifyAgentFinishErrorKind,
  SUB_AGENT_TOOL_DENYLIST,
  toolReachableGroups,
  RequiredToolsUnreachableError,
  toSafeErrorLogString,
  type UnreachableToolEntry,
  type SubAgentSpawnRejectedEvent,
  type UserTrustLevel,
  type MemoryWriteEntry,
  type MemoryWriteScope,
  type ResolvedTurnScope,
  SUBAGENT_RESULT_SUMMARY_MAX_CHARS,
} from "@comis/core";
import { err, ok, suppressError, tryCatch, type Result } from "@comis/shared";
import {
  createCoordinatorProgressFork,
  type CoordinatorProgressForkHandle,
} from "./coordinator-progress-fork.js";
import { sanitizeAssistantResponse } from "../provider/response/sanitize-pipeline.js";
import { randomUUID } from "node:crypto";
import type {
  AnnouncementBatcher,
  AnnouncementDeadLetterQueue,
  SendGovernedCompletionAnnouncement,
} from "./announcement-ports.js";
import type { DeliveryDedup } from "./announce-key.js";
import {
  classifyAbortReason,
  buildAnnouncementMessage,
  deliverAnnouncement,
  deliverFailureNotification,
  resolveAnnouncementThreadId,
  validateOutputs,
  sweepResultFiles,
  persistFailureRecord,
  type AbortClassification,
  type ValidationResult,
} from "./sub-agent-result-processor.js";
import { comparePosture, SandboxDowngradeError, type SandboxPosture } from "./sandbox-posture.js";
import { steerRun as steerRunHelper, type SteerRunDeps, type SteerableRun } from "./steer-run.js";
import type { RunHandle } from "../executor/active-run-registry.js";
import {
  hashSubAgentResumeDescriptor,
  parseSubAgentResumeDescriptor,
  SubAgentResumeDescriptorSchema,
  validateSubAgentResumeAuthority,
  type SubAgentResumeDescriptor,
} from "./sub-agent-resume-descriptor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for the text-only parent candidate execution. A timeout leaves
 *  the durable decision reservation quarantined and never starts another path. */
export const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;
const SHUTDOWN_ACTIVE_GRACE_MS = 30_000;
const SHUTDOWN_NOTICE_GRACE_MS = 5_000;
/**
 * Maximum caller-side guard for a sub-agent runner shutdown. The runner owns
 * the active-run drain and governed-notice grace, with a final bounded margin
 * for its announcement batch and dead-letter drains.
 */
export const SUB_AGENT_SHUTDOWN_TIMEOUT_MS =
  SHUTDOWN_ACTIVE_GRACE_MS + SHUTDOWN_NOTICE_GRACE_MS + 5_000;

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
 *   - channelId  -> the run's canonical caller endpoint
 *                   ?? run.sessionKey  (the PARSED sub-session channelId, NOT
 *                   run.announceChannelId -- the executor keys on
 *                   subSessionKey.channelId, never the announce channelId; the
 *                   last-resort raw key keeps the resolver's empty-field guard
 *                   from tripping)
 *
 * PITFALL: a formula using "sub-agent" for channelType or
 * `run.announceChannelId ?? parsed?.channelId` for channelId DIVERGES
 * from the registration key. For steer (steer-run.ts) that miss is FATAL
 * (the inject's whole purpose is to reach the live handle); for the kill /
 * ghost-sweep / watchdog aborts below it is a silent best-effort no-op
 * (latent). Keeping the formula aligned makes steer work AND lets those aborts
 * actually reach the handle. Keep this BYTE-IDENTICAL to
 * steer-run.ts:deriveCompositeForRun — the resolution spike
 * (sub-agent-runner.steer-resolve.spike.test.ts) fails loudly on drift.
 */
function createSubAgentConversation(
  tenantId: string,
  agentId: string,
  runId: string,
  principalId: string,
): ConversationLocator {
  const locator = createConversationLocator({
    tenantId,
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "sub-agent",
        channelInstanceId: "runtime",
        conversationId: runId,
        conversationKind: "direct",
      },
      principalId,
    },
  });
  if (!locator.ok) {
    // @allow-throw: the runner mints these fields from validated non-empty ids; failure is an internal construction invariant at the spawn boundary.
    throw locator.error;
  }
  return locator.value;
}

function displayKeyForConversation(locator: ConversationLocator): { key: SessionKey; formatted: string } {
  const projected = conversationScopeToSessionKey(locator.conversationScope);
  if (!projected.ok) {
    // @allow-throw: persisted sub-agent conversation scopes are validated before this boundary.
    throw projected.error;
  }
  return { key: projected.value, formatted: formatSessionKey(projected.value) };
}

function appendExpectedOutputContract(task: string, expectedOutputs: string[] | undefined): string {
  if (!expectedOutputs || expectedOutputs.length === 0) return task;
  const paths = expectedOutputs.map((filePath) => `- ${JSON.stringify(filePath)}`).join("\n");
  return (
    `${task}\n\n` +
    `Expected output contract:\n` +
    `${paths}\n` +
    `Create every file at its exact path. The completion runner validates these exact paths; ` +
    `an alternate filename or directory is treated as missing. Before your final response, verify every listed file exists.`
  );
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SubAgentRunTelemetry {
  tokensUsedTotal: number;
  costTotal: number;
  finishReason: string;
  stepsExecuted: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type SubAgentCompletion =
  | {
      endReason: "completed";
      completedAtMs: number;
      summary?: string;
      resultRef?: ResultRef;
    }
  | {
      endReason: "failed" | "killed" | "watchdog_timeout" | "ghost_sweep";
      completedAtMs: number;
      errorKind: ErrorKind;
      summary?: string;
      resultRef?: ResultRef;
    };

// @optional-field-count: 13 — these are independent routing/authority facets of
// one run. Lifecycle-dependent timing, telemetry, and completion are modeled by
// the closed variants below rather than accumulating optional mutable fields.
interface SubAgentRunCommon {
  runId: string;
  agentId: string;
  /** Authoritative caller trust captured when the spawn was accepted. */
  trustLevel: UserTrustLevel;
  task: string;
  sessionKey: string;
  conversationScope: ConversationScope;
  conversationRef: ConversationLocator["conversationRef"];
  /** Originating channel context from the spawning request */
  requesterOrigin?: DeliveryOrigin;
  /** Spawn depth in the chain (0 = first child, 1 = grandchild, etc.). */
  depth: number;
  /** Tree-stable run identity. Every run belongs to exactly one
   *  spawn tree; the root mints this id and descendants inherit it. The unified
   *  semaphore keys on it and killByRootRun enumerates a whole tree by it. */
  rootRunId: string;
  /** Exact attenuated capability ceiling accepted for this child. */
  caps: readonly AgentCapability[];
  /** Lease that authorized this spawn (revocation-cascade correlation); undefined for the root. */
  parentLeaseId?: string;
  /** This child's own assembly lease, recorded after tool assembly. */
  leaseId?: string;
  /** Session key of the caller agent, used for active children counting. */
  callerSessionKey?: string;
  callerConversation?: ConversationLocator;
  /** Immutable endpoint captured with the authenticated caller turn. */
  callerEndpoint?: ChannelEndpoint;
  /** Authenticated caller agent that owns completion delivery. */
  callerAgentId?: string;
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
  /** True when this run reserved a tree-wide ceiling slot
   *  (`checkSpawnCeiling` returned ok). The slot is released EXACTLY ONCE on the
   *  run's first terminal transition (`releaseCeilingSlotOnce` clears the flag),
   *  so a kill→later-settle or a double-fired completion never double-releases
   *  (which would steal a sibling's slot under a shared root). A promoted queued
   *  run never sets this (it never acquired) so it never releases. */
  ceilingSlotAcquired?: boolean;
}

export interface SubAgentQueuedRun extends SubAgentRunCommon {
  status: "queued";
  queuedAt: number;
  startedAt?: never;
  completion?: never;
  telemetry?: never;
}

export interface SubAgentRunningRun extends SubAgentRunCommon {
  status: "running";
  startedAt: number;
  queuedAt?: never;
  completion?: never;
  telemetry?: never;
}

export interface SubAgentCompletedRun extends SubAgentRunCommon {
  status: "completed";
  startedAt: number;
  queuedAt?: never;
  completion: Extract<SubAgentCompletion, { endReason: "completed" }>;
  telemetry: SubAgentRunTelemetry;
}

export interface SubAgentFailedRun extends SubAgentRunCommon {
  status: "failed";
  startedAt?: number;
  queuedAt?: never;
  completion: Exclude<SubAgentCompletion, { endReason: "completed" }>;
  telemetry?: SubAgentRunTelemetry;
}

export type SubAgentRun =
  | SubAgentQueuedRun
  | SubAgentRunningRun
  | SubAgentCompletedRun
  | SubAgentFailedRun;

export type SubAgentWaitResult =
  | { runId: string; status: "completed"; completion: SubAgentCompletion }
  | { runId: string; status: "denied_unknown" }
  | { runId: string; status: "timeout" }
  | { runId: string; status: "cancelled" };

/** Minimal pino-compatible logger for sub-agent runner diagnostics. */
export interface SubAgentRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface SubAgentSpawnAdmissionState {
  paused: boolean;
  acceptingSpawns: boolean;
  resetsOnRestart: true;
}

export interface SubAgentSpawnAdmissionMutation extends SubAgentSpawnAdmissionState {
  changed: boolean;
}

/** Typed, closed rejection returned when the reversible operator gate is paused. */
export class SubAgentSpawnPausedError extends Error {
  readonly reason = "spawn_paused" as const;

  constructor() {
    super("Sub-agent spawning is paused by operator");
    this.name = "SubAgentSpawnPausedError";
  }
}

export interface SubAgentRunnerDeps {
  sessionStore: Pick<SessionStorePort, "save" | "delete" | "loadByRef">;
  executeAgent: (
    agentId: string,
    sessionKey: SessionKey,
    conversation: ConversationLocator,
    task: string,
    maxSteps?: number,
    callerAgentId?: string,
    overrides?: { graphId?: string; nodeId?: string; reuseConversation?: ConversationLocator; graphNodeDepth?: number },
    /** Per-spawn token budget — becomes the child's BudgetGuard per-execution cap. */
    tokenBudget?: number,
    /** Exact parent authority used to attenuate the child's own tool assembly. */
    autonomyContext?: {
      rootRunId: string;
      parentLeaseId?: string;
      parentCaps: readonly AgentCapability[];
      onAssemblyAuthority(authority: {
        rootRunId: string;
        leaseId: string;
        caps: readonly AgentCapability[];
      }): void;
    },
  ) => Promise<{
    response: string;
    tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number };
    cost: { total: number; cacheSaved?: number };
    finishReason: string;
    stepsExecuted: number;
    toolCallHistory?: string[];
    /** Boundary-classified kind for settled failures whose finish reason does not fix one. */
    terminalErrorKind?: ErrorKind;
    errorContext?: {
      errorType: string;
      retryable: boolean;
      originalError?: string;
      failingTool?: string;
    };
  }>;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { threadId?: string }) => Promise<boolean>;
  /** Optional callback that asks the parent agent to rewrite an announcement.
   *  It returns the candidate text without performing the platform send;
   *  `undefined` means the parent intentionally chose NO_REPLY. */
  announceToParent?: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    callerConversation: ConversationLocator,
    text: string,
    channelType: string,
    channelId: string,
    options?: { threadId?: string; resolvedLanguage?: string },
  ) => Promise<string | undefined>;
  eventBus: TypedEventBus;
  config: AgentToAgentConfig;
  tenantId: string;
  /**
   * Resolve an agent's sandbox posture from its per-agent skills config
   * for the fail-closed no-downgrade gate. Injected by
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
   * Tree-wide spawn ceiling consult. Called at the spawn chokepoint —
   * the SINGLE convergence point `session.spawn`, `graph.*`, AND the in-process
   * agent loop ALL hit (they all call `runner.spawn`) — so a `for(;;) spawn()`
   * fork-bomb is bounded tree-wide where the per-caller depth/fanout gates cannot
   * (a semaphore that only sees the cap-endpoint path
   * misses the in-process path). Receives the run's tree-stable `rootRunId`, the
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
   * Symmetric release of a slot reserved by {@link checkSpawnCeiling}.
   * Called 1:1 with every successful acquire on EVERY terminal transition
   * of the run that reserved it — the run-completion `finally` and the queue-
   * timeout fail path. Without it the per-`rootRunId` `active` counter only ever
   * increments and a tree is bricked after `maxConcurrentSelfAgents` spawns
   * (a permanent spawn brick — masked only while roots never share a counter).
   * Idempotent at the sink (the semaphore floors `active` at 0). **Absent ⇒
   * inert** (older/non-daemon wiring); the daemon wires it to
   * `boundedAutonomy.releaseSpawn`.
   */
  releaseSpawnCeiling?: (rootRunId: string) => void;
  /** Optional structured logger for lifecycle diagnostics. */
  logger?: SubAgentRunnerLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: MemoryWriteEntry, scope: MemoryWriteScope): Promise<{ ok: boolean }>;
  };
  /** Optional announcement batcher for coalescing near-simultaneous completions. */
  batcher?: AnnouncementBatcher;
  /** Optional dead-letter queue for persisting failed announcement deliveries */
  deadLetterQueue?: AnnouncementDeadLetterQueue;
  /** Durable single-attempt sender for final completion-announcement delivery. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  /**
   * Shared, bounded delivered-key store, forwarded to deliverAnnouncement
   * + deliverFailureNotification so the failure-path dedup is correct whether or
   * not a batcher is wired. The daemon injects the SAME instance the batcher uses.
   */
  deliveryDedup?: DeliveryDedup;
  /** Optional live-run resolver for aborting in-flight SDK sessions on kill. */
  sessionResolver?: {
    resolveActiveSession(conversationRef: ConversationRef): { abort(): Promise<void> } | undefined;
  };
  /** Optional result condenser for compressing subagent output */
  resultCondenser?: {
    condense(params: {
      fullResult: string;
      task: string;
      runId: string;
      tenantId: string;
      sessionKey: string;
      agentId: string;
      model?: unknown;
      apiKey?: string;
      // Enriched metadata for offline analysis
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
      /** The materialized full-output handle, when produced. */
      resultRef?: ResultRef;
    }): string;
  };
  /** Base data directory for locating subagent-results (e.g., ~/.comis). Optional — caller may omit. */
  dataDir?: string;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling for the sweep interval and per-run watchdog. */
  timers: TimerPort;
  /**
   * The durable-run checkpoint store. OPTIONAL — when
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
   * The keep-alive cadence + lapsed threshold (from
   * `autonomy.durability`). `keepAliveMs` drives the heartbeat-refresh interval
   * (independent of step/spawn completion so a long-running child never looks
   * stale). Optional alongside {@link durableRuns}; defaults applied
   * when absent.
   */
  durability?: { keepAliveMs: number; staleHeartbeatMs: number };
  /**
   * Resolve the durable-checkpoint facts for a tree root —
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
  ) => {
    caps: readonly AgentCapability[];
    leaseIds: readonly string[];
    rootBudget: import("@comis/core").DurableRootBudget;
  } | undefined;
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
  /**
   * Materialize the child's FULL output to the CHILD's
   * own jailed workspace as a structured {@link ResultRef} (preview + ref +
   * bytes + kind), so the lead's announcement carries a bounded summary + a
   * HANDLE instead of the megabyte body (the longevity invariant). The daemon
   * supplies a `createResultRefStore`-backed impl targeting
   * `resolveWorkspaceDir(spawnAgentConfig, childAgentId, dataDir)`; the runner
   * stays `@comis/skills`-free (DI, mirroring {@link resultCondenser}). The
   * contract IS the store's own 3-way union — the runner discriminates it by
   * structure (a `ResultRef` has `.ref`; a refusal has `.error`; `undefined` is
   * the contained-write-failed signal). **Absent ⇒ the announcement embeds the
   * condensed summary + diskPath only (today's behavior)** — the no-op is the
   * absence of the dep / a no-handle outcome, never a flag.
   *
   * `ctx.agentId` is the CHILD's agent id — the daemon resolves the materialize
   * target (`resolveWorkspaceDir(config[agentId], agentId, dataDir)`) from it so
   * the write lands in the CHILD's OWN jailed workspace, NEVER the
   * lead's; the store is additionally `safePath`-confined to that root.
   */
  materializeFullOutput?: (
    content: string,
    ctx: { runId: string; nowMs: number; agentId: string },
  ) => Promise<ResultRef | { error: string } | undefined>;
  /**
   * Release the child session's trajectory recorder (flush + unsubscribe from
   * the shared event bus). Called EXACTLY ONCE per run, when the in-flight
   * execution settles — after the child's final records (session.summary)
   * have landed, on every terminal path (completion, failure, kill,
   * watchdog). Production wiring binds this to
   * `SessionTrajectoryHandleRegistry.close`; absent ⇒ no-op (older test
   * wiring). Without it a terminal child's recorder stays subscribed for the
   * daemon's lifetime and keeps ingesting other sessions' events into the
   * dead child's trajectory file.
   */
  closeTrajectory?: (formattedSessionKey: string) => Promise<void>;
}

export interface SpawnParams {
  task: string;
  agentId: string;
  callerSessionKey?: string;
  callerConversation?: ConversationLocator;
  /** Trusted caller endpoint for context-independent graph/control-plane spawns. */
  callerEndpoint?: ChannelEndpoint;
  callerAgentId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  model?: string;
  max_steps?: number;
  /** Per-spawn token budget — becomes the child's BudgetGuard per-execution cap.
   *  Threaded SpawnParams -> ExecuteSubAgentFn -> ExecutionOverrides -> resetExecution(cap).
   *  When absent, the child enforces config.perExecution unchanged. */
  tokenBudget?: number;
  expected_outputs?: string[];
  /** Originating channel context for default announcement routing */
  requesterOrigin?: DeliveryOrigin;
  /** Current spawn depth in the chain (0 = top-level agent spawning its first child). */
  depth?: number;
  /** Maximum allowed spawn depth from config. */
  maxDepth?: number;
  /** Tree-stable run identity. Established ONCE at the root spawn
   *  (depth 0) and propagated to every descendant so the tree-wide semaphore
   *  and kill-by-root primitive see one id per spawn tree. When absent, spawn() mints
   *  one (the root); a child MUST pass its parent's id down — a fresh id per child would
   *  escape the parent's ceiling (a silent under-count). */
  rootRunId?: string;
  /** Lease that authorized this spawn (revocation-cascade correlation). Recorded on the
   *  run so a future revoke-by-root can map runs to leases; omitted for the root. */
  parentLeaseId?: string;
  /**
   * The REAL cron signal carried from the cron-fire
   * turn metadata (`metadata.isCronAgentTurn` — see prompt-assembly.ts:676). When
   * a sub-agent is spawned during a cron-fired turn, the caller threads this from
   * the turn metadata so the durable checkpoint records a non-null `cronOrigin`
   * (the jobId). A non-cron spawn leaves it false → cronOrigin = null. There is NO
   * `cronOrigin` string parameter — the runner DERIVES it from this flag + jobId.
   */
  isCronAgentTurn?: boolean;
  /** The firing cron job's id — the cronOrigin value when `isCronAgentTurn`. */
  jobId?: string;
  /** The firing cron job's name — the cronOrigin fallback when jobId is absent. */
  jobName?: string;
  /**
   * The ATTENUATED caps this run was minted with (the lease's
   * caps). Threaded from the spawn caller (the cap layer / cron-fire mint) so the
   * durable checkpoint records the exact caps a resume must re-mint VERBATIM
   * (never re-attenuated). When absent, `durableRunFacts` (deps) is consulted; if
   * both are absent the checkpoint records an empty set (a safe degrade).
   */
  caps?: readonly AgentCapability[];
  /** Caller boundary. GraphCoordinator bypasses the children limit; the
   *  authenticated control plane bypasses agent-principal binding only. */
  callerType?: "agent" | "graph" | "control-plane" | "durable-resume";
  /**
   * Attempt identity reserved by GraphCoordinator and persisted in its running
   * launch claim before this runner is allowed to start the side effect. Honored
   * only for graph-owned spawns.
   */
  reservedRunId?: string;
  /**
   * Authoritative trust snapshot for a graph run. Only graph-marked spawns
   * consume this field; direct spawns always read trust from the live parent
   * RequestContext. GraphCoordinator resolves it once at graph submission so
   * later queued/dependent nodes cannot inherit whichever ALS happens to drive
   * their promotion.
   */
  callerTrustLevel?: UserTrustLevel;
  /** File paths for the sub-agent to reference. */
  artifactRefs?: string[];
  /** Objective statement that survives context compaction. */
  objective?: string;
  /** Domain knowledge entries for the sub-agent. */
  domainKnowledge?: string[];
  /** Tool group names for sub-agent tool filtering. */
  toolGroups?: string[];
  /** Inherited reply language from the parent ALS; persisted into child
   *  session metadata as `language` so it survives the spawn round-trip. */
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
  reuseConversation?: ConversationLocator;
  /** Graph node depth: 0 = root node (dependsOn=[]), 1+ = downstream.
   *  Used for depth-aware cache retention in setup-cross-session. */
  graphNodeDepth?: number;
  /** True when this graph node is a leaf (no other node depends on it).
   *  Leaf nodes use "short" (5m) cache retention instead of the 1h default
   *  because their cache prefix has no downstream consumers. */
  isLeafNode?: boolean;
  /**
   * Run this child in an ISOLATED git worktree (its own working tree on a
   * fresh branch rooted under the child's jailed workspace) so parallel children
   * never clobber each other's files. The runner is @comis/skills-free, so it does
   * NOT create the worktree itself — it persists this flag onto the child session
   * metadata (`worktree`), and the daemon's executeSubAgent (which holds the
   * GitExec seam + the workspace resolver) reads the metadata, creates the
   * worktree, runs the child in it, and auto-cleans-if-unchanged on completion.
   * Absent/false ⇒ the child runs in its normal jailed workspace (the default).
   */
  worktree?: boolean;
  workspacePolicyHash?: string;
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
  interface CompletionDeferred {
    promise: Promise<SubAgentCompletion>;
    resolve(completion: SubAgentCompletion): void;
    settled: boolean;
  }
  const completionDeferreds = new Map<string, CompletionDeferred>();
  const activePromises = new Set<Promise<void>>();
  const activeRunIds = new Set<string>();
  const providerSettledRunIds = new Set<string>();
  const deliverySuppressedRunIds = new Set<string>();
  const forcedTerminalRunIds = new Set<string>();
  const trajectoryClosedRunIds = new Set<string>();
  const watchdogTimers = new Map<string, TimerHandle>();
  const failureNotificationPromises = new Set<Promise<void>>();
  let acceptingSpawns = true;
  let spawnPaused = false;
  let shutdownPromise: Promise<void> | undefined;

  function createCompletionDeferred(runId: string): void {
    let resolvePromise!: (completion: SubAgentCompletion) => void;
    const deferred: CompletionDeferred = {
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      }),
      resolve(completion) {
        if (deferred.settled) return;
        deferred.settled = true;
        resolvePromise(completion);
      },
      settled: false,
    };
    completionDeferreds.set(runId, deferred);
  }

  function boundedCompletionSummary(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const sanitized = sanitizeAssistantResponse(text).trim();
    if (sanitized.length === 0) return undefined;
    return sanitized.slice(0, SUBAGENT_RESULT_SUMMARY_MAX_CHARS);
  }

  function classifyCompletionErrorKind(
    finishReason: string,
    terminalErrorKind: ErrorKind | undefined,
  ): ErrorKind {
    if (finishReason === "error" || finishReason === "completed_with_tool_errors") {
      return terminalErrorKind ?? "internal";
    }
    const parsed = AgentExecutionFinishReasonSchema.safeParse(finishReason);
    return parsed.success
      ? classifyAgentFinishErrorKind(parsed.data) ?? "internal"
      : "internal";
  }

  function freezeResultRef(resultRef: ResultRef | undefined): ResultRef | undefined {
    if (!resultRef) return undefined;
    const copy: ResultRef = {
      ...resultRef,
      ...(resultRef.schema ? { schema: [...resultRef.schema] } : {}),
    };
    if (copy.schema) Object.freeze(copy.schema);
    return Object.freeze(copy);
  }

  function freezeCompletion(completion: SubAgentCompletion): SubAgentCompletion {
    const summary = boundedCompletionSummary(completion.summary);
    const resultRef = freezeResultRef(completion.resultRef);
    if (completion.endReason === "completed") {
      return Object.freeze({
        endReason: completion.endReason,
        completedAtMs: completion.completedAtMs,
        ...(summary ? { summary } : {}),
        ...(resultRef ? { resultRef } : {}),
      });
    }
    return Object.freeze({
      endReason: completion.endReason,
      completedAtMs: completion.completedAtMs,
      errorKind: completion.errorKind,
      ...(summary ? { summary } : {}),
      ...(resultRef ? { resultRef } : {}),
    });
  }

  function terminalizeRun(
    runId: string,
    completionInput: SubAgentCompletion,
    telemetry?: SubAgentRunTelemetry,
  ): SubAgentCompletedRun | SubAgentFailedRun {
    const current = runs.get(runId);
    if (!current) {
      // @allow-throw: terminalization is private to admitted run lifecycle paths; a missing record is an internal invariant.
      throw new Error("Cannot terminalize an untracked sub-agent run");
    }
    if (current.status === "completed" || current.status === "failed") return current;

    const completion = freezeCompletion(completionInput);
    let terminal: SubAgentCompletedRun | SubAgentFailedRun;
    if (completion.endReason === "completed") {
      if (current.status !== "running") {
        // @allow-throw: queued runs cannot complete successfully without first entering the running variant.
        throw new Error("A queued sub-agent run cannot complete before execution starts");
      }
      const { status: _status, ...base } = current;
      terminal = {
          ...base,
          status: "completed",
          completion,
          telemetry: telemetry ?? {
            tokensUsedTotal: 0,
            costTotal: 0,
            finishReason: "stop",
            stepsExecuted: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
    } else {
      const base = current.status === "queued"
        ? (({ status: _status, queuedAt: _queuedAt, ...common }) => common)(current)
        : (({ status: _status, ...common }) => common)(current);
      terminal = {
          ...base,
          status: "failed",
          completion,
          ...(telemetry ? { telemetry } : {}),
        };
    }
    runs.set(runId, terminal);
    removeDedupEntry(terminal);
    completionDeferreds.get(runId)?.resolve(completion);
    return terminal;
  }

  function waitForCompletion(runId: string): Promise<SubAgentCompletion> | undefined {
    const run = runs.get(runId);
    if (!run) return undefined;
    if (run.status === "completed" || run.status === "failed") {
      const retained = completionDeferreds.get(runId);
      return retained?.promise ?? Promise.resolve(run.completion);
    }
    return completionDeferreds.get(runId)?.promise;
  }

  async function waitForCompletions(
    requestedRunIds: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentWaitResult[]> {
    const runIds = [...new Set(requestedRunIds)];
    const immediate = new Map<string, SubAgentWaitResult>();
    const pending: Array<{ runId: string; promise: Promise<SubAgentCompletion> }> = [];

    for (const runId of runIds) {
      const run = runs.get(runId);
      if (!run) {
        immediate.set(runId, { runId, status: "denied_unknown" });
        continue;
      }
      if (run.status === "completed" || run.status === "failed") {
        immediate.set(runId, { runId, status: "completed", completion: run.completion });
        continue;
      }
      const promise = waitForCompletion(runId);
      if (!promise) {
        immediate.set(runId, { runId, status: "denied_unknown" });
        continue;
      }
      pending.push({ runId, promise });
    }

    if (pending.length === 0) {
      return runIds.map((runId) => immediate.get(runId)!);
    }
    if (signal?.aborted) {
      for (const entry of pending) {
        immediate.set(entry.runId, { runId: entry.runId, status: "cancelled" });
      }
      return runIds.map((runId) => immediate.get(runId)!);
    }
    if (timeoutMs <= 0) {
      for (const entry of pending) {
        immediate.set(entry.runId, { runId: entry.runId, status: "timeout" });
      }
      return runIds.map((runId) => immediate.get(runId)!);
    }

    let deadlineHandle: TimerHandle | undefined;
    let removeAbortListener: (() => void) | undefined;
    const deadline = new Promise<"timeout" | "cancelled">((resolve) => {
      deadlineHandle = timers.setTimeout(() => resolve("timeout"), timeoutMs);
      deadlineHandle.unref();
      if (signal) {
        const onAbort = (): void => resolve("cancelled");
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
    });

    const settled = await Promise.all(pending.map(async ({ runId, promise }) => {
      const outcome = await Promise.race([
        promise.then((completion) => ({ status: "completed" as const, completion })),
        deadline.then((status) => ({ status })),
      ]);
      return outcome.status === "completed"
        ? { runId, status: "completed" as const, completion: outcome.completion }
        : { runId, status: outcome.status };
    }));
    deadlineHandle?.cancel();
    removeAbortListener?.();
    for (const result of settled) immediate.set(result.runId, result);
    return runIds.map((runId) => immediate.get(runId)!);
  }

  function trackFailureNotification(promise: Promise<void>): void {
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    failureNotificationPromises.add(tracked);
    void tracked.then(() => failureNotificationPromises.delete(tracked));
  }

  // -------------------------------------------------------------------------
  // Durable checkpoint + keep-alive heartbeat.
  // Inert when `deps.durableRuns` is absent (the default install). The
  // heartbeat timer is tracked per runId so the terminal `finally` clears it
  // (no leaked interval). Store calls are best-effort — a write error is
  // WARN-logged but NEVER crashes the live run (durability is a recovery aid).
  // -------------------------------------------------------------------------
  const heartbeatTimers = new Map<string, TimerHandle>();
  const resumeDescriptors = new Map<string, SubAgentResumeDescriptor>();
  const DURABLE_KEEPALIVE_MS = deps.durability?.keepAliveMs ?? 30_000;

  /**
   * Derive the `cronOrigin` from the REAL cron signal threaded onto the
   * spawn params (`isCronAgentTurn` + `jobId`/`jobName`). A cron-fired turn's
   * sub-agent records the firing job's id; a non-cron spawn records null. There
   * is NO `cronOrigin` string parameter — this IS the derivation.
   */
  function deriveCronOrigin(params: SpawnParams): string | null {
    return params.isCronAgentTurn === true ? (params.jobId ?? params.jobName ?? "cron") : null;
  }

  /**
   * Write the initial execution checkpoint at the spawn boundary and start
   * the keep-alive heartbeat.
   * Inert when no store is wired. Never throws.
   */
  function persistDurableCheckpoint(run: SubAgentRun, params: SpawnParams): void {
    const store = deps.durableRuns;
    if (!store) return;
    const rootRunId = run.rootRunId;
    const facts = deps.durableRunFacts?.(rootRunId, params.agentId);
    const leaseIds = facts?.leaseIds ?? [run.parentLeaseId, run.leaseId]
      .filter((leaseId): leaseId is string => leaseId !== undefined);
    const rootBudget = facts?.rootBudget ?? {
      startedAtMs: clock.now(),
      tokensConsumed: 0,
      usdConsumed: 0,
    };
    const cronOrigin = deriveCronOrigin(params);
    const partition = run.conversationScope.partition;
    if (partition.kind !== "endpoint-conversation-principal") {
      deps.logger?.warn(
        {
          runId: run.runId,
          rootRunId,
          hint: "Persist the child with the canonical sub-agent principal partition before starting durability",
          errorKind: "validation" as const,
        },
        "Durable checkpoint skipped: invalid child conversation authority",
      );
      return;
    }
    void store
      .upsertCheckpoint({
        checkpointId: run.runId,
        rootRunId,
        tenantId: run.conversationScope.tenantId,
        agentId: run.agentId,
        conversationRef: run.conversationRef,
        conversationScope: run.conversationScope,
        principalId: partition.principalId,
        deliveryOrigin: run.requesterOrigin ?? null,
        spawnTree: [run.runId],
        // Copy into mutable arrays — DurableRunRecord's caps/leaseIds are mutable
        // (the Zod-inferred shape); the deps/params surfaces are readonly.
        caps: [...run.caps],
        leaseIds: [...leaseIds],
        budgetConsumed: rootBudget.usdConsumed,
        rootBudget,
        cronOrigin,
        trustLevel: run.trustLevel,
        status: "running",
        lastHeartbeatAt: clock.now(),
        scriptRef: null,
        checkpointRef: null,
        workspacePolicyHash: params.workspacePolicyHash ?? tryGetContext()?.workspacePolicyHash,
        ...(resumeDescriptors.has(run.runId)
          ? { resumeDescriptorHash: hashSubAgentResumeDescriptor(resumeDescriptors.get(run.runId)!) }
          : {}),
      })
      .then((r) => {
        if (!r.ok) {
          deps.logger?.warn(
            { rootRunId, err: toSafeErrorLogString(r.error), hint: "durable checkpoint upsert failed — the run still proceeds; it will not be resumable after a crash", errorKind: "internal" as const },
            "Durable checkpoint: upsert failed (run continues)",
          );
        }
      })
      .catch((err: unknown) => {
        deps.logger?.warn(
          { rootRunId, err: toSafeErrorLogString(err), hint: "durable checkpoint upsert threw — the run still proceeds", errorKind: "internal" as const },
          "Durable checkpoint: upsert threw (run continues)",
        );
      });
  }

  /** Write the initial durable row and start its independent keep-alive. */
  function startDurableCheckpoint(run: SubAgentRun, params: SpawnParams): void {
    const store = deps.durableRuns;
    if (!store) return;
    persistDurableCheckpoint(run, params);

    // A keep-alive that fires INDEPENDENT of step/spawn completion so a
    // long-running child never trips the watchdog's stale threshold.
    // One interval per run, cleared on terminal settle (no leaked timer).
    if (!heartbeatTimers.has(run.runId)) {
      const handle = timers.setInterval(() => {
        persistDurableCheckpoint(run, params);
      }, DURABLE_KEEPALIVE_MS);
      handle.unref();
      heartbeatTimers.set(run.runId, handle);
    }
  }

  /**
   * Terminal seam: mark the run completed + clear its keep-alive
   * heartbeat. Fires on EVERY terminal settle of a started run (completion,
   * failure, kill/ghost/watchdog — the underlying executeAgent promise still
   * settles), so the interval is reclaimed and the durable record stops being
   * resumable. Inert + idempotent when no store / no timer. Never throws.
   */
  function finishDurableCheckpoint(
    run: SubAgentRun,
    terminalReason: DurableRunTerminalReason,
  ): void {
    const handle = heartbeatTimers.get(run.runId);
    if (handle) {
      handle.cancel();
      heartbeatTimers.delete(run.runId);
    }
    const store = deps.durableRuns;
    if (!store) return;
    suppressError(
      store
        .markCompleted(run.runId, terminalReason)
        .then((r) => {
          if (!r.ok) {
            deps.logger?.warn(
              { rootRunId: run.rootRunId, err: r.error, hint: "durable markCompleted failed — the watchdog will eventually orphan-sweep the stale record (no live impact)", errorKind: "internal" as const },
              "Durable checkpoint: markCompleted failed",
            );
          }
        }),
      "durable terminal markCompleted (best-effort)",
    );
  }

  function closeTrajectoryOnce(run: SubAgentRun): void {
    if (!deps.closeTrajectory || trajectoryClosedRunIds.has(run.runId)) return;
    trajectoryClosedRunIds.add(run.runId);
    suppressError(
      deps.closeTrajectory(run.sessionKey),
      "sub-agent trajectory close",
      (message) => deps.logger?.debug({ runId: run.runId }, message),
    );
  }

  function forceTerminalCleanup(
    run: SubAgentRun,
    terminalReason: Exclude<DurableRunTerminalReason, "completed" | "failed">,
  ): void {
    if (forcedTerminalRunIds.has(run.runId)) return;
    forcedTerminalRunIds.add(run.runId);
    watchdogTimers.get(run.runId)?.cancel();
    watchdogTimers.delete(run.runId);
    finishDurableCheckpoint(run, terminalReason);
    stopProgressFork(run);
    closeTrajectoryOnce(run);
  }

  // -------------------------------------------------------------------------
  // The ~30s read-only progress fork (coordinator-progress-fork.ts).
  // One fork per running child, tracked by runId so the terminal `finally`
  // stops it (no leaked timer — the fork's interval is .unref()'d). The fork is
  // a READ-ONLY summary of the in-flight child's advance — it never re-executes,
  // calls a tool, or spawns. It runs INDEPENDENT of the durable store (a long
  // child should surface progress even when durability is off), so it is started
  // at the spawn boundary alongside — but not inside — startDurableCheckpoint.
  // -------------------------------------------------------------------------
  const progressForks = new Map<string, CoordinatorProgressForkHandle>();

  /**
   * Start the read-only progress fork for a just-started child run. `getStepState`
   * currently reports `stepsExecuted: 0`; the elapsed wall-clock is the advance
   * signal. Provider output and terminal telemetry are deliberately not retained
   * on the active run.
   * Idempotent per runId. No model call, no tool, no spawn.
   */
  function startProgressFork(run: SubAgentRun, params: SpawnParams): void {
    if (progressForks.has(run.runId)) return;
    const fork = createCoordinatorProgressFork({
      eventBus: deps.eventBus,
      clock,
      timers,
      runId: run.runId,
      agentId: params.agentId,
      getStepState: () => ({ stepsExecuted: 0 }),
    });
    fork.start();
    progressForks.set(run.runId, fork);
  }

  /**
   * Stop + reclaim a child's progress fork on its terminal settle. Idempotent +
   * inert when none was started (e.g. a queued run that never ran). Mirrors
   * finishDurableCheckpoint's terminal-seam discipline — the fork never outlives
   * the child.
   */
  function stopProgressFork(run: SubAgentRun): void {
    const fork = progressForks.get(run.runId);
    if (!fork) return;
    fork.stop();
    progressForks.delete(run.runId);
  }

  // Make the fail-OPEN observable. The sandbox no-downgrade gate (below)
  // silently no-ops when `resolvePosture` is absent — a critical security control that
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
    return (
      params.callerSessionKey !== undefined
      && params.callerType !== "graph"
      && params.callerType !== "durable-resume"
    );
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
   * Release a run's reserved tree-wide ceiling slot EXACTLY ONCE.
   * Pairs 1:1 with the `checkSpawnCeiling` acquire recorded on the run.
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
      durationMs: Math.max(0, clock.now() - (run.startedAt ?? clock.now())),
      timestamp: clock.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Auto-archive sweep (every 5 minutes)
  // -------------------------------------------------------------------------

  const SWEEP_INTERVAL_MS = 300_000;
  const MAX_RUNS = 1000;

  // DLQ recovery sink — when a dead-lettered announcement is finally
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
        now - run.completion.completedAtMs > retentionMs
      ) {
        const deleted = deps.sessionStore.delete(run.conversationScope);
        if (!deleted.ok) {
          deps.logger?.warn({
            runId,
            conversationRef: run.conversationRef,
            hint: "Inspect session database integrity; the retention sweep will retry on its next pass",
            errorKind: deleted.error.errorKind,
          }, "Sub-agent session archive failed");
          continue;
        }

        deps.eventBus.emit("session:sub_agent_archived", {
          runId,
          sessionKey: run.sessionKey,
          ageMs: now - run.completion.completedAtMs,
          timestamp: now,
        });

        deps.logger?.debug({ runId, ageMs: now - run.completion.completedAtMs }, "Sub-agent run auto-archived");
        // Belt-and-suspenders: terminal-transition sites already remove the
        // dedup entry, but archive is the last chance to evict if those missed.
        removeDedupEntry(run);
        runs.delete(runId);
        completionDeferreds.delete(runId);
        forcedTerminalRunIds.delete(runId);
        trajectoryClosedRunIds.delete(runId);
        resumeDescriptors.delete(runId);
      }
    }

    // Size cap: prune oldest completed runs if over limit
    if (runs.size > MAX_RUNS) {
      const completedRuns = [...runs.entries()]
        .filter(([, r]) => r.status === "completed" || r.status === "failed")
        .sort((a, b) => {
          const aCompleted = a[1].status === "completed" || a[1].status === "failed"
            ? a[1].completion.completedAtMs
            : 0;
          const bCompleted = b[1].status === "completed" || b[1].status === "failed"
            ? b[1].completion.completedAtMs
            : 0;
          return aCompleted - bCompleted;
        });

      const toRemove = runs.size - MAX_RUNS;
      for (let i = 0; i < toRemove && i < completedRuns.length; i++) {
        const [pruneRunId, pruneRun] = completedRuns[i]!;
        removeDedupEntry(pruneRun);
        runs.delete(pruneRunId);
        completionDeferreds.delete(pruneRunId);
        forcedTerminalRunIds.delete(pruneRunId);
        trajectoryClosedRunIds.delete(pruneRunId);
        resumeDescriptors.delete(pruneRunId);
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
            const errorMessage = `Queue timeout: waited ${queueTimeoutMs}ms for an execution slot`;
            terminalizeRun(entry.runId, {
              endReason: "failed",
              completedAtMs: now,
              errorKind: "timeout",
              summary: errorMessage,
            });

            deps.eventBus.emit("session:sub_agent_spawn_rejected", {
              parentSessionKey: callerKey,
              agentId: run.agentId,
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

      deliverySuppressedRunIds.add(runId);
      const errorMessage = `Ghost run: stuck in 'running' for ${(runningDurationMs / 1000).toFixed(0)}s (grace: ${(ghostGraceMs / 1000).toFixed(0)}s)`;
      terminalizeRun(runId, {
        endReason: "ghost_sweep",
        completedAtMs: now,
        errorKind: "timeout",
        summary: errorMessage,
      });
      forceTerminalCleanup(run, "ghost_sweep");

      // Persist failure record
      if (deps.dataDir) {
        suppressError(
          persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: run.sessionKey,
            runId,
            task: run.task,
            error: errorMessage,
            endReason: "ghost_sweep",
            runtimeMs: runningDurationMs,
          }, deps.logger),
          "ghost-sweep-failure-record",
        );
      }

      // Abort SDK session (best-effort, composite-key resolver)
      if (deps.sessionResolver) {
        const handle = deps.sessionResolver.resolveActiveSession(run.conversationRef);
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
        trackFailureNotification(deliverFailureNotification({
          channelType: run.announceChannelType,
          channelId: run.announceChannelId,
          task: run.task,
          runtimeMs: runningDurationMs,
          runId,
          threadId: resolveAnnouncementThreadId(
            run.requesterOrigin,
            run.announceChannelType,
            run.announceChannelId,
          ),
          callerAgentId: run.callerAgentId,
          callerSessionKey: run.callerSessionKey,  // shared dedup key
          callerConversation: run.callerConversation,
          destinationEndpoint: run.callerEndpoint,
        }, deps));
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
    if (!acceptingSpawns) {
      // @allow-throw: spawn() is the synchronous daemon RPC boundary and must reject admission after shutdown starts.
      throw new Error("Sub-agent runner is shutting down");
    }
    if (spawnPaused) {
      const currentDepth = params.depth ?? 0;
      const maxDepth = params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;
      const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
      deps.eventBus.emit("session:sub_agent_spawn_rejected", {
        parentSessionKey: params.callerSessionKey ?? "unknown",
        agentId: params.agentId,
        reason: "spawn_paused",
        currentDepth,
        maxDepth,
        currentChildren: 0,
        maxChildren,
        timestamp: clock.now(),
      });
      deps.logger?.warn(
        {
          agentId: params.agentId,
          reason: "spawn_paused",
          hint: "Resume sub-agent admission with the admin subagent.resume operation when new background work is allowed",
          errorKind: "precondition" as const,
        },
        "Sub-agent spawn rejected: admission paused",
      );
      // @allow-throw: spawn() is the synchronous daemon RPC boundary and reports the closed operator-pause rejection.
      throw new SubAgentSpawnPausedError();
    }
    // Reset dedup signal at the start of every call so a non-deduped spawn
    // does not see a stale hit from the previous invocation.
    lastDedupHit = undefined;

    const requesterOrigin = params.requesterOrigin;
    const isGraphSpawn = params.callerType === "graph";
    const isDurableResume = params.callerType === "durable-resume";
    if ((isGraphSpawn || isDurableResume) && params.reservedRunId !== undefined && runs.has(params.reservedRunId)) {
      // @allow-throw: graph launch identity collisions are rejected before any spawn ceiling is acquired.
      throw new Error("Graph spawn reserved run identity is already active");
    }
    const isContextIndependentSpawn =
      isGraphSpawn || isDurableResume || params.callerType === "control-plane";
    const callerContext = tryGetContext();
    const hasExplicitAnnouncementRoute = params.announceChannelType !== undefined
      || params.announceChannelId !== undefined;
    const reuseConversation = params.reuseConversation;
    const callerEndpoint = isContextIndependentSpawn
      ? params.callerEndpoint
      : callerContext?.turnScope?.endpoint;

    const rejectCallerPrincipal = (): never => {
      deps.logger?.warn({
        agentId: params.agentId,
        reason: "caller_principal_mismatch",
        hint: "Reject the spawn and verify the caller session, agent, and delivery route were copied from the active request context",
        errorKind: "auth" as const,
      }, "Sub-agent spawn rejected: caller principal mismatch");
      // @allow-throw: spawn() is a daemon RPC boundary and rejects forged caller identity before creating a run or session.
      throw new Error("Spawn rejected: caller principal does not match the active request context");
    };
    const rejectAnnouncementRoute = (): never => {
      deps.logger?.warn({
        agentId: params.agentId,
        reason: "announcement_route_mismatch",
        hint: "Reject the spawn; agent-origin delivery is bound to the authenticated request, so omit explicit announcement route fields",
        errorKind: "auth" as const,
      }, "Sub-agent spawn rejected: announcement route mismatch");
      // @allow-throw: spawn() is a daemon RPC boundary and rejects forged delivery routing before creating a run or session.
      throw new Error("Spawn rejected: announcement route does not match the authenticated requester");
    };

    // GraphCoordinator snapshots and authorizes graph nodes independently, and
    // route-less daemon jobs may call the runner outside ALS. A direct spawn
    // that does have ambient request identity must bind every supplied caller
    // field to that principal exactly; partial or stale async state cannot pick
    // another parent session, agent, chat, or announcement destination.
    if (params.callerType === "agent" && callerContext === undefined) {
      rejectCallerPrincipal();
    }
    if (!isContextIndependentSpawn && callerContext !== undefined) {
      const contextualCaller = callerContext.turnScope === undefined
        ? undefined
        : createConversationLocator(callerContext.turnScope.conversation);
      if (
        callerContext.userId === undefined
        || callerContext.sessionKey === undefined
        || callerContext.agentId === undefined
        || callerContext.turnScope === undefined
        || params.callerSessionKey !== callerContext.sessionKey
        || params.callerAgentId !== callerContext.agentId
        || params.callerConversation === undefined
        || contextualCaller === undefined
        || !contextualCaller.ok
        || params.callerConversation.conversationRef !== contextualCaller.value.conversationRef
        || (
          reuseConversation !== undefined
          && (
            reuseConversation.conversationScope.tenantId !== callerContext.tenantId
          )
        )
      ) {
        rejectCallerPrincipal();
      }

      const contextOrigin = callerContext.deliveryOrigin;
      if (
        requesterOrigin !== undefined
        && (
          contextOrigin === undefined
          || (
            contextOrigin.tenantId !== requesterOrigin.tenantId
            || contextOrigin.userId !== requesterOrigin.userId
            || contextOrigin.channelType !== requesterOrigin.channelType
            || contextOrigin.channelId !== requesterOrigin.channelId
            || contextOrigin.threadId !== requesterOrigin.threadId
            || (
              callerContext.channelType !== undefined
              && callerContext.channelType !== requesterOrigin.channelType
            )
          )
        )
      ) {
        rejectCallerPrincipal();
      }
      if (
        hasExplicitAnnouncementRoute
        && (
          requesterOrigin === undefined
          || params.announceChannelType !== requesterOrigin.channelType
          || params.announceChannelId !== requesterOrigin.channelId
        )
      ) {
        rejectAnnouncementRoute();
      }
    }
    const announcementRouteMismatch = requesterOrigin !== undefined
      && (
        requesterOrigin.tenantId !== deps.tenantId
        || (hasExplicitAnnouncementRoute && (
          params.announceChannelType === undefined
          || params.announceChannelId === undefined
          || params.announceChannelType !== requesterOrigin.channelType
          || params.announceChannelId !== requesterOrigin.channelId
        ))
        || (reuseConversation !== undefined && (
          reuseConversation.conversationScope.tenantId !== requesterOrigin.tenantId
        ))
        || (callerEndpoint !== undefined && (
          callerEndpoint.channelType !== requesterOrigin.channelType
          || callerEndpoint.conversationId !== requesterOrigin.channelId
          || callerEndpoint.threadId !== requesterOrigin.threadId
        ))
      );
    if (announcementRouteMismatch) {
      deps.logger?.warn({
        agentId: params.agentId,
        reason: "announcement_route_mismatch",
        hint: "Spawn rejected because the requested announcement route or reused session does not belong to the authenticated requester",
        errorKind: "precondition" as const,
      }, "Sub-agent spawn rejected: announcement route mismatch");
      // @allow-throw: spawn() is a daemon RPC boundary and rejects forged routing before creating a run or session.
      throw new Error("Spawn rejected: announcement route does not match the authenticated requester");
    }

    // 0. Resolve depth and config values for limit enforcement
    const currentDepth = params.depth ?? 0;
    const maxDepth = params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;
    // Snapshot authorization at the acceptance boundary. Direct spawns trust
    // only the live framework context; a caller-provided field cannot elevate
    // them. Graph nodes consume the coordinator's submission-time snapshot.
    // Missing context/data is guest, never the RequestContext schema default.
    const acceptedTrustLevel: UserTrustLevel = isGraphSpawn || isDurableResume
      ? params.callerTrustLevel ?? "guest"
      : callerContext?.trustLevel ?? "guest";

    if (reuseConversation !== undefined) {
      if (reuseConversation.conversationScope.tenantId !== deps.tenantId) {
        deps.logger?.warn({
          agentId: params.agentId,
          reason: "reused_session_tenant_mismatch",
          hint: "Reject the spawn and use a persistent session from the configured tenant",
          errorKind: "auth" as const,
        }, "Sub-agent spawn rejected: reused session tenant mismatch");
        // @allow-throw: spawn() is a daemon RPC boundary and rejects cross-tenant session reuse before creating a run.
        throw new Error("Spawn rejected: reused session tenant does not match the configured tenant");
      }
      const persistedSession = deps.sessionStore.loadByRef(
        {
          tenantId: reuseConversation.conversationScope.tenantId,
          agentId: reuseConversation.conversationScope.agentId,
        },
        reuseConversation.conversationRef,
      );
      if (!persistedSession.ok) throw persistedSession.error;
      if (persistedSession.value !== undefined) {
        if (persistedSession.value.conversationScope.agentId !== params.agentId) {
          deps.logger?.warn({
            agentId: params.agentId,
            reason: "reused_session_owner_mismatch",
            hint: "Reject the spawn and use a persistent session owned by the requested child agent",
            errorKind: "auth" as const,
          }, "Sub-agent spawn rejected: reused session ownership mismatch");
          // @allow-throw: spawn() is a daemon RPC boundary and rejects cross-agent session reuse before creating a run.
          throw new Error("Spawn rejected: reused session ownership does not match the requested agent");
        }
      }
    }

    // Establish the tree-stable rootRunId. The root
    // (the first caller with no rootRunId) mints one; every descendant MUST pass its
    // parent's id down via params.rootRunId. We mint whenever it is absent — regardless
    // of depth — so a missing id never silently splits a tree into per-spawn ids that
    // each escape the parent's ceiling. Uses the injected
    // ClockPort (never the wall-clock global — the globals.test.ts arch-gate).
    const rootRunId = params.rootRunId ?? `root-${params.agentId}-${clock.now().toString(36)}`;
    const acceptedCaps = [
      ...(params.caps
        ?? deps.durableRunFacts?.(rootRunId, params.agentId)?.caps
        ?? []),
    ];

    // Depth check (applies to ALL spawns including graph)
    if (currentDepth >= maxDepth) {
      deps.eventBus.emit("session:sub_agent_spawn_rejected", {
        parentSessionKey: params.callerSessionKey ?? "unknown",
        agentId: params.agentId,
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

    // Sandbox no-downgrade gate. The single fail-closed posture
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
    // `config.agents[...]`.
    //
    // ORDERING (intentional): this fail-closed gate runs BEFORE the
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
          // Enum labels only — never posture values/paths/hosts in log fields.
          violatedDimensions: cmp.violatedDimensions,
          hint:
            `Spawn refused: child sandbox posture is less confined than its spawner on ${violated}; ` +
            "align the child's skills sandbox config or set security.agentToAgent.sandboxNoDowngrade:false to disable",
          errorKind: "precondition" as const,
        }, "Sub-agent spawn refused: sandbox downgrade");
        // Typed refusal event: both postures as enum TUPLES + the
        // violated dimension labels + the two agent ids — labels only, NO
        // paths/hosts/uid-numbers/credential values. Fires
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
        // Typed: classifyRpcError maps SandboxDowngradeError to
        // precondition/warn — this fail-closed SECURITY refusal must NOT read as an
        // internal/error handler fault in an operator's ERROR-level health sweep.
        throw new SandboxDowngradeError(
          `Spawn refused: child "${params.agentId}" sandbox posture is less confined than parent "${params.callerAgentId}" on: ${violated}.`,
          cmp.violatedDimensions,
        );
      }
    }

    // Children check (bypassed for graph spawns)
    if (!isGraphSpawn && !isDurableResume && params.callerSessionKey) {
      const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
      const activeChildren = countActiveChildren(params.callerSessionKey);
      if (activeChildren >= maxChildren) {
        const maxQueuedPerAgent = deps.config.subagentContext?.maxQueuedPerAgent ?? 10;

        // maxQueuedPerAgent === 0 means queuing is disabled -- preserve old throw behavior
        if (maxQueuedPerAgent === 0) {
          deps.eventBus.emit("session:sub_agent_spawn_rejected", {
            parentSessionKey: params.callerSessionKey,
            agentId: params.agentId,
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
        const queuedPrincipalId = params.callerConversation?.conversationScope.partition.kind
          === "endpoint-conversation-principal"
          ? params.callerConversation.conversationScope.partition.principalId
          : params.requesterOrigin?.userId ?? `sub-agent:${queuedRunId}`;
        const queuedConversation = params.reuseConversation
          ?? createSubAgentConversation(
            deps.tenantId,
            params.agentId,
            queuedRunId,
            queuedPrincipalId,
          );
        const queuedDisplay = displayKeyForConversation(queuedConversation);
        const now = clock.now();
        const queuedRun: SubAgentRun = {
          runId: queuedRunId,
          status: "queued",
          agentId: params.agentId,
          trustLevel: acceptedTrustLevel,
          task: params.task,
          sessionKey: queuedDisplay.formatted,
          conversationScope: queuedConversation.conversationScope,
          conversationRef: queuedConversation.conversationRef,
          queuedAt: now,
          requesterOrigin: params.requesterOrigin,
          depth: currentDepth,
          rootRunId,
          caps: acceptedCaps,
          ...(params.parentLeaseId !== undefined ? { parentLeaseId: params.parentLeaseId } : {}),
          callerSessionKey: params.callerSessionKey,
          callerConversation: params.callerConversation,
          callerEndpoint,
          callerAgentId: params.callerAgentId,
          announceChannelType: params.announceChannelType,
          announceChannelId: params.announceChannelId,
          graphId: params.graphId,
          nodeId: params.nodeId,
          abortGroup: params.callerType === "graph" && params.graphId
            ? `graph:${params.graphId}`
            : params.callerSessionKey,
        };
        runs.set(queuedRunId, queuedRun);
        createCompletionDeferred(queuedRunId);

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
    // Deliberately hoisted ABOVE the ceiling acquire below. The allowlist
    // check has NO side effects and can throw; if it ran AFTER the ceiling
    // reserve, a not-allowlisted spawn would reserve a slot and
    // then throw with no run ever created — so no completion `finally` would ever
    // release it (a slot leak). Refusing here,
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

    // Tree-wide spawn ceiling. The SINGLE consult both session.spawn
    // AND graph.* AND the in-process agent loop hit (they all reach here via
    // runner.spawn), keyed on the tree-stable rootRunId — so a for(;;) spawn()
    // is bounded across the whole tree, not just one caller. Placed AFTER the
    // per-caller depth/children/queue gates AND the allowlist and BEFORE
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
        // it so the run's terminal transition releases it 1:1. This is the
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
    const runId = (isGraphSpawn || isDurableResume) && params.reservedRunId !== undefined
      ? params.reservedRunId
      : randomUUID();
    const runPrincipalId = params.callerConversation?.conversationScope.partition.kind
      === "endpoint-conversation-principal"
      ? params.callerConversation.conversationScope.partition.principalId
      : params.requesterOrigin?.userId ?? `sub-agent:${runId}`;
    const runConversation = params.reuseConversation
      ?? createSubAgentConversation(
        deps.tenantId,
        params.agentId,
        runId,
        runPrincipalId,
      );
    const runDisplay = displayKeyForConversation(runConversation);
    const run: SubAgentRun = {
      runId, status: "running", agentId: params.agentId,
      trustLevel: acceptedTrustLevel,
      task: params.task, sessionKey: runDisplay.formatted,
      conversationScope: runConversation.conversationScope,
      conversationRef: runConversation.conversationRef,
      startedAt: clock.now(),
      requesterOrigin: params.requesterOrigin,
      depth: currentDepth,
      rootRunId,
      caps: acceptedCaps,
      ...(params.parentLeaseId !== undefined ? { parentLeaseId: params.parentLeaseId } : {}),
      callerSessionKey: params.callerSessionKey,
      callerConversation: params.callerConversation,
      callerEndpoint,
      callerAgentId: params.callerAgentId,
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
    createCompletionDeferred(runId);

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
    admittedRun: SubAgentQueuedRun | SubAgentRunningRun,
    params: SpawnParams,
    currentDepth: number,
    maxDepth: number,
  ): void {
    let run: SubAgentRunningRun;
    if (admittedRun.status === "queued") {
      const { status: _status, queuedAt: _queuedAt, ...common } = admittedRun;
      run = {
        ...common,
        status: "running",
        startedAt: clock.now(),
      };
      runs.set(runId, run);
    } else {
      run = admittedRun;
    }
    const display = displayKeyForConversation({
      conversationScope: run.conversationScope,
      conversationRef: run.conversationRef,
    });
    const subSessionKey = display.key;
    const formattedKey = display.formatted;
    const workspacePolicyHash = params.workspacePolicyHash ?? tryGetContext()?.workspacePolicyHash;
    if (deps.durableRuns && workspacePolicyHash !== undefined) {
      const descriptor = SubAgentResumeDescriptorSchema.safeParse({
        kind: "subagent_resume",
        task: params.task,
        agentId: params.agentId,
        callerSessionKey: params.callerSessionKey,
        callerConversation: params.callerConversation,
        callerEndpoint: run.callerEndpoint,
        callerAgentId: params.callerAgentId,
        announceChannelType: params.announceChannelType,
        announceChannelId: params.announceChannelId,
        model: params.model,
        maxSteps: params.max_steps,
        tokenBudget: params.tokenBudget,
        expectedOutputs: params.expected_outputs,
        requesterOrigin: params.requesterOrigin,
        depth: currentDepth,
        maxDepth,
        rootRunId: run.rootRunId,
        capabilityCeiling: run.caps,
        isCronAgentTurn: params.isCronAgentTurn,
        jobId: params.jobId,
        jobName: params.jobName,
        artifactRefs: params.artifactRefs,
        objective: params.objective,
        domainKnowledge: params.domainKnowledge,
        toolGroups: params.toolGroups,
        resolvedLanguage: params.resolvedLanguage,
        requiredTools: params.requiredTools,
        includeParentHistory: params.includeParentHistory,
        discoveredDeferredTools: params.discoveredDeferredTools,
        graphToolNames: params.graphToolNames,
        worktree: params.worktree,
        workspacePolicyHash,
      });
      if (descriptor.success) resumeDescriptors.set(runId, descriptor.data);
    }

    if (!params.reuseConversation) {
      const saved = deps.sessionStore.save(run.conversationScope, [], {
        agentId: params.agentId,
        parentSessionKey: params.callerSessionKey,
        parentConversationRef: params.callerConversation?.conversationRef,
        parentConversationScope: params.callerConversation?.conversationScope,
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
        // Carry the worktree request onto the child session metadata so
        // executeSubAgent (the only place that holds the GitExec seam + the
        // workspace resolver) can run the child in an isolated git worktree.
        // Defaults to false so the no-worktree path stays byte-identical.
        worktree: params.worktree ?? false,
        ...(resumeDescriptors.has(runId)
          ? { durableResumeDescriptor: resumeDescriptors.get(runId) }
          : {}),
      });
      if (!saved.ok) {
        // @allow-throw: session creation is part of the synchronous spawn admission boundary.
        throw saved.error;
      }
    } else {
      deps.logger?.info(
        { runId, conversationRef: run.conversationRef, agentId: params.agentId },
        "Reusing persistent conversation for multi-round driver",
      );
    }

    // Update run with canonical session info. Queued records were replaced by
    // the closed running variant above; lifecycle discrimination is never
    // mutated in place.
    run.sessionKey = formattedKey;
    run.startedAt = clock.now();

    // The SPAWN BOUNDARY — the run is now registered
    // + running, so write the initial durable checkpoint (stepIndex -1) + start
    // the keep-alive heartbeat. Inert when no durable store is wired. The keep-
    // alive is cleared + the record marked completed in the terminal `finally`.
    startDurableCheckpoint(run, params);

    // Start the ~30s read-only progress fork so a long-running child
    // surfaces its advance (a content-free session:sub_agent_progress) WITHOUT
    // completing. Stopped in the terminal `finally` (no leaked timer). Runs
    // independent of the durable store.
    startProgressFork(run, params);

    deps.logger?.info({
      runId, agentId: params.agentId,
      callerAgentId: params.callerAgentId ?? "unknown",
      parentSessionKey: params.callerSessionKey ?? "unknown",
      maxSteps: params.max_steps ?? deps.config.subAgentMaxSteps,
      toolProfile: deps.config.subAgentToolGroups,
    }, "Sub-agent spawn initiated");

    // Emit spawn event
    deps.eventBus.emit("session:sub_agent_spawned", {
      runId, parentSessionKey: params.callerSessionKey ?? "unknown",
      agentId: params.agentId, timestamp: clock.now(),
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
        // Propagate delivery origin into ALS so sub-agent tool calls
        // (e.g. pipeline execute -> graph.execute RPC) include announce channel fields.
        // Without this, setup-tools.ts cannot inject _callerChannelType/_callerChannelId.
        const childTenantId = subSessionKey.tenantId;
        const childUserId = subSessionKey.userId;
        const originChannelType = run.announceChannelType ?? run.requesterOrigin?.channelType;
        const originChannelId = run.announceChannelId ?? run.requesterOrigin?.channelId;
        const preservesRequesterRoute = originChannelType === run.requesterOrigin?.channelType
          && originChannelId === run.requesterOrigin?.channelId;
        const subDeliveryOrigin = originChannelType && originChannelId
          ? createDeliveryOrigin({
              channelType: originChannelType,
              channelId: originChannelId,
              userId: preservesRequesterRoute
                ? run.requesterOrigin?.userId ?? childUserId
                : childUserId,
              // The child session is the tenant isolation authority. Never let
              // a serialized routing object move the child into another tenant.
              tenantId: childTenantId,
              ...(preservesRequesterRoute && run.requesterOrigin?.threadId
                ? { threadId: run.requesterOrigin.threadId }
                : {}),
            })
          : undefined;

        const childPartition = run.conversationScope.partition;
        if (childPartition.kind !== "endpoint-conversation-principal") {
          // @allow-throw: sub-agent conversations are minted with this exact internal partition at admission.
          throw new Error("Sub-agent conversation authority has an invalid partition");
        }
        const childTurnScope: ResolvedTurnScope = {
          conversation: run.conversationScope,
          principal: { principalId: childPartition.principalId },
          endpoint: childPartition.endpoint,
        };
        const childContext = createResolvedRequestContext({
          traceId,
          tenantId: childTenantId,
          userId: childUserId,
          sessionKey: subSessionKey,
          agentId: run.agentId,
          startedAt: clock.now(),
          trustLevel: run.trustLevel,
          // Propagate channel context for downstream tool RPC injection
          ...(subDeliveryOrigin && { channelType: subDeliveryOrigin.channelType }),
          ...(subDeliveryOrigin && { deliveryOrigin: subDeliveryOrigin }),
          turnScope: childTurnScope,
        });
        if (!childContext.ok) {
          deps.logger?.error({
            runId,
            agentId: run.agentId,
            hint: "Inspect the persisted child session and requester route for inconsistent principal identity",
            errorKind: "internal" as const,
          }, "Sub-agent request context validation failed");
          // @allow-throw: the surrounding execution boundary records the failed run and releases all lifecycle resources.
          throw childContext.error;
        }

        const childTask = appendExpectedOutputContract(params.task, params.expected_outputs);
        const result = await runWithContext(
          childContext.value,
          () => deps.executeAgent(
            params.agentId,
            subSessionKey,
            { conversationScope: run.conversationScope, conversationRef: run.conversationRef },
            childTask,
            params.max_steps,
            params.callerAgentId,
            params.graphId && params.nodeId
              ? { graphId: params.graphId, nodeId: params.nodeId, reuseConversation: params.reuseConversation, graphNodeDepth: params.graphNodeDepth }
              : params.reuseConversation
                ? { reuseConversation: params.reuseConversation }
                : undefined,
            params.tokenBudget,
            {
              rootRunId: run.rootRunId,
              ...(run.parentLeaseId !== undefined
                ? { parentLeaseId: run.parentLeaseId }
                : {}),
              parentCaps: run.caps,
              onAssemblyAuthority: (authority) => {
                const heldCaps = new Set(run.caps);
                const widened = authority.caps.some((capability) => !heldCaps.has(capability));
                if (authority.rootRunId !== run.rootRunId || widened) {
                  // @allow-throw: the surrounding execution boundary records this invalid composition-root authority and releases run resources.
                  throw new Error("Sub-agent assembly authority exceeded its authenticated parent ceiling");
                }
                run.leaseId = authority.leaseId;
                run.caps = [...authority.caps];
                persistDurableCheckpoint(run, params);
              },
            },
          ),
        );
        providerSettledRunIds.add(runId);

        // Guard: if already killed, skip completion logic
        if (deliverySuppressedRunIds.has(runId)) return;

        const providerCompletedAt = clock.now();
        const isSuccess = result.finishReason === "stop" || result.finishReason === "end_turn";

        // Warn on empty response — may indicate prompt or context issues
        if (!result.response || result.response.trim().length === 0) {
          deps.logger?.warn({
            runId, agentId: params.agentId, finishReason: result.finishReason,
            hint: "Sub-agent returned empty response; check task prompt clarity and model context limits",
            errorKind: "internal" as const,
          }, "Sub-agent produced empty output");
        }

        const runtimeMs = providerCompletedAt - run.startedAt;

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
              tenantId: run.conversationScope.tenantId,
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

        // Materialize the child's FULL output to its OWN
        // jailed workspace as a structured ResultRef, so the lead's announcement
        // grows by a bounded summary + a HANDLE, never the megabyte body (the
        // longevity invariant). The condenser (summary) and the store
        // (handle) are complementary — both run. The drill-in line that
        // follows the summary defaults to the condenser's diskPath: the genuine
        // "no store wired / no handle produced" path (no store to materialize
        // through, so the on-disk condensed result IS the handle — NOT a shim).
        let fullResultLine = condensedResult ? `\n\nFull result: ${condensedResult.diskPath}` : "";
        // The successful handle (when produced) — threaded into the NarrativeCaster
        // path too, so the production-default tagged announcement also carries the
        // handle, not the diskPath (the longevity invariant on every path).
        let materializedRef: ResultRef | undefined;
        if (
          deps.materializeFullOutput &&
          (condensedResult !== undefined || result.response.length > SUBAGENT_RESULT_SUMMARY_MAX_CHARS)
        ) {
          const materialized = await deps.materializeFullOutput(result.response, { runId, nowMs: clock.now(), agentId: params.agentId });
          if (materialized && "ref" in materialized && typeof materialized.ref === "string") {
            // Success: the lead drills into the handle on demand (read/grep/jq).
            materializedRef = materialized;
            fullResultLine = `\n\nFull result (drill in with read/grep/jq): ${materialized.ref} (${materialized.bytes}B, ${materialized.kind})`;
            deps.logger?.debug({
              runId, step: "child-result-materialize",
              bytes: materialized.bytes, kind: materialized.kind,
            }, "Child output materialized to ResultRef");
          } else if (materialized && "error" in materialized && typeof materialized.error === "string") {
            // Refused (over per-file cap / path-traversal); the store wrote
            // nothing. Degrade to the summary + diskPath and surface a WARN — the
            // `.error` is a content-free CODE string, safe to echo in the hint.
            deps.logger?.warn({
              runId, step: "child-result-materialize",
              errorKind: "resource" as const,
              hint: `Child output materialize refused (${materialized.error}); the lead falls back to the condensed summary + diskPath.`,
            }, "Child output materialize refused");
          } else {
            // undefined: the contained write itself failed (the store already
            // logged it). Degrade to the summary + diskPath WITHOUT a WARN — no
            // double-report; a DEBUG of the no-handle degrade is sufficient.
            deps.logger?.debug({
              runId, step: "child-result-materialize",
            }, "Child output materialize produced no handle; using condensed summary + diskPath");
          }
        }

        const completedAt = clock.now();
        const completionSummary = condensedResult?.result.summary ?? result.response;
        const telemetry: SubAgentRunTelemetry = {
          tokensUsedTotal: result.tokensUsed.total,
          costTotal: result.cost.total,
          finishReason: result.finishReason,
          stepsExecuted: result.stepsExecuted,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        };
        if (isSuccess) {
          terminalizeRun(runId, {
            endReason: "completed",
            completedAtMs: completedAt,
            summary: completionSummary,
            ...(materializedRef ? { resultRef: materializedRef } : {}),
          }, telemetry);
        } else {
          terminalizeRun(runId, {
            endReason: "failed",
            completedAtMs: completedAt,
            errorKind: classifyCompletionErrorKind(
              result.finishReason,
              result.terminalErrorKind,
            ),
            summary: completionSummary || result.errorContext?.originalError,
            ...(materializedRef ? { resultRef: materializedRef } : {}),
          }, telemetry);
        }

        // The runner-owned completion deferred resolves in terminalizeRun()
        // before any lifecycle notification becomes observable.
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
              content,
              trustLevel: "system",
              source: { who: "sub-agent-runner", sessionKey: formattedKey },
              tags: ["sub-agent-result", "task-completion", ...(abortClassification ? ["aborted"] : [])],
              createdAt: clock.now(),
              sourceType: "tool",
            }, {
              turnScope: childTurnScope,
              visibility: { kind: "agent-shared" },
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

        // A bounded shutdown may stop the run while post-processing is still
        // active. The attributed failure notice then owns delivery; never
        // enqueue a late terminal result behind the final batch drain.
        if (deliverySuppressedRunIds.has(runId)) return;

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
              threadId: resolveAnnouncementThreadId(
                params.requesterOrigin,
                params.announceChannelType,
                params.announceChannelId,
              ),
              callerAgentId: params.callerAgentId,
              callerSessionKey: params.callerSessionKey,  // shared dedup key
              callerConversation: params.callerConversation,
              destinationEndpoint: run.callerEndpoint,
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
                // The materialized handle (when produced) so the tagged
                // announcement carries the drill-in handle, not the diskPath.
                resultRef: materializedRef,
              });
            } else {
              // Legacy fallback: no condenser or no caster
              announcementText = buildAnnouncementMessage({
                task: params.task,
                status: "completed",
                response: condensedResult
                  ? `${condensedResult.result.summary}${fullResultLine}`
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
              announceThreadId: resolveAnnouncementThreadId(
                params.requesterOrigin,
                params.announceChannelType,
                params.announceChannelId,
              ),
              callerAgentId: params.callerAgentId,
              callerSessionKey: params.callerSessionKey,
              callerConversation: params.callerConversation,
              destinationEndpoint: run.callerEndpoint,
              resolvedLanguage: params.resolvedLanguage,
              runId,
              ...(validationResults?.some((output) => output.exists)
                ? {
                    attachments: validationResults
                      .filter((output) => output.exists)
                      .map((output) => ({ sourceAgentId: params.agentId, path: output.path })),
                  }
                : {}),
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
        if (deliverySuppressedRunIds.has(runId)) return;
        const authoritativeRun = runs.get(runId);
        if (
          authoritativeRun?.status === "completed" ||
          authoritativeRun?.status === "failed"
        ) return;

        const completedAt = clock.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        const runtimeMs = completedAt - run.startedAt;
        terminalizeRun(runId, {
          endReason: "failed",
          completedAtMs: completedAt,
          errorKind: "internal",
          summary: errorMessage,
        });

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
            threadId: resolveAnnouncementThreadId(
              params.requesterOrigin,
              params.announceChannelType,
              params.announceChannelId,
            ),
            callerAgentId: params.callerAgentId,
            callerSessionKey: params.callerSessionKey,  // shared dedup key
            callerConversation: params.callerConversation,
            destinationEndpoint: run.callerEndpoint,
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
      } finally {
        providerSettledRunIds.delete(runId);
        // Release the child's trajectory recorder on EVERY terminal settle —
        // completion, natural failure, kill, and watchdog all flow through
        // this promise. Without it the dead child's recorder stays subscribed
        // to the shared event bus for the daemon's lifetime and keeps
        // ingesting other sessions' events into its trajectory file (stamped
        // with the dead child's sessionId).
        closeTrajectoryOnce(run);
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
      // Provider settlement transfers ownership to bounded post-processing;
      // the provider watchdog must not manufacture a competing terminal while
      // condensation/materialization is attaching the completion projection.
      const authoritativeRun = runs.get(runId);
      if (authoritativeRun?.status !== "running" || providerSettledRunIds.has(runId)) return;

      const completedAt = clock.now();
      const runtimeMs = completedAt - run.startedAt;

      deliverySuppressedRunIds.add(runId);
      const errorMessage = `Execution timeout: exceeded ${runTimeoutMs}ms wall-clock limit`;
      terminalizeRun(runId, {
        endReason: "watchdog_timeout",
        completedAtMs: completedAt,
        errorKind: "timeout",
        summary: errorMessage,
      });
      forceTerminalCleanup(run, "watchdog_timeout");

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
            error: errorMessage,
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
        const handle = deps.sessionResolver.resolveActiveSession(run.conversationRef);
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
        trackFailureNotification(deliverFailureNotification({
          channelType: params.announceChannelType,
          channelId: params.announceChannelId,
          task: params.task,
          runtimeMs,
          runId,
          threadId: resolveAnnouncementThreadId(
            params.requesterOrigin,
            params.announceChannelType,
            params.announceChannelId,
          ),
          callerAgentId: params.callerAgentId,
          callerSessionKey: params.callerSessionKey,  // shared dedup key
          callerConversation: params.callerConversation,
          destinationEndpoint: run.callerEndpoint,
        }, deps));
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
    watchdogTimers.set(runId, watchdogTimer);

    // Clear watchdog on normal completion/failure
    execPromise.finally(() => {
      watchdogTimer.cancel();
      watchdogTimers.delete(runId);
    });

    activePromises.add(execPromise);
    activeRunIds.add(runId);
    execPromise.finally(() => {
      activePromises.delete(execPromise);
      activeRunIds.delete(runId);
      deliverySuppressedRunIds.delete(runId);
      // Release the tree-wide ceiling slot this run reserved (idempotent;
      // a no-op for promoted queued runs, which never acquired). This fires for
      // EVERY started run on its terminal settle — completion, failure, AND a
      // kill/ghost/watchdog (those mark the run failed but the underlying
      // executeAgent promise still settles here), so a long-running tree's slots
      // are reclaimed rather than monotonically leaking.
      releaseCeilingSlotOnce(run);
      // The SAME universal terminal seam — mark the
      // durable record completed + clear its keep-alive heartbeat (no leaked
      // interval). Inert + idempotent when no durable store is wired.
      const terminalRun = runs.get(runId);
      if (!forcedTerminalRunIds.has(runId) && terminalRun && terminalRun.status !== "running" && terminalRun.status !== "queued") {
        finishDurableCheckpoint(run, terminalRun.completion.endReason);
      }
      // Stop the read-only progress fork on the same universal terminal
      // seam so it never outlives the child (no leaked timer).
      stopProgressFork(run);
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
   * `sessionKey`. When a sub-agent itself calls
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
    let best: SubAgentQueuedRun | SubAgentRunningRun | undefined;
    for (const run of runs.values()) {
      if (run.sessionKey !== sessionKey) continue;
      if (run.status !== "running" && run.status !== "queued") continue;
      const admittedAt = run.status === "queued" ? run.queuedAt : run.startedAt;
      const bestAdmittedAt = best?.status === "queued" ? best.queuedAt : best?.startedAt;
      if (!best || admittedAt > (bestAdmittedAt ?? 0)) best = run;
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
   * and find the run already marked -- it skips its completion logic (the
   * trajectory teardown in its finally still runs).
   *
   * Attribution: `opts.killedBy` names WHO initiated the kill (closed union;
   * defaults to "parent" — the historical caller). A daemon health-monitor
   * kill must never masquerade as a parent kill: the misattributed
   * "Killed by parent agent" status is what the parent agent relays to the
   * user, so it must carry the real cause. Non-parent kills additionally
   * deliver the LLM-free failure notification to the announce channel —
   * a parent knows about its own kill, but nobody is watching for an
   * autonomous one (the watchdog-timeout path's notification precedent).
   *
   * @param runId - The run ID to kill
   * @param opts - Attribution: who killed the run, the operator-facing
   *   reason (free text — stays OFF the bus), and idle/threshold telemetry.
   * @returns Result indicating success or failure with error message
   */
  function killRun(runId: string, opts?: {
    killedBy?: "parent" | "health_monitor" | "operator" | "system";
    reason?: string;
    idleMs?: number;
    thresholdMs?: number;
  }): { killed: boolean; error?: string } {
    const run = runs.get(runId);
    if (!run) {
      return { killed: false, error: `Unknown run ID: ${runId}` };
    }
    if (run.status !== "running" && run.status !== "queued") {
      return { killed: false, error: `Run ${runId} is not running (status: ${run.status})` };
    }

    const killedBy = opts?.killedBy ?? "parent";
    deliverySuppressedRunIds.add(runId);
    const killedAt = clock.now();
    const errorMessage = opts?.reason
      ?? (killedBy === "parent" ? "Killed by parent agent" : `Killed by ${killedBy}`);
    const runBeganAt = run.status === "queued" ? run.queuedAt : run.startedAt;
    const killRuntimeMs = Math.max(0, killedAt - runBeganAt);
    terminalizeRun(runId, {
      endReason: "killed",
      completedAtMs: killedAt,
      errorKind: killedBy === "health_monitor" ? "timeout" : "precondition",
      summary: errorMessage,
    });
    forceTerminalCleanup(run, "killed");

    // Persist failure record for killed runs (fire-and-forget, belt-defense)
    if (deps.dataDir) {
      suppressError(
        persistFailureRecord({
          dataDir: deps.dataDir,
          sessionKey: run.sessionKey,
          runId,
          task: run.task,
          error: errorMessage,
          endReason: "killed",
          runtimeMs: killRuntimeMs,
          killedBy,
        }, deps.logger),
        "kill-failure-record",
      );
    }

    // Attributed kill telemetry — content-free (ids/enum/numbers; the
    // free-text reason stays on the failure record + WARN log). The child
    // sessionKey routes the trajectory record into the killed child's file.
    deps.eventBus.emit("subagent:killed", {
      runId,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      killedBy,
      runtimeMs: killRuntimeMs,
      ...(opts?.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
      ...(opts?.thresholdMs !== undefined ? { thresholdMs: opts.thresholdMs } : {}),
      timestamp: killedAt,
    });

    // Abort the in-flight SDK session via composite-key resolver
    // (best-effort).
    if (deps.sessionResolver) {
      const handle = deps.sessionResolver.resolveActiveSession(run.conversationRef);
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
      graphCoordinatorRef.notifyNodeFailed(run.graphId, run.nodeId, runId, errorMessage);
    } else {
      // Non-graph runs: use existing event bus path
      deps.eventBus.emit("session:sub_agent_completed", {
        runId,
        agentId: run.agentId,
        success: false,
        runtimeMs: killRuntimeMs,
        tokensUsed: 0,
        cost: 0,
        timestamp: killedAt,
      });
    }

    // Stop proxy typing on kill
    emitProxyStop(run, runId, "killed");

    // Non-parent kills notify the announce channel (LLM-free, dedup-keyed) —
    // the parent only knows about a kill it issued itself; an autonomous
    // health-monitor kill would otherwise be silent until the user asks.
    if (killedBy !== "parent" && run.announceChannelType && run.announceChannelId) {
      trackFailureNotification(deliverFailureNotification({
        channelType: run.announceChannelType,
        channelId: run.announceChannelId,
        task: run.task,
        runtimeMs: killRuntimeMs,
        runId,
        threadId: resolveAnnouncementThreadId(
          run.requesterOrigin,
          run.announceChannelType,
          run.announceChannelId,
        ),
        callerAgentId: run.callerAgentId,
        callerSessionKey: run.callerSessionKey,  // shared dedup key
        callerConversation: run.callerConversation,
        destinationEndpoint: run.callerEndpoint,
        detail: killedBy === "health_monitor"
          ? `The background task was stopped by the daemon health monitor${opts?.idleMs !== undefined ? ` after ${Math.round(opts.idleMs / 1000)}s without progress` : ""}${opts?.thresholdMs !== undefined ? ` (security.agentToAgent.subagentContext.stuckKillThresholdMs=${opts.thresholdMs})` : ""}.`
          : `The background task was stopped (${killedBy}).`,
      }, deps));
    }

    deps.logger?.info({
      runId, agentId: run.agentId, killedBy,
      durationMs: killRuntimeMs,
      ...(opts?.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
      ...(opts?.thresholdMs !== undefined ? { thresholdMs: opts.thresholdMs } : {}),
    }, "Sub-agent run killed");

    // Lifecycle hook - onEnded (kill path, fire-and-forget)
    if (deps.lifecycleHooks) {
      deps.lifecycleHooks.onEnded({
        runId,
        agentId: run.agentId,
        parentSessionKey: run.callerSessionKey ?? "unknown",
        childSessionKey: run.sessionKey,
        endReason: "killed",
        runtimeMs: killRuntimeMs,
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
   * Hard-stop a whole spawn tree. Fans the per-run {@link killRun}
   * (which marks the run failed and aborts its in-flight SDK session) over every
   * running/queued run sharing `rootRunId`, and returns the count killed.
   *
   * Filters STRICTLY on `run.rootRunId === rootRunId` (a
   * different tree must be untouched) and on the same status guard killRun uses,
   * so already-terminal runs are skipped. An unknown root is a clean no-op
   * (`{ killed: 0 }`), never a throw — the count return is the contract the
   * daemon-side `run.kill` RPC handler (the @allow-throw boundary)
   * drives; this helper itself raises nothing (the raw-throw.test.ts gate).
   */
  function killByRootRun(rootRunId: string, opts?: Parameters<typeof killRun>[1]): { killed: number } {
    let killed = 0;
    for (const run of runs.values()) {
      if (
        run.rootRunId === rootRunId &&
        (run.status === "running" || run.status === "queued")
      ) {
        if (killRun(run.runId, opts).killed) killed++;
      }
    }
    return { killed };
  }

  /**
   * Inject a steer message into a RUNNING child's live SDK session
   * (mid-flight steering), distinct from killRun. Delegates to the steer-run.ts
   * helper to keep the mechanism OUT of this (already large) file.
   *
   * Widen the resolver/registry surface at the delegation boundary: this
   * runner's `deps.sessionResolver`/`deps.activeRunRegistry` are typed to the
   * narrowed `{ abort(): Promise<void> }` (the kill path only needs abort, and
   * the narrow type avoids a daemon→agent import cycle in those Deps). steerRun
   * needs the FULL RunHandle (steer/followUp/isStreaming/isCompacting). The
   * RUNTIME handle is complete — PiExecutor builds all five and registers it
   * under the canonical conversation ref. So
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
        | { resolveActiveSession(conversationRef: ConversationRef): RunHandle | undefined }
        | undefined,
      logger: deps.logger,
    };
    return steerRunHelper(steerDeps, runId, message);
  }

  async function waitForTrackedPromises(
    tracked: ReadonlySet<Promise<void>>,
    timeoutMs: number,
  ): Promise<boolean> {
    if (tracked.size === 0) return true;
    let timeoutHandle: TimerHandle | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = timers.setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutHandle.unref();
    });
    while (tracked.size > 0) {
      const outcome = await Promise.race([
        Promise.allSettled([...tracked]).then(() => "settled" as const),
        timeout,
      ]);
      if (outcome === "timeout") {
        timeoutHandle?.cancel();
        return false;
      }
    }
    timeoutHandle?.cancel();
    return true;
  }

  async function performShutdown(): Promise<void> {
    sweepInterval.cancel();

    const activeSettled = await waitForTrackedPromises(
      activePromises,
      SHUTDOWN_ACTIVE_GRACE_MS,
    );
    if (!activeSettled) {
      const remaining = new Set(activeRunIds);
      for (const run of runs.values()) {
        if (run.status === "queued") remaining.add(run.runId);
      }
      for (const runId of remaining) {
        const run = runs.get(runId);
        if (!run) continue;
        if (providerSettledRunIds.has(runId)) {
          deliverySuppressedRunIds.add(runId);
          if (run.announceChannelType && run.announceChannelId) {
            trackFailureNotification(deliverFailureNotification({
              channelType: run.announceChannelType,
              channelId: run.announceChannelId,
              task: run.task,
              runtimeMs: Math.max(
                0,
                clock.now() - (
                  run.status === "queued"
                    ? run.queuedAt
                    : run.startedAt ?? clock.now()
                ),
              ),
              runId,
              threadId: resolveAnnouncementThreadId(
                run.requesterOrigin,
                run.announceChannelType,
                run.announceChannelId,
              ),
              callerAgentId: run.callerAgentId,
              callerSessionKey: run.callerSessionKey,
              callerConversation: run.callerConversation,
              destinationEndpoint: run.callerEndpoint,
              detail: "The background task finished, but result delivery was stopped during daemon shutdown.",
            }, deps));
          }
          continue;
        }
        if (run.status === "completed" || run.status === "failed") continue;
        killRun(runId, {
          killedBy: "system",
          reason: "Stopped during daemon shutdown",
        });
      }
      deps.logger?.warn(
        {
          activeRunCount: remaining.size,
          errorKind: "timeout" as const,
          hint: "Inspect the attributed shutdown failure notices and any retained outward operations",
        },
        "Sub-agent shutdown grace expired; remaining runs were stopped",
      );
    }

    const noticesSettled = await waitForTrackedPromises(
      failureNotificationPromises,
      SHUTDOWN_NOTICE_GRACE_MS,
    );
    if (!noticesSettled) {
      deps.logger?.warn(
        {
          notificationCount: failureNotificationPromises.size,
          errorKind: "timeout" as const,
          hint: "Inspect the outward ledger; timed-out governed notices remain retained for recovery",
        },
        "Sub-agent shutdown notice grace expired",
      );
    }

    // The batcher closes its own admission and waits any reservation already
    // admitted before this final drain. Stopped runs are status-gated from
    // producing a late success when their underlying provider call returns.
    await deps.batcher?.shutdown();

    // Batcher delivery may have persisted a dead letter, so drain it last.
    if (deps.deadLetterQueue) {
      try {
        await deps.deadLetterQueue.drain(deps.sendToChannel, markRecoveredDelivered);
      } catch {
        // Best-effort drain on shutdown
      }
    }

  }

  function shutdown(): Promise<void> {
    acceptingSpawns = false;
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
  }

  function spawnAdmissionStatus(): SubAgentSpawnAdmissionState {
    return {
      paused: spawnPaused,
      acceptingSpawns,
      resetsOnRestart: true,
    };
  }

  function pauseSpawns(): SubAgentSpawnAdmissionMutation {
    const changed = !spawnPaused;
    spawnPaused = true;
    return { ...spawnAdmissionStatus(), changed };
  }

  function resumeSpawns(): SubAgentSpawnAdmissionMutation {
    const changed = spawnPaused;
    spawnPaused = false;
    return { ...spawnAdmissionStatus(), changed };
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

  async function resumeDurable(
    record: DurableRunRecord,
    leaseId: string,
  ): Promise<Result<string, Error>> {
    const loaded = deps.sessionStore.loadByRef(
      { tenantId: record.tenantId, agentId: record.agentId },
      record.conversationRef,
    );
    if (!loaded.ok) return err(new Error(loaded.error.message));
    if (loaded.value === undefined) {
      return err(new Error("Protected sub-agent resume session was not found"));
    }
    if (
      JSON.stringify(loaded.value.conversationScope)
      !== JSON.stringify(record.conversationScope)
    ) {
      return err(new Error("Protected sub-agent resume session authority mismatch"));
    }
    const descriptor = parseSubAgentResumeDescriptor(
      loaded.value.metadata.durableResumeDescriptor,
    );
    if (!descriptor.ok) return descriptor;
    const authority = validateSubAgentResumeAuthority(descriptor.value, record);
    if (!authority.ok) return authority;
    if (descriptor.value.workspacePolicyHash !== record.workspacePolicyHash) {
      return err(new Error("Protected sub-agent resume workspace policy mismatch"));
    }
    const resumed = tryCatch(() => spawn({
      task: descriptor.value.task,
      agentId: descriptor.value.agentId,
      callerSessionKey: descriptor.value.callerSessionKey,
      callerConversation: descriptor.value.callerConversation,
      callerEndpoint: descriptor.value.callerEndpoint,
      callerAgentId: descriptor.value.callerAgentId,
      announceChannelType: descriptor.value.announceChannelType,
      announceChannelId: descriptor.value.announceChannelId,
      model: descriptor.value.model,
      max_steps: descriptor.value.maxSteps,
      tokenBudget: descriptor.value.tokenBudget,
      expected_outputs: descriptor.value.expectedOutputs,
      requesterOrigin: descriptor.value.requesterOrigin,
      depth: descriptor.value.depth,
      maxDepth: descriptor.value.maxDepth,
      rootRunId: descriptor.value.rootRunId,
      parentLeaseId: leaseId,
      caps: record.caps,
      callerType: "durable-resume",
      reservedRunId: record.checkpointId,
      callerTrustLevel: record.trustLevel,
      artifactRefs: descriptor.value.artifactRefs,
      objective: descriptor.value.objective,
      domainKnowledge: descriptor.value.domainKnowledge,
      toolGroups: descriptor.value.toolGroups,
      resolvedLanguage: descriptor.value.resolvedLanguage,
      requiredTools: descriptor.value.requiredTools,
      includeParentHistory: descriptor.value.includeParentHistory,
      discoveredDeferredTools: descriptor.value.discoveredDeferredTools,
      graphToolNames: descriptor.value.graphToolNames,
      worktree: descriptor.value.worktree,
      workspacePolicyHash: descriptor.value.workspacePolicyHash,
      reuseConversation: {
        conversationRef: record.conversationRef,
        conversationScope: record.conversationScope,
      },
      isCronAgentTurn: descriptor.value.isCronAgentTurn,
      jobId: descriptor.value.jobId,
      jobName: descriptor.value.jobName,
    }));
    if (!resumed.ok) return resumed;
    return resumed.value === record.checkpointId
      ? ok(resumed.value)
      : err(new Error("Durable sub-agent resume execution identity mismatch"));
  }

  return {
    spawn,
    getRunStatus,
    waitForCompletion,
    waitForCompletions,
    getRunBySessionKey,
    listRuns,
    killRun,
    killByRootRun,
    steerRun,
    spawnAdmissionStatus,
    pauseSpawns,
    resumeSpawns,
    shutdown,
    setGraphCoordinator,
    lastSpawnDedupInfo,
    resumeDurable,
  };
}
