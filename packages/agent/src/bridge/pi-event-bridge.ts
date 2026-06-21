// SPDX-License-Identifier: Apache-2.0
/**
 * PiEventBridge: Maps pi-coding-agent AgentSessionEvent stream to Comis's
 * TypedEventBus events and enforces safety controls (step counter, budget guard).
 *
 * This is the core event translation layer between pi-coding-agent and Comis.
 * PiExecutor subscribes this bridge to the AgentSession and uses
 * getResult() to extract execution stats.
 *
 * @module
 */

import { shouldCompact } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  formatSessionKey,
  sanitizeLogString,
  fingerprint,
  systemNowMs,
  systemDateFrom,
  tryGetContext,
  redactValue,
  getToolMetadata,
  type SessionKey,
  type TypedEventBus,
  type MemoryPort,
  type MemoryEntry,
  type ModelOperationType,
  type ErrorKind,
  // Classification data for "Tool X not found" enrichment.
  // @comis/agent has no @comis/skills edge in the architecture graph
  // (agent = [shared, core, observability, scheduler]). Import ONLY from @comis/core.
  SUB_AGENT_TOOL_DENYLIST,
  toolReachableGroups,
} from "@comis/core";
import type { SessionTrajectoryHandleRegistry } from "@comis/observability";
import { buildTraceMetadata } from "@comis/observability";
import type { ComisLogger, SpendConfig } from "@comis/core";
import { suppressError } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { resolveModelPricing } from "@comis/core";
import { getCacheProviderInfo } from "../executor/cache-usage-helpers.js";
import { sanitizeMcpToolNameForAnalytics } from "../executor/cache-detection/index.js";
import { classifyError } from "../executor/error-classifier.js";
import { getSessionPromptSkillLocations } from "../executor/prompt-assembly.js";
import { suggestClosestTool } from "./tool-name-suggest.js";
import { toolFailureHint } from "./tool-failure-hint.js";
import type { ExecutionBudgetWindow } from "../budget/budget-guard.js";
import { checkSpendCeiling } from "../budget/budget-guard.js";
import type { CostTracker } from "../budget/cost-tracker.js";
import type { SpendAccumulator, SpendScope } from "../budget/spend-accumulator.js";
import type { StepCounter } from "../executor/step-counter.js";
import type { CircuitBreaker } from "../safety/circuit-breaker.js";
import type { ToolRetryBreaker } from "../safety/tool-retry-breaker.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import type { ContextWindowGuard, ContextUsageData } from "../safety/context-window-guard.js";
import type { ExecutionResult } from "../executor/types.js";
import type { ExecutionPlan } from "../planner/types.js";
import { extractPlanFromResponse } from "../planner/plan-extractor.js";
import { extractMcpServerName } from "@comis/shared";
import { classifyMcpErrorType, sanitizeToolArgs, extractErrorText } from "./bridge-event-handlers.js";

/**
 * Classify a tool failure's errorKind when the SDK reported `isError: true`
 * from the start (i.e., `toolSuccess === false` BEFORE the exitCode branch
 * flips it). Previously this branch left `toolErrorKind` undefined and the
 * `tool:executed` event payload lacked `errorKind` for the most common
 * failure path. Heuristic:
 *  - errorText starting with `[invalid_value]` / `[validation]` → validation
 *  - otherwise → dependency (external tool / MCP server returned an error)
 */
function classifyToolError(_toolName: string, errorText: string | undefined): ErrorKind {
  if (errorText && /^\[(invalid_value|validation)\]/.test(errorText)) return "validation";
  return "dependency";
}
import * as os from "node:os";
import * as pathModule from "node:path";
import { appendSessionIndexEntry } from "@comis/observability";
import { createBridgeMetrics, buildBridgeResult } from "./bridge-metrics.js";
import { drainAt, type DrainInflightState } from "../executor/drain-helper.js";
import { checkStepLimit, emitStepLimitAbort, checkLoopLimit, emitLoopAbort, checkBudgetLimit, emitBudgetAbort, checkBudgetTrajectory, checkContextWindow, emitContextAbort, checkCircuitBreaker, emitCircuitBreakerAbort, buildAbortRedirectMessage, checkSpendLimit, emitSpendAbort } from "./bridge-safety-controls.js";
import type { LoopStateReporter, SpendEmitHooks } from "./bridge-safety-controls.js";
import {
  computeThinkingBlockHashes,
  diffThinkingBlocksAgainstPersisted,
  WIRE_DIFF_HINT_FILE_MISSING,
  WIRE_DIFF_HINT_NOT_FOUND,
  type ThinkingBlockHash,
} from "./thinking-block-hash-invariant.js";
import { isContextExhaustionErrorMessage } from "../context-engine/errors.js";

// ---------------------------------------------------------------------------
// Module-level one-shot latches
// ---------------------------------------------------------------------------

/**
 * One-shot latch gating the SDK-breakdown notice. The notice
 * states that pi-ai does NOT expose `usage.cacheCreation.{shortTtl,longTtl}`
 * and that Comis estimates the per-TTL split via marker counting. Previously
 * the bridge logged this fact at DEBUG on every turn that wrote
 * cache tokens, stacking thousands of identical lines under normal load.
 *
 * The notice now fires exactly once per daemon process (at the first
 * `createPiEventBridge` construction) at INFO. The flag is module-scoped
 * so multiple bridge constructions across the daemon's lifetime share it.
 */
let _sdkBreakdownNoticeEmitted = false;

/**
 * Test-only hook to reset the one-shot SDK-breakdown notice flag. Used
 * by pi-event-bridge.test.ts to assert "fires exactly once" across
 * multiple bridge constructions within a single test. NOT a public API —
 * production code MUST NOT call this.
 */
export function __resetSdkBreakdownNoticeForTest(): void {
  _sdkBreakdownNoticeEmitted = false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool-not-found enrichment helpers
// ---------------------------------------------------------------------------

/** Matches the SDK's exact "Tool not found" error format (agent-loop.js:356):
 *  `Tool ${toolCall.name} not found` */
const NOT_FOUND_RE = /^Tool (\S+) not found$/;

/**
 * Classify a tool that was not found during sub-agent execution.
 * Uses SUB_AGENT_TOOL_DENYLIST and toolReachableGroups from @comis/core.
 * Returns enriched hint text that replaces the opaque SDK error.
 *
 * @comis/agent has no @comis/skills edge — do NOT import TOOL_PROFILES from @comis/skills.
 */
function classifyUnreachableTool(toolName: string, activeGroups: string[]): string {
  if (SUB_AGENT_TOOL_DENYLIST.has(toolName)) {
    return `Tool '${toolName}' is denied to ALL sub-agents — the parent must perform this step.`;
  }
  const broader = toolReachableGroups(toolName).filter((p) => !activeGroups.includes(p));
  // When no profile contains the tool, suggest only 'full' — 'supervisor' does not
  // contain generic tools like web_fetch/browser/sessions_spawn, so it would fail again.
  const suggestion = broader.length > 0 ? broader.join("' | '") : "full";
  return (
    `Tool '${toolName}' is outside this sub-agent's profile. ` +
    `Re-spawn with tool_groups:['${suggestion}'].`
  );
}

/** Per-call TTL split estimate, populated by requestBodyInjector's onPayload.
 *  Shared mutable object — written by the stream wrapper, read by the bridge. */
export interface TtlSplitEstimate {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** Dependencies required by the PiEventBridge. */
export interface PiEventBridgeDeps {
  eventBus: TypedEventBus;
  // CR-01: the per-execution budget window for THIS run (the shared per-agent
  // BudgetGuard is structurally assignable for the legacy single-execution path).
  // recordUsage accrues into this window; checkBudgetLimit reads it.
  budgetGuard: ExecutionBudgetWindow;
  costTracker: CostTracker;
  stepCounter: StepCounter;
  circuitBreaker: CircuitBreaker;
  /**
   * Per-execution loop detector (FIX #2). When present, the bridge breaks the
   * turn early with finishReason "loop_detected" once it reports a no-progress
   * / empty-turn loop — well before the step limit. Satisfied by the executor's
   * TurnLoopDetector.
   */
  turnLoopDetector?: LoopStateReporter;
  sessionKey: SessionKey;
  agentId: string;
  channelId: string;
  executionId: string;
  provider: string;
  model: string;
  /** Operation type for cost attribution. */
  operationType: ModelOperationType;
  logger: ComisLogger;
  /** Optional memory port for flushing compaction summaries to long-term memory. */
  memoryPort?: MemoryPort;
  /** Called with streaming text deltas for real-time response forwarding.
   *  kind='text' for visible text_delta events; kind='thinking' for thinking_delta events.
   *  Consumers must only accumulate kind==='text' — thinking deltas must never reach the channel. */
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
  /** Called when a safety control triggers -- PiExecutor uses this to call session.abort(). */
  onAbort?: () => void;
  /** Called when a `rate_limited` error fires inside the SDK's auto-retry loop --
   *  PiExecutor wires this to `session.abortRetry()` to cancel the SDK's
   *  internal retry. Rate-limit windows are per-minute (longer than the SDK's
   *  ~30s retry budget), so retrying within the window cannot succeed.
   *  Non-`rate_limited` retryable errors (overloaded, network, 5xx) bypass this
   *  hook -- the SDK's normal retry-with-backoff proceeds. */
  onAbortRetry?: () => void;
  /** SDK context usage accessor -- returns live context metrics from AgentSession. */
  getContextUsage?: () => ContextUsageData | undefined;
  /** Context window guard for percent-based warn/block checks. */
  contextGuard?: ContextWindowGuard;
  /** Compaction settings for shouldCompact() check. When provided, compaction:recommended events fire. */
  compactionSettings?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Optional provider health monitor for cross-agent failure aggregation. */
  providerHealth?: ProviderHealthMonitor;
  /** Called when a tool execution completes -- used by pi-executor to reset prompt timeout. */
  onToolExecutionEnd?: () => void;
  /** Returns current model ID for per-turn pricing resolution. Updated on manual /model switch. */
  getCurrentModel?: () => string;
  /**
   * Phase 177 — the daemon-wide spend accumulator (the dollars kill-switch
   * enforcement state). The per-agent bridge holds a REFERENCE to the single
   * daemon-wide instance (Pitfall 4). When ABSENT (flags off / not wired) the
   * entire spend path is a no-op — the healthy path is byte-identical.
   */
  spendAccumulator?: SpendAccumulator;
  /**
   * The resolved `(tenant, agent)` this bridge reserves spend against — derived
   * at the daemon composition root via `parseFormattedSessionKey` (L1). Required
   * whenever `spendAccumulator` is present.
   */
  spendScope?: SpendScope;
  /** `observability.spend.*` — drives the perTurnMax reservation, the action gate, and the pricing gate. */
  spendConfig?: SpendConfig;
  /** Callback to record cache reads for adaptive retention escalation. */
  onCacheReads?: (tokens: number) => void;
  /** Callback to record a completed turn with cache write token count.
   *  Enables adaptive retention fast-path escalation for large system prompts. */
  onTurnWithCacheWrite?: (cacheWriteTokens: number) => void;
  /** Callback fired when cache break detection finds a break event.
   *  Receives the full CacheBreakEvent. PiExecutor uses this to trigger
   *  coordinated reset on server eviction. */
  onCacheBreakDetected?: (event: import("../executor/cache-detection/index.js").CacheBreakEvent) => void;
  /** Decrement eviction cooldown counter each turn (unconditional). */
  decrementEvictionCooldown?: () => void;
  /** Callback to record per-turn cache savings for cost gate evaluation.
   *  Receives the per-turn savedVsUncached value (can be negative). */
  onTurnCacheSavings?: (savedUsd: number) => void;
  /** Registry of per-tool truncation metadata populated by stream wrappers.
   *  Returns truncation info for a tool call, or undefined if no truncation occurred. */
  getTruncationMeta?: (toolCallId: string) => { truncated: boolean; fullChars: number; returnedChars: number } | undefined;
  /** Mutable reference to the SEP execution plan for step tracking. */
  executionPlan?: { current: ExecutionPlan | undefined };
  /** SEP config for mid-loop plan extraction. Required when executionPlan is provided. */
  sepConfig?: {
    maxSteps: number;
    minSteps: number;
  };
  /** Original user message text (truncated) for SEP plan request field. */
  sepMessageText?: string;
  /** Execution start timestamp for SEP timing metrics. */
  sepExecutionStartMs?: number;
  /** Cache break detection callback. Returns CacheBreakEvent if break detected. */
  checkCacheBreak?: (input: { sessionKey: string; provider: string; cacheReadTokens: number; cacheWriteTokens: number; totalInputTokens: number; apiError?: boolean }) => import("../executor/cache-detection/index.js").CacheBreakEvent | null;
  /** Called on each turn_end with the per-turn usage.input tokens.
   *  Used by pi-executor to update the TokenAnchor for API-grounded estimation. */
  onTurnUsage?: (inputTokens: number) => void;
  /** Per-execution token budget cap for trajectory warning. Omit to disable trajectory analysis. */
  perExecutionBudgetCap?: number;
  /** Mutable ref for budget warning state shared with prompt runner. */
  budgetWarningRef?: { current: boolean };
  /** Tool retry breaker for recording tool call success/failure. */
  toolRetryBreaker?: ToolRetryBreaker;
  /** Graph ID for cache write signal emission. Set only for graph subagents. */
  graphId?: string;
  /** Graph node ID for cache write signal emission. Set only for graph subagents. */
  nodeId?: string;
  /** Shared mutable TTL split estimate. Populated by request-body-injector
   *  on each API call, read by the bridge on turn_end for per-TTL cost calculation.
   *  The bridge normalizes these estimates against the actual SDK-reported cacheWriteTokens. */
  ttlSplit?: TtlSplitEstimate;
  /** Pre-call hook: invoked once per `turn_start` event, BEFORE pi-ai
   *  serializes the next request. The closure (defined in pi-executor) walks
   *  `session.agent.state.messages`, asserts the cross-turn hash-invariant
   *  per assistant message with a stored hash entry (logs ERROR on mutation),
   *  then runs the canonical-restore helper against the canonical store
   *  (heals any mutation in-place by writing the result back to
   *  `session.agent.state.messages`). The return value is unused by the
   *  bridge -- the side effect is the heal write-back. Optional: when
   *  omitted, both the diagnostic and the heal are silently disabled
   *  (e.g., unit tests that don't drive a full agent session). */
  getSessionMessages?: () => ReadonlyArray<unknown> | undefined;
  /** Wire-edge diagnostic: returns the absolute path to the per-session JSONL
   *  on disk. The bridge invokes this only when the LLM error path detects
   *  the signed-replay rejection signature, then diff'd against the persisted
   *  canonical to surface mutation that occurred AFTER the bridge's
   *  restoration hook. Optional — when omitted, the wire-edge diagnostic is
   *  a silent no-op. */
  getSessionJsonlPath?: () => string | null;
  /**
   * Session-scoped trajectory registry. When present, the bridge's
   * `agent_start` case consults `hasSessionStartedBeenEmitted(formattedKey)`
   * to suppress per-turn `session:started` re-emits (`session.started`
   * fires once per session, NOT per pi-mono turn). The bridge itself is per-turn; the registry survives every
   * turn so the latch lives there.
   *
   * When omitted (legacy/test callers), the bridge falls back to the
   * legacy unconditional emit so existing harnesses keep working.
   */
  trajectoryRegistry?: SessionTrajectoryHandleRegistry;
  /**
   * Snapshot passed into `trace.metadata` once per session, immediately
   * after `session.started`. Contains harness/model/config/plugins/skills/
   * prompting/redaction. When omitted, the trace.metadata lifecycle envelope
   * is skipped for this session.
   *
   * The config field is run through `sanitizeForPersistence` inside
   * `buildTraceMetadata` — raw config may contain secrets.
   */
  runtimeSnapshot?: import("@comis/observability").TraceMetadataParams;
  /**
   * Comis data root directory (e.g. `~/.comis`). Used by the session-index
   * writer to derive the date-rolled JSONL path
   * `<dataDir>/logs/session-index.YYYY-MM-DD.jsonl`.
   *
   * When omitted, defaults to `~/.comis` via `os.homedir()` so existing
   * callers (tests, legacy harnesses) work without changes — their
   * session-index writes land in the production data directory.
   * Production wiring: pi-executor threads `deps.sessionBaseDir`'s
   * ancestor (`~/.comis`) here.
   */
  dataDir?: string;
  /**
   * Operator home directory (`$HOME`) for `$HOME`→`~` path compaction at
   * the tool-event emit sites. When supplied, the redacted `params` on
   * `tool:started` / `tool:executed` compact absolute home paths to `~` for ALL
   * bus consumers (delivery-tracer, trajectory writers, plan-stream) — not only
   * the activity renderer that re-redacts with its own injected homeDir. When
   * omitted, secret/PII/absolute-path masking still applies; only the
   * home-prefix compaction is skipped.
   */
  homeDir?: string;
  /** Active tool group names for the sub-agent's profile ceiling.
   *  When provided, "Tool X not found" errors in tool_execution_end are
   *  enriched with delegation routing hints. Omit for top-level
   *  agents where all tools are reachable. */
  activeToolGroups?: string[];
  /** Names of the tools actually assembled for this turn. When provided,
   *  "Tool X not found" errors are enriched with a `Did you mean "<closest>"?`
   *  hint (F-13) so a small model that hallucinated a tool name (e.g.
   *  `mcp__memory_manage--delete` for the builtin `memory_manage`) self-corrects
   *  instead of looping. Fires for top-level AND sub-agents. */
  allToolNames?: readonly string[];
}

/** Estimated cost payload for a timed-out API request. */
export interface GhostCostEstimate {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Result of createPiEventBridge -- a listener function and a result accessor. */
export interface PiEventBridgeResult {
  /** Event listener to subscribe to AgentSession events. */
  listener: (event: AgentSessionEvent) => void;
  /** Returns accumulated execution stats (includes last known context usage and duration breakdown). */
  getResult: () => Partial<ExecutionResult> & { contextUsage?: ContextUsageData; textEmitted?: boolean; cumulativeLlmDurationMs?: number; cumulativeToolDurationMs?: number; cumulativeToolWallclockMs?: number; toolCallHistory?: string[]; lastActiveToolName?: string; lastLlmErrorMessage?: string; failedToolCalls?: number; failedTools?: string[]; toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string; errorKind?: ErrorKind }>; breakerTripCount?: number; turnCount?: number; lastStopReason?: string; cacheWrite5mTokens?: number; cacheWrite1hTokens?: number; sessionCostUsd?: number; sessionCacheSavedUsd?: number; thinkingTokens?: number; budgetWarningEmitted?: boolean };
  /** Accumulate estimated cost from a timed-out API request. */
  addGhostCost: (estimated: GhostCostEstimate) => void;
  /** ReadonlyMap views of the per-responseId hash store and canonical-snapshot
   *  store, both populated at stream-close in lockstep. The executor's
   *  pre-LLM-call closure reads both stores to drive the hash-invariant
   *  assertion plus the canonical restore helper. Returns ReadonlyMap views
   *  to preserve internal-state encapsulation -- the underlying `m` object is
   *  never exported. */
  getThinkingBlockStores: () => {
    hashes: ReadonlyMap<string, ReadonlyArray<ThinkingBlockHash>>;
    canonical: ReadonlyMap<string, ReadonlyArray<unknown>>;
  };
  /**
   * Expose the bridge-owned drain inflight gate so executor-post-execution
   * can fire an end-of-turn backstop drainAt sharing the same composite-key
   * gate map. Returns the live `BridgeMetricsState` slice -- callers MUST
   * treat this as read-mostly (the only mutation contract is `drainAt`
   * adding/removing entries).
   */
  getDrainState: () => DrainInflightState;
  /**
   * ATTR-01: a ReadonlySet view of the per-turn skill ids attributed this run
   * (skillNames whose `<location>` a `read` matched). The executor reads this
   * back at the postExecution call site and threads it onto the counts/ids-only
   * `memory:skill_used` write-back event. Read-only view — encapsulation
   * preserved (the underlying `m` object is never exported), mirroring
   * getThinkingBlockStores. Empty when no skill was attributed.
   */
  getUsedSkillIds: () => ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PiEventBridge that translates AgentSessionEvent to TypedEventBus
 * events and enforces safety controls.
 *
 * The returned listener handles all AgentSessionEvent types:
 * - message_update (text_delta) -> onDelta callback
 * - tool_execution_start -> start time tracking + DEBUG log (no event emission)
 * - tool_execution_end -> step counter + tool:executed event + safety check
 * - turn_end -> budget guard + cost tracker + observability:token_usage event
 * - compaction_start -> INFO log + compaction:started event
 * - compaction_end -> INFO/WARN log + compaction:flush event
 * - error (from turn_end with stopReason) -> circuit breaker failure
 */
export function createPiEventBridge(deps: PiEventBridgeDeps): PiEventBridgeResult {
  // Internal accumulation state (managed by bridge-metrics module)
  const m = createBridgeMetrics();

  // One-shot SDK-breakdown notice. Fires exactly once per
  // daemon process — the latch is module-scoped so multiple bridge
  // constructions (per-execution / test harnesses) share it. The notice
  // is INFO because it's a one-time operator-relevant fact, not a
  // recurring DEBUG signal.
  if (!_sdkBreakdownNoticeEmitted) {
    _sdkBreakdownNoticeEmitted = true;
    deps.logger.info(
      {
        errorKind: "dependency" as const,
        hint: "pi-ai SDK does not expose usage.cacheCreation per-TTL breakdown; Comis estimates the 5m/1h split via marker counting. Estimate accuracy may drift if cache-write composition skews from the marker-count assumption.",
      },
      "pi-ai SDK does not expose cacheCreation per-TTL breakdown; Comis estimates via marker counting",
    );
  }

  const listener = (event: AgentSessionEvent): void => {
    try {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Streaming text deltas
        // -----------------------------------------------------------------
        case "message_update": {
          const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
          if (ame && (ame.type === "text_delta" || ame.type === "thinking_delta")) {
            if (ame.type === "text_delta") {
              // Track that visible text was produced in some turn.
              // thinking_delta intentionally excluded — empty-final-turn detection
              // depends on this flag reflecting user-visible text only.
              m.textEmitted = true;
            }
            if (deps.onDelta && typeof ame.delta === "string") {
              try {
                // SA1: forward the SDK's typed delta kind so the consumer can gate
                // accumulation to kind==='text' only. thinking_delta is forwarded
                // with kind='thinking' so the consumer can still refresh the typing
                // TTL (proves the agent is alive during extended reasoning phases)
                // without the chain-of-thought reaching the channel.
                deps.onDelta(ame.delta, ame.type === "text_delta" ? "text" : "thinking");
              } catch {
                // Never abort agent due to streaming callback error
              }
            }
          }
          break;
        }

        // -----------------------------------------------------------------
        // Agent run lifecycle
        //
        // pi-mono emits `agent_start` at the top of each AgentSession.send()
        // and `agent_end` after the entire agentic loop completes. The
        // trajectory writer subscribes to the corresponding EventMap
        // events to bracket every run. session.started is the FIRST
        // trajectory record; session.ended is the LAST (plus the
        // trace.truncated sentinel from flushAndClose if dropped events
        // accumulated).
        // -----------------------------------------------------------------
        case "agent_start": {
          if (m.agentStartMs === undefined) {
            m.agentStartMs = systemNowMs();
          }
          // Suppress per-turn re-emits: session.started fires ONCE per
          // session (not per pi-mono turn). The bridge is
          // per-turn, so consult the session-scoped trajectoryRegistry
          // latch — it survives across turns and resets only when the
          // session is destroyed (or the daemon restarts and rebuilds
          // the registry fresh). When the registry is absent
          // (legacy/test callers), fall through to the legacy
          // unconditional emit so existing harnesses keep working.
          const formattedKey = formatSessionKey(deps.sessionKey);
          if (deps.trajectoryRegistry?.hasSessionStartedBeenEmitted(formattedKey) === true) {
            break;
          }
          // channelType lives on RequestContext (AsyncLocalStorage); fall
          // back to "" when running outside a scope (e.g., direct test
          // invocation). Trajectory consumers tolerate the empty case.
          const channelType = tryGetContext()?.channelType ?? "";
          deps.eventBus.emit("session:started", {
            agentId: deps.agentId,
            sessionKey: formattedKey,
            traceId: tryGetContext()?.traceId ?? deps.executionId,
            channelType,
            channelId: deps.channelId,
            timestamp: systemNowMs(),
          });
          deps.trajectoryRegistry?.markSessionStarted(formattedKey);
          // Append session_started to the date-rolled session index JSONL.
          // Co-located with the session:started bus emit + trajectoryRegistry
          // latch so session_started fires exactly once per session (same
          // guard).
          appendSessionIndexEntry(
            deps.dataDir ?? pathModule.join(os.homedir(), ".comis"),
            {
              traceSchema: "comis-session-index",
              schemaVersion: 1,
              event: "session_started",
              ts: systemDateFrom(systemNowMs()).toISOString(),
              sessionId: formattedKey,
              sessionKey: formattedKey,
              channelType,
              channelId: deps.channelId ?? "",
              agentId: deps.agentId,
              traceIds: [deps.executionId],
              source: "runtime" as const, // D9 provenance stamp (production rows)
            },
          );
          // Emit the trace.metadata lifecycle envelope directly via the
          // recorder — no bus event source.
          if (deps.runtimeSnapshot !== undefined) {
            const recorder = deps.trajectoryRegistry?.getRecorder?.(formattedKey);
            if (recorder != null) {
              recorder.recordEvent("trace.metadata", buildTraceMetadata(deps.runtimeSnapshot));
            }
          }
          break;
        }

        case "agent_end": {
          // session:ended is NO LONGER emitted from agent_end —
          // "(session) ended" is a session-destroy semantic, not
          // per-turn. The emit moved to
          // ComisSessionManager.destroySession. Per-turn duration metrics
          // are surfaced via observability:token_usage → model.completed,
          // which already carries durationMs.
          //
          // We preserve the m.agentStartMs / m.lastStopReason reads since
          // other accumulators may rely on these — only the eventBus
          // emit is removed.
          const startMs = m.agentStartMs ?? systemNowMs();
          const durationMs = systemNowMs() - startMs;
          void durationMs;
          void (m.lastStopReason ?? "end");
          break;
        }

        // -----------------------------------------------------------------
        // Tool execution lifecycle
        // -----------------------------------------------------------------
        case "tool_execution_start": {
          const toolEvent = event as { toolName: string; toolCallId: string; args?: unknown };
          m.toolStartTimes.set(toolEvent.toolCallId, systemNowMs());
          m.toolCallHistory.push(toolEvent.toolName);
          m.lastActiveToolName = toolEvent.toolName;

          // Build truncated args preview for observability (1000 chars max, sanitized)
          let argsPreview: string | undefined;
          if (toolEvent.args !== undefined) {
            try {
              const raw = JSON.stringify(toolEvent.args);
              const sanitized = sanitizeLogString(raw);
              argsPreview = sanitized.length > 1000 ? sanitized.slice(0, 1000) + "…" : sanitized;
            } catch {
              argsPreview = "[unserializable]";
            }
          }

          // Store sanitized arg snapshot for failure correlation
          if (toolEvent.args !== undefined && typeof toolEvent.args === "object" && toolEvent.args !== null) {
            try {
              m.toolArgSnapshots.set(toolEvent.toolCallId, sanitizeToolArgs(toolEvent.args as Record<string, unknown>));
            } catch {
              // Never fail execution due to arg snapshot error
            }
          }
          // Stash the RAW args so the paired tool:executed emit can forward
          // redacted params. Redaction happens at the emit, not here.
          if (toolEvent.args !== undefined) {
            m.toolRawArgs.set(toolEvent.toolCallId, toolEvent.args);
          }

          // Thread redacted params + an `action` field onto tool:started.
          // redactValue is the only sanctioned path — secrets/PII/absolute paths
          // are masked BEFORE the emit crosses the bus. homeDir (when wired)
          // compacts $HOME→~ for all consumers, not just the re-redacting
          // activity renderer.
          const startedRedactedParams = redactValue(toolEvent.args, { homeDir: deps.homeDir }).value as
            | Record<string, unknown>
            | undefined;
          const startedAction =
            startedRedactedParams && typeof startedRedactedParams.action === "string"
              ? startedRedactedParams.action
              : undefined;

          deps.eventBus.emit("tool:started", {
            toolName: toolEvent.toolName,
            toolCallId: toolEvent.toolCallId,
            timestamp: systemNowMs(),
            agentId: deps.agentId,
            sessionKey: formatSessionKey(deps.sessionKey),
            traceId: tryGetContext()?.traceId ?? deps.executionId,
            ...(startedRedactedParams !== undefined && { params: startedRedactedParams }),
            ...(startedAction !== undefined && { action: startedAction }),
          });

          deps.logger.debug(
            { toolName: toolEvent.toolName, ...(argsPreview && { argsPreview }) },
            argsPreview ? `Tool execution started: ${toolEvent.toolName}(${argsPreview})` : "Tool execution started",
          );
          break;
        }

        case "tool_execution_end": {
          const endEvent = event as {
            toolCallId: string;
            toolName: string;
            result: unknown;
            isError: boolean;
          };

          deps.stepCounter.increment();

          // Calculate duration from tracked start time
          const startTime = m.toolStartTimes.get(endEvent.toolCallId);
          const durationMs = startTime ? systemNowMs() - startTime : 0;
          m.toolStartTimes.delete(endEvent.toolCallId);
          // Clear active tool once completed (no tool in-flight after this point)
          if (m.lastActiveToolName === endEvent.toolName) m.lastActiveToolName = undefined;
          m.cumulativeToolDurationMs += durationMs;
          m.turnToolDurationMs += durationMs;

          // Determine success: SDK isError flag + exit code inspection.
          // Tools like exec never throw — they return { details: { exitCode: N } }.
          // The SDK only sets isError on thrown exceptions, so we also inspect the result.
          let toolSuccess = !endEvent.isError;
          let toolErrorKind: ErrorKind | undefined;
          // D1 failure-classification provenance (P1): assigned AT each
          // mutation point (never a post-hoc switch — by the WARN site
          // toolSuccess is just `false` and the source is lost). transportOk
          // is derived from classifiedFailureBy at the sinks (sdk_iserror ⇒
          // transport failed ⇒ false; exit-code/detector/mcp-content ⇒ true).
          let classifiedFailureBy:
            | "sdk_iserror"
            | "exit_code"
            | "failure_detector"
            | "mcp_classifier"
            | undefined;
          let matchedRule: string | undefined;
          let matchedToken: string | undefined;
          let httpStatus: number | undefined;
          // transportOk tracks the SDK/transport signal itself: false ONLY when
          // the SDK reported isError (the call/transport failed). An exit-code,
          // detector, or MCP-content failure means the call RETURNED and the
          // content was a failure → transportOk stays true. This is the
          // self-evident-misclassification tell: a transportOk:true failure
          // with classifiedFailureBy:'failure_detector' means "we matched a
          // structured field, the transport was fine". (OQ A3 — derived from
          // the flip source, NOT the refined classifiedFailureBy label, so the
          // A1 MCP-refinement of an SDK-isError failure stays transportOk:false.)
          const transportOk = !endEvent.isError;
          // :591 — SDK isError flip (the transport/call itself errored).
          if (!toolSuccess) classifiedFailureBy = "sdk_iserror";
          // Tool metadata, read ONCE — gates the exit-code heuristic AND the failureDetector hook.
          const toolMeta = getToolMetadata(endEvent.toolName);
          // The exit-code heuristic flags a non-zero `details.exitCode` as a tool failure — but
          // ONLY when the exit code is the TOOL's own outcome (exec/process). The terminal
          // driver's perception tools (status/read/wait) surface the DRIVEN SESSION's exit code
          // as an informational datum (`exitCodeIsDrivenSession`); a driven program exiting
          // non-zero there does NOT mean the tool failed — the tool SUCCEEDED in reporting it.
          // Skip flagged tools (real-VPS 2026-06-16: a bash `exit 1` misclassified a perfectly
          // successful terminal_session_status as success:false / classifiedFailureBy:exit_code).
          if (toolSuccess && endEvent.result != null && toolMeta?.exitCodeIsDrivenSession !== true) {
            const details = (endEvent.result as Record<string, unknown>)?.details;
            if (
              details != null &&
              typeof (details as Record<string, unknown>).exitCode === "number" &&
              (details as Record<string, unknown>).exitCode !== 0
            ) {
              toolSuccess = false;
              toolErrorKind = "dependency";
              classifiedFailureBy = "exit_code"; // exec non-zero exit — call returned, content failed
            }
          }

          // §16.10: run the tool's failureDetector hook BEFORE the
          // tool:executed emit, so observability never sees the raw result.
          // The detector is pure + synchronous; it lets a tool flag a
          // logically-failed result the SDK reported as success. A THROWING
          // detector is caught — the original success is preserved and a WARN
          // is logged with errorKind:"internal" (the result is never leaked).
          // NOTE: this wires the hook SEAM; per-tool detector bodies are
          // authored separately.
          {
            const detector = toolMeta?.failureDetector;
            if (detector !== undefined) {
              try {
                const detected = detector(endEvent.result, endEvent.isError);
                if (detected !== false && detected !== undefined) {
                  // D2 single-chokepoint no-false-flag guard (P2): the codified
                  // c53ab0f invariant, generalized to ALL detectors here at the
                  // ONE consumption site (not per-detector, so it also covers
                  // future detectors). A status:200 + no-string-error result is
                  // a structural success and must NEVER be flagged a failure.
                  const r = endEvent.result;
                  const looksLikeSuccess =
                    r !== null &&
                    typeof r === "object" &&
                    (r as { status?: unknown }).status === 200 &&
                    typeof (r as { error?: unknown }).error !== "string";
                  if (looksLikeSuccess) {
                    // Refuse the flag (preserve success) + observable WARN.
                    // The guard NEVER aborts the turn — it mirrors the
                    // catch below, which also preserves the success outcome.
                    deps.logger.warn(
                      {
                        submodule: "bridge.failure-detector",
                        toolName: endEvent.toolName,
                        toolCallId: endEvent.toolCallId,
                        errorKind: "internal" as const,
                        hint: "failureDetector flagged a status:200/no-error result; refusing the flag (c53ab0f invariant). Fix the detector — it must classify off structured failure fields only.",
                      },
                      "failureDetector no-false-flag guard tripped",
                    );
                    // Do NOT flip toolSuccess; do NOT set classifiedFailureBy.
                  } else {
                    toolSuccess = false;
                    toolErrorKind =
                      (typeof detected === "object" && detected !== null
                        ? detected.errorKind
                        : undefined) ?? toolErrorKind ?? "internal";
                    classifiedFailureBy = "failure_detector";
                    if (typeof detected === "object" && detected !== null) {
                      // matchedRule/matchedToken are verdict provenance (P2).
                      // matchedToken is free-text untrusted tool output — it is
                      // sanitized+bounded at BOTH sinks (WARN + emit), never here.
                      matchedRule = detected.matchedRule;
                      matchedToken = detected.matchedToken;
                    }
                    const status = (r as { status?: unknown })?.status;
                    if (typeof status === "number") httpStatus = status;
                  }
                }
              } catch (detectorError: unknown) {
                deps.logger.warn(
                  {
                    submodule: "bridge.failure-detector",
                    toolName: endEvent.toolName,
                    toolCallId: endEvent.toolCallId,
                    err: detectorError,
                    errorKind: "internal" as const,
                    hint: "failureDetector threw; preserving the SDK-reported tool outcome. Fix the detector — it must be pure and never throw.",
                  },
                  "Tool failureDetector threw",
                );
                // Original success preserved (no mutation of toolSuccess).
              }
            }
          }

          // Retrieve stored args and extract error text for failure diagnostics
          const sanitizedArgs = m.toolArgSnapshots.get(endEvent.toolCallId);
          m.toolArgSnapshots.delete(endEvent.toolCallId); // Cleanup regardless of success/failure
          // Retrieve + clear the raw args stashed at tool_execution_start; redact
          // them into the tool:executed `params` field below.
          const rawArgsForParams = m.toolRawArgs.get(endEvent.toolCallId);
          m.toolRawArgs.delete(endEvent.toolCallId);

          let errorText: string | undefined;
          // resultBytes/resultDigest replace the raw body with a count + a
          // non-reversible 12-hex digest on the failure path (D1+D4) — the
          // body itself never crosses into the event/log.
          let resultBytes: number | undefined;
          let resultDigest: string | undefined;
          // Extract MCP server name for attribution
          const mcpServer = extractMcpServerName(endEvent.toolName);
          if (!toolSuccess) {
            errorText = extractErrorText(endEvent.result);
            const serialized =
              typeof endEvent.result === "string"
                ? endEvent.result
                : (() => {
                    try {
                      return JSON.stringify(endEvent.result) ?? "";
                    } catch {
                      return "";
                    }
                  })();
            resultBytes = serialized.length;
            resultDigest = fingerprint(serialized);
            // When toolSuccess was already false from the SDK's isError
            // flag (not flipped by an exitCode check), toolErrorKind is
            // still undefined here. Classify it so the downstream
            // tool:executed event carries an actionable errorKind for
            // trajectory + alerting consumers. For MCP tools, mirror the
            // dedicated MCP classifier into the closed ErrorKind union
            // (timeout → timeout, connection/transport → dependency,
            // everything else → classifyToolError fallback).
            if (toolErrorKind === undefined) {
              if (mcpServer !== undefined) {
                const mcpKind = classifyMcpErrorType(errorText);
                toolErrorKind = mcpKind === "timeout"
                  ? "timeout"
                  : (mcpKind === "connection" || mcpKind === "transport")
                    ? "dependency"
                    : classifyToolError(endEvent.toolName, errorText);
                // A1 precedence: the MCP classifier refines the sdk_iserror
                // flip when this is an MCP-namespaced tool. The flip source
                // is primary; the classifier that produced the errorKind wins
                // the label here.
                classifiedFailureBy = "mcp_classifier";
              } else {
                toolErrorKind = classifyToolError(endEvent.toolName, errorText);
                // Keep the flip source (sdk_iserror) — no MCP refinement.
                classifiedFailureBy ??= "sdk_iserror";
              }
            }
            // Enrich "Tool X not found" errors with delegation routing hints.
            // Only applied when activeToolGroups is provided (sub-agent context).
            // NOT_FOUND_RE is anchored (^…$) — only the exact SDK format triggers.
            // Skip enrichment for MCP-namespaced tools (mcp__<server>--<tool>) —
            // MCP tool reachability is governed by subAgentMcpTools policy, not by tool
            // profiles. Profile-widening hints are misleading for MCP tools. Preserve the
            // MCP-classified errorKind (dependency/timeout) rather than overwriting with "validation".
            if (errorText) {
              const notFoundMatch = NOT_FOUND_RE.exec(errorText);
              if (notFoundMatch) {
                const missingTool = notFoundMatch[1]!;
                // Sub-agent profile-widening hint (unchanged): only non-MCP names, only
                // when an activeToolGroups ceiling is in force.
                if (
                  deps.activeToolGroups &&
                  deps.activeToolGroups.length > 0 &&
                  extractMcpServerName(missingTool) === undefined
                ) {
                  errorText = classifyUnreachableTool(missingTool, deps.activeToolGroups);
                  toolErrorKind = "validation";
                }
                // F-13: "did you mean <closest>?" for a hallucinated tool name. Fires
                // for top-level AND sub-agents whenever a confident match exists — this is
                // exactly the path a small model needs when it guessed e.g.
                // `mcp__memory_manage--delete` for the builtin `memory_manage`.
                const suggestion = deps.allToolNames
                  ? suggestClosestTool(missingTool, deps.allToolNames)
                  : undefined;
                if (suggestion && suggestion !== missingTool) {
                  errorText = `${errorText} Did you mean "${suggestion}"? Call it by that exact name (builtin tools have no "mcp__" prefix).`;
                  toolErrorKind = "validation";
                }
              }
            }

            m.failedToolCount++;
            if (!m.failedToolNames.includes(endEvent.toolName)) {
              m.failedToolNames.push(endEvent.toolName);
            }

            // WARN log with error text + sanitized args
            // Include mcpServer and mcpErrorType for MCP tools
            deps.logger.warn(
              {
                toolName: endEvent.toolName,
                toolCallId: endEvent.toolCallId,
                durationMs,
                ...(errorText && { errorText: sanitizeLogString(errorText).slice(0, 1500) }),
                ...(sanitizedArgs && { toolArgs: sanitizedArgs }),
                ...(mcpServer !== undefined && { mcpServer, mcpErrorType: classifyMcpErrorType(errorText) }),
                errorKind: toolErrorKind ?? ("dependency" as const),
                // Name the bracketed `[error_code]` the errorText carries
                // (permission_denied / invalid_value / …) instead of a generic
                // "check errorText" — §2.7 name-which-knob (UC-C2, 2026-06-20).
                hint: toolFailureHint(errorText),
                // D1 provenance — assigned at the mutation points above.
                // matchedToken is untrusted tool output → sanitize+bound it
                // exactly like errorText; the rest are enum-like/digest/number.
                // transportOk = !endEvent.isError — it reflects whether the
                // transport DELIVERED a response, not which classifier labeled
                // the failure. It is false ONLY when the SDK reported a
                // transport/spawn failure (endEvent.isError), and STAYS false
                // even when the A1 MCP classifier later refines that isError
                // failure (relabeling classifiedFailureBy → "mcp_classifier").
                // Do NOT rewrite as (classifiedFailureBy !== "sdk_iserror") —
                // that flips the A1 case to transportOk:true and reopens the
                // c53ab0f MCP-transport-failure misclassification (see the
                // const above).
                ...(classifiedFailureBy !== undefined && { classifiedFailureBy }),
                transportOk,
                ...(httpStatus !== undefined && { httpStatus }),
                ...(matchedRule !== undefined && { matchedRule }),
                ...(matchedToken !== undefined && { matchedToken: sanitizeLogString(matchedToken).slice(0, 1500) }),
                ...(resultBytes !== undefined && { resultBytes }),
                ...(resultDigest !== undefined && { resultDigest }),
              },
              "Tool execution failed",
            );
          }

          // Record tool result in retry breaker for consecutive failure
          // tracking. recordResult returns a transition verdict at the
          // tool-wide counter-crossing edges (the breaker stays emitter-free,
          // D3) — capture it and emit the breaker event here, the bridge being
          // the sole holder of the event bus. Emit the two events as SEPARATE
          // string-literal calls in an if/else (NOT a ternary) so the
          // trajectory-event-types-known arch gate's EMIT_REGEX sees both names
          // and verifies their mappings (Pitfall 7).
          if (deps.toolRetryBreaker) {
            const transition = deps.toolRetryBreaker.recordResult(
              endEvent.toolName,
              (sanitizedArgs ?? {}) as Record<string, unknown>,
              toolSuccess,
              errorText,
            );
            if (transition) {
              // Count of tools executed so far this execution — the monotonic
              // per-execution seq Phase 153 orders the breakerTimeline on (A3).
              // Pushed at the m.toolExecResults.push below, so this is the
              // pre-push count (0 for the first tool).
              const seq = m.toolExecResults.length;
              if (transition.transition === "opened") {
                deps.eventBus.emit("tool:breaker_opened", {
                  toolName: transition.toolName,
                  consecutiveFailures: transition.consecutiveFailures,
                  errorTag: transition.errorTag,
                  reason: transition.reason,
                  seq,
                  timestamp: systemNowMs(),
                });
                // Count the trip for the session-health rollup (D5/F1). Only the
                // opened transition increments — a reset must not (the rollup
                // wants total trips this execution, not net breaker state).
                m.breakerTripCount++;
              } else {
                deps.eventBus.emit("tool:breaker_reset", {
                  toolName: transition.toolName,
                  reason: transition.reason,
                  seq,
                  timestamp: systemNowMs(),
                });
              }
            }
          }

          // Track all tool execution results
          m.toolExecResults.push({
            toolName: endEvent.toolName,
            success: toolSuccess,
            durationMs,
            ...(errorText && { errorText }),
            // Carry the closed-union errorKind (Phase 150 classification, set on
            // the failure path only) for the rollup's bounded topErrorKinds.
            ...(toolErrorKind !== undefined && { errorKind: toolErrorKind }),
          });

          // Capture outbound deliveries. The post-execution silent-sentinel
          // gate reads this per-turn log to make sentinel-aware decisions
          // about paired memory persistence. Reset at turn_start; bounded by
          // per-turn outbound message count.
          //
          // On the SAME tool_execution_end event, fire
          // `drainAt({agentId, channelType, channelId})` (the composite-keyed
          // inline-consumption drain). The gate state lives in bridge-metrics
          // (`m.drainInflightByKey`) so concurrent drains for the same
          // composite key collapse to a single in-flight Promise; concurrent
          // drains for different composite keys (multi-agent) run
          // independently. Failures inside drainAt are suppressed with WARN
          // logging -- the bridge's tool_execution_end propagation is NEVER
          // aborted by drain misbehavior.
          if (endEvent.toolName === "message" && toolSuccess && sanitizedArgs) {
            const action = typeof sanitizedArgs.action === "string" ? sanitizedArgs.action : "";
            if (action === "send" || action === "reply" || action === "attach") {
              const channelType = typeof sanitizedArgs.channel_type === "string" ? sanitizedArgs.channel_type : "";
              const channelId = typeof sanitizedArgs.channel_id === "string" ? sanitizedArgs.channel_id : "";
              m.outboundLog.push({
                action,
                channelType,
                channelId,
                timestamp: systemNowMs(),
              });

              // Composite-key drain at the bridge call site. The composite
              // (agentId, channelType, channelId) prevents cross-agent
              // contamination of the inline-consumption queue. Use the
              // message tool's own channel_type / channel_id when present
              // (the tool resolved them); fall back to the bridge's bound
              // deps.channelId when the tool args were sanitized away
              // (defensive). A drain trigger with empty channelType OR empty
              // channelId is skipped -- formatDrainKey would otherwise
              // produce ambiguous keys.
              //
              // drainAt is fire-and-forget: it spawns the drain Promise and
              // wraps it in suppressError internally. The kickoffDrain
              // wrapper below double-wraps the synchronous invocation in
              // suppressError (Promise.resolve adapter) so a (impossible)
              // synchronous throw inside drainAt cannot abort the bridge's
              // tool_execution_end propagation -- fire-and-forget contract /
              // non-fatal drain failure.
              const drainChannelType = channelType.length > 0 ? channelType : "";
              const drainChannelId = channelId.length > 0 ? channelId : deps.channelId;
              if (drainChannelType.length > 0 && drainChannelId.length > 0) {
                const kickoffDrain = Promise.resolve().then(() => {
                  drainAt(
                    {
                      agentId: deps.agentId,
                      channelType: drainChannelType,
                      channelId: drainChannelId,
                    },
                    { drainInflightByKey: m.drainInflightByKey },
                    deps.logger,
                  );
                });
                suppressError(kickoffDrain, "bridge tool_use_complete drainAt kickoff");
              }
            }
          }

          // Look up truncation metadata from stream wrapper registry
          const truncMeta = deps.getTruncationMeta?.(endEvent.toolCallId);

          // Forward redacted params (from the raw args stashed at
          // tool_execution_start). redactValue masks secrets/PII/absolute paths
          // before the emit crosses the bus. homeDir (when wired) compacts
          // $HOME→~ for all consumers, not just the activity renderer.
          const executedRedactedParams = redactValue(rawArgsForParams, { homeDir: deps.homeDir }).value as
            | Record<string, unknown>
            | undefined;

          deps.eventBus.emit("tool:executed", {
            toolName: endEvent.toolName,
            toolCallId: endEvent.toolCallId,
            durationMs,
            success: toolSuccess,
            timestamp: systemNowMs(),
            agentId: deps.agentId,
            sessionKey: formatSessionKey(deps.sessionKey),
            traceId: tryGetContext()?.traceId ?? deps.executionId,
            ...(executedRedactedParams !== undefined && { params: executedRedactedParams }),
            ...(toolErrorKind !== undefined && { errorKind: toolErrorKind }),
            ...(errorText && { errorMessage: sanitizeLogString(errorText).slice(0, 1500) }),
            ...(!toolSuccess && mcpServer !== undefined && { mcpServer, mcpErrorType: classifyMcpErrorType(errorText) }),
            ...(truncMeta && { truncated: truncMeta.truncated, fullChars: truncMeta.fullChars, returnedChars: truncMeta.returnedChars }),
            // D1 provenance (P1) — assigned at the mutation points above.
            // matchedToken is untrusted tool output and the payload feeds the
            // trajectory + cache-trace translators (Plan 06), so it MUST be
            // sanitized+bounded HERE TOO (identical to the WARN) — a raw token
            // would leak into the event stream. resultDigest/resultBytes/
            // httpStatus/classifiedFailureBy/matchedRule are digest/number/
            // closed-union → emitted as-is.
            ...(classifiedFailureBy !== undefined && { classifiedFailureBy }),
            ...(!toolSuccess && { transportOk }),
            ...(httpStatus !== undefined && { httpStatus }),
            ...(matchedRule !== undefined && { matchedRule }),
            ...(matchedToken !== undefined && { matchedToken: sanitizeLogString(matchedToken).slice(0, 1500) }),
            ...(resultBytes !== undefined && { resultBytes }),
            ...(resultDigest !== undefined && { resultDigest }),
          });

          // ATTR-01: skill-use attribution. A `read` whose path equals a frozen
          // learned-skill `<location>` means the model invoked that skill. Map
          // the read path → skillName via the per-session location index
          // (parsed once at prompt-assembly freeze time), emit the EXISTING
          // observable `skill:prompt_invoked` (model-invoked), and record the
          // skillName in the named per-turn carrier (m.turnUsedSkillIds) which
          // the executor reads back into the `memory:skill_used` write-back.
          // No match (the default — no learned-skill locations) → no-op.
          if (endEvent.toolName === "read") {
            const readPath = (rawArgsForParams as { path?: string } | undefined)?.path;
            if (typeof readPath === "string" && readPath !== "") {
              const skillName = getSessionPromptSkillLocations(formatSessionKey(deps.sessionKey))?.get(readPath);
              if (skillName !== undefined) {
                m.turnUsedSkillIds.add(skillName);
                deps.eventBus.emit("skill:prompt_invoked", {
                  skillName,
                  invokedBy: "model",
                  args: "",
                  timestamp: systemNowMs(),
                });
              }
            }
          }

          // Explicit tool:timeout emit when the tool was classified as
          // timed-out. Fires alongside tool:executed for the same
          // physical timeout — both share toolCallId, so the trajectory
          // writer + downstream consumers dedupe by that key (see
          // TRAJECTORY_BRIDGE_MAPPING JSDoc + events-agent.ts
          // tool:timeout declaration for the dedup contract).
          if (toolErrorKind === "timeout") {
            deps.eventBus.emit("tool:timeout", {
              agentId: deps.agentId,
              sessionKey: formatSessionKey(deps.sessionKey),
              traceId: tryGetContext()?.traceId ?? deps.executionId,
              toolName: endEvent.toolName,
              toolCallId: endEvent.toolCallId,
              timeoutMs: durationMs,
              timestamp: systemNowMs(),
            });
          }

          // Reset prompt timeout after each tool completion so slow tools
          // do not starve subsequent LLM turns.
          deps.onToolExecutionEnd?.();

          // Safety: check step limit (delegated to bridge-safety-controls)
          {
            const stepCheck = checkStepLimit(deps.stepCounter, m.aborted);
            if (stepCheck.shouldAbort) {
              m.finishReason = stepCheck.finishReason!;
              m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
              m.aborted = true;
              emitStepLimitAbort(deps);
            }
          }

          // Safety: break a runaway repeating-tool loop early (FIX #2) — fires
          // at the detector's no-progress threshold, well before the step limit.
          // finishReason "loop_detected" flows to the orchestrator's
          // mapAbortToTurnOutcome (FIX #3) for a truthful status.
          if (deps.turnLoopDetector) {
            const loopCheck = checkLoopLimit(deps.turnLoopDetector, m.aborted);
            if (loopCheck.shouldAbort) {
              m.finishReason = loopCheck.finishReason!;
              m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
              m.aborted = true;
              emitLoopAbort(deps);
            }
          }

          // SEP: Track step progress on tool completion
          {
            const plan = deps.executionPlan?.current;
            if (plan?.active) {
              const currentStep = plan.steps.find(s => s.status === "in_progress")
                ?? plan.steps.find(s => s.status === "pending");
              if (currentStep) {
                const oldStatus = currentStep.status;
                if (currentStep.status === "pending") {
                  currentStep.status = "in_progress";
                }
                currentStep.completedBy ??= [];
                currentStep.completedBy.push(endEvent.toolCallId);
                if (oldStatus !== currentStep.status) {
                  deps.logger.debug(
                    { agentId: deps.agentId, stepIndex: currentStep.index, oldStatus, newStatus: currentStep.status },
                    "SEP step status changed",
                  );
                }
              }
            }
          }

          break;
        }

        // -----------------------------------------------------------------
        // LLM turn about to start (pre-serialize hook for assert+restore)
        // -----------------------------------------------------------------
        case "turn_start": {
          // Reset per-turn outbound capture. The log accumulates
          // message(send/reply/attach) calls across the turn so the
          // post-execution gate can make sentinel-aware decisions.
          m.outboundLog.length = 0;

          // Run the executor-supplied pre-call closure once per turn, before
          // pi-ai reads `session.agent.state.messages` to serialize the next
          // API request. The closure performs the assert-then-restore pass
          // over the live transcript and writes the healed array back into
          // session state when at least one swap happens, so the bytes
          // Anthropic sees match the canonical stream-close snapshot. The
          // closure swallows its own throws; the wrapper here is
          // belt-and-braces.
          //
          // ALWAYS emit ONE INFO log carrying the counters the bridge can
          // derive — even when the closure is unwired or returns undefined /
          // no candidates. This closes the silent-success ambiguity where
          // ZERO agent.bridge.* events appeared despite the helpers having
          // shipped.
          //
          // Counters are computed by the bridge's own walk of the messages
          // returned by the closure (or empty when unwired) so the executor
          // closure stays untouched. `mismatchesLogged` and `restoredCount`
          // are derived from positional hash diffs — they equal the work the
          // closure's helpers actually emit/heal.
          const hashStoreSize = m.thinkingBlockHashes.size;
          const canonicalStoreSize = m.thinkingBlockCanonical.size;

          let candidatesChecked = 0;
          let mismatchesLogged = 0;
          let anyResponseIdMatched = false;

          if (deps.getSessionMessages) {
            let liveBeforeClosure: ReadonlyArray<unknown> | undefined;
            try {
              liveBeforeClosure = deps.getSessionMessages();
            } catch {
              // Pre-call hook must NEVER abort agent flow.
              liveBeforeClosure = undefined;
            }

            if (Array.isArray(liveBeforeClosure)) {
              for (const msg of liveBeforeClosure) {
                if (!msg || typeof msg !== "object") continue;
                const sm = msg as { role?: string; responseId?: string; content?: unknown };
                if (sm.role !== "assistant") continue;
                if (typeof sm.responseId !== "string") continue;
                const prior = m.thinkingBlockHashes.get(sm.responseId);
                if (!prior) continue;
                candidatesChecked++;
                anyResponseIdMatched = true;
                const currentBlocks = Array.isArray(sm.content)
                  ? (sm.content as Array<Record<string, unknown>>)
                  : [];
                const currentHashes = computeThinkingBlockHashes(currentBlocks);
                const byIndex = new Map<number, ThinkingBlockHash>();
                for (const h of currentHashes) byIndex.set(h.blockIndex, h);
                for (const old of prior) {
                  const now = byIndex.get(old.blockIndex);
                  if (!now || now.hash !== old.hash) mismatchesLogged++;
                }
              }
            }
          }

          // restoredCount equals mismatchesLogged in the current symmetric
          // implementation; surfaced as a separate field so future asymmetric
          // assert/restore semantics are observable.
          const restoredCount = mismatchesLogged;

          m.hashAssertionsRan++;
          m.hashAssertionMismatches += mismatchesLogged;

          const hashAssertionPayload = {
            submodule: "bridge.hash-invariant",
            candidatesChecked,
            mismatchesLogged,
            restoredCount,
            anyResponseIdMatched,
            hashStoreSize,
            canonicalStoreSize,
          };
          if (mismatchesLogged > 0) {
            deps.logger.warn(
              {
                ...hashAssertionPayload,
                hint: "Cross-turn thinking-block mutation detected; pre-call restore pass will heal before next API serialize. Investigate if this fires repeatedly without the heal succeeding (canonicalStoreSize === 0).",
                errorKind: "internal" as const,
              },
              "Pre-call assertion ran",
            );
          } else {
            deps.logger.debug(hashAssertionPayload, "Pre-call assertion ran");
          }
          break;
        }

        // -----------------------------------------------------------------
        // Assistant message stream closed (BEFORE tools fire)
        //
        // pi-mono emits `message_end` when the assistant message stream
        // resolves (agent-loop.js:214,227) — strictly before any
        // `tool_execution_start` for tool_calls in that same message
        // (agent-loop.js:245-249). Eager-extract the SEP plan here so
        // plan-stream paints the checkbox header DURING the turn rather
        // than ~3 ms before scaffold deletion at turn_end.
        //
        // The shared `!deps.executionPlan.current` guard makes the
        // existing `case "turn_end"` SEP-extract block (below) a
        // self-disabling no-op once we extract at message_end. The
        // turn_end block is preserved as a defensive fallback for
        // pi-mono shape variants where text appears only at turn_end.
        // -----------------------------------------------------------------
        case "message_end": {
          const msgEvent = event as { message: unknown };
          // pi-mono emits message_end for EVERY message (user prompts, pending
          // tool-result messages, AND assistant responses — agent-loop.js:52, 96,
          // 198, 214, 227). The eager SEP extraction only makes sense for the
          // assistant's response; scanning a user prompt produces phantom plans
          // from numbered/bulleted content in the injected memory/system context.
          // Discriminate on role to ensure only assistant messages reach the extractor.
          const candidate = msgEvent.message as { role?: string } | undefined;
          if (candidate?.role !== "assistant") break;
          const assistantMsg = candidate as AssistantMessage;
          if (deps.executionPlan && deps.sepConfig && !deps.executionPlan.current) {
            const assistantTextForPlan = Array.isArray(assistantMsg?.content)
              ? assistantMsg!.content
                  .filter((c: unknown) => (c as { type?: string })?.type === "text")
                  .map((c: unknown) => (c as { text?: string }).text ?? "")
                  .join(" ")
              : "";

            if (assistantTextForPlan.length > 0) {
              const steps = extractPlanFromResponse(assistantTextForPlan, deps.sepConfig.maxSteps);
              if (steps && steps.length >= deps.sepConfig.minSteps) {
                const plan: ExecutionPlan = {
                  active: true,
                  request: (deps.sepMessageText ?? "").slice(0, 200),
                  steps,
                  completedCount: 0,
                  createdAtMs: systemNowMs(),
                };
                deps.executionPlan.current = plan;
                deps.logger.info(
                  {
                    agentId: deps.agentId,
                    stepCount: steps.length,
                    durationMs: deps.sepExecutionStartMs
                      ? systemNowMs() - deps.sepExecutionStartMs
                      : undefined,
                  },
                  "SEP plan extracted (message_end, eager)",
                );
                deps.eventBus.emit("sep:plan_extracted", {
                  agentId: deps.agentId ?? "default",
                  sessionKey: formatSessionKey(deps.sessionKey),
                  stepCount: steps.length,
                  timestamp: systemNowMs(),
                });
              }
            }
          }
          break;
        }

        // -----------------------------------------------------------------
        // LLM turn completed
        // -----------------------------------------------------------------
        case "turn_end": {
          m.llmCallCount++;

          const turnEvent = event as { message: unknown };
          const assistantMsg = turnEvent.message as AssistantMessage | undefined;

          // Capture stopReason for output escalation detection
          if (assistantMsg && "stopReason" in assistantMsg) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
            m.lastStopReason = (assistantMsg as any).stopReason as string | undefined;
          }

          // Block-accounting diagnostic: captures the post-stream shape of any
          // assistant message that contains signed thinking blocks. Used to
          // diagnose Anthropic 400 `messages.N.content.M: thinking/redacted_thinking
          // blocks cannot be modified` errors by comparing wire shape vs. persisted
          // shape vs. replay request body. Only fires when at least one signed
          // thinking block is present to keep the log budget bounded.
          if (assistantMsg && Array.isArray((assistantMsg as { content?: unknown }).content)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
            const blocks = (assistantMsg as any).content as Array<Record<string, unknown>>;
            const signedThinkingCount = blocks.filter(
              (b) => b.type === "thinking" && typeof b.thinkingSignature === "string" && (b.thinkingSignature as string).length > 0,
            ).length;
            if (signedThinkingCount > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
              const responseIdForLog = (assistantMsg as any).responseId as string | undefined;
              deps.logger.info(
                {
                  responseId: responseIdForLog,
                  wireBlockCount: blocks.length,
                  signedThinkingCount,
                  blockShape: blocks.map((b) => ({
                    type: b.type,
                    sigLen: typeof b.thinkingSignature === "string" ? (b.thinkingSignature as string).length : 0,
                    redacted: b.redacted === true,
                    textLen: typeof b.text === "string" ? (b.text as string).length : 0,
                    thinkingLen: typeof b.thinking === "string" ? (b.thinking as string).length : 0,
                  })),
                },
                "Assistant message block accounting at stream close",
              );

              // Diagnostic + heal: capture hashes AND a canonical (pre-mutation)
              // snapshot of the full content array, keyed by responseId, in
              // lockstep across both stores. The hash store powers the
              // assertion ERROR log (mutation diagnostic); the canonical
              // store powers the pre-call restore pass that heals cross-turn
              // mutation before the next API serialize. Both stores are
              // FIFO-evicted at 32 entries in lockstep so they always share
              // the same keyset.
              if (typeof responseIdForLog === "string") {
                const hashes = computeThinkingBlockHashes(blocks);
                if (hashes.length > 0) {
                  while (m.thinkingBlockHashes.size >= 32) {
                    const oldestKey = m.thinkingBlockHashes.keys().next().value;
                    if (oldestKey === undefined) break;
                    m.thinkingBlockHashes.delete(oldestKey);
                    m.thinkingBlockCanonical.delete(oldestKey);
                  }
                  m.thinkingBlockHashes.set(responseIdForLog, hashes);
                  // Capture canonical (pre-mutation) full content array so
                  // the pre-LLM-call restore pass can heal any cross-turn
                  // mutation before pi-ai serializes the next request.
                  // structuredClone is a Node 22 global; the try/catch is
                  // defensive against rare exotic input shapes.
                  try {
                    const canonical = Object.freeze(structuredClone(blocks)) as ReadonlyArray<unknown>;
                    m.thinkingBlockCanonical.set(responseIdForLog, canonical);
                  } catch {
                    // Canonical capture failure is non-fatal: the hash store
                    // still fires the assertion diagnostic on resend; only
                    // the heal step degrades to no-op for this responseId.
                  }
                }
              }
            }
          }

          // Compute LLM latency: turn wallclock minus tool execution time
          const turnWallclockMs = systemNowMs() - m.turnStartMs;
          // Cap per-turn tool duration to turn wallclock (parallel tools can sum > wallclock)
          const effectiveTurnToolMs = Math.min(m.turnToolDurationMs, turnWallclockMs);
          m.cumulativeToolWallclockMs += effectiveTurnToolMs;
          const llmLatencyMs = turnWallclockMs - effectiveTurnToolMs;
          m.cumulativeLlmDurationMs += llmLatencyMs;
          m.turnToolDurationMs = 0;

          // Extract responseId from assistant message (optional -- not all providers supply it)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
          const responseId = (assistantMsg as any)?.responseId as string | undefined;

          if (assistantMsg && "usage" in assistantMsg && assistantMsg.usage) {
            const usage = assistantMsg.usage;

            // Accumulate token totals
            m.totalInputTokens += usage.input;
            // Report per-turn input tokens for TokenAnchor recording
            deps.onTurnUsage?.(usage.input);
            m.totalOutputTokens += usage.output;
            m.totalTokens += usage.totalTokens;
            // NOTE: m.totalCost accumulation deferred until after cost correction (see below)
            m.totalCacheReadTokens += usage.cacheRead ?? 0;
            m.totalCacheWriteTokens += usage.cacheWrite ?? 0;

            // Hoist cache token locals for use in savings formula
            const cacheReadTokens = usage.cacheRead ?? 0;
            const cacheWriteTokens = usage.cacheWrite ?? 0;

            // Emit graph cache-write signal on first turn of a graph subagent
            if (deps.graphId && deps.nodeId && m.llmCallCount === 1 && cacheWriteTokens > 0) {
              deps.eventBus.emit("cache:graph_prefix_written", {
                graphId: deps.graphId,
                nodeId: deps.nodeId,
                cacheWriteTokens,
                timestamp: systemNowMs(),
              });
            }

            // Per-turn pricing resolution via getCurrentModel().
            const currentModelId = deps.getCurrentModel?.() ?? deps.model;
            const pricing = resolveModelPricing(deps.provider, currentModelId);

            // Feed cache reads to adaptive retention escalation callback
            if (cacheReadTokens > 0 && deps.onCacheReads) {
              deps.onCacheReads(cacheReadTokens);
            }

            // Feed turn completion with cache write tokens to adaptive retention.
            // The fast-path evaluates whether first turn wrote >20K tokens for early escalation.
            // Must run AFTER onCacheReads so totalCacheReads is current when tryEscalate runs.
            if (deps.onTurnWithCacheWrite) {
              deps.onTurnWithCacheWrite(cacheWriteTokens);
            }

            // Cache break detection (all providers, unconditional)
            // MUST NOT guard with cacheReadTokens > 0 -- complete cache misses (drop to 0) must be detected
            if (deps.checkCacheBreak) {
              // Detect API errors -- zero usage with error stop reason
              const isApiError = usage.input === 0 && usage.output === 0 && m.lastStopReason === "error";

              const breakEvent = deps.checkCacheBreak({
                sessionKey: formatSessionKey(deps.sessionKey),
                provider: deps.provider,
                cacheReadTokens,
                cacheWriteTokens,
                totalInputTokens: usage.input ?? 0,
                apiError: isApiError || undefined,
              });
              if (breakEvent) {
                deps.eventBus.emit("observability:cache_break", {
                  ...breakEvent,
                  // Structured analytics fields from detection pipeline
                  // Sanitize MCP tool names to bare 'mcp' for analytics
                  toolsAdded: breakEvent.changes.addedTools.map(sanitizeMcpToolNameForAnalytics),
                  toolsRemoved: breakEvent.changes.removedTools.map(sanitizeMcpToolNameForAnalytics),
                  toolsSchemaChanged: breakEvent.changes.changedSchemaTools.map(sanitizeMcpToolNameForAnalytics),
                  systemCharDelta: (breakEvent.currentSystem?.length ?? 0) - (breakEvent.previousSystem?.length ?? 0),
                  model: currentModelId,
                });

                // Forward cache break event to executor for coordinated reset.
                if (deps.onCacheBreakDetected) {
                  deps.onCacheBreakDetected(breakEvent);
                }
              }
            }

            // Extract cacheCreation breakdown (future upstream -- runtime check)
            const rawUsage = usage as unknown as Record<string, unknown>;
            const cacheCreation = rawUsage.cacheCreation && typeof rawUsage.cacheCreation === "object"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
              ? { shortTtl: (rawUsage.cacheCreation as any).shortTtl ?? 0, longTtl: (rawUsage.cacheCreation as any).longTtl ?? 0 }
              : undefined;

            // Per-call DEBUG breakdown log removed. The fact
            // that pi-ai does not expose the per-TTL split is now stated
            // once at construction time via the module-level
            // _sdkBreakdownNoticeEmitted latch above. cacheCreation
            // (when present) still flows downstream into the
            // observability:token_usage event payload below.

            // Record usage in budget guard (token-based, not cost-based -- stays before correction)
            deps.budgetGuard.recordUsage(usage.totalTokens);

            // Ordering: Normalize TTL split estimates BEFORE cost correction.
            // The injector provides raw per-TTL estimates; normalize so they sum to the
            // SDK-reported total (eliminates the 28% estimation error).
            // Mutate in-place so per-TTL cost and accumulation use normalized values.
            // CRITICAL: Must run before cost correction to prevent inflated 1h token counts from over-charging.
            if (deps.ttlSplit && (deps.ttlSplit.cacheWrite5mTokens > 0 || deps.ttlSplit.cacheWrite1hTokens > 0)) {
              const rawTotal = deps.ttlSplit.cacheWrite5mTokens + deps.ttlSplit.cacheWrite1hTokens;
              if (rawTotal > 0 && cacheWriteTokens > 0) {
                const scale = cacheWriteTokens / rawTotal;
                const norm5m = Math.round(deps.ttlSplit.cacheWrite5mTokens * scale);
                deps.ttlSplit.cacheWrite5mTokens = norm5m;
                deps.ttlSplit.cacheWrite1hTokens = cacheWriteTokens - norm5m; // remainder ensures exact sum
              }
            }

            // Compute cost correction for 1h tokens the SDK underpriced at the 5m rate.
            // The SDK prices ALL cacheWrite tokens at pricing.cacheWrite (5m rate).
            // When TTL split is available, 1h tokens should be priced at pricing.cacheWrite1h.
            // Delta = cacheWrite1hTokens * (cacheWrite1h - cacheWrite) -- the underpayment per 1h token.
            let costCorrectionDelta = 0;
            if (deps.ttlSplit && deps.ttlSplit.cacheWrite1hTokens > 0 && pricing.cacheWrite1h > pricing.cacheWrite) {
              costCorrectionDelta = deps.ttlSplit.cacheWrite1hTokens * (pricing.cacheWrite1h - pricing.cacheWrite);
            }

            // Build cost object: apply correction to total if delta > 0, otherwise SDK passthrough
            const sdkCost = usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
            const cost = costCorrectionDelta > 0
              ? { ...sdkCost, total: sdkCost.total + costCorrectionDelta }
              : sdkCost;

            // Accumulate corrected cost
            m.totalCost += cost.total;

            // Accumulate per-turn cost-correction delta (>0
            // only — matches the invariant that negative
            // correction is suppressed; see costCorrectionField gate at
            // line ~1106). Surfaced via buildBridgeResult on the
            // "Execution complete" log.
            if (costCorrectionDelta > 0) {
              m.totalCostCorrectionDeltaUsd += costCorrectionDelta;
            }

            // Per-call DEBUG cost-correction log removed. The
            // costCorrection breadcrumb now rides on the
            // observability:token_usage event payload below — operators
            // already query that event for cost forensics, so moving the
            // signal there preserves observability without inflating
            // DEBUG volume. The field is included only when delta !== 0;
            // a turn with no correction emits nothing extra.

            // Record in cost tracker (uses corrected cost)
            deps.costTracker.record(
              deps.agentId,
              deps.channelId,
              deps.executionId,
              {
                input: usage.input,
                output: usage.output,
                totalTokens: usage.totalTokens,
                cost,
                provider: deps.provider,
                model: deps.getCurrentModel?.() ?? deps.model,
                sessionKey: formatSessionKey(deps.sessionKey),
                operationType: deps.operationType,
              },
            );

            // Compute savedVsUncached: per-TTL split formula when available,
            // single-rate fallback otherwise.
            let savedVsUncached = 0;
            if ((cacheReadTokens > 0 || cacheWriteTokens > 0) && pricing.input > 0) {
              const readSavings = cacheReadTokens * (pricing.input - pricing.cacheRead);
              // Per-TTL write overhead split. When ttlSplit data is available,
              // use separate rates for 5m and 1h writes. Otherwise fall back to single-rate.
              let writeOverhead: number;
              if (deps.ttlSplit && (deps.ttlSplit.cacheWrite5mTokens > 0 || deps.ttlSplit.cacheWrite1hTokens > 0)) {
                const write5mOverhead = deps.ttlSplit.cacheWrite5mTokens * (pricing.cacheWrite - pricing.input);
                const write1hOverhead = deps.ttlSplit.cacheWrite1hTokens * (pricing.cacheWrite1h - pricing.input);
                writeOverhead = write5mOverhead + write1hOverhead;
                // Accumulate TTL-split tokens
                m.totalCacheWrite5mTokens += deps.ttlSplit.cacheWrite5mTokens;
                m.totalCacheWrite1hTokens += deps.ttlSplit.cacheWrite1hTokens;
              } else {
                // Fallback: all writes priced at 5m rate (prior behavior)
                writeOverhead = cacheWriteTokens * (pricing.cacheWrite - pricing.input);
              }
              const raw = readSavings - writeOverhead;
              savedVsUncached = Number.isFinite(raw) ? raw : 0;
            }

            // Accumulate cache savings across turns
            m.totalCacheSaved += savedVsUncached;

            // Warmup-turn signal. Identifies the first
            // cache-write turn in a session (writes-without-prior-reads).
            // Per-call cache math is correct, but reporting cacheSavedUsd
            // as a negative dollar value on this turn is misleading
            // because the "loss" is a deferred investment recouped by
            // subsequent cached reads, not a cost regression. The
            // positive-signed `pendingCacheInvestmentUsd` is the
            // dashboard-friendly framing of the same magnitude; the
            // original `savedVsUncached` keeps its negative value (math
            // preserved).
            const warmupTurn = cacheReadTokens === 0 && cacheWriteTokens > 0;
            const pendingCacheInvestmentUsd =
              warmupTurn && savedVsUncached < 0 ? -savedVsUncached : 0;
            if (warmupTurn) {
              m.warmupTurnCount += 1;
              m.totalPendingCacheInvestmentUsd += pendingCacheInvestmentUsd;
            }

            // Record per-turn cache savings for cost gate evaluation.
            if (deps.onTurnCacheSavings) {
              deps.onTurnCacheSavings(savedVsUncached);
            }

            // Accumulate session-cumulative costs alongside per-turn values
            m.sessionCumulativeCostUsd += cost.total;
            m.sessionCumulativeCacheSavedUsd += savedVsUncached;

            // Track thinking tokens from SDK usage object.
            // The pi-ai SDK Usage type does not have a dedicated thinking/reasoning field,
            // but future versions or raw API responses may include `reasoningTokens`.
            // Runtime-check the raw usage object for this field.
            {
              const rawUsageForThinking = usage as unknown as Record<string, unknown>;
              const sdkThinkingTokens = typeof rawUsageForThinking.reasoningTokens === "number"
                ? rawUsageForThinking.reasoningTokens
                : 0;
              if (sdkThinkingTokens > 0) {
                m.totalThinkingTokens += sdkThinkingTokens;
              }
            }

            // Populate cacheCreation from bridge metrics TTL split when SDK doesn't provide it.
            // SDK-sourced cacheCreation takes priority; bridge metrics provide the fallback
            // when pi-ai doesn't surface per-TTL breakdown.
            const effectiveCacheCreation = cacheCreation ?? (
              (m.totalCacheWrite5mTokens > 0 || m.totalCacheWrite1hTokens > 0)
                ? { shortTtl: m.totalCacheWrite5mTokens, longTtl: m.totalCacheWrite1hTokens }
                : undefined
            );

            // Emit observability event
            // Include costCorrection breadcrumb when the SDK
            // total was bumped to cover 1h-rate underpricing. Omitted
            // when delta === 0 — operators can filter on
            // `costCorrection != null` to surface only corrected turns.
            const costCorrectionField =
              costCorrectionDelta !== 0
                ? {
                    costCorrection: {
                      delta: cost.total - sdkCost.total, // = costCorrectionDelta when > 0
                      sdkRaw: sdkCost.total,
                      corrected: cost.total,
                    },
                  }
                : {};
            // COST-01: tag this turn with the DISTINCT tools that fired (from the
            // already-tracked m.toolCallHistory at :557 — NOT a new accumulator).
            // Content-free: tool NAMES/ids only, never args/output. The per-tool $
            // split a consumer renders is best-effort/labeled (N3) — an even split
            // across these distinct tools that conserves cost.total (locked A5);
            // exact per-tool accounting is out of scope. undefined ⇒ the spread
            // vanishes and the emit is byte-for-byte unchanged on a no-tool turn.
            const toolTag =
              m.toolCallHistory.length > 0 ? Array.from(new Set(m.toolCallHistory)) : undefined;
            deps.eventBus.emit("observability:token_usage", {
              timestamp: systemNowMs(),
              traceId: tryGetContext()?.traceId ?? deps.executionId,
              agentId: deps.agentId,
              channelId: deps.channelId,
              executionId: deps.executionId,
              provider: deps.provider,
              model: deps.getCurrentModel?.() ?? deps.model,
              tokens: {
                prompt: usage.input,
                completion: usage.output,
                total: usage.totalTokens,
              },
              cost: {
                input: cost.input,
                output: cost.output,
                cacheRead: cost.cacheRead,
                cacheWrite: cost.cacheWrite,
                total: cost.total,
              },
              latencyMs: llmLatencyMs,
              cacheReadTokens,
              cacheWriteTokens,
              sessionKey: formatSessionKey(deps.sessionKey),
              savedVsUncached,
              cacheEligible: getCacheProviderInfo(deps.provider, deps.getCurrentModel?.() ?? deps.model).cacheEligible,
              responseId,
              cacheCreation: effectiveCacheCreation,
              // Warmup-turn flag + deferred investment
              // dollar value. Both included unconditionally so consumers
              // can pivot/filter without conditional schemas.
              warmupTurn,
              pendingCacheInvestmentUsd,
              ...costCorrectionField,
              // COST-01: the distinct tool tag (best-effort, labeled). Spread so
              // a no-tool turn keeps the payload byte-for-byte unchanged (no shim).
              ...(toolTag && { toolTag }),
              // B3 (D8): SDK per-turn stop signal. RELIABLE — m.lastStopReason is
              // captured at :1231 in this same turn_end case, BEFORE this emit.
              ...(m.lastStopReason !== undefined && { stopReason: m.lastStopReason }),
              // B3 (D8): execution-level finish disposition. m.finishReason settles
              // LATER than turn_end (the safety guards set it at
              // :1005/:1018/:1625/:1672/:2113), so on a normal turn it is still the
              // init default "stop". Forward it ONLY once it has diverged from that
              // default, so model.completed does not carry a stale, authoritative-
              // looking "stop" on every normal turn (WR-151-01) — the translator's
              // presence-conditional guard then correctly omits it. A genuinely
              // settled value (a guard-set "max_steps"/"loop_detected"/etc. from this
              // or a prior turn) IS forwarded. The authoritative settled finishReason
              // is Phase 152's flight-recorder (effectiveFinishReason); the reliable
              // D8 field at this per-turn emit is stopReason above.
              ...(m.finishReason !== "stop" && { finishReason: m.finishReason }),
            });

            // Append turn_completed to the session index. Co-located with
            // observability:token_usage emit (the only site that carries
            // BOTH input AND output tokens per turn — onTurnUsage only
            // has input tokens).
            appendSessionIndexEntry(
              deps.dataDir ?? pathModule.join(os.homedir(), ".comis"),
              {
                traceSchema: "comis-session-index",
                schemaVersion: 1,
                event: "turn_completed",
                ts: systemDateFrom(systemNowMs()).toISOString(),
                sessionId: formatSessionKey(deps.sessionKey),
                traceId: tryGetContext()?.traceId ?? deps.executionId,
                durationMs: llmLatencyMs ?? 0,
                inputTokens: usage.input,
                outputTokens: usage.output,
                // W7 (obs-llm-troubleshooting): make degraded turns greppable from
                // the index alone. stopReason is the RELIABLE per-turn signal
                // (captured at :1231 in this same turn_end); finishReason mirrors
                // the model.completed WR-151-01 guard — forwarded only once it has
                // settled away from the init default "stop" (the HR-01 mapping for
                // THIS turn runs after this append, so it lands on later rows).
                ...(m.lastStopReason !== undefined && { stopReason: m.lastStopReason }),
                ...(m.finishReason !== "stop" && { finishReason: m.finishReason }),
                lastError: null, // populated by error paths in a follow-up plan; null here
                source: "runtime" as const, // D9 provenance stamp (production rows)
              },
            );

            // Safety: check budget after recording (delegated to bridge-safety-controls)
            {
              const budgetCheck = checkBudgetLimit(deps.budgetGuard, m.aborted);
              if (budgetCheck.shouldAbort) {
                m.finishReason = budgetCheck.finishReason!;
                m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
                m.aborted = true;
                emitBudgetAbort(deps, m.totalTokens);
              }
            }

            // Safety: the dollars kill-switch (Phase 177). ADMISSION-BOUNDED +
            // COOPERATIVE-ABORT. The bridge has NO pre-flight cost estimate at this
            // post-record point, so it reserves a conservative perTurnMax through
            // the SYNCHRONOUS atomic accumulator (which serializes concurrent
            // admissions), runs the 3-state pricing gate, and routes a breach
            // through the single execution:aborted{reason:"spend_exceeded"} path.
            //
            // No double-count: the granted reservation is reconciled to $0 below —
            // a PURE admission hold released at the billing point. The actual
            // cost.total already landed via the daemon-wide observability:token_usage
            // subscriber (emitted just above, ~:1671), which is the SOLE permanent
            // actual-adder. The reservation only bounds concurrent admissions to a
            // single turn's perTurnMax overshoot; it never permanently consumes the
            // ceiling itself.
            //
            // When spendAccumulator is absent (flags off / not wired) this whole
            // block is skipped — the healthy path is byte-identical.
            if (deps.spendAccumulator && deps.spendScope && deps.spendConfig) {
              const spendAcc = deps.spendAccumulator;
              const spendCfg = deps.spendConfig;
              const spendScope = deps.spendScope;
              const spendModel = deps.getCurrentModel?.() ?? deps.model;
              // Breach detail for the content-free spend_exceeded event, captured
              // from the gate outcome before checkSpendLimit fires the emit hook.
              let spendBreachScope: "agent" | "tenant" | "global" = "global";
              let spendBreachCurrentUsd = 0;
              let spendBreachCapUsd = 0;
              const spendEmit: SpendEmitHooks = {
                // WR-1 (177-obs-loop): emit the breaching warn DIMENSION the
                // accumulator reported (the crossed scope + THAT dimension's
                // post-reserve total + cap) — NOT a hard-coded scope:"agent" + the
                // session-local cumulative cost + a first-non-null cap (an
                // internally-inconsistent event when the tenant/global ceiling is
                // the one that crossed — the security-review WR-1 finding).
                spendWarning: (warn) =>
                  deps.eventBus.emit("observability:spend_warning", {
                    timestamp: systemNowMs(),
                    agentId: deps.agentId,
                    sessionKey: formatSessionKey(deps.sessionKey),
                    scope: warn.scope,
                    spentUsd: warn.totalUsd,
                    capUsd: warn.capUsd,
                    fraction: spendCfg.warnAtFraction,
                  }),
                spendExceeded: () =>
                  deps.eventBus.emit("observability:spend_exceeded", {
                    timestamp: systemNowMs(),
                    agentId: deps.agentId,
                    sessionKey: formatSessionKey(deps.sessionKey),
                    scope: spendBreachScope,
                    spentUsd: spendBreachCurrentUsd,
                    capUsd: spendBreachCapUsd,
                    estUsd: spendCfg.perTurnMax,
                  }),
                spendUnpriceable: () =>
                  deps.eventBus.emit("observability:spend_unpriceable", {
                    timestamp: systemNowMs(),
                    agentId: deps.agentId,
                    sessionKey: formatSessionKey(deps.sessionKey),
                    provider: deps.provider,
                    model: spendModel,
                  }),
              };

              // Atomic reserve of the conservative perTurnMax + the 3-state gate.
              const gate = checkSpendCeiling(
                spendAcc,
                spendScope,
                deps.provider,
                spendModel,
                spendCfg.perTurnMax,
                { onUnknownPricing: spendCfg.onUnknownPricing, pricingFallback: spendCfg.pricingFallback },
                usage.totalTokens > 0,
              );

              // checkSpendCeiling is Result-returning; an err here is unexpected
              // (the gate maps a breach to an `exceeded` outcome, not an err), but
              // be defensive: a defensive err means "do not abort" (fail-safe).
              if (gate.ok) {
                const outcome = gate.value;
                // Surface the breach scope/amounts for the content-free event.
                if (outcome.kind === "exceeded") {
                  spendBreachScope = outcome.error.scope;
                  spendBreachCurrentUsd = outcome.error.currentUsd;
                  spendBreachCapUsd = outcome.error.capUsd;
                }
                const spendCheck = checkSpendLimit(
                  outcome,
                  spendCfg.action,
                  spendCfg.onUnknownPricing,
                  m.aborted,
                  spendEmit,
                );
                if (spendCheck.shouldAbort) {
                  m.finishReason = spendCheck.finishReason!;
                  m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
                  m.aborted = true;
                  emitSpendAbort(deps);
                }
                // COOPERATIVE: release the admission hold to $0. The actual
                // cost.total is recorded by the live token_usage subscriber, so
                // reconciling to 0 (delta = 0 - perTurnMax) nets the reservation
                // out of the counters and avoids double-counting.
                if (outcome.kind === "ok") {
                  spendAcc.reconcile(outcome.reservation, 0);
                }
              }
            }

            // Budget trajectory warning: detect approaching exhaustion before hard abort
            if (!m.budgetWarningEmitted) {
              const trajectory = checkBudgetTrajectory(m, deps.perExecutionBudgetCap);
              if (trajectory.shouldWarn) {
                m.budgetWarningEmitted = true;
                if (deps.budgetWarningRef) {
                  deps.budgetWarningRef.current = true;
                }
                const avgTokensPerCall = m.totalTokens / m.llmCallCount;
                deps.eventBus.emit("execution:budget_warning", {
                  agentId: deps.agentId,
                  sessionKey: formatSessionKey(deps.sessionKey),
                  totalTokens: m.totalTokens,
                  llmCallCount: m.llmCallCount,
                  projectedCallsLeft: Math.floor((deps.perExecutionBudgetCap! - m.totalTokens) / avgTokensPerCall),
                  timestamp: systemNowMs(),
                });
                deps.logger.warn({
                  totalTokens: m.totalTokens,
                  llmCallCount: m.llmCallCount,
                  perExecutionCap: deps.perExecutionBudgetCap,
                  hint: "Budget trajectory shows ~2 LLM calls remaining; warning injected into next turn",
                  errorKind: "resource" as const,
                }, "Budget trajectory warning emitted");
              }
            }
          }

          // Decrement eviction cooldown each turn (unconditional).
          deps.decrementEvictionCooldown?.();

          // Context guard: check context window usage after each turn
          // Delegated to bridge-safety-controls
          if (deps.contextGuard && deps.getContextUsage && !m.aborted) {
            const contextUsage = deps.getContextUsage();
            if (contextUsage) {
              // Store last known usage for external consumers (/status)
              m.lastContextUsage = contextUsage;

              const contextCheck = checkContextWindow(deps.contextGuard, contextUsage, m.aborted, deps.logger);
              if (contextCheck.shouldAbort) {
                m.finishReason = contextCheck.finishReason!;
                m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
                m.aborted = true;
                emitContextAbort(deps, contextUsage);
              }
            }
          }

          // Proactive compaction advice: check if SDK would recommend compaction
          if (deps.compactionSettings && deps.getContextUsage && !m.aborted) {
            const contextUsage = m.lastContextUsage ?? deps.getContextUsage();
            if (contextUsage && contextUsage.tokens !== null) {
              const compactNeeded = shouldCompact(
                contextUsage.tokens,
                contextUsage.contextWindow,
                deps.compactionSettings,
              );
              if (compactNeeded) {
                deps.eventBus.emit("compaction:recommended", {
                  agentId: deps.agentId,
                  sessionKey: deps.sessionKey,
                  contextPercent: contextUsage.percent ?? Math.round((contextUsage.tokens / contextUsage.contextWindow) * 100),
                  contextTokens: contextUsage.tokens,
                  contextWindow: contextUsage.contextWindow,
                  timestamp: systemNowMs(),
                });
                deps.logger.debug(
                  {
                    contextPercent: contextUsage.percent,
                    contextTokens: contextUsage.tokens,
                  },
                  "Compaction recommended by SDK",
                );
              }
            }
          }

          // Record successful LLM call in circuit breaker + provider health
          deps.circuitBreaker.recordSuccess();
          deps.providerHealth?.recordSuccess(deps.provider, deps.agentId);

          // SEP: Advance step status on turn completion
          m.turnCount++;

          // SEP: Extract plan from first LLM turn that has tool calls + assistant text.
          // This runs inside the agentic loop so subsequent turns can track against the plan.
          if (deps.executionPlan && deps.sepConfig && !deps.executionPlan.current) {
            const assistantTextForPlan = Array.isArray(assistantMsg?.content)
              ? assistantMsg!.content
                  .filter((c: unknown) => (c as { type?: string })?.type === "text")
                  .map((c: unknown) => (c as { text?: string }).text ?? "")
                  .join(" ")
              : "";

            if (assistantTextForPlan.length > 0) {
              const steps = extractPlanFromResponse(assistantTextForPlan, deps.sepConfig.maxSteps);
              if (steps && steps.length >= deps.sepConfig.minSteps) {
                const plan: ExecutionPlan = {
                  active: true,
                  request: (deps.sepMessageText ?? "").slice(0, 200),
                  steps,
                  completedCount: 0,
                  createdAtMs: systemNowMs(),
                };
                deps.executionPlan.current = plan;
                deps.logger.info(
                  {
                    agentId: deps.agentId,
                    stepCount: steps.length,
                    durationMs: deps.sepExecutionStartMs ? systemNowMs() - deps.sepExecutionStartMs : undefined,
                  },
                  "SEP plan extracted (mid-loop)",
                );
                deps.eventBus.emit("sep:plan_extracted", {
                  agentId: deps.agentId ?? "default",
                  sessionKey: formatSessionKey(deps.sessionKey),
                  stepCount: steps.length,
                  timestamp: systemNowMs(),
                });
              }
            }
          }

          {
            const plan = deps.executionPlan?.current;
            if (plan?.active) {
              const assistantContent = assistantMsg?.content;
              const assistantText = Array.isArray(assistantContent)
                ? assistantContent
                    .filter((c: unknown) => (c as { type?: string })?.type === "text")
                    .map((c: unknown) => (c as { text?: string }).text ?? "")
                    .join(" ")
                : "";

              const completionSignals = /\b(?:done|completed|finished|configured|set up|created|updated|verified|installed|removed|deleted|moved|renamed)\b/i;
              const currentStep = plan.steps.find(s => s.status === "in_progress");
              if (currentStep && completionSignals.test(assistantText)) {
                const oldStatus = currentStep.status;
                currentStep.status = "done";
                plan.completedCount++;
                deps.logger.debug(
                  { agentId: deps.agentId, stepIndex: currentStep.index, oldStatus, newStatus: "done" },
                  "SEP step completed",
                );
                // Advance to next pending step
                const nextStep = plan.steps.find(s => s.status === "pending");
                if (nextStep) {
                  nextStep.status = "in_progress";
                  deps.logger.debug(
                    { agentId: deps.agentId, stepIndex: nextStep.index, oldStatus: "pending", newStatus: "in_progress" },
                    "SEP step advanced",
                  );
                }
              }
            }
          }

          // Consecutive empty assistant turn detection
          {
            const assistantContent = assistantMsg?.content;
            const hasTextContent = Array.isArray(assistantContent) && assistantContent.some(
              (c: unknown) => {
                const block = c as { type?: string; text?: string };
                return block.type === "text" && block.text?.trim();
              },
            );
            const hasToolCalls = Array.isArray(assistantContent) && assistantContent.some(
              (c: unknown) => {
                const block = c as { type?: string };
                return block.type === "toolCall" || block.type === "tool_use";
              },
            );

            if (!hasTextContent && !hasToolCalls) {
              // Truly empty turn: no text, no tool calls
              m.consecutiveEmptyTurns++;
              if (m.consecutiveEmptyTurns >= 2) {
                deps.logger.warn(
                  {
                    consecutiveEmptyTurns: m.consecutiveEmptyTurns,
                    model: deps.model,
                    lastToolUsed: m.lastActiveToolName ?? "none",
                    contextTokens: m.lastContextUsage?.tokens ?? 0,
                    hint: "Model produced consecutive empty responses; may indicate a stall pattern or context issue",
                    errorKind: "dependency" as const,
                  },
                  "Consecutive empty assistant turns detected",
                );
              }
            } else {
              // Reset counter on any turn with content (text or tool calls)
              m.consecutiveEmptyTurns = 0;
            }
          }

          // Reset LLM turn timer for next turn
          m.turnStartMs = systemNowMs();
          break;
        }

        // -----------------------------------------------------------------
        // Auto-compaction lifecycle
        // -----------------------------------------------------------------
        case "compaction_start": {
          m.compactionStartMs = systemNowMs();
          deps.logger.info(
            { step: "compaction", sessionKey: formatSessionKey(deps.sessionKey) },
            "Auto-compaction started",
          );
          deps.eventBus.emit("compaction:started", {
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
            timestamp: systemNowMs(),
          });
          break;
        }

        case "compaction_end": {
          const compactionEvent = event as {
            result: { summary: string; firstKeptEntryId: string; tokensBefore: number } | undefined;
            aborted: boolean;
            willRetry: boolean;
            errorMessage?: string;
          };

          // Flush compaction summary to long-term memory
          let memoriesWritten = 0;
          if (compactionEvent.result?.summary && deps.memoryPort) {
            const entry = {
              id: randomUUID(),
              tenantId: deps.sessionKey.tenantId,
              userId: deps.sessionKey.userId,
              agentId: deps.agentId,
              content: compactionEvent.result.summary,
              trustLevel: "learned" as const,
              source: { who: "compaction", channel: deps.channelId },
              tags: ["compaction-summary"],
              createdAt: systemNowMs(),
            };
            // Fire-and-forget: never block event processing on memory I/O
            suppressError(deps.memoryPort.store(entry as MemoryEntry), "compaction memory flush");
            memoriesWritten = 1;
          }

          deps.eventBus.emit("compaction:flush", {
            sessionKey: deps.sessionKey,
            memoriesWritten,
            trigger: "soft",
            success: !compactionEvent.aborted && !!compactionEvent.result,
            timestamp: systemNowMs(),
          });

          const durationMs = m.compactionStartMs ? systemNowMs() - m.compactionStartMs : 0;
          m.compactionStartMs = 0; // reset

          // WARN for failure/abort
          if (compactionEvent.aborted || compactionEvent.errorMessage) {
            deps.logger.warn(
              {
                durationMs,
                aborted: compactionEvent.aborted,
                hasSummary: !!compactionEvent.result?.summary,
                memoriesWritten,
                ...(compactionEvent.errorMessage && { err: compactionEvent.errorMessage }),
                hint: compactionEvent.aborted
                  ? "Auto-compaction was aborted; context may be near capacity -- check if agent is stuck in a tool loop"
                  : "Auto-compaction failed; the session will retry on next turn",
                errorKind: "internal" as const,
              },
              "Auto-compaction failed",
            );
          } else {
            // INFO for successful completion
            deps.logger.info(
              {
                step: "compaction",
                durationMs,
                aborted: false,
                hasSummary: !!compactionEvent.result?.summary,
                memoriesWritten,
              },
              "Auto-compaction completed",
            );
          }
          break;
        }

        // -----------------------------------------------------------------
        // SDK auto-retry loop: abort on rate_limited
        // -----------------------------------------------------------------
        case "auto_retry_start": {
          const errorMessage = (event as { errorMessage?: string }).errorMessage ?? "";
          const attempt = (event as { attempt?: number }).attempt;
          const maxAttempts = (event as { maxAttempts?: number }).maxAttempts;
          const delayMs = (event as { delayMs?: number }).delayMs;

          const classification = classifyError(new Error(errorMessage));
          if (classification.category === "rate_limited") {
            deps.logger.info(
              {
                submodule: "bridge.auto-retry-abort",
                attempt,
                maxAttempts,
                delayMs,
                errorMessage,
                hint: "Rate-limit windows are per-minute; SDK retry budget cannot bridge the window -- aborting retry to surface terminal failure",
                errorKind: "rate_limited" as const,
              },
              "Aborting SDK auto-retry on rate-limited error",
            );
            deps.onAbortRetry?.();
          }
          // Non-rate_limited categories (overloaded, network, server_error, etc.)
          // fall through -- let the SDK's normal retry-with-backoff proceed.
          break;
        }

        // -----------------------------------------------------------------
        // Default: ignore unknown event types (future SDK events)
        // -----------------------------------------------------------------
        default:
          break;
      }

      // Handle error detection from turn_end messages (stopReason === "error")
      if (event.type === "turn_end") {
        const turnMsg = (event as { message: unknown }).message as AssistantMessage | undefined;
        if (turnMsg && "stopReason" in turnMsg && turnMsg.stopReason === "error") {
          m.lastLlmErrorMessage = turnMsg.errorMessage ?? "Unknown LLM error";
          // HR-01 (v2.19): a ContextExhaustionError thrown by the context-engine
          // pre-flight during a MID-TURN continuation surfaces here as a turn_end
          // error with its message preserved (the SDK strips the `instanceof`, so
          // the top-level handleEnvelopeException mapping never runs). Recover the
          // signal and map it to finishReason:"context_exhausted" — this makes
          // postExecution deliver the honest buildContextExhaustedReply() instead
          // of letting the empty-turn recovery synthesize a false "the work was
          // done" summary. The provider is healthy; this is a local fit failure,
          // so it is a resource condition, not a dependency error. The wire-diff
          // diagnostic below is a no-op for this message (its regex needs
          // thinking-block-replay tokens), so we let it fall through.
          if (isContextExhaustionErrorMessage(m.lastLlmErrorMessage)) {
            m.finishReason = "context_exhausted";
            deps.logger.warn(
              {
                err: m.lastLlmErrorMessage,
                hint: "Context window exhausted mid-turn (pre-flight) — mapped to context_exhausted so the honest degraded reply is delivered; raise the agent's context window or narrow the ask",
                errorKind: "resource" as const,
              },
              "Context exhausted mid-turn — mapped to finishReason",
            );
          } else {
            deps.logger.warn(
              {
                err: m.lastLlmErrorMessage,
                hint: "Check LLM provider status",
                errorKind: "dependency" as const,
              },
              "LLM call returned error",
            );
          }
          // Wire-edge diagnostic: when the LLM error matches the Anthropic
          // signed-replay rejection signature ("thinking blocks ... cannot
          // be modified"), diff the in-memory content against the persisted
          // JSONL canonical and emit one ERROR per divergent block. Fully
          // async / fire-and-forget — never blocks the existing error path.
          // Silent no-op when the signature doesn't match or when either
          // getSessionMessages / getSessionJsonlPath is unwired.
          //
          // ALWAYS emit ONE dispatch-decision INFO log carrying boolean flags
          // that explain WHY the wire-diff dispatch was or was not entered
          // (regex match, candidate count, callback presence) — even when
          // regexMatched is false or callbacks are unwired. When the dispatch
          // IS entered, emit a second dispatch-completion INFO after the
          // async candidates loop completes.
          //
          // The signature regex matches Anthropic's actual 400 message:
          // "messages.N.content.M: thinking blocks cannot be modified"
          // and the redacted_thinking variant. Both `thinking|redacted_thinking`
          // AND `modif|cannot` must be present to avoid false positives on
          // unrelated 400s (rate limits, auth, schema errors).
          {
            const errMsg = m.lastLlmErrorMessage;
            const regexMatched =
              typeof errMsg === "string" &&
              /thinking|redacted_thinking/.test(errMsg) &&
              /modif|cannot/.test(errMsg);
            const liveForDecision = deps.getSessionMessages?.();
            const jsonlPathForDecision = deps.getSessionJsonlPath?.();

            // Pre-compute candidatesFound by walking liveForDecision with the
            // same filter the dispatch uses. Cap at 3 to mirror dispatch behavior.
            type Candidate = { responseId: string; content: ReadonlyArray<Record<string, unknown>> };
            const candidates: Candidate[] = [];
            if (Array.isArray(liveForDecision)) {
              for (let i = liveForDecision.length - 1; i >= 0 && candidates.length < 3; i--) {
                // eslint-disable-next-line security/detect-object-injection -- numeric loop index
                const msg = liveForDecision[i] as { role?: string; responseId?: string; content?: unknown };
                if (!msg || typeof msg !== "object") continue;
                if (msg.role !== "assistant") continue;
                if (typeof msg.responseId !== "string") continue;
                if (!Array.isArray(msg.content)) continue;
                const blocks = msg.content as Array<Record<string, unknown>>;
                const hasSigned = blocks.some(
                  (b) =>
                    b.type === "thinking" &&
                    typeof b.thinkingSignature === "string" &&
                    (b.thinkingSignature as string).length > 0 &&
                    b.redacted !== true,
                );
                if (!hasSigned) continue;
                candidates.push({ responseId: msg.responseId, content: blocks });
              }
            }

            const jsonlPathPresent =
              typeof jsonlPathForDecision === "string" && jsonlPathForDecision.length > 0;

            deps.logger.info(
              {
                submodule: "bridge.wire-diff",
                regexMatched,
                candidatesFound: candidates.length,
                jsonlPathPresent,
                getSessionMessagesPresent: typeof deps.getSessionMessages === "function",
                getSessionJsonlPathPresent: typeof deps.getSessionJsonlPath === "function",
              },
              "Wire-edge diff dispatch decision",
            );

            if (regexMatched && jsonlPathPresent && candidates.length > 0) {
              const capturedJsonlPath = jsonlPathForDecision;
              // Async non-blocking dispatch -- never blocks the error path.
              void Promise.resolve().then(async () => {
                let candidatesProcessed = 0;
                let totalDivergences = 0;
                let persistedNotFound = 0;
                let fileReadErrors = 0;

                // Wrapped logger forwards to deps.logger AND counts the
                // helper's WARN outcomes by hint-constant identity (no regex).
                const countingLogger = {
                  warn: (obj: Record<string, unknown>, msg: string) => {
                    deps.logger.warn(obj, msg);
                    if (obj.hint === WIRE_DIFF_HINT_FILE_MISSING) fileReadErrors++;
                    else if (obj.hint === WIRE_DIFF_HINT_NOT_FOUND) persistedNotFound++;
                  },
                };

                try {
                  for (const c of candidates) {
                    candidatesProcessed++;
                    const entries = await diffThinkingBlocksAgainstPersisted(
                      c.content,
                      c.responseId,
                      capturedJsonlPath,
                      { logger: countingLogger },
                    );
                    totalDivergences += entries.length;
                    for (const entry of entries) {
                      deps.logger.error(
                        {
                          submodule: "bridge.wire-diff",
                          responseId: c.responseId,
                          blockIndex: entry.blockIndex,
                          persistedHash: entry.persistedHash,
                          inMemoryHash: entry.inMemoryHash,
                          persistedText: entry.persistedText,
                          inMemoryText: entry.inMemoryText,
                          persistedSigLen: entry.persistedSigLen,
                          inMemorySigLen: entry.inMemorySigLen,
                          errorKind: "internal" as const,
                          hint:
                            "Mutation occurred between bridge restoration hook and " +
                            "pi-ai serialization — likely inside pi-ai or its dependencies",
                        },
                        "Wire-edge thinking-block divergence vs persisted JSONL",
                      );
                    }
                  }
                } catch {
                  // Diagnostic must NEVER abort the error path.
                }

                // ALWAYS emit the completion INFO, even on totalDivergences=0
                // or when every helper call hit a read error.
                deps.logger.info(
                  {
                    submodule: "bridge.wire-diff",
                    candidatesProcessed,
                    totalDivergences,
                    persistedNotFound,
                    fileReadErrors,
                  },
                  "Wire-edge diff dispatch complete",
                );
              });
            }
          }
          deps.circuitBreaker.recordFailure();
          deps.providerHealth?.recordFailure(deps.provider, deps.agentId);
          // If circuit breaker just opened, abort mid-execution
          // Delegated to bridge-safety-controls
          {
            const cbCheck = checkCircuitBreaker(deps.circuitBreaker, m.aborted);
            if (cbCheck.shouldAbort) {
              m.finishReason = cbCheck.finishReason!;
              m.abortResponse = buildAbortRedirectMessage(deps.executionPlan?.current, m.finishReason);
              m.aborted = true;
              emitCircuitBreakerAbort(deps);
            }
          }
        }
      }
    } catch (listenerError) {
      // Never throw from the listener -- all errors must be caught and logged
      deps.logger.warn(
        {
          err: listenerError,
          eventType: event.type,
          hint: "Event bridge listener encountered unexpected error; execution continues",
          errorKind: "internal" as const,
        },
        "Event bridge listener error",
      );
    }
  };

  const getResult = () => buildBridgeResult(m, deps.stepCounter.getCount());

  /** Accumulate estimated cost from a timed-out API request. */
  const addGhostCost = (estimated: GhostCostEstimate): void => {
    m.ghostCostUsd += estimated.costUsd;
    m.timedOutRequests += 1;
  };

  // Typed ReadonlyMap accessor for the executor's pre-call closure.
  // Returns views over the live maps -- the executor never receives the
  // mutable `m` object itself.
  const getThinkingBlockStores = (): {
    hashes: ReadonlyMap<string, ReadonlyArray<ThinkingBlockHash>>;
    canonical: ReadonlyMap<string, ReadonlyArray<unknown>>;
  } => ({
    hashes: m.thinkingBlockHashes,
    canonical: m.thinkingBlockCanonical,
  });

  // Expose the per-composite-key drain inflight gate so executor-post-
  // execution can fire an end-of-turn backstop drainAt that shares the SAME
  // gate map as the bridge's tool_execution_end call site. The returned
  // object has a live reference to the underlying Map -- mutations from the
  // bridge AND the executor post-execution path land in the same state
  // container, satisfying the single-tick gate contract.
  const getDrainState = (): DrainInflightState => ({
    drainInflightByKey: m.drainInflightByKey,
  });

  // ATTR-01: ReadonlySet view of the per-turn attributed skill ids. The
  // executor reads this back at the postExecution call site (carrier → the
  // memory:skill_used write-back). Read-only — `m` is never exported.
  const getUsedSkillIds = (): ReadonlySet<string> => m.turnUsedSkillIds;

  return { listener, getResult, addGhostCost, getThinkingBlockStores, getDrainState, getUsedSkillIds };
}
