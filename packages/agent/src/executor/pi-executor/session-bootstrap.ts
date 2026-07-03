// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-lock session bootstrap: OAuth pre-resolve + ExecutionResult init +
 * SEP execution-plan ref + per-execution retention/min-tokens overrides
 * decoded from `ExecutionOverrides`.
 *
 * Closure-extraction protocol: state-by-parameter
 * (Readonly<SessionBootstrapState>). The mutable retention/min-tokens
 * references that the factory's downstream wrappers / cleanup paths require
 * are passed in as `{ get, set }` accessor pairs so this helper writes to
 * them WITHOUT capturing them via closure — preserving the contract that
 * every closure-extracted helper takes state explicitly.
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import { formatSessionKey } from "@comis/core";
import type {
  SessionKey,
  ModelOperationType,
} from "@comis/core";

import type { ExecutionResult, ExecutionOverrides } from "../types.js";
import type { TimeoutSource } from "../../model/operation-model-resolver.js";
import type { ExecutionPlan } from "../../planner/types.js";
import type { ExecutionPlanHolder } from "./execution-plan-holder.js";
import type { PiExecutorDeps } from "./pi-executor-types.js";
import type { AdaptiveCacheRetention } from "../adaptive-cache-retention.js";
import { resolveProviderApiKey } from "../../model/resolve-provider-api-key.js";
import {
  createAdaptiveCacheRetention,
  createStaticRetention,
} from "../adaptive-cache-retention.js";
import { setCacheWarm } from "../executor-session-state.js";
import type { PerAgentConfig } from "@comis/core";

/**
 * Mutable accessor pair — `{ get, set }` — used in place of `let` closures
 * so the closure-extracted helper writes to the factory's per-execute
 * scope explicitly rather than via closure capture.
 */
export interface MutableRef<T> {
  get(): T;
  set(value: T): void;
}

/**
 * State surface for session bootstrap. Empty fields-wise (only the canonical
 * `state` first param contract); the factory passes per-execute mutable
 * references via the `ctx` parameter so the helper can write back into
 * the factory's scope without closure capture.
 */
export interface SessionBootstrapState {
  readonly _empty?: never;
}

/**
 * Per-execute bootstrap output — the values the factory captures into its
 * `withSession` callback. `executionPlanRef` is a fresh ref object; the
 * other fields are derived from `overrides` / `config`.
 */
export interface SessionBootstrapResult {
  readonly executionStartMs: number;
  readonly result: ExecutionResult;
  readonly sepEnabled: boolean;
  readonly executionPlanRef: { current: ExecutionPlan | undefined };
}

/**
 * The merged per-execution timeout: values + binding provenance.
 * `source`/`operationType` feed knob-named hints (timeout-knob.ts) and the
 * execution:prompt_timeout payload. This is THE one effectiveTimeout shape —
 * RunSessionLockedContext and RunPromptParams alias it (three inline copies
 * unified). `stallCeilingMultiplier` threads the makespan ceiling through the
 * same shape.
 */
export interface EffectiveTimeout {
  promptTimeoutMs: number;
  retryPromptTimeoutMs: number;
  /**
   * makespan = promptTimeoutMs × stallCeilingMultiplier — non-optional
   * wherever stall semantics apply. The ceiling is DERIVED at the race call
   * site (model-retry), never a standalone ms knob.
   */
  stallCeilingMultiplier: number;
  source: TimeoutSource;
  operationType?: ModelOperationType;
}

/**
 * Per-execute override decode — separated from the bootstrap so the factory
 * can write the values into its own closure-scope `let`s via the provided
 * accessor refs.
 */
export interface OverrideDecodeResult {
  readonly effectiveTimeout: EffectiveTimeout;
}

/**
 * Pre-resolve OAuth + initialize ExecutionResult + SEP execution-plan ref.
 *
 * Runs BEFORE input-validation / safety-gate. The OAuth pre-resolve has a
 * critical side effect: `resolveProviderApiKey` sets the runtime API key
 * via the `setRuntimeApiKey` priority path, which pi-coding-agent's
 * outbound LLM dispatch reads. For OAuth-eligible providers (openai-codex,
 * anthropic, github-copilot via pi-ai's built-in registry) the resolver
 * chain runs and refreshes the token if expired. For non-OAuth providers
 * it falls through to `authStorage.getApiKey`.
 *
 * Throw-propagation: on OAuthError the helper throws an Error containing
 * the OAuthError.message. Outer async callers lift the throw into a
 * user-facing error response.
 */
export async function bootstrapSession(
  state: Readonly<SessionBootstrapState>,
  deps: PiExecutorDeps,
  ctx: {
    readonly config: PerAgentConfig;
    readonly sessionKey: SessionKey;
    readonly overrides: ExecutionOverrides | undefined;
    /**
     * Optional ExecutionPlanPort holder. When provided and SEP is
     * enabled for this turn, the per-turn `executionPlanRef` is published into
     * it so the gateway/ACP plan bridge reads the active plan via the port.
     * Absent in non-ACP runtimes — existing callers are unaffected.
     */
    readonly executionPlanHolder?: ExecutionPlanHolder;
  },
): Promise<SessionBootstrapResult> {
  void state;
  // a. Record execution start time
  const executionStartMs = deps.clock.now();

  // a-bis. Pre-resolve OAuth token before any pi-coding-agent dispatch.
  // See module JSDoc for the full safety rationale.
  await resolveProviderApiKey(ctx.config.provider, {
    authStorage: deps.authStorage,
    oauthManager: deps.oauthManager,
    agentConfig: ctx.config,
  });

  // b. Initialize result
  const result: ExecutionResult = {
    response: "",
    sessionKey: ctx.sessionKey,
    tokensUsed: { input: 0, output: 0, total: 0 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 0,
    finishReason: "stop",
  };

  // SEP: Initialize execution plan ref (shared with bridge via mutable ref)
  const sepEnabled = ctx.config.sep?.enabled !== false && !ctx.overrides?.skipSep;
  const executionPlanRef: { current: ExecutionPlan | undefined } = { current: undefined };

  // Keep the ExecutionPlanPort holder lifecycle SYMMETRIC so the
  // gateway/ACP plan bridge never reads a stale plan. A SEP-on turn publishes
  // the live per-turn ref (so a disabled turn does not point the port at a
  // never-populated ref); a SEP-off turn DE-PUBLISHES any ref left by
  // a prior SEP-on turn so getCurrentPlan() cannot project the previous turn's
  // plan during this turn (stale-plan leak).
  if (ctx.executionPlanHolder) {
    if (sepEnabled) {
      ctx.executionPlanHolder.publish(executionPlanRef);
    } else {
      ctx.executionPlanHolder.clear();
    }
  }

  return { executionStartMs, result, sepEnabled, executionPlanRef };
}

/**
 * Per-execute override decode — derives the effective timeout from the
 * 3-tier priority (explicit override > OPERATION_TIMEOUT_DEFAULTS >
 * agent-level config) and writes the cache retention / adaptive retention /
 * min-tokens overrides into the factory's `let` scope via accessor refs.
 *
 * State-by-parameter (Readonly<SessionBootstrapState>) preserves the
 * closure-extraction contract; the per-execute mutable references are
 * carried in `ctx.cacheRetentionRef` / `adaptiveRetentionRef` /
 * `minTokensOverrideRef` rather than via closure capture.
 */
export function decodeExecutionOverrides(
  state: Readonly<SessionBootstrapState>,
  deps: PiExecutorDeps,
  ctx: {
    readonly config: PerAgentConfig;
    readonly sessionKey: SessionKey;
    readonly overrides: ExecutionOverrides | undefined;
    readonly operationDefaults: Record<string, number | undefined>;
    readonly cacheRetentionRef: MutableRef<CacheRetention | undefined>;
    readonly adaptiveRetentionRef: MutableRef<AdaptiveCacheRetention | undefined>;
    readonly minTokensOverrideRef: MutableRef<number | undefined>;
  },
): OverrideDecodeResult {
  void state;
  void deps;
  const { config, sessionKey, overrides, operationDefaults } = ctx;

  // Per-execution cache retention override (mutable ref read by wrapper chain getter)
  const executionCacheRetention = overrides?.cacheRetention as CacheRetention | undefined;
  ctx.cacheRetentionRef.set(executionCacheRetention);

  // Per-operation timeout merge.
  // 3-tier priority: explicit override > OPERATION_TIMEOUT_DEFAULTS[operationType] > agent-level config.
  const operationDefaultTimeout = overrides?.operationType
    ? operationDefaults[overrides.operationType]
    : undefined;
  // Binding provenance: a present override CARRIES
  // the source its producer labeled — the cron producer materializes
  // promptTimeout unconditionally, so re-deriving here would call every cron
  // timeout "explicit". An override whose producer set no source label IS
  // explicit by the caller; otherwise the level that binds labels itself.
  const overrideMs = overrides?.promptTimeout?.promptTimeoutMs;
  const source: TimeoutSource =
    overrideMs !== undefined
      ? (overrides?.promptTimeout?.source ?? "operation_explicit")
      : operationDefaultTimeout !== undefined
        ? "operation_default"
        : "agent_config";
  const effectiveTimeout: EffectiveTimeout = {
    promptTimeoutMs:
      overrideMs
      ?? operationDefaultTimeout
      ?? config.promptTimeout.promptTimeoutMs,
    retryPromptTimeoutMs:
      overrides?.promptTimeout?.retryPromptTimeoutMs
      ?? config.promptTimeout.retryPromptTimeoutMs,
    // The schema's .default(10) guarantees presence post-parse; the
    // `?? 10` covers hand-built configs (e.g. test fixtures) that bypass
    // the zod parse.
    stallCeilingMultiplier: config.promptTimeout.stallCeilingMultiplier ?? 10,
    source,
    operationType: overrides?.operationType,
  };

  // Create adaptive retention.
  // Parent agents start at configRetention directly (typically "long"/1h) so the
  // initial system prompt write gets 1h TTL -- surviving gaps >5m (e.g. graph execution).
  // Sub-agents start at "short" (5m) since they complete in <60s and share prefix via stagger.
  // Session-scoped warm state is still useful for escalation tracking (onEscalated callback).
  const configRetention = executionCacheRetention ?? config.cacheRetention;
  if (configRetention && configRetention !== "none") {
    const formattedKeyForRetention = formatSessionKey(sessionKey);
    const isSubAgent = !!overrides?.spawnPacket;
    // Sub-agents use static retention. Graph subagents
    // (cacheRetention: "long" from setup-cross-session) get static "long" --
    // they never escalate but get 1h TTL. Non-graph subagents get static "short".
    // Parent agents use turn-based escalation (3+ turns required).
    const configRetentionForSubagent = (overrides?.cacheRetention ?? "short") as CacheRetention;
    const adaptiveRetention = isSubAgent
      ? createStaticRetention(configRetentionForSubagent)
      : createAdaptiveCacheRetention({
          coldStartRetention: configRetention,
          warmRetention: configRetention,
          escalationThreshold: 1000,
          onEscalated: () => setCacheWarm(formattedKeyForRetention, true),
        });
    ctx.adaptiveRetentionRef.set(adaptiveRetention);
  } else {
    ctx.adaptiveRetentionRef.set(undefined);
  }

  // Lower threshold for parent agents (1024) to enable message breakpoints.
  // Parent conversations have 500-2000 token messages -- 4096 default is too high.
  // Sub-agents: 512 (short sessions, system prompt dominates).
  ctx.minTokensOverrideRef.set(overrides?.spawnPacket ? 512 : 1024);

  return { effectiveTimeout };
}
