// SPDX-License-Identifier: Apache-2.0
/**
 * Shared executor types used by PiExecutor and PiEventBridge.
 *
 * @module
 */

import type { SessionKey, NormalizedMessage, SpawnPacket, ModelOperationType } from "@comis/core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
// CommandDirectives canonical home is @comis/orchestrator/src/commands/types.ts.
// Agent uses a local mirror to avoid the orchestrator → agent circular dep
// (see file docstring there).
import type { CommandDirectives } from "./command-directive-types.js";
import type { StepCounter } from "./step-counter.js";
import type { ComisSessionManager } from "../session/comis-session-manager.js";
import type { TimeoutSource } from "../model/operation-model-resolver.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a single agent execution cycle. */
export interface ExecutionResult {
  response: string;
  sessionKey: SessionKey;
  /** PER-EXECUTION token totals (the bridge's accumulation for THIS execute()
   *  call) — scope-consistent with `cost`. For the session-cumulative total
   *  (across every execution on the persisted session) read `sessionTokensUsed`. */
  tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  /** SDK CUMULATIVE session token totals (all executions on the persisted
   *  session) — the `/status` / session-inspect view. Absent when the SDK
   *  reported no stats (e.g. an abort before any LLM call). Distinct from the
   *  per-execution `tokensUsed` so a per-execution log line / obs row never
   *  reports a session-cumulative token count beside a per-execution cost. */
  sessionTokensUsed?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost: {
    total: number;
    cacheSaved?: number;
    /** Estimated cost of timed-out API requests (additive, not included in total). */
    ghostCostUsd?: number;
    /** Number of API requests that timed out. */
    timedOutRequests?: number;
    /** Session-cumulative total cost across all turns (USD). */
    executionCostUsd?: number;
    /** Session-cumulative cache savings across all turns (USD). */
    executionCacheSavedUsd?: number;
  };
  stepsExecuted: number;
  llmCalls: number;
  // prompt_timeout is the PromptTimeoutError terminal —
  // END_REASON_MAP translates it to endReason timeout (the named cause).
  // spend_exceeded is the dollars kill-switch terminal —
  // a DEDICATED member (not a reuse of budget_exceeded, which is the token cap)
  // so the dollars-vs-tokens cause stays distinct. SafetyCheckResult.finishReason
  // (bridge-safety-controls.ts) is typed off this; checkSpendLimit returns it.
  finishReason: "stop" | "max_steps" | "budget_exceeded" | "budget_exhausted" | "circuit_open" | "provider_degraded" | "context_loop" | "context_exhausted" | "output_starved" | "session_reset" | "loop_detected" | "prompt_timeout" | "spend_exceeded" | "error";
  /** Ordered list of tool names invoked during execution (for post-mortem analysis). */
  toolCallHistory?: string[];
  /** Narrate-without-emit nudge outcome (small/nano only). A fired-but-
   *  unrecovered nudge promotes the clean would-be terminal to the named
   *  degraded cause `narration_stall` at the post-execution chokepoint. */
  narrateNudge?: { fired: boolean; recovered: boolean };
  /** Structured error classification for non-successful executions (operator-only, never user-facing). */
  errorContext?: {
    errorType: string;
    retryable: boolean;
    originalError?: string;
    /** Tool that was in-flight when the error occurred (e.g., during PromptTimeout). */
    failingTool?: string;
  };
  /** Per-turn budget tracking metrics (undefined if no user budget active). */
  budgetMetrics?: {
    /** User-requested budget in tokens (from +Nk / /budget directive). */
    requestedBudget: number;
    /** Effective budget after operator cap reconciliation. */
    effectiveBudget: number;
    /** Whether the user budget was capped by operator limits. */
    wasCapped: boolean;
    /** Final utilization ratio (0.0 to 1.0+). */
    utilization: number;
    /** Number of continuations executed. */
    continuations: number;
    /** Stop reason from tracker (budget_reached | diminishing_returns | max_continuations | under_budget). */
    stopReason: string;
  };
  /** Silent Execution Planner metrics (undefined if SEP inactive).
   *  SEP is observability-only: plan extraction + step counting
   *  remain; enforcement is handled by the post-batch continuation
   *  handler, not an SEP nudge. */
  plannerMetrics?: {
    stepsPlanned: number;
    stepsCompleted: number;
    stepsSkipped: number;
    planExtractionTurn: number;
  };
  /** Post-batch continuation handler outcome (undefined when handler did
   *  not run, e.g., guardrail failed before reaching it). */
  continuationMetrics?: {
    fired: boolean;
    attempts: number;
    outcome: "recovered" | "still_empty" | "max_attempts_exhausted" | "disabled" | "no_match";
  };
}

/** Optional overrides for per-execution behavior (e.g., sub-agent isolation). */
// @optional-field-count: 13 — ExecutionOverrides is the per-EXECUTION override bag;
// every `?` field is an independent per-run knob the caller MAY set (stepCounter/
// tokenBudget for sub-agent isolation, spawnPacket/model/cacheRetention/skipRag/
// graphId/nodeId/activeToolGroups for graph nodes, ephemeralSessionAdapter/skipSep/
// promptTimeout, and workspaceDir for an isolated worktree run). They are
// not a cluster-split candidate — each describes ONE execution's override surface,
// applied at distinct executor chokepoints; `operationType` is the only required field.
export interface ExecutionOverrides {
  /** Override the shared StepCounter with a fresh instance.
   *  When provided, this counter is used instead of the deps.stepCounter. */
  stepCounter?: StepCounter;
  /** Per-execution token cap for sub-agent isolation.
   *  Fed to budgetGuard.resetExecution(cap); checkBudget enforces
   *  min(config.perExecution, tokenBudget) so a runaway child is stopped
   *  mid-run. Absent ⇒ resetExecution() with no cap (config.perExecution). */
  tokenBudget?: number;
  /** Spawn packet for sub-agent context injection.
   *  When provided, prompt assembly uses it to build an enriched system prompt. */
  spawnPacket?: SpawnPacket;
  /** Model override for per-node graph execution.
   *  Format: "provider:modelId" (e.g., "anthropic:claude-sonnet-4-20250514").
   *  When provided, pi-executor resolves this model instead of the agent's default. */
  model?: string;
  /** Cache retention override for per-execution TTL control.
   *  "short" = 5m TTL (pipeline sub-agents), "long" = 1h TTL (user conversations), "none" = no caching. */
  cacheRetention?: "none" | "short" | "long";
  /** Skip RAG memory injection for graph pipeline sub-agents that receive
   *  context via the graph envelope. Prevents cross-run memory contamination
   *  from the tenantId-only RAG search that lacks graphId awareness. */
  skipRag?: boolean;
  /** Ephemeral session adapter override for sub-agent in-memory sessions.
   *  When provided, PiExecutor uses this instead of deps.sessionAdapter for
   *  withSession and writeSessionMetadata calls. Skips write lock and JSONL persistence. */
  ephemeralSessionAdapter?: ComisSessionManager;
  /** Skip SEP for pipeline/graph nodes that have their own orchestration. */
  skipSep?: boolean;
  /** Per-operation prompt timeout override. When set, shadows config.promptTimeout for ALL LLM calls in this execution.
   *  `source` labels which resolution level produced promptTimeoutMs — carried,
   *  never re-derived (the cron producer materializes this object
   *  unconditionally, so the label cannot be inferred at decode). Absent ⇒
   *  treated as operation_explicit at decode. */
  promptTimeout?: { promptTimeoutMs?: number; retryPromptTimeoutMs?: number; source?: TimeoutSource };
  /** Operation type for cost attribution and timeout resolution. */
  operationType: ModelOperationType;
  /** Graph ID for cache write signal emission. Set only for graph subagents. */
  graphId?: string;
  /** Graph node ID for cache write signal emission. Set only for graph subagents. */
  nodeId?: string;
  /** Active tool group names for the sub-agent's profile ceiling.
   *  When provided, "Tool X not found" errors in tool_execution_end are
   *  enriched with delegation routing hints. Omit for top-level
   *  agents where all tools are reachable. */
  activeToolGroups?: string[];
  /**
   * Per-run workspace override — the child's file-tool jail cwd for THIS
   * execution. A `spawn --worktree` child runs in an ISOLATED git worktree, so the
   * daemon passes the worktree dir here; the executor uses it as the SDK session
   * cwd + the resource-loader / command-handler / context-engine workspace root,
   * so exec/read/write/edit resolve inside the worktree (still attenuated + jailed
   * — the worktree is confined under the agent's own jailed workspace).
   * Absent ⇒ `deps.workspaceDir` (the agent's shared workspace — today's path,
   * byte-identical).
   */
  workspaceDir?: string;
}

/** Agent executor interface. */
export interface AgentExecutor {
  /** Execute a message through the agent with all safety controls. */
  execute(
    msg: NormalizedMessage,
    sessionKey: SessionKey,
    tools?: AgentTool[],
    onDelta?: (delta: string, kind: "text" | "thinking") => void,
    agentId?: string,
    directives?: CommandDirectives,
    prevTimestamp?: number,
    overrides?: ExecutionOverrides,
  ): Promise<ExecutionResult>;
}
