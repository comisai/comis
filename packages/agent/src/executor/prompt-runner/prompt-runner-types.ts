// SPDX-License-Identifier: Apache-2.0
/**
 * Public type surface for the prompt runner.
 *
 * Leaf modules (`envelope-wrapper.ts`, `budget-precheck.ts`, `retry-loop.ts`,
 * `output-escalation.ts`) import their types from THIS file, never from
 * `prompt-runner.ts`. The orchestrator itself is allowed to depend back on
 * this file (types-only) without violating the dependency-direction invariant.
 *
 * @module
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  NormalizedMessage,
  PerAgentConfig,
  SessionKey,
  TypedEventBus,
  OutputGuardPort,
  ClockPort,
  TimerPort,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import type { CommandDirectives } from "../command-directive-types.js";
import type { BudgetGuard } from "../../budget/budget-guard.js";
import type { CostTracker } from "../../budget/cost-tracker.js";
import type { ExecutionResult, ExecutionOverrides } from "../types.js";
import type { ExecutionPlan } from "../../planner/types.js";
import type { AuthRotationAdapter } from "../../model/auth-rotation-adapter.js";
import type { ProviderHealthMonitor } from "../../safety/provider-health-monitor.js";
import type { LastKnownModelTracker } from "../../model/last-known-model.js";
import type { EnvelopeConfig } from "@comis/core";
import type { CapabilityIndexRenderResult } from "../capability-index-context.js";
import type { ModelProfile } from "../model-profile.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge interface used by the prompt runner (minimal getResult). */
export interface PromptRunnerBridge {
  getResult(): {
    llmCalls?: number;
    finishReason?: string;
    textEmitted?: boolean;
    lastLlmErrorMessage?: string;
    lastStopReason?: string;
    tokensUsed?: { output?: number };
    stepsExecuted?: number;
    toolCallHistory?: string[];
    /** R2: Abort redirect message set at bridge abort sites; undefined for normal completions. */
    abortResponse?: string;
  };
}

/** Parameters for runPrompt(). */
export interface RunPromptParams {
  msg: NormalizedMessage;
  session: AgentSession;
  config: PerAgentConfig;
  sessionKey: SessionKey;
  formattedKey: string;
  agentId: string | undefined;
  result: ExecutionResult;
  executionOverrides: ExecutionOverrides | undefined;
  executionStartMs: number;
  effectiveTimeout: { promptTimeoutMs: number; retryPromptTimeoutMs: number };
  executionId: string;
  bridge: PromptRunnerBridge;
  // Prompt assembly data
  dynamicPreamble: string | undefined;
  deferredContext: string | undefined;
  /**
   * Per-turn capability-index render result. The .text field is concatenated
   * into the dynamic preamble via `[...].filter(Boolean).join("\n\n")`; the
   * count fields feed the Pino debug log below.
   */
  capabilityIndexResult: CapabilityIndexRenderResult;
  inlineMemory: string | undefined;
  systemPrompt: string | undefined;
  mergedCustomTools: Array<{ name: string; description?: string; parameters?: unknown }>;
  // Command/state
  cmdResult: { hasCommandDirective: boolean };
  sepEnabled: boolean;
  executionPlanRef: { current: ExecutionPlan | undefined };
  _directives: CommandDirectives | undefined;
  _prevTimestamp: number | undefined;
  resolvedModel: { id: string; provider: string; input?: string[] } | undefined;
  /** ModelProfile resolved once per execution; drives scaffoldLevel-gated features (R1 GoalAnchor). */
  modelProfile?: ModelProfile;
  // Deps
  deps: {
    eventBus: TypedEventBus;
    logger: ComisLogger;
    budgetGuard: BudgetGuard;
    costTracker: CostTracker;
    authRotation?: AuthRotationAdapter;
    fallbackModels?: string[];
    modelRegistry: ModelRegistry;
    providerHealth?: ProviderHealthMonitor;
    lastKnownModel?: LastKnownModelTracker;
    envelopeConfig?: EnvelopeConfig;
    outputGuard?: OutputGuardPort;
    canaryToken?: string;
    /** Wall-clock + monotonic time reads. */
    clock: ClockPort;
    /** Timer scheduling. */
    timers: TimerPort;
  };
  // Callbacks
  onResetTimer: (fn: (() => void) | undefined) => void;
  /** Returns last known cache write tokens from bridge metrics.
   *  Used to estimate cache reads for timed-out requests. */
  getLastCacheWriteTokens?: () => number;
  /** Budget trajectory warning: shared mutable ref set by bridge when warning fires. */
  budgetWarningRef?: { current: boolean };
}

/** Result of runPrompt(). */
export interface PromptRunResult {
  /** Whether the prompt succeeded (or was skipped). */
  promptSucceeded: boolean;
  /** The prompt error if it failed. */
  promptError: unknown;
  /** Whether escalation was attempted. */
  escalationAttempted: boolean;
  /** Ghost cost estimate from a timed-out API request (undefined if no timeout). */
  ghostCost?: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  /** Session was stuck with zero LLM calls; needs reset. */
  stuckSessionDetected?: boolean;
}
