// SPDX-License-Identifier: Apache-2.0
/**
 * Shared executor types used by PiExecutor and PiEventBridge.
 *
 * @module
 */

import type { SessionKey, NormalizedMessage, SpawnPacket, ModelOperationType } from "@comis/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CommandDirectives } from "../commands/types.js";
import type { StepCounter } from "./step-counter.js";
import type { ComisSessionManager } from "../session/comis-session-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a single agent execution cycle. */
export interface ExecutionResult {
  response: string;
  sessionKey: SessionKey;
  tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost: {
    total: number;
    cacheSaved?: number;
    /** Estimated cost of timed-out API requests (additive, not included in total). */
    ghostCostUsd?: number;
    /** Number of API requests that timed out. */
    timedOutRequests?: number;
    /** 1.3: Session-cumulative total cost across all turns (USD). */
    sessionCostUsd?: number;
    /** 1.3: Session-cumulative cache savings across all turns (USD). */
    sessionCacheSavedUsd?: number;
  };
  stepsExecuted: number;
  llmCalls: number;
  finishReason: "stop" | "max_steps" | "budget_exceeded" | "budget_exhausted" | "circuit_open" | "provider_degraded" | "context_loop" | "context_exhausted" | "session_reset" | "error";
  /** Ordered list of tool names invoked during execution (for post-mortem analysis). */
  toolCallHistory?: string[];
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
  /** Silent Execution Planner metrics (undefined if SEP inactive). */
  plannerMetrics?: {
    stepsPlanned: number;
    stepsCompleted: number;
    stepsSkipped: number;
    nudgeTriggered: boolean;
    planExtractionTurn: number;
  };
}

/** Optional overrides for per-execution behavior (e.g., sub-agent isolation). */
export interface ExecutionOverrides {
  /** Override the shared StepCounter with a fresh instance.
   *  When provided, this counter is used instead of the deps.stepCounter. */
  stepCounter?: StepCounter;
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
  /** Ephemeral session adapter override for sub-agent in-memory sessions (R-11).
   *  When provided, PiExecutor uses this instead of deps.sessionAdapter for
   *  withSession and writeSessionMetadata calls. Skips write lock and JSONL persistence. */
  ephemeralSessionAdapter?: ComisSessionManager;
  /** Skip SEP for pipeline/graph nodes that have their own orchestration. */
  skipSep?: boolean;
  /** Per-operation prompt timeout override. When set, shadows config.promptTimeout for ALL LLM calls in this execution. */
  promptTimeout?: { promptTimeoutMs?: number; retryPromptTimeoutMs?: number };
  /** Operation type for cost attribution and timeout resolution. */
  operationType: ModelOperationType;
  /** Graph ID for cache write signal emission. Set only for graph subagents. */
  graphId?: string;
  /** Graph node ID for cache write signal emission. Set only for graph subagents. */
  nodeId?: string;
}

/** Agent executor interface. */
export interface AgentExecutor {
  /** Execute a message through the agent with all safety controls. */
  execute(
    msg: NormalizedMessage,
    sessionKey: SessionKey,
    tools?: AgentTool[],
    onDelta?: (delta: string) => void,
    agentId?: string,
    directives?: CommandDirectives,
    prevTimestamp?: number,
    overrides?: ExecutionOverrides,
  ): Promise<ExecutionResult>;
}
