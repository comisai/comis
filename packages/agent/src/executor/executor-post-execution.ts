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

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CacheRetention } from "@earendil-works/pi-ai";
import {
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type MemoryPort,
  type ClockPort,
  type ContextStorePort,
  type ContextStoreScope,
  tryGetContext,
  // Secret-egress guard (the keystone). Used to gate the paired-conversation
  // memory write so user-pasted secrets never reach the memories table / vector
  // index — the SAME guard the derived-memory writes on this file already apply
  // (memory-user-representation-job.ts, memory-relationship-job.ts,
  // memory-consolidation-job.ts). validateMemoryWrite REJECTS (severity
  // "critical") when the secret-egress scan finds a redaction.
  validateMemoryWrite,
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
import {
  setBreakpointIndex,
  deleteBreakpointIndex,
  getBreakpointIndexMapSize,
} from "./executor-session-state.js";
// Import directly from the leaf module (not the barrel) to keep the cycle
// detector happy — pi-executor.ts imports executor-post-execution.ts in the
// finally block, so going through the barrel would create
// executor-post-execution → pi-executor/index → pi-executor/pi-executor →
// executor-post-execution.
import { mergeSessionStats } from "./pi-executor/session-stats.js";
import { recordLastResponseTs } from "./ttl-guard.js";
import { stripDiscoverySchemas } from "./schema-stripping.js";
// LCD afterTurn ingest write-path (Phase 128, A1). Body lives in lcd-ingest.ts
// (this file is already over the 800L cap); the call below is a thin gated
// invocation. The agent↛memory cut: lcd-ingest imports only the core port type
// + the core codec — never @comis/memory.
import { ingestTurnGuarded } from "./lcd-ingest.js";
// LCD afterTurn leaf-pass trigger (Phase 129, C1/C3). Activates the inert
// contextThreshold: a thin gated call right after the ingest fires one leaf pass
// when utilization is over threshold. The body (gating + opts + summarize +
// range-replace + emit) lives in lcd-compaction-trigger.ts (this file is over
// the 800L cap); the call here is a single non-fatal invocation. The
// agent↛memory cut: the trigger imports only the core port type + the core codec.
import { runLeafPassAfterTurn } from "./lcd-compaction-trigger.js";
// LCD afterTurn CONDENSE pass (Phase 130, C2). A second thin gated call right
// after the leaf pass: when ≥condensedMinFanout contiguous same-depth summaries
// have accumulated, fold the shallowest run into one depth+1 condensed summary.
// Runs AFTER the leaf pass so a turn that just created the Nth leaf can fold it.
// The body lives in lcd-condense-trigger.ts (this file is over the 800L cap); the
// call here is a single non-fatal invocation. The agent↛memory cut: the condense
// trigger imports only core types + the agent-side condense summarizer.
import { runCondensePassAfterTurn } from "./lcd-condense-trigger.js";
// LCD→LTM distillation runner (Phase 172-02, DIST-01..04). Fires via the
// onCondensed callback on runCondensePassAfterTurn — non-fatal, fire-and-forget
// (mirrors the condense pass's own T-130-07 wrapping). The agent↛memory cut:
// the runner imports only core TYPE-only ports — no @comis/memory import.
import { runDistillationPassAfterTurn } from "./lcd-distillation-runner.js";
import type { LeafSummarizerDeps, CompactionModelSnapshot } from "../context-engine/lcd-leaf-summarizer.js";
// In-package pure attribution fn (the agent↛memory cut — core types
// only; the write-back is the daemon's job, off the recall-used bus event).
import { attributeRecallUsage } from "../rag/recall-attribution.js";
// Write side: the DETERMINISTIC, LLM-free intent classifier (same package, NOT
// publicly exported — Pitfall 2). The turn-end memory:recall_used emit threads
// classifyIntent(msg.text) so the daemon write-back records the per-intent usefulness bucket.
import { classifyIntent } from "../rag/query-understanding.js";
import { getWorkspaceStatus } from "../workspace/index.js";
import type { ExecutionResult, ExecutionOverrides } from "./types.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
// WR-02: import the precise type so PostExecutionParams.capabilityClass
// is CapabilityClass | undefined, not string | undefined.
import type { CapabilityClass } from "./model-profile.js";
import { createHash, randomUUID } from "node:crypto";
// R4: critic hook (no inline logic — all logic in verification-gate.ts)
import { shouldRunCritic, runVerificationCritic } from "./verification-gate.js";
// CWF-05: deterministic user-facing reply for named degraded terminal causes.
import { buildOutputStarvedAnnotation, buildContextExhaustedReply, buildLoopDetectedReply } from "./degraded-reply.js";
// GEN-02 (DET-02): resolve the degraded reply's language once at the chokepoint.
import { resolveReplyLanguage } from "./resolve-reply-language.js";
import { parseContextExhaustionCause } from "../context-engine/errors.js";
import { buildSyntheticCriticDeps } from "./verification-gate-synth-deps.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { generateCanaryToken } from "@comis/core";

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
  /** The last LLM error message the bridge captured (HR-01 mid-turn path) —
   *  Issue-6 reads the `[cause: …]` tag from it when errorContext is absent. */
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
  sessionCostUsd?: number;
  /** Per-tool execution results carrying the classified errorKind (Plan 01) —
   *  the rollup's failure source for toolStats + topErrorKinds (D5/F1). */
  toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string; errorKind?: ErrorKind }>;
  /** How many times a tool circuit breaker opened this session (Plan 01). */
  breakerTripCount?: number;
  /** Turn count for the session:summary event (Plan 02/F2). */
  turnCount?: number;
  /**
   * The SDK-normalized stop reason of the session's FINAL turn (QT3). The bridge
   * captures `AssistantMessage.stopReason` at EVERY `turn_end`
   * (pi-event-bridge.ts), so the value carried here is the TERMINAL one. Its
   * union is `"stop" | "length" | "toolUse" | "error" | "aborted"` (pi-ai) — a
   * terminal `"length"` is the output-cap truncation the chokepoint promotes to
   * `finishReason:"output_starved"` (see {@link promoteOutputStarved}). Already
   * returned by `buildBridgeResult`; surfaced on this interface so the chokepoint
   * can read it without a second source.
   */
  lastStopReason?: string;
  /** Session-cumulative cache savings across all turns (USD). */
  sessionCacheSavedUsd?: number;
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
  /** R2 (Phase 153): abort-redirect message set at bridge abort sites
   *  (max_steps, budget_exceeded, loop_detected, …). When present and the
   *  turn did not finish with "stop", post-execution replaces the response
   *  so a weak executive never free-associates after an abort. Mirrors
   *  bridge-metrics.ts BridgeResult.abortResponse. */
  abortResponse?: string;
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
  sm: { buildSessionContext(): unknown };
  config: PerAgentConfig;
  msg: NormalizedMessage;
  /** USER.md preferred language (DET-02 tier-2), threaded from prompt assembly.
   *  Consumed by the degraded-reply resolver (GEN-02, wired in 181-03). */
  userMdLanguage?: string;
  sessionKey: SessionKey;
  formattedKey: string;
  /** Resolver-aligned key for activeRunRegistry.deregister. Must match the
   *  formula used at the corresponding register call site. */
  resolverRegisterKey: string;
  agentId: string | undefined;
  executionStartMs: number;
  executionId: string;
  executionOverrides: ExecutionOverrides | undefined;
  /** Recalled memories (id + content) for turn-end attribution. Consumed
   *  IN-PROCESS by the overlap heuristic here; content NEVER logged/emitted (only
   *  ids/counts cross the bus). Absent ⇒ no attribution (default-off / no recall). */
  recalledMemories?: ReadonlyArray<{ id: string; content: string }>;
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
   * SUMW-02: the turn's budget window — computeTokenBudgetForProfile().windowTokens
   * = min(reconciled contextWindow, capability class cap). MUST be computed
   * UPSTREAM (pi-executor threads it off the tool-assembly result): this module
   * has no real ModelProfile (only a synthetic scaffold profile), so it can never
   * re-derive the value. Threaded into BOTH LCD after-turn triggers as the
   * REQUIRED utilization denominator — a captured number, dispose-safe on the
   * deferred (C4) path by construction.
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
    eventBus: TypedEventBus;
    logger: ComisLogger;
    memoryPort?: MemoryPort;
    /** Optional LCD context store (Phase 128 dag-mode write-path, A1). Present
     *  ⇒ the turn's NEW messages are ingested at afterTurn; absent ⇒ skipped
     *  cleanly. TYPE-only core port (the agent↛memory cut). */
    contextStore?: ContextStorePort;
    /** Tenant id for the LCD ingest scope. Threaded from PiExecutorDeps.tenantId
     *  at the call site so the scope's SECURITY column is never empty
     *  (T-128-08). Falls back to the session key tenant when absent. */
    tenantId?: string;
    /** Getter for the leaf-summarizer deps (Phase 129, C1). Present ⇒ the
     *  afterTurn leaf pass is wired live (over threshold ⇒ a leaf summary is
     *  persisted); absent ⇒ the pass is gated off cleanly. Sourced from the
     *  context-engine setup's getCompactionDeps-style getters; TYPE-only (the
     *  agent↛memory cut — the LLM call lives behind the injected summarizer).
     *  Accepts an optional `modelSnapshot`: the DEFERRED (C4) path passes a model
     *  identity captured BEFORE `session.dispose()` so a detached pass never
     *  re-reads a torn-down `session.agent.state` (WR-04). */
    getSummarizerDeps?: (modelSnapshot?: CompactionModelSnapshot) => LeafSummarizerDeps;
    activeRunRegistry?: ActiveRunRegistry;
    embeddingEnqueue?: (entryId: string, content: string) => void;
    workspaceDir: string;
    /** Wall-clock + monotonic time reads. */
    clock: ClockPort;
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
 * SECURITY (FIX 1): the paired-conversation write is the highest-volume memory
 * path (every qualifying turn) and was the ONLY agent-visible memory write that
 * bypassed `validateMemoryWrite`. A user who pasted a secret into chat had it
 * written VERBATIM to the `memories` table AND embedded into the vector index —
 * recallable across sessions — even though the explicit `memory_store` tool
 * refuses it (cosmetic for data-at-rest). The DERIVED-memory writes
 * (user-representation, relationship, consolidation) all run `validateMemoryWrite`
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
    memoryPort, pairedContent, effectiveAgentId, sessionKey,
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
        hint: "Paired conversation memory matched a secret/dangerous/suspicious pattern — skipped (the learned-trust conversation memory has no reduced-weight tier); the secret value is never logged or persisted",
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
      tenantId: sessionKey.tenantId,
      agentId: effectiveAgentId,
      userId: sessionKey.userId,
      content: pairedContent,
      trustLevel: "learned",
      source: {
        who: sessionKey.userId,
        channel: channelType ?? "unknown",
        sessionKey: formattedKey,
      },
      tags: ["conversation", "paired"],
      createdAt: now,
    });
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
 * Decide whether the LCD afterTurn store passes (ingest + leaf + condense) run
 * for this turn, based on the agent's effective context-engine version.
 *
 * The daemon injects the LCD ContextStorePort UNCONDITIONALLY
 * (setup-agents-runtime.ts), but ONLY the dag engine READS the store: the
 * assembler's dag branch (context-engine.ts — gated `version === "dag"`) and the
 * ctx_* expansion tools (setup-tools.ts — gated `version === "dag" && lcdStore`).
 * A pipeline agent therefore must NOT write `lcd_messages` or fire leaf/condense
 * LLM summarization — that work is pure wasted cost + latency because nothing
 * reads it.
 *
 * Symmetry with the read side: the executor resolves an ABSENT
 * `config.contextEngine` via `ContextEngineConfigSchema.parse({})`, whose
 * `version` defaults to "dag" (executor-context-engine-setup.ts). So an absent
 * contextEngine (and an absent `version` within a present contextEngine) is
 * treated as dag — exactly what the assembler does — and only an EXPLICIT
 * `version: "pipeline"` skips the passes. This keeps write and read in agreement
 * and makes the dag default flip non-breaking. The gate reads per-turn config,
 * so flipping an agent pipeline→dag later takes effect on the very next turn (the
 * first dag turn catches up via the ingest delta from an empty store).
 *
 * Pure: no I/O, no side effects. Exported for unit tests.
 */
export function shouldRunLcdStorePasses(config: {
  contextEngine?: { version?: "pipeline" | "dag" };
}): boolean {
  return (config.contextEngine?.version ?? "dag") === "dag";
}

/**
 * Map an SDK finishReason to the SessionMetadata.sessionEnd.endReason enum.
 *
 * SINGLE SOURCE OF TRUTH for the run's terminal classification: the rollup's
 * `degraded` flag (session-health-rollup.ts) is derived from the value this map
 * yields (degraded := mapped endReason !== "success"), so `endReason` and
 * `degraded` are computed from the SAME table and cannot diverge (Phase 152
 * CR-01/WR-01). Exported so the chokepoint maps once and the unit tests can
 * enumerate the finishReason union against it.
 *
 * Every KNOWN, in-union `ExecutionResult.finishReason` is listed EXPLICITLY —
 * including `loop_detected` (turn-loop-detector abort) and `session_reset`,
 * which reach the rollup verbatim and previously relied on the `?? "error"`
 * fallthrough (WR-02). The fallthrough is now reserved for its stated purpose:
 * a defensive bucket for UNKNOWN provider strings we haven't classified yet,
 * not a silent home for classified in-union reasons. Module-level so the
 * post-execution path doesn't reallocate it on every turn.
 *
 * NOTE: the endReason union's "timeout" literal — dead since the union was
 * written — is ALIVE as of LAT-04 (Phase 177): the `prompt_timeout` entry
 * below is its ONLY source. The WR-02 test that pinned its unreachability
 * became a positive pin (prompt_timeout → "timeout", sole source): the
 * negative pin existed to prevent ACCIDENTAL re-introduction; this mapping
 * is the deliberate one.
 *
 * QT2/QT3 — NAMED degradation causes (Glass Box degradation detectors). The
 * taxonomy used to FLATTEN context-exhaustion into the generic "error" bucket,
 * so obs.explain / obs.fleet.health could not tell a context-exhausted session
 * from a tool crash. The two related context-exhaustion finish reasons —
 * `context_exhausted` (the bridge's hard context-window-guard abort,
 * bridge-safety-controls.ts) and `context_loop` (the loop-on-exhaustion abort) —
 * now FOLD into ONE named cause `"context_exhausted"`. `output_starved` (the
 * chokepoint promotes a terminal output-cap truncation, QT3) is its own named
 * cause `"output_starved"`. Both are degraded by construction (≠ "success", so
 * session-health-rollup's CLEAN_END_REASONS derives degraded:true unchanged).
 */
export const END_REASON_MAP: Record<string, NonNullable<SessionMetadata["sessionEnd"]>["endReason"]> = {
  stop: "success", end_turn: "success", error: "error",
  budget_exceeded: "budget_exceeded", budget_exhausted: "budget_exhausted",
  circuit_open: "circuit_open",
  provider_degraded: "provider_degraded", max_steps: "error",
  // QT2: fold the two context-exhaustion reasons into the single named cause.
  context_loop: "context_exhausted", context_exhausted: "context_exhausted",
  // QT3: the terminal output-cap truncation promoted at the chokepoint.
  output_starved: "output_starved",
  // LAT-04 (177): the deliberate flip of the WR-02 dead-literal pin — PromptTimeoutError
  // terminals get the NAMED cause (QT2/QT3 precedent). HARD_FAILURE_END_REASONS and the
  // fleet degradedByCause record are pre-wired for "timeout".
  prompt_timeout: "timeout",
  completed_with_tool_errors: "completed_with_tool_errors",
  // Issue-4: the narrate-without-emit terminal promoted at the chokepoint
  // (see promoteNarrationStall) — a small/nano turn that ended on intent
  // narration with no tool call and did not recover after the one nudge.
  narration_stall: "narration_stall",
  // Known in-union reasons — explicit, not via the catch-all fallthrough (WR-02).
  loop_detected: "error",
  session_reset: "error",
};

/**
 * The SDK-normalized terminal stop reasons that mark an output-cap truncation
 * (QT3). The pi-ai `StopReason` union normalizes the output cap to `"length"`
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
 * QT3 — promote a PATHOLOGICAL terminal output truncation to the named cause.
 *
 * Returns `"output_starved"` IFF the run would OTHERWISE end clean
 * (`stop`/`end_turn` → `success`) AND the session's FINAL turn stopped at the
 * model output cap (`lastStopReason ∈ {length, max_tokens}`). Otherwise it
 * returns `effectiveFinishReason` UNCHANGED.
 *
 * This is deliberately conservative — the hard rule is "do not flag healthy
 * sessions" (the spike's load-bearing guard):
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
 * Issue-4 (small-model e2e 2026-06-12) — promote a narrate-without-emit
 * terminal to the named cause `narration_stall`.
 *
 * Fires IFF the run would OTHERWISE end clean (`stop`/`end_turn`) AND the
 * narrate-nudge FIRED for this turn but did NOT recover a real answer — the
 * delivered response is still mid-task narration ("Now let me run the
 * tool:") with no tool call behind it. Such a turn was previously recorded
 * `degraded:false, endReason:success` (the soft false-clean: live session
 * uc4-uc5-35). Mirrors {@link promoteOutputStarved}'s conservative shape:
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
  clock: ClockPort;
  /** F1 health rollup (D5) — the 5 fields spread onto sessionEnd. Computed once
   *  at the chokepoint via buildSessionHealthRollup so this builder stays pure. */
  rollup: SessionHealthRollup;
}): SessionMetadata {
  return {
    ...(args.traceId && { traceId: args.traceId }),
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
 * F2 emit: announce `session:summary` on the eventBus once per execution.
 *
 * The payload carries ids + counts + typed flags PLUS `topErrorKinds` and
 * `source` (Phase 159 A1/A2 — OQ1 reversed): both are threaded into the
 * persisted `obs_diagnostics` row so the fleet aggregate
 * (`aggregateSessionsInWindow`) can read them without opening per-session
 * `_session-metadata.json`. Production emits the constant `source: "runtime"`;
 * a synthetic/test row is produced by a caller injecting `source: "test"`.
 * Fire-and-forget by contract: the eventBus is SYNCHRONOUS, so a throwing
 * in-process listener would otherwise abort the caller's teardown (OQ3). The
 * try/catch here is the sanctioned telemetry guard (mirrors the `:983`
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
     *  Carried so the row feeds the fleet `degradedByCause` aggregate (QT2/QT3). */
    endReason: string;
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
      timestamp: args.clock.now(),
    });
  } catch (err) {
    // Fire-and-forget: a throwing listener must not abort the teardown (OQ3).
    deps.logger?.debug(
      { err, hint: "session:summary listener threw; telemetry dropped, execution unaffected", errorKind: "internal" as const, submodule: "session-summary-emit" },
      "session:summary emit suppressed a listener throw",
    );
  }
}

/**
 * WR-04 lifetime guard for the DEFERRED (C4) compaction path.
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
export function snapshotSummarizerDepsForDefer(
  getSummarizerDeps: ((modelSnapshot?: CompactionModelSnapshot) => LeafSummarizerDeps) | undefined,
): ((modelSnapshot?: CompactionModelSnapshot) => LeafSummarizerDeps) | undefined {
  if (getSummarizerDeps === undefined) return undefined;
  // Capture the LIVE model identity now (session still alive). If the live read
  // throws at capture time, leave the getter unchanged — the deferred pass then
  // degrades non-fatally through the trigger's try/catch.
  let modelSnapshot: CompactionModelSnapshot | undefined;
  try {
    modelSnapshot = getSummarizerDeps().getModel();
  } catch {
    return getSummarizerDeps;
  }
  // Re-bind: every later resolution injects the captured snapshot, so neither the
  // top-level getModel nor the summarizer-internal model read touches the session.
  return (override?: CompactionModelSnapshot) => getSummarizerDeps(override ?? modelSnapshot);
}

/**
 * Classify failed tools into the subset that was NOT recovered this turn (HR-01).
 *
 * A tool failure is "recovered" when the SAME tool name also has a successful
 * execution in `toolExecResults` for this turn — e.g. the model retried after a
 * transient error and the retry succeeded. The user-facing `[tool failure]`
 * notice must surface only UNRECOVERED failures: a tool that failed and never
 * succeeded. The live case is the NVDA pipeline — attempt-1 (validation) failed,
 * attempt-2 launched the graph, yet the user saw "[tool failure] pipeline reported
 * an error" because the notice keyed off raw failedTools.
 *
 * Safe fallback: when `toolExecResults` is absent/empty (success record not
 * plumbed on some path) every failed tool is reported as unrecovered — i.e. the
 * pre-HR-01 behavior, so this never HIDES a genuine unrecovered failure.
 *
 * Observability is unaffected: effectiveFinishReason / logs / fleet rollup still
 * record the failure. Only the user-facing reply is gated.
 *
 * Pure: no I/O, no side effects. Returns deduped failed names with no same-name success.
 */
export function unrecoveredFailedToolNames(
  failedTools: string[],
  toolExecResults?: Array<{ toolName: string; success: boolean }>,
): string[] {
  if (failedTools.length === 0) return [];
  const succeeded = new Set(
    (toolExecResults ?? []).filter((r) => r.success).map((r) => r.toolName),
  );
  return [...new Set(failedTools)].filter((name) => !succeeded.has(name));
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
    result, session, sm, config, msg, sessionKey, formattedKey, resolverRegisterKey, agentId,
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
  const effectiveAgentId = agentId ?? "default";

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
  // R2: Abort redirect — when bridge set an abortResponse (max_steps, budget_exceeded, etc.),
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

    // Emit supplementary cache event for pipeline collector (Issue 1 timing fix).
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

  // Derive effectiveFinishReason BEFORE the bookend log so it is visible there.
  // WR-02: the bookend must log effectiveFinishReason (not result.finishReason) so that
  // an output_starved turn — which carries result.finishReason="stop" until promoted here —
  // is visible in the bookend as degraded. The variables are declared early and referenced
  // again by the tool-failure append and CWF-05 gate below (no double-computation).
  const hasToolFailures = (bridgeResult.failedTools?.length ?? 0) > 0;
  const finishReasonStr = result.finishReason as string;
  const isStopTurn = finishReasonStr === "stop" || finishReasonStr === "end_turn";
  // Stage 1: tool-failure reconciliation (a clean stop turn with failed tools
  // becomes completed_with_tool_errors).
  const toolReconciledFinishReason =
    hasToolFailures && isStopTurn
      ? "completed_with_tool_errors"
      : result.finishReason;
  // Stage 2 (QT3): promote a PATHOLOGICAL terminal output truncation. Fires ONLY
  // when stage 1 left a CLEAN would-be terminal (stop/end_turn) AND the session's
  // FINAL turn stopped at the output cap (bridge's terminal lastStopReason). A
  // tool-error / budget / breaker / context_exhausted terminal is untouched (the
  // upstream cause wins), and a continued/mid-run length-stop is not flagged
  // (the terminal stop reason is no longer "length"). See promoteOutputStarved.
  // Stage 3 (Issue-4): promote a narrate-without-emit terminal that the one
  // bounded nudge could not recover — same conservative shape as stage 2.
  const effectiveFinishReason = promoteNarrationStall(
    promoteOutputStarved(toolReconciledFinishReason, bridgeResult.lastStopReason),
    result.narrateNudge,
  );

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
      // WR-02 (Phase 169): log the post-promotion effectiveFinishReason so an
      // output_starved degradation is visible in the bookend (result.finishReason
      // stays "stop" for output_starved; only effectiveFinishReason reflects the
      // promotion). Emitted only when it differs from finishReason to avoid noise
      // on the common case where they are identical.
      ...(effectiveFinishReason !== result.finishReason && { effectiveFinishReason }),
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
      sessionCostUsd: bridgeResult.sessionCostUsd ?? 0,
      sessionCacheSavedUsd: bridgeResult.sessionCacheSavedUsd ?? 0,
      // Session cache savings rate
      sessionCacheSavingsRate: (bridgeResult.sessionCacheSavedUsd ?? 0) > 0 || (bridgeResult.sessionCostUsd ?? 0) > 0
        ? Math.round(((bridgeResult.sessionCacheSavedUsd ?? 0) / ((bridgeResult.sessionCostUsd ?? 0) + (bridgeResult.sessionCacheSavedUsd ?? 0))) * 100)
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
      activeToolCount: mergedCustomTools.length,
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

  // Notice append is gated (HR-01): surface ONLY tools that failed and were NOT
  // recovered (no same-name success this turn) — a fail-then-retry-succeed (e.g.
  // the NVDA pipeline's attempt-1 validation error → attempt-2 launch) must not
  // read as a user-facing failure. Also suppressed when the model already
  // acknowledged the failure or the response is a silent sentinel. The
  // observability label (effectiveFinishReason) is unchanged — operators still
  // see the recovered failure in logs/fleet.
  const unrecoveredFailed = unrecoveredFailedToolNames(
    bridgeResult.failedTools ?? [],
    bridgeResult.toolExecResults,
  );
  if (
    unrecoveredFailed.length > 0 &&
    isStopTurn &&
    !modelAcknowledgedFailure(result.response ?? "", unrecoveredFailed) &&
    !isSilentResponse(result.response ?? "")
  ) {
    const failedToolName = unrecoveredFailed[0];
    result.response = (result.response ?? "") +
      `\n[tool failure] ${failedToolName} reported an error (see session log for details)`;
  }

  // CWF-05: degrade loudly — deliver an honest user-facing reply for named degraded causes.
  // APPEND for output_starved (partial text exists); REPLACE for context_exhausted (no usable text).
  // Gate on effectiveFinishReason (NOT result.finishReason — output_starved is only set here).
  // GEN-02 (DET-02): resolve the reply language ONCE (config > USER.md > inbound
  // script he/ar/ru > en) and pass the tag to all three builders, so a Hebrew
  // user reads the what/why/knob in Hebrew (en/"en" path stays byte-identical).
  const replyLanguage = resolveReplyLanguage({
    inboundText: params.msg.text ?? "",
    configLanguage: params.config.language,
    userMdLanguage: params.userMdLanguage,
  });
  if (effectiveFinishReason === "output_starved") {
    result.response = (result.response ?? "") + buildOutputStarvedAnnotation(replyLanguage);
    deps.logger.warn(
      { step: "degraded-reply", errorKind: "resource" as const, hint: "output_starved annotation appended" },
      "CWF-05: output_starved — annotated truncated reply",
    );
  }
  if (effectiveFinishReason === "context_exhausted") {
    // W4 (obs-llm-troubleshooting): name the exact cap knob for small/nano and
    // append the incident traceId so `comis explain <traceId>` is one step away
    // from the chat message itself.
    // Issue-6: recover the exhaustion CAUSE from the message that crossed the
    // type-stripping boundary — errorContext.originalError on the top-level
    // path, lastLlmErrorMessage on the HR-01 mid-turn path — so the reply's
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
    });
    deps.logger.warn(
      { step: "degraded-reply", errorKind: "resource" as const, hint: "context_exhausted synthesized reply" },
      "CWF-05: context_exhausted — synthesized honest reply delivered",
    );
  }
  if (effectiveFinishReason === "loop_detected") {
    // F-15: the loop-guard halted a no-progress repeat (e.g. a tool that kept
    // failing/being blocked). APPEND an honest note when partial text exists,
    // REPLACE when the turn produced none (a pure tool-loop) — never a silent empty.
    const existing = (result.response ?? "").trim();
    const loopTraceId = tryGetContext()?.traceId;
    const loopReply = buildLoopDetectedReply({
      ...(loopTraceId !== undefined ? { traceId: loopTraceId } : {}),
      language: replyLanguage,
    });
    result.response = existing.length > 0 ? `${existing}\n\n${loopReply}` : loopReply;
    deps.logger.warn(
      { step: "degraded-reply", errorKind: "resource" as const, hint: "loop_detected synthesized reply" },
      "CWF-05: loop_detected — synthesized honest reply delivered",
    );
  }

  // SD3 (Phase 158): resolve capability-gated verification default before the gate check.
  // modelProfile is not in scope at this layer — use a synthetic profile derived from
  // capabilityClass (same approach as buildSyntheticCriticDeps; capabilityClass is threaded
  // since Phase 155 via PostExecutionParams). Only the isSmallNano distinction
  // (scaffoldLevel === "max") is load-bearing for resolveScaffoldDefaults' SD3 decision —
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
  // WR-01: criticModel is the DISTINCT CHEAP verification model the cost-gate gated
  // on (keyless-guarded). The critic must run on it, NOT the agent primary — running
  // the primary would invert the cost-gate's "never doubles local-CPU latency" rationale.
  // Falls back to the agent's (already-keyless, per shouldRunCritic) primary when undefined.
  const { verificationEnabled: effectiveVerification, criticModel } = resolveScaffoldDefaults(
    syntheticProfileForDefaults,
    config,
    { provider, agentModel: config.model, operationModels: config.operationModels ?? {} },
  );
  // CWF-05 guard: skip the verification critic entirely for degraded turns. The
  // CWF-05 block above wrote an honest synthesized reply into result.response; the
  // critic must never overwrite it with an LLM "not-verified" unmet-list derived
  // from a one-line error message. This guard makes the degraded reply authoritative
  // regardless of future edits to the synthesized strings (no implicit string-match
  // dependency on isCompletionClaim patterns).
  const isDegradedTurn =
    effectiveFinishReason === "output_starved" ||
    effectiveFinishReason === "context_exhausted" ||
    effectiveFinishReason === "loop_detected" ||
    effectiveFinishReason === "narration_stall";
  if (!isDegradedTurn && shouldRunCritic({ // R4: critic hook (WR-02: keyless-only gate)
    capabilityClass, config, executionPlanRef, provider,
    logger: deps.logger,
    effectiveEnabled: effectiveVerification, // SD3: pre-resolved via cost-gate
  })) {
    const { deps: cd, maxRetries: mr } = buildSyntheticCriticDeps({
      capabilityClass,
      provider: criticModel?.provider ?? provider, // WR-01: resolved cheap critic, not agent primary
      modelId: criticModel?.modelId ?? config.model,
      agentId: effectiveAgentId,
      canaryToken: generateCanaryToken(formattedKey, executionId), // WR-03: formatted key, not String(obj)
      minResponseChars: config.verification?.minResponseChars ?? 200, maxRetries: config.honesty?.maxCriticRetries ?? 2,
      clock: deps.clock, logger: deps.logger, eventBus: deps.eventBus,
    });
    const cr = await runVerificationCritic({ response: result.response ?? "", plan: executionPlanRef.current, deps: cd, maxRetries: mr });
    if (cr.verdict !== "verified" && cr.verdict !== "skipped") { result.response = cr.response; }
  }

  // Map the settled finishReason to the terminal endReason ONCE via the single
  // authoritative table (END_REASON_MAP). This SAME mapped value drives BOTH the
  // persisted sessionEnd.endReason (F1, in buildSessionEndMetadata, which re-maps
  // the identical effectiveFinishReason through the identical table) AND the
  // rollup's `degraded` flag below — so a reason that maps to a non-success
  // endReason (e.g. loop_detected / session_reset → "error") can never record
  // degraded:false alongside it (Phase 152 CR-01). No second closed reason set.
  const endReason = END_REASON_MAP[effectiveFinishReason] ?? "error";

  // Compute the per-session health rollup ONCE at the chokepoint (D5/F1/F2).
  // degraded is derived from the mapped endReason (≠ "success"); the same record
  // feeds BOTH sinks below — the sessionEnd metadata (F1) and the session:summary
  // event (F2) — so persist and emit never diverge.
  const sessionHealthRollup = buildSessionHealthRollup(bridgeResult, endReason);

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
      clock: deps.clock,
      rollup: sessionHealthRollup,
    }));
  } catch { /* fire-and-forget */ }

  // F2: announce session:summary once. Own fire-and-forget guard inside
  // emitSessionSummary — a throwing in-process listener must not abort teardown
  // (OQ3). The event carries ids + counts + topErrorKinds + source:"runtime"
  // (Phase 159 A1/A2) PLUS the mapped endReason (the named degradation cause,
  // QT2/QT3) so the row feeds the fleet aggregate AND its degradedByCause rollup.
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
      clock: deps.clock,
    },
  );

  // Check onboarding completion after execution
  // Fire-and-forget: triggers getWorkspaceStatus which records
  // onboardingCompletedAt when IDENTITY.md Name is filled or
  // BOOTSTRAP.md is deleted. Does not block response delivery.
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
  const skipMemoryForOperation =
    operationType != null && MEMORY_SKIP_OPERATIONS.has(operationType);

  // Layer 0: silent sentinels never enter memory. Idempotent under
  // stripReplyTags + trim per @comis/shared silent-tokens.ts JSDoc
  // contract. The check happens BEFORE the operationType + content-hash
  // dedup gates so that even when the response would otherwise pass those
  // gates, a `NO_REPLY` / `HEARTBEAT_OK` / `[SILENT]` sentinel is rejected
  // from memory persistence.
  const isSilent = !!(deps.memoryPort && result.response && msg.text && isSilentResponse(result.response));
  if (isSilent) {
    deps.logger.debug(
      { agentId: effectiveAgentId, sessionKey: formattedKey, hint: "Silent-sentinel response (NO_REPLY / HEARTBEAT_OK / [SILENT]) skipped from paired memory" },
      "Paired memory skipped: silent-sentinel response",
    );
  } else if (
    deps.memoryPort &&
    result.response &&
    msg.text &&
    !skipMemoryForOperation &&
    shouldStorePairedMemory(msg.text, result.response)
  ) {
    const now = deps.clock.now();
    const pairedContent = buildPairedMemoryContent(msg.text, result.response);

    if (isDuplicatePairedMemory(pairedContent, effectiveAgentId, deps.clock)) {
      deps.logger.debug(
        { agentId: effectiveAgentId, sessionKey: formattedKey },
        "Paired memory skipped: duplicate content within dedup window",
      );
    } else {
      // SECURITY (FIX 1): route the paired-conversation write through the
      // secret-egress firewall (validateMemoryWrite) — the SAME guard the
      // derived-memory writes (user-representation/relationship/consolidation)
      // apply. A user-pasted secret is REJECTED (verdict critical) so it is
      // never persisted to the memories table nor embedded into the vector index
      // (recallable across sessions). The skip is content-free. Non-secret
      // content stores unchanged. Helper is exported for unit-testing the gate.
      await storePairedConversationMemory({
        memoryPort: deps.memoryPort,
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

  // LCD afterTurn ingest (Phase 128 dag-mode write-path, A1). Mirrors the
  // memoryPort persist above: gated on `deps.contextStore` presence, off the
  // injected clock, non-fatal (ingestTurn wraps each append per-entry). The
  // body lives in lcd-ingest.ts (this file is over the 800L cap).
  //
  // FIX A: the block is gated on BOTH the store's presence AND the effective
  // engine being dag (`shouldRunLcdStorePasses`). The daemon injects the store
  // unconditionally, but ONLY dag mode READS it (the assembler's dag branch +
  // the ctx_* tools). A pipeline agent that wrote `lcd_messages` and fired
  // leaf/condense LLM summarization here paid pure wasted cost + latency because
  // nothing reads the store in pipeline mode. The version decision mirrors the
  // read side exactly (absent contextEngine ⇒ dag, matching the executor's
  // `ContextEngineConfigSchema.parse({})` default); only an explicit
  // `version: "pipeline"` skips the passes. See shouldRunLcdStorePasses.
  //
  // Idempotency (T-128-09): the high-water mark `getMessages(conversationId).length`
  // is the persisted count (survives restarts); the delta `live.slice(persisted)`
  // appends only the not-yet-persisted tail. A retry with no new messages appends
  // nothing. `ingestTurnGuarded` also guards the WR-01 shrink edge: if a heal ever
  // reassigns `state.messages` SHORTER than the store, it skips the append and
  // WARNs (errorKind `precondition`) rather than slicing past the end and either
  // persisting nothing forever or colliding on the unique (conversationId, seq)
  // index.
  if (deps.contextStore && shouldRunLcdStorePasses(config)) {
    const conversationId = formattedKey;
    const scope: ContextStoreScope = {
      conversationId,
      // The scope's SECURITY columns must never be empty (T-128-08). tenantId
      // prefers the explicitly-threaded deps.tenantId, falling back to the
      // session key's tenant (the same source the memoryPort persist uses).
      tenantId: deps.tenantId ?? sessionKey.tenantId,
      agentId: effectiveAgentId,
      sessionKey: formattedKey,
    };
    // The live canonical AgentMessage[] (pi-executor.ts:1118 reads the same
    // ref). Typed as unknown on AgentSession — no public SDK type for it.
    const live =
      ((session.agent as unknown as { state?: { messages?: unknown[] } }).state?.messages ??
        []) as Parameters<typeof ingestTurnGuarded>[2];
    const store = deps.contextStore;

    // R3 (132-04): route the live ingest write through the per-conversation
    // single-flight serializer so it shares the queue with the (prior turn's)
    // deferred compaction and can never interleave on (conversation_id, agent_id,
    // tenant_id, seq) / the context_items ordinals (Pitfall 2). ingestTurnGuarded
    // is NON-FATAL (skip+WARN); on a fail-closed rollover (an ambiguous/malformed
    // scope) it invokes onFailClosed → we emit a content-free context:dag_degraded
    // (reason fail_closed_rollover) so the refusal is observable on the bus. We
    // AWAIT this slot so the ingest's seq slot is claimed in order before the turn
    // returns (the ingest write is a fast synchronous append — it does not block
    // on the deferred compaction, which rides the same queue BEHIND it).
    const ingestStart = deps.clock.now();
    await store.runOnConversation(conversationId, () =>
      ingestTurnGuarded(
        store,
        scope,
        live,
        deps.clock.now(),
        deps.logger,
        () => {
          deps.eventBus.emit("context:dag_degraded", {
            conversationId: scope.conversationId,
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            reason: "fail_closed_rollover",
            durationMs: Math.max(0, deps.clock.now() - ingestStart),
            timestamp: deps.clock.now(),
          });
        },
        // Phase 160 I1: the WR-01 live/store-divergence skip emits a content-free
        // context:dag_degraded so the divergence persists as a health_signal row
        // (queryable by the fleet lens) instead of being a Pino-only WARN.
        () => {
          deps.eventBus.emit("context:dag_degraded", {
            conversationId: scope.conversationId,
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            reason: "live_store_divergence",
            durationMs: Math.max(0, deps.clock.now() - ingestStart),
            timestamp: deps.clock.now(),
          });
        },
        // RR6 (Phase 164): a detected epoch re-base that continues emits a distinct
        // content-free context:dag_degraded reason:"session_rebase" (INFO — a correct
        // continuation, not degradation) so operators can tell "continued after
        // restart/JSONL-housekeeping" from "skipped due to corruption".
        () => {
          deps.eventBus.emit("context:dag_degraded", {
            conversationId: scope.conversationId,
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            reason: "session_rebase",
            durationMs: Math.max(0, deps.clock.now() - ingestStart),
            timestamp: deps.clock.now(),
          });
        },
      ),
    );

    // The two NON-FATAL afterTurn passes (T-129-18 / T-130-07 — never reject):
    // 129 (C1/C3) leaf threshold sweep, then 130 (C2) condense fold (AFTER the
    // leaf so the Nth leaf can immediately fold). Bodies live in the trigger
    // modules (this file is over the 800L cap); the calls here stay thin.
    // `summarizerGetter` is the (possibly snapshot-bound) deps getter — the
    // deferred path passes a model-snapshot-bound getter (WR-04), the inline path
    // reads the live session.
    const runDeferredPasses = async (
      summarizerGetter: typeof deps.getSummarizerDeps,
    ): Promise<void> => {
      await runLeafPassAfterTurn({
        store,
        scope,
        contextEngine: config.contextEngine,
        getSummarizerDeps: summarizerGetter,
        // SUMW-02: the turn's budget window — the utilization denominator (a
        // captured number; dispose-safe on the deferred path).
        budgetWindowTokens: params.budgetWindowTokens,
        now: deps.clock.now(),
        // O1: a clock CALLABLE so the trigger times the pass with two reads
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
        // SUMW-02: same denominator as the leaf pass (one window truth) — also
        // feeds the condense pressureHigh hard-fanout gate.
        budgetWindowTokens: params.budgetWindowTokens,
        now: deps.clock.now(),
        // O1: clock CALLABLE for the two-read pass timing (entry → emit).
        nowFn: () => deps.clock.now(),
        logger: deps.logger,
        eventBus: deps.eventBus,
        // Phase 172-02 (DIST-01): the distillation hook seam. Fires after
        // appendCondensedSummary returns, passing summaryId/content/fallback/depth.
        // runDistillationPassAfterTurn is non-fatal end-to-end (mirrors the
        // condense pass's own T-130-07 wrapping). Only fires when the deps are
        // present (memoryPort required; other deps optional).
        onCondensed: deps.memoryPort
          ? (summaryId, content, fallbackFlag, condensedDepth) => {
              void runDistillationPassAfterTurn({
                summaryId,
                scope,
                content,
                fallback: fallbackFlag,
                depth: condensedDepth,
                now: deps.clock.now(),
                deps: {
                  memoryPort: deps.memoryPort!,
                  lcdStore: store,
                  embeddingEnqueue: deps.embeddingEnqueue,
                  // WR-03: a clock CALLABLE so the runner times its write boundary
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

    // C4 (132-04): gate on config.contextEngine.deferCompaction (default true).
    if (config.contextEngine?.deferCompaction ?? true) {
      // DEFERRED: enqueue the passes onto the SAME per-conversation serializer as
      // a DETACHED unit and do NOT await it — afterTurn returns once the ingest
      // slot is claimed + the compaction is enqueued, BEFORE the compaction write
      // runs (compaction never blocks the turn). The detached promise is wrapped
      // in suppressError so a rejection is logged, NEVER swallowed by a bare empty
      // catch (AGENTS.md §2.2).
      //
      // WR-04: snapshot the summarizer model identity NOW (session still alive)
      // and bind it into the getter the detached pass uses, so a pass that resolves
      // its deps AFTER the `session.dispose()` below never re-reads a torn-down
      // `session.agent.state.model`. The detached closure then depends only on the
      // captured snapshot + the daemon-owned store/auth/clock — all of which
      // outlive the session. (Lifetime contract, documented on
      // snapshotSummarizerDepsForDefer.)
      const deferredSummarizerGetter = snapshotSummarizerDepsForDefer(deps.getSummarizerDeps);
      const deferred = store.runOnConversation(conversationId, () =>
        runDeferredPasses(deferredSummarizerGetter),
      );
      suppressError(deferred, "deferred LCD compaction (R3 serializer)");
    } else {
      // INLINE: await the passes (the pre-132 deterministic path retained for
      // tests). Non-fatal — never surfaces an error to the live turn. Reads the
      // LIVE session model (no snapshot needed — the session is alive inline).
      await runDeferredPasses(deps.getSummarizerDeps);
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
