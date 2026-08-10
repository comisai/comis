// SPDX-License-Identifier: Apache-2.0
/**
 * Post-execution cleanup for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() `finally` block to isolate
 * bridge result merging, SDK stats delegation, cache metrics, planner
 * metrics, TTL recording, execution bookend logging, session metadata
 * persistence, memory store, active run deregister, schema stripping,
 * and session disposal into a focused module.
 *
 * Consumers:
 * - pi-executor.ts: calls postExecution() in the finally block
 *
 * @module
 */

import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CacheRetention } from "@earendil-works/pi-ai";
import {
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type MemoryPort,
  type MemoryWriteScope,
  type ClockPort,
  type ResponseLocaleRepairSkipped,
  type ContextStorePort,
  type ContextStoreScope,
  type ConversationRef,
  tryGetContext,
  // Secret-egress guard (the keystone). Used to gate the paired-conversation
  // memory write so user-pasted secrets never reach the memories table / vector
  // index — the SAME guard the derived-memory writes on this file already apply
  // (memory-user-representation-job.ts, memory-consolidation-job.ts).
  // validateMemoryWrite REJECTS (severity "critical") when the secret-egress scan
  // finds a redaction.
  validateMemoryWrite,
  type ResponseLocalePolicy,
  type UserTrustLevel,
  type AgentExecutionFinishReason,
  type ExecutionSideEffectSummary,
  createConversationRef,
  SessionCompactionConfigSchema,
  getToolMetadata,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { suppressError, isSilentResponse } from "@comis/shared";
import {
  drainAt,
  markRead,
  markConsumed,
  formatDrainKey,
  type DrainKey,
  type DrainInflightState,
} from "./drain-helper.js";
import type { ActiveRunRegistry } from "./active-run-registry.js";
import type { ComisSessionManager, SessionMetadata } from "../session/comis-session-manager.js";
import { buildSessionHealthRollup, type SessionHealthRollup } from "./session-health-rollup.js";
import { classifyError, errorKindForCategory } from "./error-classifier.js";
import {
  setBreakpointIndex,
  deleteBreakpointIndex,
  getBreakpointIndexMapSize,
  getSessionCompactionBand,
  setSessionCompactionBand,
} from "./executor-session-state.js";
// The surfaced-skill census is STORED during assembly and emitted HERE (post-execution,
// after the trajectory bridge subscribes) — see the prompt-assembly note on SkillSurfacedCensus.
import {
  getSessionPromptSkillSurfacedCensus,
  clearSessionPromptSkillSurfacedCensus,
  getSessionPromptMemoryInjected,
  clearSessionPromptMemoryInjected,
  drainSessionPromptRecallEvents,
} from "./prompt-assembly.js";
// Import directly from the leaf module (not the barrel) to keep the cycle
// detector happy — pi-executor.ts imports executor-post-execution.ts in the
// finally block, so going through the barrel would create
// executor-post-execution → pi-executor/index → pi-executor/pi-executor →
// executor-post-execution.
import { mergeSessionStats } from "./pi-executor/session-stats.js";
import { recordLastResponseTs } from "./ttl-guard.js";
import { stripDiscoverySchemas } from "./schema-stripping.js";
// LCD afterTurn ingest write-path. Body lives in lcd-ingest.ts
// (this file is already over the 800L cap); the call below is a thin gated
// invocation. The agent↛memory cut: lcd-ingest imports only the core port type
// + the core codec — never @comis/memory.
import { ingestTurnGuarded } from "./lcd-ingest.js";
import { ingestProjectedConversationHistory } from "../session/context-history-replacement.js";
import { projectInboundConversation } from "../session/inbound-message-provenance.js";
// LCD afterTurn leaf-pass trigger. Activates the inert
// contextThreshold: a thin gated call right after the ingest fires one leaf pass
// when utilization is over threshold. The body (gating + opts + summarize +
// range-replace + emit) lives in lcd-compaction-trigger.ts (this file is over
// the 800L cap); the call here is a single non-fatal invocation. The
// agent↛memory cut: the trigger imports only the core port type + the core codec.
import { runLeafPassAfterTurn } from "./lcd-compaction-trigger.js";
// LCD afterTurn CONDENSE pass. A second thin gated call right
// after the leaf pass: when ≥condensedMinFanout contiguous same-depth summaries
// have accumulated, fold the shallowest run into one depth+1 condensed summary.
// Runs AFTER the leaf pass so a turn that just created the Nth leaf can fold it.
// The body lives in lcd-condense-trigger.ts (this file is over the 800L cap); the
// call here is a single non-fatal invocation. The agent↛memory cut: the condense
// trigger imports only core types + the agent-side condense summarizer.
import { runCondensePassAfterTurn } from "./lcd-condense-trigger.js";
import { enqueueContextMaintenance } from "./lcd-maintenance-queue.js";
// LCD→LTM distillation runner. Fires via the
// onCondensed callback on runCondensePassAfterTurn — non-fatal, fire-and-forget
// (mirrors the condense pass's own non-fatal wrapping). The agent↛memory cut:
// the runner imports only core TYPE-only ports — no @comis/memory import.
import { runDistillationPassAfterTurn } from "./lcd-distillation-runner.js";
import { runSessionCompactionAfterTurn } from "./session-compaction-trigger.js";
import type { LeafSummarizerDeps, CompactionModelSnapshot } from "../context-engine/lcd-leaf-summarizer.js";
// In-package pure attribution fn (the agent↛memory cut — core types
// only; the write-back is the daemon's job, off the recall-used bus event).
import { attributeRecallUsage } from "../rag/recall-attribution.js";
// Write side: the DETERMINISTIC, LLM-free intent classifier (same package, NOT
// publicly exported — so no daemon caller can drag an LLM in via the barrel).
// The turn-end memory:recall_used emit threads
// classifyIntent(msg.text) so the daemon write-back records the per-intent usefulness bucket.
import { classifyIntent } from "../rag/query-understanding.js";
import { getWorkspaceStatus } from "@comis/core";
import type { ExecutionResult, ExecutionOverrides } from "./types.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
// Import the precise type so PostExecutionParams.capabilityClass
// is CapabilityClass | undefined, not string | undefined.
import type { CapabilityClass } from "./model-profile.js";
import { createHash, randomUUID } from "node:crypto";
// Critic hook (no inline logic — all logic in verification-gate.ts)
import { shouldRunCritic, runVerificationCritic } from "./verification-gate.js";
// Deterministic user-facing replies for named degraded terminal causes.
import { buildOutputStarvedAnnotation, buildContextExhaustedReply, buildLoopDetectedReply, buildToolFailureNotice, buildToolFailureNoticeUnnamed, buildDelegationEvidenceMissingReply, buildPersistentActionEvidenceMissingReply, buildOutboundAudioEvidenceMissingReply, buildOutboundImageEvidenceMissingReply, buildDestructiveActionNotVerifiedReply, buildProviderRequiresModelReply, buildAgentUpdateNoOpReply, buildOngoingWorkEvidenceMissingReply, buildRuntimeSelfReportEvidenceMissingReply, buildSchedulerStateEvidenceMissingReply, buildPendingSchedulerConfirmationReply, buildCompletionEvidenceMissingReply, buildSenderAuthorityOverclaimReply, buildVisionUnavailableReply, groundedVisionFallbackTool, hasUnavailableVisionFailure, catalogFromLocalePacks, LOCALE_MESSAGE_IDS } from "./degraded-reply.js";
import {
  enforceCurrentTurnDelegationEvidence,
  enforcePersistentActionEvidence,
  enforceOutboundAudioEvidence,
  enforceOutboundImageEvidence,
  enforceDestructiveEffectEvidence,
  enforceProviderModelFailureGrounding,
  enforceAgentUpdateNoOpGrounding,
  enforceSchedulerStateEvidence,
  enforceCompletionEvidence,
  enforceOngoingWorkEvidence,
  enforceRuntimeSelfReportEvidence,
  enforceSenderAuthorityGrounding,
  enforceActiveModelSelfStatus,
  hasTrustedRuntimeActionEvidence,
  isTrustedBackgroundCompletionEnvelope,
} from "./executor-response-filter.js";
import { BACKGROUND_POLLER_TOOL } from "../safety/background-failure-attribution.js";
import { parseContextExhaustionCause } from "../context-engine/errors.js";
import { recoverFinalResponseLocaleFailure } from "./prompt-runner/response-locale-enforcement.js";
import { buildSyntheticCriticDeps } from "./verification-gate-synth-deps.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { generateCanaryToken } from "@comis/core";
import type { BackgroundTaskManager } from "../background/background-task-manager.js";
import { reconcilePendingBackgroundTurn } from "./pending-background-reply.js";
import {
  synchronizeFinalAssistantResponse,
  type FinalAssistantSyncDiagnostics,
} from "./phase-filter.js";
import {
  appendCitationEvidenceRecord,
  enforceCitationEvidence,
  historicalCitationDigests,
  isCitationSourceRequest,
} from "./citation-evidence.js";
import {
  buildSubagentTerminalToolFailureReply,
  classifySubagentTerminalToolFailure,
  classifyToolFailureRecovery,
  type ToolExecutionResultRecord,
} from "../bridge/tool-failure-recovery.js";
export { buildSubagentTerminalToolFailureReply } from "../bridge/tool-failure-recovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge result interface used by post-execution. */
export interface PostExecutionBridgeResult {
  tokensUsed?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost?: { total: number; cacheSaved?: number; ghostCostUsd?: number; timedOutRequests?: number };
  stepsExecuted?: number;
  llmCalls?: number;
  toolCallHistory?: string[];
  finishReason?: ExecutionResult["finishReason"];
  lastActiveToolName?: string;
  /** The last LLM error message the bridge captured on the mid-turn path —
   *  the context-exhausted reply reads the `[cause: …]` tag from it when
   *  errorContext is absent. */
  lastLlmErrorMessage?: string;
  failedToolCalls?: number;
  failedTools?: string[];
  cumulativeLlmDurationMs?: number;
  cumulativeToolDurationMs?: number;
  /** Wallclock-capped tool duration: parallel tool overlap does not inflate this value. */
  cumulativeToolWallclockMs?: number;
  textEmitted?: boolean;
  /** Estimated 5m TTL cache write tokens from TTL split data. */
  cacheWrite5mTokens?: number;
  /** Estimated 1h TTL cache write tokens from TTL split data. */
  cacheWrite1hTokens?: number;
  /** Session-cumulative total cost across all turns (USD). */
  executionCostUsd?: number;
  /** Per-tool execution results carrying the classified errorKind —
   *  the rollup's failure source for toolStats + topErrorKinds. */
  toolExecResults?: ToolExecutionResultRecord[];
  /** How many times an execution failure breaker opened this session. */
  breakerTripCount?: number;
  /** Turn count for the session:summary event. */
  turnCount?: number;
  /**
   * The SDK-normalized stop reason of the session's FINAL turn. The bridge
   * captures `AssistantMessage.stopReason` at EVERY `turn_end`
   * (pi-event-bridge.ts), so the value carried here is the TERMINAL one. Its
   * union is
   * `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`
   * (pi-ai) — matching is POSITIVE throughout, so an added member never
   * misclassifies. `"pending"` is the stream-accumulator initial value and
   * `"deferred"` only appears for opt-in deferred provider requests, which
   * Comis does not issue. A terminal `"length"` is the output-cap truncation
   * the chokepoint promotes to
   * `finishReason:"output_starved"` (see {@link promoteOutputStarved}). Already
   * returned by `buildBridgeResult`; surfaced on this interface so the chokepoint
   * can read it without a second source.
   */
  lastStopReason?: string;
  /**
   * For a terminal `"length"`, whether output ended BELOW the model's own
   * output ceiling — i.e. the provider truncated early (context pressure)
   * rather than the model spending its whole allowance. Decided by the SDK's
   * `isRecoverableLength` at the bridge's `turn_end`, which is the same
   * predicate the SDK's own compact-and-retry uses, so both layers agree about
   * the turn. `undefined` = the model cap was unavailable, NOT "measured
   * false"; the hint falls back to its cap/emit branches in that case.
   */
  lastLengthStopRecoverable?: boolean;
  /** Session-cumulative cache savings across all turns (USD). */
  executionCacheSavedUsd?: number;
  /** Thinking tokens from SDK reasoningTokens field. */
  thinkingTokens?: number;
  // Per-execute diagnostic counters surfaced into the bookend log.
  /** Number of pre-LLM-call hash-assertion walks performed (one per turn_start). */
  hashAssertionsRan?: number;
  /** Total cross-turn thinking-block hash mismatches surfaced across all walks. */
  hashAssertionMismatches?: number;
  /** Bridge-side mirror of the scrub counter (carried through buildBridgeResult
   *  for symmetry — the canonical per-execute total comes from
   *  ceSetup.getSignatureScrubCounters() since the scrubber doesn't write to
   *  bridge metrics; included on this interface so consumers reading the
   *  bridge-result shape get a coherent type). */
  signatureScrubs?: number;
  signatureScrubsToolCallsAffected?: number;
  /** Number of turns flagged as `warmupTurn` (cacheReadTokens === 0 && cacheWriteTokens > 0). */
  warmupTurnCount?: number;
  /** Positive-signed sum of pending cache investment across warmup turns (USD). */
  totalPendingCacheInvestmentUsd?: number;
  /** Cumulative SDK→corrected cost delta across all turns (USD).
   *  Conditionally emitted on the Execution-complete log when > 0 — mirrors
   *  the per-event `costCorrection` breadcrumb gate in pi-event-bridge.ts. */
  totalCostCorrectionDeltaUsd?: number;
  /** Abort-redirect message set at bridge abort sites
   *  (max_steps, budget_exceeded, loop_detected, …). When present and the
   *  turn did not finish with "stop", post-execution replaces the response
   *  so a weak executive never free-associates after an abort. Mirrors
   *  bridge-metrics.ts BridgeResult.abortResponse. */
  abortResponse?: string;
  sideEffectSummary?: ExecutionSideEffectSummary;
}

/** Bridge interface used by post-execution. */
export interface PostExecutionBridge {
  getResult(): PostExecutionBridgeResult;
  /**
   * Expose the bridge-owned drain inflight gate so postExecution can fire
   * an end-of-turn backstop `drainAt(...)`. The bridge already drains on
   * `tool_execution_end` for `message` actions (inline-consumption); the
   * end-of-turn backstop closes the residual race for turns that never
   * invoked the `message` tool but still need the inline-consumption
   * queue flipped (NO_REPLY-only turns, sentinel passes, etc.).
   *
   * Both call sites share the SAME composite key gate map so concurrent
   * drains for the same `(agentId, channelType, channelId)` triple
   * collapse to a single in-flight Promise.
   */
  getDrainState(): DrainInflightState;
}

/** Parameters for postExecution(). */
export interface PostExecutionParams {
  result: ExecutionResult;
  session: AgentSession;
  sm: SessionManager;
  config: PerAgentConfig;
  msg: NormalizedMessage;
  /** Exact typed response-locale decision used for this turn. */
  responseLocalePolicy: ResponseLocalePolicy;
  /** Current request sender trust captured at the execution boundary. */
  senderTrust: UserTrustLevel;
  sessionKey: SessionKey;
  formattedKey: string;
  /** Conversation authority used for active-run deregistration. */
  resolverRegisterKey: ConversationRef;
  agentId: string | undefined;
  executionStartMs: number;
  executionId: string;
  executionOverrides: ExecutionOverrides | undefined;
  /** Recalled memories (id + content) for turn-end attribution. Consumed
   *  IN-PROCESS by the overlap heuristic here; content NEVER logged/emitted (only
   *  ids/counts cross the bus). Absent ⇒ no attribution (default-off / no recall). */
  recalledMemories?: ReadonlyArray<{ id: string; content: string }>;
  /** The per-turn skill ids attributed by the bridge (skillNames whose
   *  frozen `<location>` a `read` matched), read back from the bridge's named
   *  carrier. When non-empty, postExecution emits the counts/ids-only
   *  `memory:skill_used` write-back (the daemon's learning subscriber consumes
   *  it). Absent / empty ⇒ no emit. Ids only — never bodies. */
  usedSkillIds?: ReadonlyArray<string>;
  bridge: PostExecutionBridge;
  unsubscribe: () => void;
  // Context engine
  contextEngineRef: { current?: ContextEngine };
  ceSetup: {
    getContextEngineDurationMs(): number;
    // Per-execute signature-replay scrub counters rolled up into the bookend
    // "Execution complete" INFO log (replaces the per-event INFO emissions
    // demoted to DEBUG in signature-replay-scrubber.ts).
    getSignatureScrubCounters(): {
      signatureScrubs: number;
      signatureScrubsToolCallsAffected: number;
    };
  };
  streamSetup: {
    capturedRetention?: { getRetention(): CacheRetention };
  };
  // Truncation and budget summaries
  getTruncationSummary: () => { truncatedTools: number; totalTruncatedChars: number };
  getTurnBudgetSummary: () => { turnsExceeded: number; totalBudgetTruncatedChars: number };
  // State
  executionPlanRef: { current: ExecutionPlan | undefined };
  isOnboarding: boolean;
  geminiCacheHit: boolean;
  geminiCachedTokens: number;
  capabilityClass: CapabilityClass | undefined;
  /**
   * The turn's budget window — computeTokenBudgetForProfile().windowTokens
   * = min(reconciled contextWindow, capability class cap). MUST be computed
   * UPSTREAM (pi-executor threads it off the tool-assembly result): this module
   * has no real ModelProfile (only a synthetic scaffold profile), so it can never
   * re-derive the value. Threaded into BOTH LCD after-turn triggers as the
   * REQUIRED utilization denominator — a captured number, dispose-safe on the
   * deferred path by construction.
   */
  budgetWindowTokens: number;
  /**
   * Provider used for this execution. Sourced from `resolvedModel.provider` in
   * pi-executor when available; falls back to `config.provider` when the
   * misconfig silent-fallback path triggers (resolvedModel undefined). The
   * fallback value records operator INTENT — the actual provider chosen by
   * pi-coding-agent's silent-fallback logic is opaque at this layer, and intent
   * is the more useful signal for operator-side cache-hit-rate segmentation.
   */
  provider: string;
  /** Exact model identifier used for this execution. */
  modelId: string;
  /**
   * Provider family derived from `resolveProviderCapabilities(provider).providerFamily`.
   * One of "anthropic" | "openai" | "google" | "default". Pre-computed at the
   * call site (pi-executor) so this module stays free of capability-cascade dependencies.
   */
  providerFamily: string;
  deferralResult: { deferredCount: number };
  mergedCustomTools: Array<{ name: string }>;
  deliveredGuides: Set<string>;
  discoveryTracker?: DiscoveryTracker;
  // Deps
  deps: {
    agentId: string;
    eventBus: TypedEventBus;
    logger: ComisLogger;
    memoryPort?: MemoryPort;
    /** Canonical durable context store. TYPE-only core port. */
    contextStore: ContextStorePort;
    /** Tenant id for the context-store scope. */
    tenantId: string;
    /** Getter for the leaf-summarizer deps. Present ⇒ the
     *  afterTurn leaf pass is wired live (over threshold ⇒ a leaf summary is
     *  persisted); absent ⇒ the pass is gated off cleanly. Sourced from the
     *  context-engine setup's getCompactionDeps-style getters; TYPE-only (the
     *  agent↛memory cut — the LLM call lives behind the injected summarizer).
     *  Accepts an optional `modelSnapshot`: the DEFERRED path passes a model
     *  identity captured BEFORE `session.dispose()` so a detached pass never
     *  re-reads a torn-down `session.agent.state`. */
    getSummarizerDeps?: (modelSnapshot?: CompactionModelSnapshot) => LeafSummarizerDeps;
    getFlushSummarizerDeps?: (
      modelSnapshot?: CompactionModelSnapshot,
    ) => LeafSummarizerDeps | undefined;
    activeRunRegistry?: ActiveRunRegistry;
    embeddingEnqueue?: (entryId: string, content: string) => void;
    workspaceDir: string;
    /** Wall-clock + monotonic time reads. */
    clock: ClockPort;
    /** Required-work ownership for terminal response reconciliation. */
    backgroundTaskManager?: Pick<BackgroundTaskManager, "getTasks">;
  };
  // Session adapter
  sessionAdapter: ComisSessionManager;
  // Mutable ref clearing callbacks
  executionCacheRetentionClear: () => void;
  adaptiveRetentionClear: () => void;
  executionMinTokensOverrideClear: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forward-declared shape of the `rag.feedback` sub-object (a later change adds
 * it to RagConfigSchema). Until that lands, RagConfig has no `feedback`
 * key, so we read it through this view via a structural widening. Optional
 * chaining + the `=== true` check make the gate default-OFF: absent field ⇒
 * no attribution, no emit. When the field is added, this access stays correct.
 */
interface FeedbackView {
  enabled?: boolean;
  usefulnessAlpha?: number;
}

/** Max chars of agent response to include in paired memory content. */
const PAIRED_RESPONSE_MAX_CHARS = 300;

/**
 * Build paired memory content combining user message and agent response.
 * Format: "[user] <message>\n[agent] <response>" with truncated agent response.
 *
 * Pairing provides semantic context for RAG retrieval -- standalone user
 * messages like "Hello" carry no meaning without the agent's reply.
 */
function buildPairedMemoryContent(userText: string, agentResponse: string): string {
  const truncated = agentResponse.length > PAIRED_RESPONSE_MAX_CHARS
    ? agentResponse.slice(0, PAIRED_RESPONSE_MAX_CHARS - 3) + "..."
    : agentResponse;
  return `[user] ${userText}\n[agent] ${truncated}`;
}

/**
 * Recover the exact physical user-authored text represented by a turn.
 *
 * Prompt preprocessing may enrich `message.text` with fetched pages,
 * transcriptions, or extracted media context. Durable paired memory must use
 * the ingress provenance instead of persisting that model-only context as if
 * the user authored it.
 */
export function resolvePairedMemoryUserText(
  message: Pick<NormalizedMessage, "text" | "originalMessages">,
): string {
  return message.originalMessages?.map((original) => original.text).join("\n")
    ?? message.text;
}

/** Minimum trimmed user-message chars to qualify for paired memory storage. */
const PAIRED_MIN_USER_CHARS = 12;

/** Minimum combined (user + agent) trimmed chars to qualify for storage. */
const PAIRED_MIN_COMBINED_CHARS = 80;

/**
 * Quality gate for paired memory storage.
 *
 * Prevents trivially short user messages (emoji, single-word acks) from being
 * stored and embedded, which wastes embedding slots and dilutes RAG retrieval.
 *
 * @param userText - Raw user message text
 * @param agentResponse - Agent response text
 * @returns true if the turn qualifies for memory storage
 */
/**
 * Finish reasons whose reply is genuine model output and may become durable
 * paired memory. Every other reason means the user-visible text was
 * SUBSTITUTED by the runtime (the silent-recovery fallback, the
 * prepare/assemble failure replies, a context-exhausted or budget notice) or
 * was truncated mid-thought — none of which is a thing the agent said.
 *
 * Persisting one is a durable falsehood rather than a lost memory: recall
 * later injects it as `[agent] <runtime failure text>` past context, so the
 * model reads a manufactured failure as its own history and repeats it. Live,
 * that ratcheted into refusing benign owner requests as prompt injection.
 *
 * `completed_with_tool_errors` IS eligible — the turn produced real model text
 * despite a failing tool. An absent reason predates the outcome plumbing and
 * stays eligible so the common path is unchanged.
 */
const PAIRED_MEMORY_ELIGIBLE_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "completed_with_tool_errors",
]);

/**
 * Whether a turn's outcome allows its reply to enter paired conversation
 * memory. See {@link PAIRED_MEMORY_ELIGIBLE_FINISH_REASONS}.
 */
export function isPairedMemoryEligibleOutcome(finishReason: string | undefined): boolean {
  if (finishReason === undefined) return true;
  return PAIRED_MEMORY_ELIGIBLE_FINISH_REASONS.has(finishReason);
}

export function shouldStorePairedMemory(userText: string, agentResponse: string): boolean {
  const userLen = userText.trim().length;
  if (userLen < PAIRED_MIN_USER_CHARS) return false;

  const combinedLen = userLen + agentResponse.trim().length;
  if (combinedLen < PAIRED_MIN_COMBINED_CHARS) return false;

  return true;
}

/**
 * Operation types that must NOT create paired memories.
 *
 * Cron and heartbeat executions are stateless and repetitive -- storing their
 * prompts pollutes the vector space and degrades RAG recall for interactive
 * conversations. Compaction / taskExtraction / condensation are system-internal
 * operations that have their own dedicated memory paths (compaction summaries,
 * extracted tasks) and should not additionally create paired conversation
 * entries. Interactive and subagent are deliberately excluded.
 */
const MEMORY_SKIP_OPERATIONS: ReadonlySet<string> = new Set([
  "cron",
  "heartbeat",
  "compaction",
  "taskExtraction",
  "condensation",
  "verification",
]);

/**
 * In-memory dedup cache for paired memory content.
 *
 * Defense-in-depth for interactive conversations where the user sends the same
 * message multiple times (retries, reconnects). The Layer-1 operationType gate
 * is the primary defense against cron/heartbeat duplication; this Layer-2 hash
 * dedup catches residual duplicates that slip through.
 *
 * Keyed by a 64-bit truncation of sha256(agentId || content). Single-process
 * daemon deployment (pm2, no cluster) means this cache is always complete.
 */
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 500;
const pairedMemoryDedup = new Map<string, number>();

/**
 * Check whether paired memory content was stored recently for this agent.
 *
 * Exact-content hashing (not semantic similarity) -- targets the cron pattern
 * of identical prompt + identical NO_REPLY response. Lazy eviction keeps the
 * cache bounded without a timer.
 *
 * Exported for unit tests.
 */
export function isDuplicatePairedMemory(content: string, agentId: string, clock: ClockPort): boolean {
  const now = clock.now();

  if (pairedMemoryDedup.size > DEDUP_MAX_ENTRIES) {
    for (const [key, ts] of pairedMemoryDedup) {
      if (now - ts > DEDUP_TTL_MS) pairedMemoryDedup.delete(key);
    }
  }

  const hash = createHash("sha256")
    .update(agentId)
    .update(content)
    .digest("hex")
    .slice(0, 16);

  const existing = pairedMemoryDedup.get(hash);
  if (existing != null && now - existing <= DEDUP_TTL_MS) return true;
  pairedMemoryDedup.set(hash, now);
  return false;
}

/** Reset the paired-memory dedup cache. Exported for unit tests. */
export function resetPairedMemoryDedupForTests(): void {
  pairedMemoryDedup.clear();
}

/** Minimal logger surface the paired-store helper needs (debug/warn only). */
interface PairedStoreLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Args for {@link storePairedConversationMemory}. */
export interface StorePairedConversationMemoryArgs {
  memoryPort: MemoryPort;
  memoryScope: MemoryWriteScope;
  /** The built "[user] …\n[agent] …" paired content (already quality-gated + deduped). */
  pairedContent: string;
  effectiveAgentId: string;
  sessionKey: { tenantId: string; userId: string };
  channelType: string | undefined;
  formattedKey: string;
  now: number;
  logger: PairedStoreLogger;
  /** Embedding enqueue (vector-index recall path). Omitted ⇒ no embedding. */
  embeddingEnqueue?: (entryId: string, content: string) => void;
}

/**
 * Persist a paired-conversation memory through the secret-egress firewall.
 *
 * SECURITY: the paired-conversation write is the highest-volume memory
 * path (every qualifying turn); without this guard it would be the only
 * agent-visible memory write that bypasses `validateMemoryWrite`. A user who
 * pasted a secret into chat would have it written VERBATIM to the `memories`
 * table AND embedded into the vector index — recallable across sessions — even
 * though the explicit `memory_store` tool refuses it (cosmetic for
 * data-at-rest). The DERIVED-memory writes
 * (user-representation, consolidation) all run `validateMemoryWrite`
 * FIRST; this helper applies the SAME guard to the paired write for parity.
 *
 * `validateMemoryWrite` REJECTS (returns severity `critical`) when the secret-
 * egress scan finds a redaction — it does NOT scrub-and-return content. So a
 * non-`clean` verdict SKIPS the write (no row, no embedding) with a CONTENT-FREE
 * WARN, byte-identical to the user-representation path
 * (memory-user-representation-job.ts:390-406): the high-trust `learned` floor has
 * no reduced-weight tier to down-store a `warn` into, so both `warn` AND
 * `critical` are skipped, not downgraded. Non-secret content stores unchanged.
 *
 * The skip log is CONTENT-FREE (Pino redaction / AGENTS.md §2.7): the planted
 * secret value never appears in any field — only `severity` + `patterns` (the
 * verdict's pattern-source tags, e.g. `secret-egress-guard`, never the matched
 * text) + an actionable hint.
 *
 * Non-fatal: a store error is logged (dependency) and swallowed — execution never
 * fails due to a memory write. Exported for unit tests (the secret-egress gate is
 * unit-tested with a mock memoryPort capturing `.store` inputs; scaffolding all
 * 30+ postExecution deps is impractical).
 */
export async function storePairedConversationMemory(
  args: StorePairedConversationMemoryArgs,
): Promise<void> {
  const {
    memoryPort, memoryScope, pairedContent, effectiveAgentId, sessionKey,
    channelType, formattedKey, now, logger, embeddingEnqueue,
  } = args;

  // Secret-egress firewall FIRST (mirrors the derived-memory writes). A
  // non-`clean` verdict (secret OR dangerous/suspicious pattern) SKIPS the
  // write — the paired memory has the high-trust `learned` floor with no
  // reduced-weight tier, so a `warn` is skipped exactly like a `critical`
  // (parity with memory-user-representation-job.ts). The skip is CONTENT-FREE:
  // never log pairedContent or the matched secret value.
  const verdict = validateMemoryWrite(pairedContent);
  if (verdict.severity !== "clean") {
    logger.warn(
      {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        severity: verdict.severity,
        // Pattern-source tags only (e.g. "secret-egress-guard") — NEVER the
        // matched secret text. The verdict carries sources, not the content.
        patterns: verdict.patterns,
        // WHICH DETECTOR fired, as a closed enum. The two cases warrant OPPOSITE
        // responses and the pattern-source tags alone did not make that legible:
        // a `secret` verdict is the firewall working as designed (a credential
        // really was in the turn), while a `heuristic` verdict is a suspicious-
        // PATTERN match that may be a false positive on ordinary prose — and a
        // false positive silently drops a legitimate memory. Live, three drops in
        // one session were a mix of both and the WARN read identically for each.
        // Still content-free: a closed label derived from the verdict's own
        // source tags, never the matched text.
        detector: verdict.patterns.includes("secret-egress-guard")
          ? ("secret" as const)
          : ("heuristic" as const),
        hint: verdict.patterns.includes("secret-egress-guard")
          ? "A credential was detected in the paired conversation memory — the write was skipped and the value was never logged or persisted. This is the firewall working as intended; no action needed unless a credential is reaching conversation content that should not carry one."
          : "A suspicious-PATTERN heuristic (not the secret detector) matched the paired conversation memory, so the write was skipped and this turn is NOT recallable later. If the listed patterns look like a false positive on ordinary prose, that is a lost memory, not a blocked leak — review the named pattern sources before assuming the drop was correct.",
        errorKind: "validation" as ErrorKind,
      },
      "Paired memory skipped: failed the memory-write security scan",
    );
    return;
  }

  try {
    const userEntryId = randomUUID();
    const userStoreResult = await memoryPort.store({
      id: userEntryId,
      content: pairedContent,
      trustLevel: "learned",
      source: {
        who: sessionKey.userId,
        channel: channelType ?? "unknown",
        sessionKey: formattedKey,
      },
      tags: ["conversation", "paired"],
      createdAt: now,
    }, memoryScope);
    if (!userStoreResult.ok) {
      logger.warn(
        { err: userStoreResult.error.message, hint: "Check database connectivity and disk space", errorKind: "dependency" as ErrorKind },
        "Memory store failed for user message",
      );
    } else if (embeddingEnqueue) {
      embeddingEnqueue(userEntryId, pairedContent);
    }
  } catch {
    // Memory storage failure is non-fatal -- errors already logged per-entry
  }
}

/**
 * Decide whether the context-store afterTurn passes (ingest + leaf + condense)
 * run for this turn. The durable store is the canonical context source, so only
 * the explicit master toggle can suppress these passes.
 *
 * Pure: no I/O, no side effects. Exported for unit tests.
 */
export function shouldRunContextStorePasses(config: {
  contextEngine?: { enabled?: boolean };
}): boolean {
  return config.contextEngine?.enabled !== false;
}

/**
 * Map an SDK finishReason to the SessionMetadata.sessionEnd.endReason enum.
 *
 * SINGLE SOURCE OF TRUTH for the run's terminal classification: the rollup's
 * `degraded` flag (session-health-rollup.ts) is derived from the value this map
 * yields (degraded := mapped endReason !== "success"), so `endReason` and
 * `degraded` are computed from the SAME table and cannot diverge.
 * Exported so the chokepoint maps once and the unit tests can
 * enumerate the finishReason union against it.
 *
 * Every KNOWN, in-union `ExecutionResult.finishReason` is listed EXPLICITLY —
 * including `loop_detected` (turn-loop-detector abort) and `session_reset`.
 * The `?? "error"` fallthrough is reserved for its stated purpose:
 * a defensive bucket for UNKNOWN provider strings we haven't classified yet,
 * not a silent home for classified in-union reasons. Module-level so the
 * post-execution path doesn't reallocate it on every turn.
 *
 * NOTE: the `prompt_timeout` entry below is the ONLY source of the endReason
 * union's "timeout" literal — a test pins that no other mapping produces it,
 * so the named cause stays deliberate rather than accidental.
 *
 * NAMED degradation causes: flattening context-exhaustion into the generic
 * "error" bucket would leave obs.explain / obs.system.health unable to tell a
 * context-exhausted session from a tool crash. The two related
 * context-exhaustion finish reasons —
 * `context_exhausted` (the bridge's hard context-window-guard abort,
 * bridge-safety-controls.ts) and `context_loop` (the loop-on-exhaustion abort) —
 * FOLD into ONE named cause `"context_exhausted"`. `output_starved` (the
 * chokepoint promotes a terminal output-cap truncation) is its own named
 * cause `"output_starved"`. Both are degraded by construction (≠ "success", so
 * session-health-rollup's CLEAN_END_REASONS derives degraded:true unchanged).
 */
export const END_REASON_MAP: Record<string, NonNullable<SessionMetadata["sessionEnd"]>["endReason"]> = {
  stop: "success", end_turn: "success", error: "error",
  budget_exceeded: "budget_exceeded", budget_exhausted: "budget_exhausted",
  circuit_open: "circuit_open",
  provider_degraded: "provider_degraded", max_steps: "error",
  // Fold the two context-exhaustion reasons into the single named cause.
  context_loop: "context_exhausted", context_exhausted: "context_exhausted",
  // The terminal output-cap truncation promoted at the chokepoint.
  output_starved: "output_starved",
  background_pending: "background_pending",
  // PromptTimeoutError terminals get their own NAMED cause. HARD_FAILURE_END_REASONS
  // and the system degradedByCause record carry "timeout".
  prompt_timeout: "timeout",
  input_too_large: "error",
  // The dollars kill-switch abort (bridge-safety-controls sets
  // finishReason:"spend_exceeded") gets its OWN named cause instead of the `?? "error"`
  // catch-all — so obs.explain / obs.system.health can tell a spend-killed session from
  // a tool crash. HARD_FAILURE_END_REASONS (obs-explain-
  // assemble.ts) carries it so the system degradedByCause record attributes the CAUSE.
  spend_exceeded: "spend_exceeded",
  completed_with_tool_errors: "completed_with_tool_errors",
  // The narrate-without-emit terminal promoted at the chokepoint
  // (see promoteNarrationStall) — a small/nano turn that ended on intent
  // narration with no tool call and did not recover after the one nudge.
  narration_stall: "narration_stall",
  tool_invocation_stall: "tool_invocation_stall",
  // Known in-union reasons — explicit, not via the catch-all fallthrough.
  loop_detected: "error",
  session_reset: "error",
};

/**
 * The SDK-normalized terminal stop reasons that mark an output-cap truncation.
 * The pi-ai `StopReason` union normalizes the output cap to `"length"`
 * (pi-ai/types.d.ts) — that is the authoritative value. `"max_tokens"` /
 * `"maxTokens"` are accepted defensively in case a future/non-Anthropic provider
 * surfaces a provider-raw variant; the conservative terminal-only gate below
 * keeps that breadth from ever flagging a healthy session. Module-level so the
 * post-execution path does not reallocate it per turn.
 */
const TERMINAL_OUTPUT_STARVED_STOP_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "maxTokens",
]);

/**
 * Promote a PATHOLOGICAL terminal output truncation to the named cause.
 *
 * Returns `"output_starved"` IFF the run would OTHERWISE end clean
 * (`stop`/`end_turn` → `success`) AND the session's FINAL turn stopped at the
 * model output cap (`lastStopReason ∈ {length, max_tokens}`). Otherwise it
 * returns `effectiveFinishReason` UNCHANGED.
 *
 * This is deliberately conservative — the hard rule is "do not flag healthy
 * sessions" (the load-bearing guard):
 *   - It fires ONLY on a CLEAN would-be terminal. A run that already settled on
 *     a non-clean cause (tool errors, budget, breaker, context_exhausted, error)
 *     keeps that upstream cause — the truncation is not the headline there.
 *   - It keys on the TERMINAL stop reason. `m.lastStopReason` is overwritten at
 *     every `turn_end` (pi-event-bridge.ts), so a mid-run length-stop the agent
 *     CONTINUED past (output escalation re-ran, or another turn followed) carries
 *     a NON-length terminal value (`stop`/`end`/`toolUse`) by the time it reaches
 *     here and is correctly NOT flagged. Only a run whose LAST turn was cut off
 *     at the cap — with nothing after it — qualifies.
 *
 * Pure: no I/O, no side effects. Exported for unit tests (both directions pinned).
 *
 * @param effectiveFinishReason - the settled finish reason at the chokepoint
 *   (already reconciled for tool failures → completed_with_tool_errors).
 * @param lastStopReason - the bridge's terminal `AssistantMessage.stopReason`.
 */
/**
 * Operator instruction for an `output_starved` terminal, branched on whether the
 * model actually produced anything.
 *
 * The verdict names the output CAP, so every hint pointed at `maxTokens`. That is
 * right only when a real answer was cut off mid-flight. Measured live: the cap
 * sent was 32,768 with 65,853 tokens of remaining room and the model returned a
 * single token — it emitted NOTHING, so raising the cap could not have helped,
 * and the turn still billed a full cold prefix write. On a thinking-capable model
 * the usual cause of that shape is the thinking budget consuming the whole output
 * allowance, which is a different knob entirely.
 *
 * @param evidence - terminal stop reason and whether visible text was emitted.
 * @returns the hint to ride the WARN line.
 */
export function outputStarvedHint(evidence: {
  textEmitted?: boolean;
  lastStopReason?: string;
  recoverableLength?: boolean;
}): string {
  // Checked FIRST: a below-cap truncation makes both cap-shaped remedies
  // wrong, whether or not text was emitted. The SDK detects the same shape and
  // compacts + retries the turn once, so the operator needs to know a
  // compaction already ran before reaching for any knob.
  if (evidence.recoverableLength === true) {
    return "The terminal turn stopped at a length limit BELOW the model's own output ceiling, so the "
      + "configured cap was not the binding constraint — the provider truncated the response early, "
      + "which points at context pressure. The SDK compacts and retries such a turn once; if this "
      + "recurs, reduce the assembled context (contextEngine budget, tool-result sizes) rather than "
      + "raising maxTokens.";
  }
  if (evidence.textEmitted === true) {
    return "The terminal turn was cut off at the output cap after emitting text: raise the agent's "
      + "maxTokens, or enable contextEngine.outputEscalation so a capped turn retries with a larger "
      + "output budget.";
  }
  return "The terminal turn stopped at the output cap having emitted NO visible output, so the cap "
    + "was not the binding constraint and raising maxTokens will not help. On a thinking-capable "
    + "model the usual cause is the thinking budget consuming the whole output allowance — compare "
    + "the request's thinking budget against max_tokens, and check the completion token count "
    + "before treating this as a truncated answer.";
}

export function promoteOutputStarved(
  effectiveFinishReason: string,
  lastStopReason: string | undefined,
): string {
  // Gate 1: only a CLEAN would-be terminal is eligible (the conservative guard).
  if (effectiveFinishReason !== "stop" && effectiveFinishReason !== "end_turn") {
    return effectiveFinishReason;
  }
  // Gate 2: the terminal model stop must be the output cap.
  if (lastStopReason !== undefined && TERMINAL_OUTPUT_STARVED_STOP_REASONS.has(lastStopReason)) {
    return "output_starved";
  }
  return effectiveFinishReason;
}

/**
 * Promote a narrate-without-emit terminal to the named cause `narration_stall`.
 *
 * Fires IFF the run would OTHERWISE end clean (`stop`/`end_turn`) AND the
 * narrate-nudge FIRED for this turn but did NOT recover a real answer — the
 * delivered response is still mid-task narration ("Now let me run the
 * tool:") with no tool call behind it. Without this promotion such a turn
 * records `degraded:false, endReason:success` — a soft false-clean.
 * Mirrors {@link promoteOutputStarved}'s conservative shape:
 * an already-non-clean cause always wins, and a recovered (or never-fired)
 * nudge changes nothing.
 *
 * Pure. Exported for unit tests (both directions pinned).
 */
export function promoteNarrationStall(
  effectiveFinishReason: string,
  narrateNudge: { fired: boolean; recovered: boolean } | undefined,
): string {
  if (effectiveFinishReason !== "stop" && effectiveFinishReason !== "end_turn") {
    return effectiveFinishReason;
  }
  if (narrateNudge?.fired === true && narrateNudge.recovered === false) {
    return "narration_stall";
  }
  return effectiveFinishReason;
}

/** Promote an unrecovered repeated-answer action turn to a named failure. */
export function promoteToolInvocationStall(
  effectiveFinishReason: string,
  requestToolNudge: { fired: boolean; recovered: boolean } | undefined,
): string {
  if (
    effectiveFinishReason !== "stop"
    && effectiveFinishReason !== "end_turn"
    && effectiveFinishReason !== "completed_with_tool_errors"
  ) {
    return effectiveFinishReason;
  }
  if (requestToolNudge?.fired === true && requestToolNudge.recovered === false) {
    return "tool_invocation_stall";
  }
  return effectiveFinishReason;
}

/** Publish the single authoritative terminal reason and side-effect facts. */
export function settleExecutionResult(
  result: ExecutionResult,
  finishReason: AgentExecutionFinishReason,
  bridgeResult: {
    sideEffectSummary: ExecutionSideEffectSummary;
    toolExecResults?: PostExecutionBridgeResult["toolExecResults"];
    terminalErrorKind?: ErrorKind;
  },
): void {
  const mutableResult = result as ExecutionResult & {
    finishReason: AgentExecutionFinishReason;
    terminalErrorKind?: ErrorKind;
  };
  mutableResult.sideEffectSummary = { ...bridgeResult.sideEffectSummary };
  mutableResult.finishReason = finishReason;
  if (finishReason === "error" || finishReason === "completed_with_tool_errors") {
    const firstFailedKind = bridgeResult.toolExecResults?.find(
      (toolResult) => !toolResult.success,
    )?.errorKind;
    mutableResult.terminalErrorKind = firstFailedKind
      ?? mutableResult.terminalErrorKind
      ?? bridgeResult.terminalErrorKind
      ?? "internal";
    return;
  }
  delete mutableResult.terminalErrorKind;
}

/**
 * Build the SessionMetadata payload written to `_session-metadata.json` at the
 * end of an execution.
 *
 * `traceId` and `runId` are deliberately distinct:
 * - `traceId` is the request-scope AsyncLocalStorage value set by
 *   `runWithContext` at the channel boundary (execution-execute.ts) and injected
 *   into every daemon log line by the Pino tracing mixin. Operators grep
 *   daemon.log for this exact value. Pass `tryGetContext()?.traceId` here.
 * - `runId` is the executor-scope UUID minted in pi-executor.ts per
 *   `executor.execute()` call. It keys cost-tracker / token_usage rows.
 *
 * They happen to be 1:1 in the steady-state interactive path (one inbound
 * message → one execution), but the schema treats them as distinct because
 * heartbeat / sub-agent paths can fan out one trace into multiple executions.
 *
 * Pure: no I/O, no side effects. The fire-and-forget try/catch around
 * `writeSessionMetadata` lives at the call site.
 */
export function buildSessionEndMetadata(args: {
  finishReason: string;
  durationMs: number;
  totalTokens: number;
  executionId: string;
  traceId: string | undefined;
  /** The formatted session key, stored so the metadata can drive `comis explain`. */
  sessionKey: string;
  clock: ClockPort;
  /** The health rollup — the 5 fields spread onto sessionEnd. Computed once
   *  at the chokepoint via buildSessionHealthRollup so this builder stays pure. */
  rollup: SessionHealthRollup;
}): SessionMetadata {
  return {
    ...(args.traceId && { traceId: args.traceId }),
    ...(args.sessionKey && { sessionKey: args.sessionKey }),
    runId: args.executionId,
    sessionEnd: {
      type: "session_end",
      timestamp: args.clock.nowDate().toISOString(),
      endReason: END_REASON_MAP[args.finishReason] ?? "error",
      durationMs: args.durationMs,
      totalTokens: args.totalTokens,
      degraded: args.rollup.degraded,
      costUsd: args.rollup.costUsd,
      toolStats: args.rollup.toolStats,
      breakerTripCount: args.rollup.breakerTripCount,
      topErrorKinds: args.rollup.topErrorKinds,
    },
  };
}

/**
 * Announce `session:summary` on the eventBus once per execution.
 *
 * The payload carries ids + counts + typed flags PLUS `topErrorKinds` and
 * `source`: both are threaded into the
 * persisted `obs_diagnostics` row so the system aggregate
 * (`aggregateSessionsInWindow`) can read them without opening per-session
 * `_session-metadata.json`. Production emits the constant `source: "runtime"`;
 * a synthetic/test row is produced by a caller injecting `source: "test"`.
 * Fire-and-forget by contract: the eventBus is SYNCHRONOUS, so a throwing
 * in-process listener would otherwise abort the caller's teardown. The
 * try/catch here is the sanctioned telemetry guard (mirrors the
 * `writeSessionMetadata` guard) — a telemetry failure must never break execution.
 */
export function emitSessionSummary(
  deps: { eventBus?: TypedEventBus; logger?: ComisLogger },
  args: {
    sessionKey: string;
    agentId: string;
    traceId: string;
    turnCount: number;
    rollup: SessionHealthRollup;
    /** The mapped endReason (named degradation cause) — the SAME value derived
     *  once at the chokepoint via END_REASON_MAP and co-persisted on sessionEnd.
     *  Carried so the row feeds the system `degradedByCause` aggregate. */
    endReason: string;
    responseLocaleRepairSkipped?: ResponseLocaleRepairSkipped;
    clock: ClockPort;
  },
): void {
  if (!deps.eventBus) return;
  try {
    deps.eventBus.emit("session:summary", {
      sessionKey: args.sessionKey,
      agentId: args.agentId,
      traceId: args.traceId,
      degraded: args.rollup.degraded,
      turnCount: args.turnCount,
      costUsd: args.rollup.costUsd,
      toolStats: args.rollup.toolStats,
      breakerTripCount: args.rollup.breakerTripCount,
      topErrorKinds: args.rollup.topErrorKinds,
      source: "runtime" as const,
      endReason: args.endReason,
      ...(args.responseLocaleRepairSkipped !== undefined
        ? { responseLocaleRepairSkipped: args.responseLocaleRepairSkipped }
        : {}),
      timestamp: args.clock.now(),
    });
  } catch (err) {
    // Fire-and-forget: a throwing listener must not abort the teardown.
    deps.logger?.debug(
      { err, hint: "session:summary listener threw; telemetry dropped, execution unaffected", errorKind: "internal" as const, submodule: "session-summary-emit" },
      "session:summary emit suppressed a listener throw",
    );
  }
}

/**
 * Lifetime guard for the DEFERRED compaction path.
 *
 * The deferred leaf/condense passes are enqueued DETACHED onto the per-conversation
 * serializer and can run AFTER `postExecution` returns + `session.dispose()` tears
 * the session down. Each pass resolves its summarizer deps WHEN IT RUNS, and the
 * model getter (and the `buildLeafSummarizeFn`-internal model read) re-read
 * `session.agent.state.model` (executor-context-engine-setup.ts) — a use-after-
 * dispose if the SDK dispose nulls that state.
 *
 * This helper SNAPSHOTS the model identity ONCE, NOW (while the session is still
 * alive — called from `postExecution` BEFORE it returns/disposes), then re-binds
 * the getter so every later resolution passes that snapshot into `getSummarizerDeps`.
 * Because the snapshot threads into `resolveCompactionModelChain`, BOTH the top-level
 * `getModel` AND the summarizer's internal model read use the captured value — the
 * detached pass NEVER re-reads `session.agent.state`. The captured model is the
 * turn's own model (the correct one for compacting that turn's history), and the
 * lifetime contract is now explicit: the deferred path depends ONLY on this
 * snapshot + the daemon-owned store/auth/clock (all of which outlive the session),
 * never on `session.agent.state`.
 *
 * Resolving the snapshot is itself wrapped defensively: if reading the live model
 * throws (an already-disposed/edge session at call time), the helper falls back to
 * the original getter unchanged (the pass then degrades non-fatally via the
 * trigger's own try/catch — never a crash). Returns `undefined` when the input is
 * `undefined` (the leaf pass stays cleanly gated off).
 *
 * @param getSummarizerDeps - the live, session-coupled deps getter (or undefined).
 * @returns a model-snapshot-bound getter safe to call post-dispose (or undefined).
 */
export function snapshotSummarizerDepsForDefer<T extends LeafSummarizerDeps | undefined>(
  getSummarizerDeps: ((modelSnapshot?: CompactionModelSnapshot) => T) | undefined,
  snapshotSource?: (
    modelSnapshot?: CompactionModelSnapshot
  ) => LeafSummarizerDeps | undefined,
): ((modelSnapshot?: CompactionModelSnapshot) => T) | undefined {
  if (getSummarizerDeps === undefined) return undefined;
  // Capture the LIVE model identity now (session still alive). If the live read
  // throws at capture time, leave the getter unchanged — the deferred pass then
  // degrades non-fatally through the trigger's try/catch.
  let modelSnapshot: CompactionModelSnapshot | undefined;
  try {
    const resolved = (snapshotSource ?? getSummarizerDeps)();
    if (resolved === undefined) return getSummarizerDeps;
    modelSnapshot = resolved.getModel();
  } catch {
    return getSummarizerDeps;
  }
  // Re-bind: every later resolution injects the captured snapshot, so neither the
  // top-level getModel nor the summarizer-internal model read touches the session.
  return (override?: CompactionModelSnapshot) => getSummarizerDeps(override ?? modelSnapshot);
}

/**
 * Classify failed tools into the subset that was NOT recovered this turn.
 *
 * Recovery requires a later invocation and later completion of the same tool.
 * Message operations additionally require the same action and content-free exact
 * route/target identity. The user-facing `[tool failure]` notice surfaces only
 * failures without that evidence.
 *
 * Safe fallback: when `toolExecResults` is absent/empty (success record not
 * plumbed on some path) every failed tool is reported as unrecovered —
 * so this never HIDES a genuine unrecovered failure.
 *
 * Raw tool statistics retain every failed attempt. Terminal classification and
 * the user-facing failure notice consume the unrecovered subset, so a later
 * matching success can settle the requested operation cleanly without erasing
 * the diagnostic record of the rejected attempt.
 *
 * Pure: no I/O, no side effects. Returns deduped names with no proven recovery.
 */
export function unrecoveredFailedToolNames(
  failedTools: string[],
  toolExecResults?: ToolExecutionResultRecord[],
): string[] {
  return [...classifyToolFailureRecovery(failedTools, toolExecResults).unrecoveredToolNames];
}

/**
 * The COMPLEMENT of {@link unrecoveredFailedToolNames}: failed tools with a
 * later matching recovery in the same turn.
 *
 * Surfaced on the execution bookend (`recoveredTools`) so an operator can tell
 * a corrected attempt from a turn with no failures without diffing the raw
 * per-call `toolExecResults`. The raw failure remains in tool statistics while
 * terminal classification consumes the unrecovered complement.
 * Pure; deduped; empty when nothing was recovered.
 */
export function recoveredFailedToolNames(
  failedTools: string[],
  toolExecResults?: ToolExecutionResultRecord[],
): string[] {
  return [...classifyToolFailureRecovery(failedTools, toolExecResults).recoveredToolNames];
}

/**
 * Returns true when the model response already acknowledges the failure of
 * one of the failed tools — used to suppress the auto-appended failure notice
 * when the model has explicitly mentioned the error.
 *
 * Pure: no I/O, no side effects.
 */
function modelAcknowledgedFailure(response: string, failedTools: string[]): boolean {
  if (!response || failedTools.length === 0) return false;
  const lower = response.toLowerCase();
  return failedTools.some(t => {
    const name = t.toLowerCase();
    // Escape regex metacharacters in the tool name before inserting into a RegExp.
    // Word-boundary match (\b) prevents short tool names like "write" from matching
    // substrings in unrelated words like "writer" or "writing".
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameRe = new RegExp(`\\b${escaped}\\b`);
    if (!nameRe.test(lower)) return false;
    return /\b(fail(ed|ure|s)?|error|unable|could\s+not|couldn'?t)\b/.test(lower);
  });
}

// ---------------------------------------------------------------------------
// Drain-seam re-exports.
//
// Canonical implementations live in ./drain-helper.ts so the bridge
// (packages/agent/src/bridge/pi-event-bridge.ts) can import them without
// creating a cycle through pi-executor.js. The bridge owns the
// `drainInflightByKey: Map<string, Promise<void>>` gate state in
// `BridgeMetricsState` and threads it into drainAt at the
// `tool_execution_end` call site (inline-consumption + composite drain).
// ---------------------------------------------------------------------------
export {
  drainAt,
  markRead,
  markConsumed,
  formatDrainKey,
  type DrainKey,
  type DrainInflightState,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run post-execution cleanup for a PiExecutor turn.
 *
 * Handles: bridge unsubscribe, mutable ref clearing, breakpoint sync,
 * bridge stats merge, SDK stats delegation, cache metrics, planner metrics,
 * TTL recording, execution bookend logging, truncation summaries, session
 * metadata write, onboarding check, memory persistence, active run
 * deregister, schema stripping, and session disposal.
 *
 * @param params - All inputs needed for post-execution cleanup
 */
export async function postExecution(params: PostExecutionParams): Promise<void> {
  const {
    result, session, sm, config, msg, sessionKey, formattedKey, resolverRegisterKey,
    executionStartMs, executionId,
    bridge, unsubscribe,
    contextEngineRef, ceSetup, streamSetup,
    getTruncationSummary, getTurnBudgetSummary,
    executionPlanRef, isOnboarding,
    geminiCacheHit, geminiCachedTokens, capabilityClass,
    provider, providerFamily,
    deferralResult, mergedCustomTools, deliveredGuides,
    deps, sessionAdapter,
    executionCacheRetentionClear, adaptiveRetentionClear,
  } = params;

  // Hoist effectiveAgentId normalization to the TOP of the function so all
  // downstream branches (silent-sentinel gate, memory-store path, drainAt
  // call site, skip-log debug branches) share the same normalized value.
  // Multi-agent isolation requires uniformity across all paths.
  const effectiveAgentId = deps.agentId;

  unsubscribe();
  // Clear per-execution cache retention to prevent state leakage
  executionCacheRetentionClear();
  // Clear adaptive retention to prevent state leakage
  adaptiveRetentionClear();

  // Sync final breakpoint index back to persistence (handles compaction reset)
  const finalBreakpointIdx = contextEngineRef.current?.lastBreakpointIndex;
  if (finalBreakpointIdx !== undefined) {
    setBreakpointIndex(formattedKey, finalBreakpointIdx);
  } else {
    deleteBreakpointIndex(formattedKey);
  }
  deps.logger.debug(
    { formattedKey, finalBreakpointIdx: finalBreakpointIdx ?? null, mapSize: getBreakpointIndexMapSize() },
    "Breakpoint index synced to session map",
  );

  // Merge bridge stats into result
  const bridgeResult = bridge.getResult();
  result.tokensUsed = bridgeResult.tokensUsed ?? result.tokensUsed;
  result.cost = bridgeResult.cost ?? result.cost;
  result.stepsExecuted = bridgeResult.stepsExecuted ?? result.stepsExecuted;
  result.llmCalls = bridgeResult.llmCalls ?? result.llmCalls;
  result.toolCallHistory = bridgeResult.toolCallHistory;
  if (bridgeResult.finishReason && bridgeResult.finishReason !== "stop") {
    result.finishReason = bridgeResult.finishReason;
  }
  // Abort redirect — when bridge set an abortResponse (max_steps, budget_exceeded, etc.),
  // override result.response so the user sees the re-assertion message instead of the
  // partial LLM text emitted before the abort. Only applied when finishReason is non-stop
  // (belt-and-braces: abortResponse is only set at abort sites, so finishReason will be non-stop).
  if (bridgeResult.abortResponse && result.finishReason !== "stop") {
    result.response = bridgeResult.abortResponse;
  }
  // Enrich errorContext with the tool that was in-flight when failure occurred
  if (result.errorContext && bridgeResult.lastActiveToolName) {
    result.errorContext.failingTool = bridgeResult.lastActiveToolName;
  }

  // Delegate token totals to SDK session stats (single source of truth).
  // Cost stays from bridge for consistency with per-turn observability events.
  // Per-turn event emission in bridge remains manual (SDK stats are cumulative only).
  mergeSessionStats(result, () => session.getSessionStats());

  // Populate context engine cache metrics from actual API response data
  if (contextEngineRef.current?.lastMetrics) {
    const cacheReadTokens = bridgeResult.tokensUsed?.cacheRead ?? 0;
    const cacheWriteTokens = bridgeResult.tokensUsed?.cacheWrite ?? 0;
    const inputTokens = bridgeResult.tokensUsed?.input ?? 0;
    contextEngineRef.current.lastMetrics.cacheHitTokens = cacheReadTokens;
    contextEngineRef.current.lastMetrics.cacheWriteTokens = cacheWriteTokens;
    contextEngineRef.current.lastMetrics.cacheMissTokens = inputTokens;  // Already the uncached portion from the API

    // Emit supplementary cache event for the pipeline collector.
    // The context:pipeline event fires pre-LLM with zeros. This event patches actual data.
    if (deps.eventBus) {
      deps.eventBus.emit("context:pipeline:cache", {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        cacheHitTokens: cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens: inputTokens,  // Already the uncached portion from the API
        timestamp: deps.clock.now(),
      });
    }
  }

  // SEP: Attach planner metrics to result (observability-only post-L4).
  // Uses actual tool-call count instead of prose-extracted step count to
  // avoid over-counting (the LLM's numbered plan often has 2-3× more
  // items than logical steps — e.g., "11 steps" for a 4-tool task).
  if (executionPlanRef.current?.active) {
    const toolCalls = result.stepsExecuted ?? 0;
    result.plannerMetrics = {
      stepsPlanned: toolCalls,
      stepsCompleted: toolCalls,
      stepsSkipped: 0,
      planExtractionTurn: 1,
    };
  }

  // Record timestamp after successful execution for TTL guard.
  // Uses the stream-setup captured retention (same ref the wrapper chain captured)
  // because the TTL guard reads from the same module-level Map on next call.
  const capturedRetention = streamSetup.capturedRetention;
  if (capturedRetention) {
    recordLastResponseTs(formattedKey, capturedRetention.getRetention(), deps.clock);
  }

  // Single authoritative read of the supplied locale, hoisted here because the pending-background
  // notice (below) also replaces user-facing text and must speak the same language. A source-grep
  // invariant asserts this file reads the supplied locale field EXACTLY ONCE so the resolved
  // tag cannot drift between call sites — so consumers take `replyLanguage`, never a second read.
  const replyLanguage = params.responseLocalePolicy.locale;
  const pendingBackground = reconcilePendingBackgroundTurn({
    response: result.response ?? "",
    executionId,
    tasks: deps.backgroundTaskManager?.getTasks(effectiveAgentId) ?? [],
    // The notice REPLACES the model's answer, so it must speak the same language. Without these two
    // the reconcile falls back to the English pack and a Hebrew conversation gets a mixed reply —
    // measured live at 0 Hebrew characters for every runtime card on sessions whose model output was
    // 87-100% Hebrew. The unknown-id warning callback is deliberately omitted here: the catalog built
    // later in this function already reports those, and warning twice per turn would be noise.
    locale: replyLanguage,
    localeCatalog: catalogFromLocalePacks(config.localePacks),
  });
  if (pendingBackground.finishReason !== undefined) {
    result.response = pendingBackground.response;
  }

  // Run the deterministic current-model self-status guard before terminal
  // classification. Locale enforcement may have failed closed on the model's
  // mismatched draft; this guard can replace that draft with the exact captured
  // runtime identity, which must be re-evaluated before the bookend and session
  // summary decide whether the turn is degraded.
  const activeModelSelfStatus = enforceActiveModelSelfStatus({
    request: msg.text ?? "",
    response: result.response ?? "",
    provider: params.provider,
    modelId: params.modelId,
  });
  if (activeModelSelfStatus.corrected) {
    result.response = activeModelSelfStatus.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        provider: params.provider,
        modelId: params.modelId,
        errorKind: "validation" as const,
        hint:
          "The model omitted or contradicted the captured execution identity; inspect the "
          + "system-prompt report and current-turn transcript in comis explain.",
      },
      "Current model self-status replaced with captured runtime identity",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.active_model_self_status_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "current_model_status",
        reason: activeModelSelfStatus.reason,
      },
    });
  }
  if (
    activeModelSelfStatus.corrected
    && recoverFinalResponseLocaleFailure(result, params.responseLocalePolicy)
  ) {
    deps.logger.info(
      {
        step: "response-locale-recovery",
        provider: params.provider,
        modelId: params.modelId,
        durationMs: 0,
      },
      "Final response guard satisfied the captured locale policy",
    );
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "locale_fidelity",
      succeeded: true,
      timestamp: deps.clock.now(),
    });
  }

  // Derive effectiveFinishReason BEFORE the bookend log so it is visible there.
  // The bookend must log effectiveFinishReason (not result.finishReason) so that
  // an output_starved turn — which carries result.finishReason="stop" until promoted here —
  // is visible in the bookend as degraded. The variables are declared early and referenced
  // again by the tool-failure append and degraded-reply gate below (no double-computation).
  const unrecoveredToolFailures = unrecoveredFailedToolNames(
    bridgeResult.failedTools ?? [],
    bridgeResult.toolExecResults,
  );
  const finishReasonStr = result.finishReason as string;
  const isStopTurn = finishReasonStr === "stop" || finishReasonStr === "end_turn";
  // Stage 1: tool-failure reconciliation. A clean stop turn becomes
  // completed_with_tool_errors only when a failed operation has no proven
  // later matching success. Raw tool statistics still retain every attempt.
  const toolReconciledFinishReason =
    unrecoveredToolFailures.length > 0 && isStopTurn
      ? "completed_with_tool_errors"
      : result.finishReason;
  // Stage 2: promote a PATHOLOGICAL terminal output truncation. Fires ONLY
  // when stage 1 left a CLEAN would-be terminal (stop/end_turn) AND the session's
  // FINAL turn stopped at the output cap (bridge's terminal lastStopReason). A
  // tool-error / budget / breaker / context_exhausted terminal is untouched (the
  // upstream cause wins), and a continued/mid-run length-stop is not flagged
  // (the terminal stop reason is no longer "length"). See promoteOutputStarved.
  // Stage 3: promote a narrate-without-emit terminal that the one
  // bounded nudge could not recover — same conservative shape as stage 2.
  const baseEffectiveFinishReason = promoteToolInvocationStall(
    promoteNarrationStall(
      promoteOutputStarved(toolReconciledFinishReason, bridgeResult.lastStopReason),
      result.narrateNudge,
    ),
    result.requestToolNudge,
  );
  const effectiveFinishReasonCandidate = pendingBackground.finishReason ?? baseEffectiveFinishReason;
  const effectiveFinishReason = (
    effectiveFinishReasonCandidate === "end_turn"
      ? "stop"
      : effectiveFinishReasonCandidate
  ) as AgentExecutionFinishReason;
  settleExecutionResult(result, effectiveFinishReason, {
    sideEffectSummary: bridgeResult.sideEffectSummary ?? result.sideEffectSummary,
    toolExecResults: bridgeResult.toolExecResults,
    terminalErrorKind: bridgeResult.lastLlmErrorMessage !== undefined
      ? errorKindForCategory(classifyError(bridgeResult.lastLlmErrorMessage).category)
      : undefined,
  });

  // Execution bookend INFO log with summary stats
  const durationMs = deps.clock.now() - executionStartMs;
  // LLM/tool/contextEngine duration breakdown from bridge cumulative trackers
  const llmDurationMs = bridgeResult.cumulativeLlmDurationMs ?? 0;
  // Use wallclock-capped tool duration for overhead decomposition (parallel tools can inflate raw sum)
  const toolDurationMs = bridgeResult.cumulativeToolWallclockMs ?? bridgeResult.cumulativeToolDurationMs ?? 0;
  const toolCpuDurationMs = bridgeResult.cumulativeToolDurationMs ?? 0;
  const contextEngineDurationMs = ceSetup.getContextEngineDurationMs();
  const overheadDurationMs = durationMs - (llmDurationMs + toolDurationMs + contextEngineDurationMs);
  // Truncation summary from bouncer + turn budget summary
  const truncSummary = getTruncationSummary();
  const turnBudgetSummary = getTurnBudgetSummary();
  // Snapshot the scrub counters once before composing the bookend log so both
  // fields read from the same observation (the getter is cheap but the
  // read-twice pattern would still be a micro-divergence risk).
  const scrubCounters = ceSetup.getSignatureScrubCounters();
  // recoveredTools: failed tools that self-healed in the same turn. The raw
  // failed count remains visible alongside the clean terminal classification.
  const recoveredTools = recoveredFailedToolNames(
    bridgeResult.failedTools ?? [],
    bridgeResult.toolExecResults,
  );
  deps.logger.info(
    {
      step: "agent-execute",
      sessionKey: formattedKey,
      durationMs,
      llmDurationMs,
      toolDurationMs,
      ...(toolCpuDurationMs !== toolDurationMs && { toolCpuDurationMs }),
      contextEngineDurationMs,
      overheadDurationMs,
      toolCalls: result.stepsExecuted,
      llmCalls: result.llmCalls,
      finishReason: result.finishReason,
      // Log the post-promotion effectiveFinishReason so an
      // output_starved degradation is visible in the bookend (result.finishReason
      // stays "stop" for output_starved; only effectiveFinishReason reflects the
      // promotion). Emitted only when it differs from finishReason to avoid noise
      // on the common case where they are identical.
      ...(effectiveFinishReason !== result.finishReason && { effectiveFinishReason }),
      ...(pendingBackground.pendingCount > 0 && { pendingBackgroundTasks: pendingBackground.pendingCount }),
      tokensIn: result.tokensUsed.input,
      tokensOut: result.tokensUsed.output,
      tokensTotal: result.tokensUsed.total,
      cacheReadTokens: result.tokensUsed.cacheRead ?? 0,
      cacheWriteTokens: result.tokensUsed.cacheWrite ?? 0,
      // Per-execution cache hit rate percentage
      cacheHitRate: (result.tokensUsed.cacheRead ?? 0) > 0
        ? Math.round(((result.tokensUsed.cacheRead ?? 0) / ((result.tokensUsed.cacheRead ?? 0) + (result.tokensUsed.input ?? 0))) * 100)
        : 0,
      cacheWrite5mTokens: bridgeResult.cacheWrite5mTokens ?? 0,
      cacheWrite1hTokens: bridgeResult.cacheWrite1hTokens ?? 0,
      comisEstimatedTtlSplit: (bridgeResult.cacheWrite5mTokens ?? 0) > 0 || (bridgeResult.cacheWrite1hTokens ?? 0) > 0,
      costUsd: result.cost.total,
      cacheSavedUsd: result.cost.cacheSaved ?? 0,
      // Warmup-turn signal lifted from per-turn token_usage
      // events. `warmupTurn: true` whenever ANY turn in this execution
      // was flagged as a first-cache-write turn; the positive-signed
      // pendingCacheInvestmentUsd is the sum across those turns.
      // Dashboards filtering on warmupTurn keep first-write executions
      // out of cost-regression alerts (where the negative savedVsUncached
      // would otherwise dominate).
      warmupTurn: (bridgeResult.warmupTurnCount ?? 0) > 0,
      pendingCacheInvestmentUsd: bridgeResult.totalPendingCacheInvestmentUsd ?? 0,
      // Cumulative SDK→corrected cost delta this execute.
      // Conditional emit — turns with no correction omit the field
      // entirely (matches the per-event `costCorrectionField` gate at
      // pi-event-bridge.ts:1106 — avoids zero-value log noise).
      ...((bridgeResult.totalCostCorrectionDeltaUsd ?? 0) > 0 && {
        costCorrectionDeltaUsd: bridgeResult.totalCostCorrectionDeltaUsd,
      }),
      // Session-cumulative cost fields (alongside per-turn costUsd/cacheSavedUsd)
      executionCostUsd: bridgeResult.executionCostUsd ?? 0,
      executionCacheSavedUsd: bridgeResult.executionCacheSavedUsd ?? 0,
      // Session cache savings rate
      executionCacheSavingsRate: (bridgeResult.executionCacheSavedUsd ?? 0) > 0 || (bridgeResult.executionCostUsd ?? 0) > 0
        ? Math.round(((bridgeResult.executionCacheSavedUsd ?? 0) / ((bridgeResult.executionCostUsd ?? 0) + (bridgeResult.executionCacheSavedUsd ?? 0))) * 100)
        : 0,
      // Ghost cost from timed-out requests
      ghostCostUsd: result.cost.ghostCostUsd ?? 0,
      timedOutRequests: result.cost.timedOutRequests ?? 0,
      totalBilledUsd: (result.cost.total ?? 0) + (result.cost.ghostCostUsd ?? 0),
      geminiCacheHit,
      geminiCachedTokens,
      capabilityClass,
      provider,
      providerFamily,
      deferredCount: deferralResult.deferredCount,
      // Auto-discovery stubs remain in the local SDK registry but are removed
      // before the provider request. Report only the tools that cross that
      // boundary so active + deferred reconcile to the runtime inventory.
      activeToolCount: Math.max(
        0,
        mergedCustomTools.length - deferralResult.deferredCount,
      ),
      guidesDelivered: deliveredGuides.size,
      schemaPruned: capabilityClass === "nano",
      failedToolCalls: bridgeResult.failedToolCalls ?? 0,
      toolFailureRate: (result.stepsExecuted ?? 0) > 0
        ? Math.round(((bridgeResult.failedToolCalls ?? 0) / (result.stepsExecuted ?? 0)) * 100)
        : 0,
      // Per-execute diagnostic counters rolled up from the two demoted log
      // sites. Always populated (no `> 0` gate) — `0` is itself meaningful
      // ("no scrubs/assertions this execute") and gating would lose that
      // signal. hashAssertions* come from the bridge metrics path;
      // signatureScrubs* come from ceSetup since the scrubber doesn't write
      // to bridge state.
      hashAssertionsRan: bridgeResult.hashAssertionsRan ?? 0,
      hashAssertionMismatches: bridgeResult.hashAssertionMismatches ?? 0,
      signatureScrubs: scrubCounters.signatureScrubs,
      signatureScrubsToolCallsAffected: scrubCounters.signatureScrubsToolCallsAffected,
      ...(bridgeResult.failedTools && bridgeResult.failedTools.length > 0 && { failedTools: bridgeResult.failedTools }),
      ...(recoveredTools.length > 0 && { recoveredTools }),
      truncatedTools: truncSummary.truncatedTools,
      totalTruncatedChars: truncSummary.totalTruncatedChars,
      turnsExceeded: turnBudgetSummary.turnsExceeded,
      totalBudgetTruncatedChars: turnBudgetSummary.totalBudgetTruncatedChars,
      ...(result.plannerMetrics && {
        sepStepsPlanned: result.plannerMetrics.stepsPlanned,
        sepStepsCompleted: result.plannerMetrics.stepsCompleted,
      }),
      ...(result.continuationMetrics && {
        postBatchContinuationFired: result.continuationMetrics.fired,
        postBatchContinuationAttempts: result.continuationMetrics.attempts,
        postBatchContinuationOutcome: result.continuationMetrics.outcome,
      }),
      ...(result.requestToolNudge?.fired === true && {
        requestToolNudgeFired: true,
        requestToolNudgeRecovered: result.requestToolNudge.recovered,
        requestToolNudgeMatchedTools: result.requestToolNudge.matchedToolNames,
      }),
      // Thinking token tracking (conditional -- only when thinking tokens detected)
      ...(bridgeResult.thinkingTokens != null && bridgeResult.thinkingTokens > 0 && {
        thinkingTokens: bridgeResult.thinkingTokens,
        totalOutputTokens: result.tokensUsed.output ?? 0,
        visibleOutputTokens: (result.tokensUsed.output ?? 0) - (bridgeResult.thinkingTokens ?? 0),
      }),
    },
    "Execution complete",
  );

  // Separate INFO summary when per-tool truncations occurred
  if (truncSummary.truncatedTools > 0) {
    deps.logger.info(
      {
        truncatedTools: truncSummary.truncatedTools,
        totalTruncatedChars: truncSummary.totalTruncatedChars,
        maxToolResultChars: config.maxToolResultChars,
        hint: "Increase agents.<name>.maxToolResultChars if these tools legitimately produce large output",
        errorKind: "resource" as const,
      },
      "Execution truncation summary",
    );
  }

  // Separate INFO summary when per-turn budget truncations occurred
  if (turnBudgetSummary.turnsExceeded > 0) {
    deps.logger.info(
      {
        turnsExceeded: turnBudgetSummary.turnsExceeded,
        totalBudgetTruncatedChars: turnBudgetSummary.totalBudgetTruncatedChars,
        maxTurnChars: 200_000,
        hint: "Per-turn aggregate tool result budget was exceeded; reduce tool output size or adjust budget",
        errorKind: "resource" as const,
      },
      "Turn budget truncation summary",
    );
  }

  // Notice append is recovery-gated: surface ONLY tools that failed and were NOT
  // recovered by a proven later matching invocation. An unrelated same-tool
  // success must not hide a failure. Also suppressed when the model already
  // acknowledged the failure or the response is a silent sentinel. The
  // observability label (effectiveFinishReason) is unchanged — operators still
  // see the recovered failure in logs/system.
  // Wire the locale seam to operator config. `createLocaleCatalog` had exactly
  // one production caller — the no-packs DEFAULT_LOCALE_CATALOG — so every
  // deterministic reply resolved English no matter what `language` was pinned,
  // and the documented "consumed by the deterministic degraded replies" claim
  // had nothing behind it. An unknown id is reported, never silently kept.
  const localeCatalog = catalogFromLocalePacks(config.localePacks, (locale, messageId) => {
    deps.logger.warn(
      {
        step: "degraded-reply",
        errorKind: "config" as const,
        hint: `agents.<id>.localePacks.${locale}.${messageId} is not a platform-reply message id, so it is ignored; valid ids: ${LOCALE_MESSAGE_IDS.join(", ")}`,
      },
      "unknown locale pack message id ignored",
    );
  });
  const agentUpdateNoOpGrounding = enforceAgentUpdateNoOpGrounding({
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    honestResponse: buildAgentUpdateNoOpReply(
      replyLanguage,
      params.provider,
      params.modelId,
      localeCatalog,
    ),
  });
  if (agentUpdateNoOpGrounding.corrected) {
    result.response = agentUpdateNoOpGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        provider: params.provider,
        modelId: params.modelId,
        errorKind: "validation" as const,
        hint:
          "The model contradicted a successful unchanged agents_manage update; inspect "
          + "the latest update receipt, recalled skills, and final response in comis explain.",
      },
      "Agent update no-op response replaced with runtime truth",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.agent_update_noop_grounding_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "configuration_noop",
        reason: agentUpdateNoOpGrounding.reason,
        requiredTool: "agents_manage",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "agent_update_noop_grounding",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const runtimeSelfReportGrounding = enforceRuntimeSelfReportEvidence({
    request: msg.text ?? "",
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    honestResponse: buildRuntimeSelfReportEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (runtimeSelfReportGrounding.corrected) {
    result.response = runtimeSelfReportGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "precondition" as const,
        hint:
          "The runtime self-report lacked a successful current-turn obs_query receipt; "
          + "inspect request-tool relevance and obs_query availability in comis explain.",
      },
      "Unsupported runtime self-report replaced with an evidence limitation",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.runtime_self_report_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "runtime_self_report",
        reason: runtimeSelfReportGrounding.reason,
        requiredTool: "obs_query",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "missing_runtime_self_report_evidence",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const schedulerStateGrounding = enforceSchedulerStateEvidence({
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    honestResponse: buildSchedulerStateEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
    pendingConfirmationResponse: buildPendingSchedulerConfirmationReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (schedulerStateGrounding.corrected) {
    result.response = schedulerStateGrounding.response;
    const pendingConfirmation =
      schedulerStateGrounding.reason === "pending_scheduler_confirmation";
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "precondition" as const,
        hint: pendingConfirmation
          ? "The current cron.remove receipt requires user confirmation and did not mutate state; "
            + "re-call cron.remove with _confirmed:true only after an explicit confirmation."
          : "Inspect the current-turn cron receipts in comis explain and call cron list or status "
            + "before confirming that a reminder or scheduled job still exists.",
      },
      pendingConfirmation
        ? "Pending scheduler removal overclaim replaced with confirmation request"
        : "Unsupported scheduler state claim replaced with runtime truth",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.scheduler_state_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: pendingConfirmation ? "scheduler_confirmation" : "scheduler_state",
        reason: schedulerStateGrounding.reason,
        requiredTool: "cron",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: pendingConfirmation
        ? "pending_scheduler_confirmation"
        : "missing_scheduler_state_evidence",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const ongoingWorkGrounding = enforceOngoingWorkEvidence({
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    ongoingWorkEvidence: pendingBackground.finishReason !== undefined,
    honestResponse: buildOngoingWorkEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (ongoingWorkGrounding.corrected) {
    result.response = ongoingWorkGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "precondition" as const,
        hint:
          "The final reply promised continued work after a failed step, but this "
          + "execution had no background receipt; inspect tool failures and background "
          + "task ownership in comis explain.",
      },
      "Unsupported ongoing-work promise replaced with runtime truth",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.ongoing_work_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "ongoing_work",
        reason: ongoingWorkGrounding.reason,
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "missing_ongoing_work_evidence",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const senderAuthorityGrounding = enforceSenderAuthorityGrounding({
    request: msg.text ?? "",
    response: result.response ?? "",
    senderTrust: params.senderTrust,
    honestResponse: buildSenderAuthorityOverclaimReply(replyLanguage, localeCatalog),
  });
  if (senderAuthorityGrounding.corrected) {
    result.response = senderAuthorityGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        senderTrust: params.senderTrust,
        errorKind: "validation" as const,
        hint:
          "The model assigned admin-only authority to the current below-admin sender; "
          + "inspect sender trust resolution, recalled skills, and the deferred tool surface in comis explain.",
      },
      "Sender self-authority overclaim replaced with runtime truth",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.sender_authority_grounding_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "sender_authority",
        reason: senderAuthorityGrounding.reason,
        senderTrust: params.senderTrust,
        requiredTrust: "admin",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "sender_authority_grounding",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const delegationEvidence = enforceCurrentTurnDelegationEvidence({
    request: msg.text ?? "",
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    runtimeCompletion: isTrustedBackgroundCompletionEnvelope(msg),
    honestResponse: buildDelegationEvidenceMissingReply(replyLanguage, localeCatalog),
  });
  if (delegationEvidence.corrected) {
    result.response = delegationEvidence.response;
    deps.logger.warn(
      {
        step: "delegation-evidence",
        errorKind: "precondition" as const,
        hint:
          "The response was replaced because this execution had no successful sessions_spawn "
          + "receipt; inspect the current tool inventory and sessions_spawn admission in comis explain.",
      },
      "Unverified current-turn delegation claim replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.delegation_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "delegation",
        reason: delegationEvidence.reason,
        requiredTool: "sessions_spawn",
      },
    });
  }
  const persistentActionEvidence = enforcePersistentActionEvidence({
    request: msg.text ?? "",
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    currentActionEvidence: hasTrustedRuntimeActionEvidence(msg),
    honestResponse: buildPersistentActionEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (persistentActionEvidence.corrected) {
    result.response = persistentActionEvidence.response;
    deps.logger.warn(
      {
        step: "action-evidence",
        errorKind: "precondition" as const,
        hint:
          "The response was replaced because this persistent request had no successful "
          + "current-turn tool receipt; inspect action admission and the tool inventory in comis explain.",
      },
      "Unverified persistent action result replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.persistent_action_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "persistent_action",
        reason: persistentActionEvidence.reason,
      },
    });
  }
  const outboundAudioEvidence = enforceOutboundAudioEvidence({
    request: msg.text ?? "",
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    currentActionEvidence: hasTrustedRuntimeActionEvidence(msg),
    honestResponse: buildOutboundAudioEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (outboundAudioEvidence.corrected) {
    result.response = outboundAudioEvidence.response;
    deps.logger.warn(
      {
        step: "action-evidence",
        errorKind: "precondition" as const,
        hint:
          "The response claimed outbound audio delivery without a successful tts_synthesize "
          + "or trusted completion receipt; inspect tool admission and delivery in comis explain.",
      },
      "Unverified outbound audio delivery claim replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.outbound_audio_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "outbound_audio",
        reason: outboundAudioEvidence.reason,
        requiredTool: "tts_synthesize",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "missing_outbound_audio_evidence",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const outboundImageEvidence = enforceOutboundImageEvidence({
    request: msg.text ?? "",
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    currentActionEvidence: hasTrustedRuntimeActionEvidence(msg),
    honestResponse: buildOutboundImageEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
  });
  if (outboundImageEvidence.corrected) {
    result.response = outboundImageEvidence.response;
    deps.logger.warn(
      {
        step: "action-evidence",
        errorKind: "precondition" as const,
        hint:
          "The response claimed image creation or delivery without a successful image_generate "
          + "or trusted completion receipt; inspect tool admission and delivery in comis explain.",
      },
      "Unverified outbound image completion claim replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.outbound_image_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "outbound_image",
        reason: outboundImageEvidence.reason,
        requiredTool: "image_generate",
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "missing_outbound_image_evidence",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const destructiveEffectEvidence = enforceDestructiveEffectEvidence({
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    honestResponse: buildDestructiveActionNotVerifiedReply(replyLanguage, localeCatalog),
  });
  if (destructiveEffectEvidence.corrected) {
    result.response = destructiveEffectEvidence.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "precondition" as const,
        hint:
          "Inspect the failed exec record and bound approval in comis explain, confirm the "
          + "target exists inside the workspace write fence, then retry the corrected target.",
      },
      "Unverified destructive action completion claim replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.destructive_action_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "destructive_effect",
        reason: destructiveEffectEvidence.reason,
        requiredTool: "exec",
      },
    });
  }
  const providerModelFailureGrounding = enforceProviderModelFailureGrounding({
    response: result.response ?? "",
    toolExecResults: bridgeResult.toolExecResults,
    honestResponse: buildProviderRequiresModelReply(replyLanguage, localeCatalog),
  });
  if (providerModelFailureGrounding.corrected) {
    result.response = providerModelFailureGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "validation" as const,
        hint:
          `Test the provider credentials, list exact models with models_manage, then retry `
          + `agents.${effectiveAgentId}.provider and agents.${effectiveAgentId}.model together`,
      },
      "Provider-as-model response replaced with grounded guidance",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.provider_model_grounding_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "configuration_failure",
        reason: providerModelFailureGrounding.reason,
        requiredTool: "agents_manage",
      },
    });
  }
  const successfulReadOnlyToolResult = bridgeResult.toolExecResults?.some(
    (toolResult) =>
      toolResult.success
      && getToolMetadata(toolResult.toolName)?.isReadOnly === true,
  ) ?? false;
  const onlyReadOnlyFailures =
    unrecoveredToolFailures.length > 0
    && unrecoveredToolFailures.every(
      (toolName) => getToolMetadata(toolName)?.isReadOnly === true,
    );
  const completionEvidenceGrounding = enforceCompletionEvidence({
    response: result.response ?? "",
    unrecoveredToolFailures,
    honestResponse: buildCompletionEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    ),
    preservePartialResponse: successfulReadOnlyToolResult && onlyReadOnlyFailures,
  });
  if (completionEvidenceGrounding.corrected) {
    result.response = completionEvidenceGrounding.response;
    deps.logger.warn(
      {
        step: "response-honesty",
        unrecoveredToolFailureCount: unrecoveredToolFailures.length,
        responseDisposition: completionEvidenceGrounding.correction,
        errorKind: "precondition" as const,
        hint:
          "Inspect the failed tool records in comis explain, correct the failing step, "
          + "and retry verification before treating the request as complete.",
      },
      "Unverified completion claim grounded with runtime truth",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.completion_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "completion",
        reason: completionEvidenceGrounding.reason,
        unrecoveredToolFailureCount: unrecoveredToolFailures.length,
        responseDisposition: completionEvidenceGrounding.correction,
      },
    });
    deps.eventBus.emit("execution:recovery_attempted", {
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
      reason: "unrecovered_tool_failure_completion_claim",
      succeeded: true,
      traceId: tryGetContext()?.traceId,
      timestamp: deps.clock.now(),
    });
  }
  const unrecoveredFailed = unrecoveredToolFailures;
  const subagentTerminalToolFailureReply = buildSubagentTerminalToolFailureReply({
    operationType: params.executionOverrides?.operationType,
    finishReason: effectiveFinishReason,
    failedTools: bridgeResult.failedTools ?? [],
    toolExecResults: bridgeResult.toolExecResults,
  });
  const subagentTerminalToolFailure = classifySubagentTerminalToolFailure({
    operationType: params.executionOverrides?.operationType,
    finishReason: effectiveFinishReason,
    failedTools: bridgeResult.failedTools ?? [],
    toolExecResults: bridgeResult.toolExecResults,
  });
  if (subagentTerminalToolFailure !== undefined) {
    if (subagentTerminalToolFailureReply !== undefined) {
      result.response = subagentTerminalToolFailureReply;
    }
    const configKey = subagentTerminalToolFailure.disclosure.configKey;
    result.errorContext = {
      errorType: "UpstreamToolFailure",
      retryable: false,
      failingTool: subagentTerminalToolFailure.toolName,
      configKey,
    };
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: subagentTerminalToolFailure.errorKind ?? ("dependency" as const),
        hint:
          `Restore provider access or update ${configKey} before retrying; changing request size will not recover this failure`,
        responseReplaced: subagentTerminalToolFailureReply !== undefined,
      },
      "Sub-agent terminal failure attributed to upstream tool",
    );
  }
  const unavailableVisionFailure =
    unrecoveredFailed.includes("image_analyze")
    && hasUnavailableVisionFailure(bridgeResult.toolExecResults);
  const visionFallbackTool = unavailableVisionFailure
    ? groundedVisionFallbackTool(result.response ?? "", session.messages)
    : undefined;
  const unavailableVision =
    unavailableVisionFailure && visionFallbackTool === undefined;
  const userVisibleFailed = visionFallbackTool === undefined
    ? unrecoveredFailed
    : unrecoveredFailed.filter((toolName) => toolName !== "image_analyze");
  if (visionFallbackTool !== undefined) {
    deps.logger.info(
      {
        step: "response-honesty",
        failedTool: "image_analyze",
        recoveryTool: visionFallbackTool,
      },
      "Unavailable vision recovered by grounded fallback",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.vision_fallback_grounded",
      kind: "audit",
      outcome: "success",
      metadata: {
        failedTool: "image_analyze",
        recoveryTool: visionFallbackTool,
        reason: "same_source_output_overlap",
      },
    });
  }
  if (unavailableVision) {
    result.response = buildVisionUnavailableReply(
      effectiveAgentId,
      replyLanguage,
      localeCatalog,
    );
    deps.logger.warn(
      {
        step: "response-honesty",
        errorKind: "precondition" as const,
        hint:
          `Select a vision-capable model at agents.${effectiveAgentId}.model, or configure `
          + "integrations.media.vision.providers and integrations.media.vision.defaultProvider; "
          + "re-uploading the same image will not help until that configuration changes",
      },
      "Unavailable vision recovery guidance replaced",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.vision_unavailable_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "capability_recovery",
        reason: "vision_unavailable",
        requiredTool: "image_analyze",
      },
    });
  }
  if (
    !unavailableVision &&
    !providerModelFailureGrounding.corrected &&
    !ongoingWorkGrounding.corrected &&
    !completionEvidenceGrounding.corrected &&
    userVisibleFailed.length > 0 &&
    isStopTurn &&
    !modelAcknowledgedFailure(result.response ?? "", userVisibleFailed) &&
    !isSilentResponse(result.response ?? "")
  ) {
    // Never NAME the background poller as the culprit. It relays other tools'
    // failures, so blaming it points the reader at the one tool that was
    // working — the same mis-attribution the retry breaker had. Prefer any
    // real tool in the list; fall back to a nameless notice.
    const failedToolName = userVisibleFailed.find((t) => t !== BACKGROUND_POLLER_TOOL);
    // Localized prose + the tool name VERBATIM. This was a bare English
    // `[tool failure] <tool> reported an error`, appended raw to replies in
    // any language — a bracket-tagged internal string, outside the only
    // mechanism that can translate it. Identifiers stay untranslated by
    // design; only the sentence around them is localized.
    // No "(see session log)" pointer: the recipient is the CHAT user, who has
    // no session log to see — the operator's lens is `comis explain` (the
    // failure rides the trajectory + IncidentReport.failures already).
    // Two variants: the named notice ends in an em-dash awaiting the tool name;
    // the unnamed one is a complete sentence. Using the named form with no name
    // left replies ending in a dangling "incomplete — " whenever the poller was
    // the only unrecovered failure.
    result.response = (result.response ?? "")
      + (failedToolName === undefined
        ? buildToolFailureNoticeUnnamed(replyLanguage, localeCatalog)
        : buildToolFailureNotice(replyLanguage, localeCatalog) + failedToolName);
  }

  // Degrade loudly — deliver an honest user-facing reply for named degraded causes.
  // APPEND for output_starved (partial text exists); REPLACE for context_exhausted (no usable text).
  // Gate on effectiveFinishReason (NOT result.finishReason — output_starved is only set here).
  // Resolve the open response-locale policy once and pass the canonical tag to
  // each deterministic degraded-reply builder. Missing locale packs fall back
  // to the injected catalog's English strings.
  if (effectiveFinishReason === "tool_invocation_stall") {
    result.response = buildPersistentActionEvidenceMissingReply(
      replyLanguage,
      localeCatalog,
    );
    deps.logger.warn(
      {
        step: "request-tool-nudge",
        matchedToolNames: result.requestToolNudge?.matchedToolNames ?? [],
        errorKind: "internal" as const,
        hint:
          "The model repeated an earlier answer and the bounded continuation still "
          + "emitted no matched tool call; inspect request-tool-nudge in comis explain.",
      },
      "tool_invocation_stall — synthesized honest reply delivered",
    );
  }
  if (effectiveFinishReason === "output_starved") {
    result.response = (result.response ?? "") + buildOutputStarvedAnnotation(replyLanguage, localeCatalog);
    // Carry the evidence the verdict is DERIVED from. The line used to say only
    // "annotation appended", so an operator could not tell a genuinely truncated
    // answer from a completion that emitted nothing — and the generic advice
    // ("raise maxTokens") is actively wrong for the second shape.
    deps.logger.warn(
      {
        step: "degraded-reply",
        errorKind: "resource" as const,
        lastStopReason: bridgeResult.lastStopReason,
        textEmitted: bridgeResult.textEmitted === true,
        // Omitted rather than coerced when unmeasured, so the field never
        // asserts a below-cap truncation the bridge could not substantiate.
        ...(bridgeResult.lastLengthStopRecoverable !== undefined
          ? { recoverableLength: bridgeResult.lastLengthStopRecoverable }
          : {}),
        hint: outputStarvedHint({
          ...(bridgeResult.textEmitted !== undefined ? { textEmitted: bridgeResult.textEmitted } : {}),
          ...(bridgeResult.lastStopReason !== undefined ? { lastStopReason: bridgeResult.lastStopReason } : {}),
          ...(bridgeResult.lastLengthStopRecoverable !== undefined
            ? { recoverableLength: bridgeResult.lastLengthStopRecoverable }
            : {}),
        }),
      },
      "output_starved — annotated truncated reply",
    );
  }
  if (effectiveFinishReason === "context_exhausted") {
    // Name the exact cap knob for small/nano and
    // append the incident traceId so `comis explain <traceId>` is one step away
    // from the chat message itself.
    // Recover the exhaustion CAUSE from the message that crossed the
    // type-stripping boundary — errorContext.originalError on the top-level
    // path, lastLlmErrorMessage on the mid-turn path — so the reply's
    // advice names the remedy that actually applies (an oversized HISTORY
    // message is fixed by a session reset, never by "narrowing the ask").
    const incidentTraceId = tryGetContext()?.traceId;
    const exhaustionCause = parseContextExhaustionCause(
      result.errorContext?.originalError ?? bridgeResult.lastLlmErrorMessage,
    );
    result.response = buildContextExhaustedReply({
      ...(capabilityClass !== undefined ? { capabilityClass } : {}),
      ...(incidentTraceId !== undefined ? { traceId: incidentTraceId } : {}),
      cause: exhaustionCause,
      language: replyLanguage,
      localeCatalog,
    });
    deps.logger.warn(
      { step: "degraded-reply", errorKind: "resource" as const, hint: "context_exhausted synthesized reply" },
      "context_exhausted — synthesized honest reply delivered",
    );
  }
  if (effectiveFinishReason === "loop_detected") {
    // The loop-guard halted a no-progress repeat (e.g. a tool that kept
    // failing/being blocked). APPEND an honest note when partial text exists,
    // REPLACE when the turn produced none (a pure tool-loop) — never a silent empty.
    const existing = (result.response ?? "").trim();
    const loopTraceId = tryGetContext()?.traceId;
    const loopReply = buildLoopDetectedReply({
      ...(loopTraceId !== undefined ? { traceId: loopTraceId } : {}),
      language: replyLanguage,
      localeCatalog,
    });
    result.response = existing.length > 0 ? `${existing}\n\n${loopReply}` : loopReply;
    deps.logger.warn(
      { step: "degraded-reply", errorKind: "resource" as const, hint: "loop_detected synthesized reply" },
      "loop_detected — synthesized honest reply delivered",
    );
  }

  // Resolve the capability-gated verification default before the gate check.
  // modelProfile is not in scope at this layer — use a synthetic profile derived from
  // capabilityClass (same approach as buildSyntheticCriticDeps; capabilityClass is threaded
  // via PostExecutionParams). Only the isSmallNano distinction
  // (scaffoldLevel === "max") is load-bearing for resolveScaffoldDefaults' decision —
  // the non-max value is deliberately collapsed to "light" (nothing here reads scaffoldLevel
  // beyond the isSmallNano check; a real mid profile would be "standard"). small/nano → "max";
  // frontier/mid/unknown → "light" (fail-closed: undefined capabilityClass → frontier).
  // operationModels defaults to {} when not set (no distinct critic → cost-gate returns false).
  const resolvedCapabilityClass = capabilityClass ?? "frontier";
  const syntheticProfileForDefaults = {
    scaffoldLevel: (resolvedCapabilityClass === "small" || resolvedCapabilityClass === "nano") ? "max" as const : "light" as const,
    reasoningStyle: "none" as const,
    maxOutputTokens: 4096, contextWindow: 8192,
    capabilityClass: resolvedCapabilityClass,
    securityLevel: "standard" as const,
    supportsVision: false, supportsTools: true, supportsPromptCache: false,
    supportsServerToolSearch: false, supportsStructuredOutput: false,
  };
  // criticModel is the DISTINCT CHEAP verification model the cost-gate gated
  // on (keyless-guarded). The critic must run on it, NOT the agent primary — running
  // the primary would invert the cost-gate's "never doubles local-CPU latency" rationale.
  // Falls back to the agent's (already-keyless, per shouldRunCritic) primary when undefined.
  const { verificationEnabled: effectiveVerification, criticModel } = resolveScaffoldDefaults(
    syntheticProfileForDefaults,
    config,
    { provider, agentModel: config.model, operationModels: config.operationModels ?? {} },
  );
  // Degraded-turn guard: skip the verification critic entirely for degraded turns. The
  // degraded-reply block above wrote an honest synthesized reply into result.response; the
  // critic must never overwrite it with an LLM "not-verified" unmet-list derived
  // from a one-line error message. This guard makes the degraded reply authoritative
  // regardless of future edits to the synthesized strings (no implicit string-match
  // dependency on isCompletionClaim patterns).
  const isDegradedTurn =
    effectiveFinishReason === "output_starved" ||
    effectiveFinishReason === "context_exhausted" ||
    effectiveFinishReason === "loop_detected" ||
    effectiveFinishReason === "narration_stall" ||
    effectiveFinishReason === "tool_invocation_stall";
  if (!isDegradedTurn && shouldRunCritic({ // critic hook (keyless-only gate)
    capabilityClass, config, executionPlanRef, provider,
    logger: deps.logger,
    effectiveEnabled: effectiveVerification, // pre-resolved via cost-gate
  })) {
    const { deps: cd, maxRetries: mr } = buildSyntheticCriticDeps({
      capabilityClass,
      provider: criticModel?.provider ?? provider, // resolved cheap critic, not agent primary
      modelId: criticModel?.modelId ?? config.model,
      agentId: effectiveAgentId,
      canaryToken: generateCanaryToken(formattedKey, executionId), // formatted key, not String(obj)
      minResponseChars: config.verification?.minResponseChars ?? 200, maxRetries: config.honesty?.maxCriticRetries ?? 2,
      clock: deps.clock, logger: deps.logger, eventBus: deps.eventBus,
    });
    const cr = await runVerificationCritic({ response: result.response ?? "", plan: executionPlanRef.current, deps: cd, maxRetries: mr });
    if (cr.verdict !== "verified" && cr.verdict !== "skipped") { result.response = cr.response; }
  }

  // Citation integrity is enforced after every model-authored rewrite (including
  // locale repair and the optional critic), immediately before the canonical
  // assistant turn is synchronized. Current successful web_fetch receipts are
  // authoritative. A background completion carries only their SHA-256 URL
  // digests, while a later explicit source question may reuse digests attached
  // by this same guard to earlier append-only runtime journal receipts.
  const currentWebResearchObserved = (bridgeResult.toolExecResults ?? []).some(
    (toolResult) => toolResult.toolName === "web_fetch" || toolResult.toolName === "web_search",
  );
  const currentFetchDigests = (bridgeResult.toolExecResults ?? [])
    .filter(
      (toolResult) =>
        toolResult.toolName === "web_fetch"
        && toolResult.success
        && toolResult.citationUrlDigest !== undefined,
    )
    .flatMap((toolResult) =>
      toolResult.citationUrlDigest === undefined ? [] : [toolResult.citationUrlDigest],
    );
  const relayedCitationEvidence = hasTrustedRuntimeActionEvidence(msg)
    ? msg.metadata.citationEvidence
    : undefined;
  const citationSourceRequest = isCitationSourceRequest(msg.text ?? "");
  const historicalDigests = citationSourceRequest
    ? historicalCitationDigests(sm)
    : [];
  const allowedCitationDigests = [
    ...currentFetchDigests,
    ...(relayedCitationEvidence?.urlDigests ?? []),
    ...historicalDigests,
  ];
  const citationGrounding = enforceCitationEvidence({
    response: result.response ?? "",
    allowedUrlDigests: allowedCitationDigests,
    enabled:
      currentWebResearchObserved
      || relayedCitationEvidence !== undefined
      || historicalDigests.length > 0
      || citationSourceRequest,
  });
  result.response = citationGrounding.response;
  if (citationGrounding.corrected) {
    deps.logger.warn(
      {
        step: "citation-evidence",
        removedCitationCount: citationGrounding.removedCitationCount,
        errorKind: "validation" as const,
        hint:
          "The response contained a citation URL without an exact successful web_fetch digest; "
          + "inspect current tool receipts and citation_evidence journal entries in comis explain.",
      },
      "Citation without exact fetch evidence removed",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.citation_evidence_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "citation",
        reason: citationGrounding.reason,
        removedCitationCount: citationGrounding.removedCitationCount,
      },
    });
  }

  const syncDiagnostics: FinalAssistantSyncDiagnostics = {};
  const responseSync = synchronizeFinalAssistantResponse(
    session,
    result.response ?? "",
    sm,
    syncDiagnostics,
  );
  if (responseSync === "updated") {
    deps.logger.info(
      { step: "response-persistence" },
      "Synchronized post-processed response with live session transcript",
    );
  } else if (responseSync === "updated_memory_only") {
    // Branch by failure class: a moved leaf and a failed write need opposite investigations.
    // Emitting one hint for both sent operators hunting disk faults for the benign case.
    const leafMoved = syncDiagnostics.durableFailureReason === "leaf_precondition_mismatch";
    deps.logger.warn(
      {
        step: "response-persistence",
        errorKind: leafMoved ? ("precondition" as const) : ("resource" as const),
        durableFailureReason: syncDiagnostics.durableFailureReason ?? "unknown",
        hint: leafMoved
          ? "The corrected response reached delivery and live LCD ingest, but the append-only "
            + "session leaf was no longer the assistant message being corrected, so the "
            + "replacement could not be branched onto it. This is usually a benign race, NOT a "
            + "storage fault — do not investigate disk health for this reason; compare the "
            + "session JSONL leaf entry against the corrected turn."
          : "The corrected response reached delivery and live LCD ingest, but the append-only "
            + "session replacement branch THREW while writing; this is a genuine storage fault — "
            + "inspect the session JSONL leaf and disk health.",
      },
      "Corrected response could not be made canonical in durable session history",
    );
    deps.eventBus.emit("audit:event", {
      timestamp: deps.clock.now(),
      agentId: effectiveAgentId,
      tenantId: deps.tenantId,
      actionType: "response.persistence_projection_guard",
      kind: "audit",
      outcome: "denied",
      metadata: {
        claimKind: "assistant_response",
        reason: "durable_replacement_unavailable",
        durableFailureReason: syncDiagnostics.durableFailureReason ?? "unknown",
      },
    });
  } else if (responseSync === "missing" && (result.response?.length ?? 0) > 0) {
    deps.logger.warn(
      {
        step: "response-persistence",
        errorKind: "precondition" as const,
        hint:
          "The delivered response had no current-turn assistant message to update; inspect "
          + "the session transcript before relying on LCD history for this turn.",
      },
      "Could not synchronize post-processed response with live session transcript",
    );
  }

  if (citationGrounding.matchedDigests.length > 0) {
    const journalStartedAt = deps.clock.now();
    const citationReceipt = appendCitationEvidenceRecord({
      sessionManager: sm,
      sourceMessageId: msg.id,
      urlDigests: citationGrounding.matchedDigests,
    });
    const durationMs = Math.max(0, deps.clock.now() - journalStartedAt);
    if (!citationReceipt.ok) {
      deps.logger.warn(
        {
          step: "citation-evidence-persistence",
          durationMs,
          errorKind: "resource" as const,
          hint:
            "Inspect the selected session JSONL for a valid citation_evidence custom entry "
            + "and verify that the session directory is writable.",
        },
        "Citation evidence could not be persisted",
      );
      deps.eventBus.emit("audit:event", {
        timestamp: deps.clock.now(),
        agentId: effectiveAgentId,
        tenantId: deps.tenantId,
        actionType: "response.citation_evidence_persistence",
        kind: "audit",
        outcome: "denied",
        metadata: { reason: "append_failed" },
      });
    } else {
      deps.logger.debug(
        {
          step: "citation-evidence-persistence",
          durationMs,
          citationCount: citationGrounding.matchedDigests.length,
        },
        "Citation evidence persisted",
      );
    }
  }

  // Map the settled finishReason to the terminal endReason ONCE via the single
  // authoritative table (END_REASON_MAP). This SAME mapped value drives BOTH the
  // persisted sessionEnd.endReason (in buildSessionEndMetadata, which re-maps
  // the identical effectiveFinishReason through the identical table) AND the
  // rollup's `degraded` flag below — so a reason that maps to a non-success
  // endReason (e.g. loop_detected / session_reset → "error") can never record
  // degraded:false alongside it. No second closed reason set.
  const endReason = END_REASON_MAP[effectiveFinishReason] ?? "error";

  // Compute the per-session health rollup ONCE at the chokepoint.
  // degraded is derived from the mapped endReason (≠ "success"); the same record
  // feeds BOTH sinks below — the sessionEnd metadata and the session:summary
  // event — so persist and emit never diverge.
  const sessionHealthRollup = buildSessionHealthRollup(
    {
      ...bridgeResult,
      terminalErrorKind:
        result.finishReason === "error" ||
        result.finishReason === "completed_with_tool_errors"
          ? result.terminalErrorKind
          : undefined,
    },
    endReason,
  );

  // Write session metadata companion file with trace correlation.
  // traceId comes from the AsyncLocalStorage request scope so `_session-metadata.json`
  // can be cross-correlated against daemon.log via grep; runId stays as the
  // executor-scope UUID. See buildSessionEndMetadata for the contract.
  // Fire-and-forget: metadata write failure must not affect execution.
  try {
    sessionAdapter.writeSessionMetadata(sessionKey, buildSessionEndMetadata({
      finishReason: effectiveFinishReason,
      durationMs,
      totalTokens: result.tokensUsed.total,
      executionId,
      traceId: tryGetContext()?.traceId,
      sessionKey: formattedKey, // the explain-format key, so the metadata is self-describing
      clock: deps.clock,
      rollup: sessionHealthRollup,
    }));
  } catch { /* fire-and-forget */ }

  // Announce session:summary once. Own fire-and-forget guard inside
  // emitSessionSummary — a throwing in-process listener must not abort teardown.
  // The event carries ids + counts + topErrorKinds + source:"runtime"
  // PLUS the mapped endReason (the named degradation cause)
  // so the row feeds the system aggregate AND its degradedByCause rollup.
  // endReason is the SAME value mapped once above and co-persisted on sessionEnd.
  emitSessionSummary(
    { eventBus: deps.eventBus, logger: deps.logger },
    {
      sessionKey: formattedKey,
      agentId: effectiveAgentId,
      traceId: tryGetContext()?.traceId ?? executionId,
      turnCount: bridgeResult.turnCount ?? 0,
      rollup: sessionHealthRollup,
      endReason,
      ...(result.responseLocaleRepairSkipped !== undefined
        ? { responseLocaleRepairSkipped: result.responseLocaleRepairSkipped }
        : {}),
      clock: deps.clock,
    },
  );

  // Check onboarding completion after execution
  // Fire-and-forget: triggers getWorkspaceStatus which records
  // onboardingCompletedAt when BOOTSTRAP.md is empty or absent. Does not
  // block response delivery.
  if (isOnboarding) {
    suppressError(getWorkspaceStatus(deps.workspaceDir), "onboarding status check");
  }

  // Persist user+agent paired content to memory (centralized in executor)
  // Pairing user message with agent response creates entries that carry enough
  // context for meaningful RAG retrieval. Standalone user messages like "Hello"
  // or "you choose" have no semantic value without the agent's response.
  //
  // Two-layer dedup defense:
  //   Layer 1: operationType gate -- skip cron/heartbeat/system-internal ops
  //            which are stateless/repetitive and would pollute the vector
  //            space with near-identical entries.
  //   Layer 2: content-hash dedup -- safety net for interactive retries.
  //
  // Non-blocking, non-fatal -- execution never fails due to memory store errors.
  const operationType = params.executionOverrides?.operationType;
  const pairedContext = tryGetContext();
  const pairedTurnScope = pairedContext?.turnScope;
  const learningEligible = pairedContext?.learningEligible;
  const canPersistPairedMemory = learningEligible !== false;
  const skipMemoryForOperation =
    operationType != null && MEMORY_SKIP_OPERATIONS.has(operationType);
  const requestedDurableForgetting = bridgeResult.toolExecResults?.some(
    (record) =>
      record.toolName === "memory_manage"
      && (record.action === "forget" || record.action === "delete"),
  ) ?? false;
  const pairedUserText = resolvePairedMemoryUserText(msg);

  // Layer 0: silent sentinels never enter memory. Idempotent under
  // stripReplyTags + trim per @comis/shared silent-tokens.ts JSDoc
  // contract. The check happens BEFORE the operationType + content-hash
  // dedup gates so that even when the response would otherwise pass those
  // gates, a `NO_REPLY` / `HEARTBEAT_OK` / `[SILENT]` sentinel is rejected
  // from memory persistence.
  const isSilent = !!(deps.memoryPort && result.response && msg.text && isSilentResponse(result.response));
  if (!canPersistPairedMemory) {
    deps.logger.debug(
      { agentId: effectiveAgentId, sessionKey: formattedKey, step: "memory-persistence" },
      "Paired memory skipped: turn ineligible for learning",
    );
  } else if (requestedDurableForgetting) {
    deps.logger.debug(
      { agentId: effectiveAgentId, sessionKey: formattedKey, step: "memory-persistence" },
      "Paired memory skipped: turn requested durable forgetting",
    );
  } else if (isSilent) {
    deps.logger.debug(
      { agentId: effectiveAgentId, sessionKey: formattedKey, hint: "Silent-sentinel response (NO_REPLY / HEARTBEAT_OK / [SILENT]) skipped from paired memory" },
      "Paired memory skipped: silent-sentinel response",
    );
  } else if (!isPairedMemoryEligibleOutcome(result.finishReason)) {
    // The reply the user saw was substituted by the runtime, not produced by
    // the model. Storing it would recall as `[agent] <runtime failure text>`
    // on later turns — the model reading a manufactured failure as its own
    // history. WARN, not DEBUG: an operator should see that a turn degraded
    // hard enough to be withheld from the agent's durable memory.
    deps.logger.warn(
      {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        finishReason: result.finishReason,
        errorKind: "precondition" as ErrorKind,
        hint: "the turn ended degraded, so its user-visible reply was runtime-generated rather than model output and was withheld from durable memory; investigate the finishReason if this recurs",
      },
      "Paired memory skipped: degraded turn outcome",
    );
  } else if (
    deps.memoryPort &&
    result.response &&
    msg.text &&
    pairedTurnScope !== undefined &&
    !skipMemoryForOperation &&
    shouldStorePairedMemory(pairedUserText, result.response)
  ) {
    const now = deps.clock.now();
    const pairedContent = buildPairedMemoryContent(pairedUserText, result.response);

    if (isDuplicatePairedMemory(pairedContent, effectiveAgentId, deps.clock)) {
      deps.logger.debug(
        { agentId: effectiveAgentId, sessionKey: formattedKey },
        "Paired memory skipped: duplicate content within dedup window",
      );
    } else {
      // SECURITY: route the paired-conversation write through the
      // secret-egress firewall (validateMemoryWrite) — the SAME guard the
      // derived-memory writes (user-representation/consolidation)
      // apply. A user-pasted secret is REJECTED (verdict critical) so it is
      // never persisted to the memories table nor embedded into the vector index
      // (recallable across sessions). The skip is content-free. Non-secret
      // content stores unchanged. Helper is exported for unit-testing the gate.
      await storePairedConversationMemory({
        memoryPort: deps.memoryPort,
        memoryScope: { turnScope: pairedTurnScope, visibility: { kind: "conversation" } },
        pairedContent,
        effectiveAgentId,
        sessionKey: { tenantId: sessionKey.tenantId, userId: sessionKey.userId },
        channelType: msg.channelType,
        formattedKey,
        now,
        logger: deps.logger,
        embeddingEnqueue: deps.embeddingEnqueue,
      });
    }
  } else if (deps.memoryPort && result.response && msg.text) {
    // Memory not stored -- distinguish the two skip reasons for observability.
    if (skipMemoryForOperation) {
      deps.logger.debug(
        { operationType, sessionKey: formattedKey },
        "Paired memory skipped: non-interactive operation type",
      );
    } else {
      deps.logger.debug(
        { userLen: msg.text.trim().length, minUserChars: PAIRED_MIN_USER_CHARS, minCombinedChars: PAIRED_MIN_COMBINED_CHARS },
        "Paired memory skipped: content below quality threshold",
      );
    }
  }

  // Context-store afterTurn ingest. Mirrors the memoryPort persist above: off the
  // injected clock, non-fatal (ingestTurn wraps each append per-entry). The
  // body lives in lcd-ingest.ts (this file is over the 800L cap).
  //
  // The master context-engine toggle gates both reads and writes through
  // `shouldRunContextStorePasses`.
  //
  // Idempotency: the high-water mark `getMessages(conversationRef).length`
  // is the persisted count (survives restarts); the delta `live.slice(persisted)`
  // appends only the not-yet-persisted tail. A retry with no new messages appends
  // nothing. `ingestTurnGuarded` also guards the shrink edge: if a heal ever
  // reassigns `state.messages` SHORTER than the store, it skips the append and
  // WARNs (errorKind `precondition`) rather than slicing past the end and either
  // persisting nothing forever or colliding on the unique (conversationRef, seq)
  // index.
  const turnScope = tryGetContext()?.turnScope;
  const turnConversation = turnScope?.conversation;
  const resolvedConversationRef = turnConversation === undefined
    ? undefined
    : createConversationRef(turnConversation);
  if (shouldRunContextStorePasses(config) && resolvedConversationRef?.ok && turnScope) {
    const conversationRef = resolvedConversationRef.value;
    const scope: ContextStoreScope = {
      conversationRef,
      // The scope's SECURITY columns must never be empty. tenantId
      // prefers the explicitly-threaded deps.tenantId, falling back to the
      // session key's tenant (the same source the memoryPort persist uses).
      tenantId: deps.tenantId,
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
    };
    // The SDK JSONL retains rendered current-turn context for forensics.
    // Re-project the completed branch so LCD receives physical inbound history
    // and generated locale repair never becomes conversation state.
    const completedProjection = projectInboundConversation(sm);
    const live =
      ((session.agent as unknown as { state?: { messages?: unknown[] } }).state?.messages ??
        []) as Parameters<typeof ingestTurnGuarded>[2];
    if (completedProjection.ok) {
      session.agent.state.messages = completedProjection.value.messages;
    }
    const store = deps.contextStore;

    // Route the live ingest write through the per-conversation short mutation
    // serializer. Slow summarization uses its own maintenance queue and
    // reacquires this serializer only for its synchronous range-replace.
    // ingestTurnGuarded
    // is NON-FATAL (skip+WARN); on a fail-closed rollover (an ambiguous/malformed
    // scope) it invokes onFailClosed → we emit a content-free context:dag_degraded
    // (reason fail_closed_rollover) so the refusal is observable on the bus. We
    // AWAIT this slot so the ingest's seq slot is claimed in order before the turn
    // returns. If this short critical section ever waits materially, emit a
    // trace-correlated signal: the symptom otherwise looks like a successful
    // model execution whose channel reply arrived minutes late.
    const ingestStart = deps.clock.now();
    const onFailClosed = (): void => {
      deps.eventBus.emit("context:dag_degraded", {
        conversationId: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "fail_closed_rollover",
        durationMs: Math.max(0, deps.clock.now() - ingestStart),
        timestamp: deps.clock.now(),
      });
    };
    const onDivergence = (): void => {
      // The live/store-divergence skip emits a content-free
      // context:dag_degraded so the divergence persists as a health_signal row
      // (queryable by the system health view) instead of being a Pino-only WARN.
      deps.eventBus.emit("context:dag_degraded", {
        conversationId: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "live_store_divergence",
        durationMs: Math.max(0, deps.clock.now() - ingestStart),
        timestamp: deps.clock.now(),
      });
    };
    const onRebase = (): void => {
      // A detected epoch re-base that continues emits a distinct
      // content-free context:dag_degraded reason:"session_rebase" (INFO — a correct
      // continuation, not degradation) so operators can tell "continued after
      // restart/JSONL-housekeeping" from "skipped due to corruption".
      deps.eventBus.emit("context:dag_degraded", {
        conversationId: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "session_rebase",
        durationMs: Math.max(0, deps.clock.now() - ingestStart),
        timestamp: deps.clock.now(),
      });
    };
    if (completedProjection.ok) {
      const projectedIngest = await ingestProjectedConversationHistory({
        store,
        scope,
        sourceMessages: completedProjection.value.sourceMessages,
        projectedMessages: completedProjection.value.messages,
        now: deps.clock.now(),
        logger: deps.logger,
        onFailClosed,
        onDivergence,
        onRebase,
      });
      if (!projectedIngest.ok) {
        deps.logger.warn(
          {
            conversationRef,
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            step: "inbound-history-lcd-reconciliation",
            durationMs: Math.max(0, deps.clock.now() - ingestStart),
            failureKind: projectedIngest.error.message,
            hint:
              "Inspect LCD storage health and structured inbound-provenance "
              + "records; the completed canonical history could not be persisted.",
            errorKind: projectedIngest.error.errorKind,
          },
          "Completed projected conversation LCD ingest failed",
        );
        onDivergence();
      }
    } else {
      deps.logger.warn(
        {
          conversationRef,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          step: "inbound-history-projection",
          durationMs: Math.max(0, deps.clock.now() - ingestStart),
          hint:
            "Inspect the active SDK branch and inbound-provenance records; "
            + "the unprojected live history was retained for this ingest.",
          errorKind: "resource" as const,
        },
        "Completed conversation projection failed before LCD ingest",
      );
      await store.runOnConversation(conversationRef, () =>
        ingestTurnGuarded(
          store,
          scope,
          live,
          deps.clock.now(),
          deps.logger,
          onFailClosed,
          onDivergence,
          onRebase,
        ),
      );
    }
    const ingestDurationMs = Math.max(0, deps.clock.now() - ingestStart);
    if (ingestDurationMs >= 1_000) {
      const traceId = tryGetContext()?.traceId;
      deps.logger.warn(
        {
          conversationRef,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          traceId,
          durationMs: ingestDurationMs,
          hint: "Inspect LCD maintenance and summarizer latency; live ingest should hold the mutation serializer only for its synchronous commit",
          errorKind: "resource" as const,
        },
        "LCD live ingest waited on the mutation serializer",
      );
      deps.eventBus.emit("context:dag_degraded", {
        conversationId: scope.conversationRef,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "serialized_wait",
        durationMs: ingestDurationMs,
        timestamp: deps.clock.now(),
        traceId,
      });
    }

    // The two NON-FATAL afterTurn passes (never reject):
    // the leaf threshold sweep, then the condense fold (AFTER the
    // leaf so the Nth leaf can immediately fold). Bodies live in the trigger
    // modules (this file is over the 800L cap); the calls here stay thin.
    // `summarizerGetter` is the (possibly snapshot-bound) deps getter — the
    // deferred path passes a model-snapshot-bound getter, the inline path
    // reads the live session.
    const runDeferredPasses = async (
      summarizerGetter: typeof deps.getSummarizerDeps,
      flushSummarizerGetter: typeof deps.getFlushSummarizerDeps,
    ): Promise<void> => {
      await runSessionCompactionAfterTurn({
        store,
        scope,
        sessionKey,
        formattedKey,
        sessionCompaction: SessionCompactionConfigSchema.parse(
          config.session?.compaction ?? {},
        ),
        contextEngine: config.contextEngine,
        budgetWindowTokens: params.budgetWindowTokens,
        getSummarizerDeps: summarizerGetter,
        getFlushSummarizerDeps: flushSummarizerGetter,
        memoryPort: deps.memoryPort,
        memoryScope: {
          turnScope,
          visibility: { kind: "conversation" },
        },
        state: {
          get: getSessionCompactionBand,
          set: setSessionCompactionBand,
        },
        now: deps.clock.now(),
        nowFn: () => deps.clock.now(),
        logger: deps.logger,
        eventBus: deps.eventBus,
        embeddingEnqueue: deps.embeddingEnqueue,
      });
      await runLeafPassAfterTurn({
        store,
        scope,
        contextEngine: config.contextEngine,
        getSummarizerDeps: summarizerGetter,
        // The turn's budget window — the utilization denominator (a
        // captured number; dispose-safe on the deferred path).
        budgetWindowTokens: params.budgetWindowTokens,
        now: deps.clock.now(),
        // A clock CALLABLE so the trigger times the pass with two reads
        // (entry → emit). Bound to the injected ClockPort — never Date.now().
        nowFn: () => deps.clock.now(),
        logger: deps.logger,
        eventBus: deps.eventBus,
      });
      await runCondensePassAfterTurn({
        store,
        scope,
        contextEngine: config.contextEngine,
        getCondenseSummarizerDeps: summarizerGetter,
        // Same denominator as the leaf pass (one window truth) — also
        // feeds the condense pressureHigh hard-fanout gate.
        budgetWindowTokens: params.budgetWindowTokens,
        now: deps.clock.now(),
        // Clock CALLABLE for the two-read pass timing (entry → emit).
        nowFn: () => deps.clock.now(),
        logger: deps.logger,
        eventBus: deps.eventBus,
        // The distillation hook seam. Fires after
        // appendCondensedSummary returns, passing summaryId/content/fallback/depth.
        // runDistillationPassAfterTurn is non-fatal end-to-end (mirrors the
        // condense pass's own non-fatal wrapping). Only fires when the deps are
        // present (memoryPort required; other deps optional).
        onCondensed: deps.memoryPort
          ? (summaryId, content, fallbackFlag, condensedDepth) => {
              void runDistillationPassAfterTurn({
                summaryId,
                scope,
                memoryScope: { turnScope, visibility: { kind: "conversation" } },
                content,
                fallback: fallbackFlag,
                depth: condensedDepth,
                now: deps.clock.now(),
                deps: {
                  memoryPort: deps.memoryPort!,
                  lcdStore: store,
                  embeddingEnqueue: deps.embeddingEnqueue,
                  // A clock CALLABLE so the runner times its write boundary
                  // (entry → completion) for the durationMs INFO line. Bound to the
                  // injected ClockPort — never Date.now().
                  nowFn: () => deps.clock.now(),
                  logger: deps.logger,
                  eventBus: deps.eventBus,
                  distillConfig: config.contextEngine?.memory?.distillFromLcd,
                  modelProfile:
                    capabilityClass !== undefined
                      ? { capabilityClass: capabilityClass as "frontier" | "mid" | "small" | "nano" }
                      : undefined,
                  strongerSummarizerModel:
                    config.contextEngine?.compaction?.strongerSummarizerModel || undefined,
                  isSubagentSession: params.executionOverrides?.spawnPacket != null,
                },
              });
            }
          : undefined,
      });
    };

    // Deferral gate: config.contextEngine.deferCompaction (default true).
    if (config.contextEngine?.deferCompaction ?? true) {
      // DEFERRED: enqueue the passes onto the slow per-conversation maintenance
      // queue as a DETACHED unit and do NOT await it. The summarizer never owns
      // the live-ingest mutation serializer; each pass reacquires that serializer
      // only for its synchronous, stale-snapshot-guarded range-replace. The
      // detached promise is wrapped
      // in suppressError so a rejection is logged, NEVER swallowed by a bare empty
      // catch (AGENTS.md §2.2).
      //
      // Snapshot the summarizer model identity NOW (session still alive)
      // and bind it into the getter the detached pass uses, so a pass that resolves
      // its deps AFTER the `session.dispose()` below never re-reads a torn-down
      // `session.agent.state.model`. The detached closure then depends only on the
      // captured snapshot + the daemon-owned store/auth/clock — all of which
      // outlive the session. (Lifetime contract, documented on
      // snapshotSummarizerDepsForDefer.)
      const deferredSummarizerGetter = snapshotSummarizerDepsForDefer(deps.getSummarizerDeps);
      const deferredFlushSummarizerGetter =
        snapshotSummarizerDepsForDefer(
          deps.getFlushSummarizerDeps,
          deps.getSummarizerDeps,
        );
      const deferred = enqueueContextMaintenance(
        conversationRef,
        () => runDeferredPasses(
          deferredSummarizerGetter,
          deferredFlushSummarizerGetter,
        ),
      );
      suppressError(deferred, "postExecution deferred LCD compaction");
    } else {
      // INLINE: await the passes (the deterministic path retained for
      // tests). Non-fatal — never surfaces an error to the live turn. Reads the
      // LIVE session model (no snapshot needed — the session is alive inline).
      await runDeferredPasses(
        deps.getSummarizerDeps,
        deps.getFlushSummarizerDeps,
      );
    }
  }

  // Attribute recall usage + emit the recall-used event (flag-gated, non-fatal).
  // The overlap heuristic reads recalled text in-process and produces ids only; the event
  // carries counts + ids (never bodies). Default-OFF: when rag.feedback.enabled !== true
  // this whole block is skipped (no attribution, no emit). The daemon subscriber
  // (setup-memory-usefulness-wiring.ts) does the write-back through the usefulness-store port; the
  // agent stays inside the build cut (no memory-package import on the write path).
  const feedback = (config.rag as (typeof config.rag & { feedback?: FeedbackView }) | undefined)?.feedback;
  if (
    feedback?.enabled === true &&
    params.recalledMemories !== undefined &&
    params.recalledMemories.length > 0 &&
    result.response
  ) {
    try {
      const { usedIds, ignoredIds } = attributeRecallUsage(params.recalledMemories, result.response);
      // Write side: thread the recall-time intent so the daemon subscriber writes
      // the PER-INTENT usefulness bucket. The intent is classifyIntent over the SAME recalled
      // query the recall read classified (msg.text — prompt-assembly.ts:818), gated on the SAME
      // queryUnderstanding.intentReweight flag the recall read uses. classifyIntent is pure +
      // deterministic ("NO LLM, NO network") so the emit adds NO model call. intentReweight off
      // (or msg.text absent) → intent stays undefined → the spread OMITS it → the subscriber
      // records the global ('') bucket (byte-identical to the prior write). The intent is a
      // closed-union metadata string (factual|temporal|preference|enumeration), never the raw
      // query — the event stays ids/counts/intent-only (§2.7).
      const intent =
        config.rag.queryUnderstanding?.intentReweight === true && msg.text
          ? classifyIntent(msg.text)
          : undefined;
      deps.eventBus.emit("memory:recall_used", {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        traceId: tryGetContext()?.traceId ?? formattedKey,
        usedIds,
        ignoredIds,
        usedCount: usedIds.length,
        ignoredCount: ignoredIds.length,
        timestamp: deps.clock.now(),
        ...(intent !== undefined ? { intent } : {}),
      });
    } catch {
      // Attribution + emit is non-fatal — it must never fail the turn.
    }
  }

  // Emit the counts/ids-only memory:skill_used write-back carrying the
  // per-turn skill ids attributed by the bridge (its named carrier, read
  // back at the pi-executor call site). Mirrors the memory:recall_used emit
  // above — PLAIN emit, ids/counts ONLY (never procedure bodies). Gated on a
  // non-empty usedSkillIds so the no-skill default path is unchanged.
  // The daemon subscriber (setup-learning.ts) threads
  // usedSkillIds into observe() → the used_skill_ids column. This is the
  // dedicated write-back event — the daemon-emitted outcome event has no
  // usedSkillIds field and is never the carrier's target.
  if (params.usedSkillIds !== undefined && params.usedSkillIds.length > 0) {
    try {
      deps.eventBus.emit("memory:skill_used", {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        traceId: tryGetContext()?.traceId ?? formattedKey,
        usedSkillIds: [...params.usedSkillIds],
        usedCount: params.usedSkillIds.length,
        timestamp: deps.clock.now(),
      });
    } catch {
      // Skill-use emit is non-fatal — it must never fail the turn.
    }
  }

  // Emit the surfaced-skill CENSUS stored during prompt-assembly (the reuse near-misses
  // + credited, content-free). Emitted HERE — not inline in prompt-assembly — because the
  // standing-block assembly runs BEFORE the trajectory bridge subscribes (assembleTools precedes
  // attachTrajectoryToEventBus in pi-executor), so an inline emit fired to NO listener (the bridge
  // wrote nothing). Mirrors the memory:skill_used carrier.
  const surfacedCensus = getSessionPromptSkillSurfacedCensus(formattedKey);
  if (surfacedCensus !== undefined) {
    clearSessionPromptSkillSurfacedCensus(formattedKey);
    try {
      deps.eventBus.emit("memory:skill_surfaced", {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        traceId: tryGetContext()?.traceId ?? formattedKey,
        surfacedCount: surfacedCensus.surfacedCount,
        creditedCount: surfacedCensus.creditedCount,
        scores: surfacedCensus.scores,
        timestamp: deps.clock.now(),
      });
    } catch {
      // Census emit is non-fatal — it must never fail the turn.
    }
  }

  // memory:injected: emit the RAG-injection summary stored during assembly.
  // Like the census above, this is emitted HERE — not inline in prompt-assembly — because the
  // assembly runs BEFORE the trajectory bridge subscribes, so the prior inline emit was lost on
  // EVERY turn (the trajectory never recorded a RAG injection). Content-free: counts + closed
  // trust-level tags only.
  const memoryInjected = getSessionPromptMemoryInjected(formattedKey);
  if (memoryInjected !== undefined) {
    clearSessionPromptMemoryInjected(formattedKey);
    try {
      deps.eventBus.emit("memory:injected", {
        agentId: effectiveAgentId,
        sessionKey: formattedKey,
        traceId: tryGetContext()?.traceId ?? formattedKey,
        hitCount: memoryInjected.hitCount,
        charsInjected: memoryInjected.charsInjected,
        trustTags: memoryInjected.trustTags,
        pinnedCount: memoryInjected.pinnedCount,
        timestamp: deps.clock.now(),
      });
    } catch {
      // Injection-telemetry emit is non-fatal — it must never fail the turn.
    }
  }

  // memory:recalled / memory:reranked / memory:recall_degraded: flush the
  // recall emits deferred during assembly — same pre-bridge timing reason as
  // memory:injected above (an inline emit fired to no trajectory listener, so
  // memory.recalled never appeared in any trajectory).
  const deferredRecallEvents = drainSessionPromptRecallEvents(formattedKey);
  if (deferredRecallEvents !== undefined) {
    for (const flush of deferredRecallEvents) {
      try {
        flush(deps.eventBus);
      } catch {
        // Recall-telemetry emit is non-fatal — it must never fail the turn.
      }
    }
  }

  // End-of-turn backstop drain.
  //
  // The bridge fires `drainAt(...)` on `tool_execution_end` for successful
  // `message(send|reply|attach)` calls (the primary inline-consumption
  // call site). The end-of-turn call site below is the BACKSTOP for turns
  // that produced a response WITHOUT invoking the message tool (NO_REPLY-
  // only turns, sentinel-passthrough turns, error paths). Both call sites
  // share the SAME composite-key inflight gate (`drainInflightByKey`) so a
  // bridge-fired drain in flight collapses any backstop drain for the same
  // composite key (single-tick gate).
  //
  // The drain key is composed from `effectiveAgentId` (multi-agent
  // isolation) + `msg.channelType` + `msg.channelId`. markRead and
  // markConsumed inside drainAt read tool context via tryGetContext();
  // when the executor runs outside an AsyncLocalStorage scope (e.g.,
  // tests with no runWithContext wrapper) the helpers fall through silently.
  const drainKey: DrainKey = {
    agentId: effectiveAgentId,
    channelType: msg.channelType,
    channelId: msg.channelId,
  };
  // tryGetContext() reads the AsyncLocalStorage scope; markRead/markConsumed
  // do the same internally, but reading once here lets us correlate the
  // backstop-drain log line with the request's traceId without re-deriving
  // it inside the helper. Returns undefined outside any request scope --
  // markRead/markConsumed handle that path silently.
  const drainCtx = tryGetContext();
  if (drainCtx) {
    deps.logger.debug(
      {
        submodule: "drain.endOfTurn",
        agentId: effectiveAgentId,
        channelType: msg.channelType,
        channelId: msg.channelId,
        traceId: drainCtx.traceId,
      },
      "End-of-turn drain backstop firing",
    );
  }
  drainAt({ agentId: effectiveAgentId, channelType: drainKey.channelType, channelId: drainKey.channelId }, bridge.getDrainState(), deps.logger);

  // Deregister active run before dispose. Must use the same resolver-aligned
  // key formula as the corresponding register call site.
  if (deps.activeRunRegistry) {
    deps.activeRunRegistry.deregister(resolverRegisterKey);
  }

  // Strip verbose <functions> blocks from discover_tools results
  // in session history. Runs post-execution so the current turn's model
  // saw full schemas. Safe no-op when no discover_tools results exist.
  // Fence-aware: entries at or below the cache fence are not stripped to preserve prefix stability.
  stripDiscoverySchemas(sm, deps.logger, finalBreakpointIdx);

  session.dispose();
}
