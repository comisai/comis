// SPDX-License-Identifier: Apache-2.0
/**
 * Model failover pipeline for PiExecutor.
 *
 * The SDK handles transient retry (429/5xx) with exponential backoff via
 * SettingsManager.retry configuration. This module handles the higher-level
 * failover concerns that the SDK does not provide:
 *
 * - Auth key rotation -- when an API key is exhausted or revoked,
 *   rotate to the next available key for the same provider.
 * - Model fallback -- when all keys for the primary model/provider
 *   are exhausted, fall back to alternate models in priority order.
 *
 * Each `session.prompt()` call benefits from SDK internal retry before
 * Comis failover triggers.
 *
 * Steps:
 * 1. Attempt primary prompt (SDK handles transient retry internally)
 * 2. On failure, try key rotation if authRotation available
 * 3. Loop through fallback models
 * 4. Emit model:fallback_attempt and model:fallback_exhausted events
 * 5. Return { succeeded, error }
 *
 * @module
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TypedEventBus, ClockPort, TimerPort } from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { tryGetContext } from "@comis/core";
import type { AuthRotationAdapter } from "../model/auth-rotation-adapter.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import type { LastKnownModelTracker } from "../model/last-known-model.js";
import type { TimeoutSource } from "../model/operation-model-resolver.js";
import { withPromptTimeout, withResettablePromptTimeout, PromptTimeoutError } from "./prompt-timeout.js";
import { describeTimeoutKnob, describeRetryTimeoutKnob } from "./timeout-knob.js";
import { normalizeModelId } from "../provider/model-id-normalize.js";
import { classifyError } from "./error-classifier.js";
import type { Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Cache-aware short retry constants
// ---------------------------------------------------------------------------

/**
 * Maximum retry-after duration (ms) for cache-preserving short retry.
 * Below this threshold: sleep and retry with same model to preserve cache hit.
 * Above this threshold: fall through to auth rotation / model fallback.
 */
const SHORT_RETRY_THRESHOLD_MS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for the model failover pipeline (auth rotation + model fallback). */
export interface ModelRetryParams {
  session: AgentSession;
  messageText: string;
  promptImages?: ImageContent[];
  onProviderStart?: () => Result<void, Error>;
  config: { provider: string; model: string };
  /** Session-resolved model string ("provider:modelId") for diagnostic logging. */
  resolvedModel?: string;
  timeoutConfig: {
    promptTimeoutMs: number;
    retryPromptTimeoutMs: number;
    /**
     * Makespan ceiling = promptTimeoutMs × stallCeilingMultiplier,
     * threaded into the primary race (non-optional wherever stall
     * semantics apply; production callers always pass it). Optional on the
     * carrier so hand-built carriers keep compiling.
     */
    stallCeilingMultiplier?: number;
    /** Timeout binding provenance — feeds bindingKnob on timeout emits. */
    source?: TimeoutSource;
    operationType?: string;
  };
  deps: {
    eventBus: TypedEventBus;
    logger: ComisLogger;
    authRotation?: AuthRotationAdapter;
    fallbackModels?: string[];
    modelRegistry: ModelRegistry;
    agentId?: string;
    sessionKey?: string;
    /** Optional provider health monitor for failure aggregation. */
    providerHealth?: ProviderHealthMonitor;
    /** Optional last-known-working model tracker for auth-failure fallback. */
    lastKnownModel?: LastKnownModelTracker;
    /** Callback to receive the resetTimer function from the resettable prompt timeout. */
    onResetTimer?: (resetFn: () => void) => void;
    /** Wall-clock + monotonic time reads. */
    clock: ClockPort;
    /** Timer scheduling. Short-retry uses timers.setTimeout. */
    timers: TimerPort;
  };
}

/** Result of the model failover pipeline. */
export interface ModelRetryResult {
  succeeded: boolean;
  error?: unknown;
  /** The model that ultimately succeeded (primary, fallback, or LKW). */
  effectiveModel?: { provider: string; model: string };
}

// ---------------------------------------------------------------------------
// Helpers used by the fallback loop
// ---------------------------------------------------------------------------

/**
 * Parse a "provider:modelId" string into provider and modelId components.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(modelStr: string): { provider: string; modelId: string } | undefined {
  const colonIdx = modelStr.indexOf(":");
  if (colonIdx <= 0 || colonIdx >= modelStr.length - 1) return undefined;
  return {
    provider: modelStr.slice(0, colonIdx),
    modelId: modelStr.slice(colonIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Helpers for cache-aware short retry
// ---------------------------------------------------------------------------

/** Extract HTTP status code from error, returning 0 if not found. */
function getErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) return 0;
  const errObj = error as unknown as Record<string, unknown>;
  if (typeof errObj.status === "number") return errObj.status;
  if (typeof errObj.statusCode === "number") return errObj.statusCode;
  return 0;
}

/**
 * Extract retry-after delay from API error.
 * Checks for `headers["retry-after"]` on the error object (pi-ai SDK errors
 * expose response headers). Returns milliseconds, or null if not available.
 */
function parseRetryAfterMs(error: unknown, clock: ClockPort): number | null {
  if (!(error instanceof Error)) return null;

  const errObj = error as unknown as Record<string, unknown>;

  // Check for retry-after header (may be on error.headers or error.responseHeaders)
  let retryAfter: string | undefined;

  if (errObj.headers && typeof errObj.headers === "object") {
    const headers = errObj.headers as Record<string, string>;
    retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  }
  if (!retryAfter && errObj.responseHeaders && typeof errObj.responseHeaders === "object") {
    const headers = errObj.responseHeaders as Record<string, string>;
    retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  }

  if (!retryAfter) return null;

  // retry-after can be seconds (integer) or HTTP-date
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try HTTP-date format
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - clock.now());
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auth error detection
// ---------------------------------------------------------------------------

/**
 * Check whether an error is an authentication/authorization failure (401/403).
 * Used to gate the last-known-working model fallback -- LKW only fires for
 * auth errors, not for rate limits or transient failures.
 */
export function isAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;
  if (error instanceof Error) {
    return /invalid.?api.?key|authentication|unauthorized|401|403|permission.?denied/i.test(
      error.message,
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Execute a prompt with auth rotation and model failover.
 *
 * Each `session.prompt()` call benefits from SDK internal retry (429/5xx
 * exponential backoff) before this function's failover logic triggers.
 * When SDK retry is exhausted, this function:
 * 1. Rotates API keys within the same provider
 * 2. Falls back to alternate models in priority order
 *
 * Emits structured events for observability.
 */
export async function runWithModelRetry(params: ModelRetryParams): Promise<ModelRetryResult> {
  const { session, messageText, promptImages, config, deps, timeoutConfig } = params;
  const { eventBus, logger, authRotation, modelRegistry, clock, timers } = deps;
  const fallbackModels = deps.fallbackModels ?? [];

  // Turn-scoping ids are stamped onto every model:* emit so
  // kind:"model" activity groups to the right turn. agentId/sessionKey come
  // from deps; traceId rides on the RequestContext (AsyncLocalStorage) — the
  // same source tool:* uses. Omit a field when absent so the optional schema
  // shape is honored. Resolved once per call (context is stable for the turn).
  const turnIds: { agentId?: string; sessionKey?: string; traceId?: string } = {
    ...(deps.agentId !== undefined && { agentId: deps.agentId }),
    ...(deps.sessionKey !== undefined && { sessionKey: deps.sessionKey }),
    ...(tryGetContext()?.traceId !== undefined && { traceId: tryGetContext()!.traceId }),
  };
  // Use session-resolved model for diagnostic logs, falling back to agent config default
  const displayModel = params.resolvedModel ?? `${config.provider}:${config.model}`;
  // Track total elapsed time across all retry attempts
  const retryStartMs = clock.now();
  const maxRetries = 1 + (authRotation?.hasProfiles(config.provider) ? 1 : 0) + fallbackModels.length;

  let promptError: unknown = undefined;
  let promptSucceeded = false;
  let effectiveModel: { provider: string; model: string } | undefined;

  const providerStart = params.onProviderStart?.();
  if (providerStart !== undefined && !providerStart.ok) {
    return Promise.reject(providerStart.error);
  }

  try {
    // Primary prompt uses resettable timeout so tool completions and stream
    // deltas can reset the deadline. Retry/fallback paths use
    // the original withPromptTimeout (fresh whole-turn timeout).
    const resettable = withResettablePromptTimeout(
      session.prompt(messageText, {
        expandPromptTemplates: false,
        images: promptImages,
      }),
      timeoutConfig.promptTimeoutMs,
      () => session.abort(),
      timers,
      {
        // The makespan ceiling is non-optional wherever stall semantics
        // apply — DERIVED here from the multiplier, never a standalone ms
        // knob. A delta-resetting runaway generation is bounded at
        // promptTimeoutMs × stallCeilingMultiplier.
        // initialBudgetMs deliberately NOT wired: scaling the first-activity
        // budget would stretch hang-detection latency from minutes to tens
        // of minutes, a cost accepted nowhere.
        // Clamped at Node's 32-bit timer cap (defense-in-depth against
        // hand-built configs that bypass the zod 1..100 bound): a product
        // > 2^31-1 makes setTimeout clamp the delay to 1ms — the ceiling
        // would fire INSTANTLY, every prompt killed at once, classified
        // makespan, and suppressed from providerHealth.
        ...(timeoutConfig.stallCeilingMultiplier !== undefined && {
          makespanMs: Math.min(
            timeoutConfig.promptTimeoutMs * timeoutConfig.stallCeilingMultiplier,
            2_147_483_647,
          ),
        }),
      },
    );
    // Expose resetTimer to the caller (pi-executor) for wiring to tool execution events
    deps.onResetTimer?.(resettable.resetTimer);
    await resettable.promise;
    promptSucceeded = true;
    effectiveModel = { provider: config.provider, model: config.model };
    // Record success for auth rotation cooldown tracking
    if (authRotation?.hasProfiles(config.provider)) {
      authRotation.recordSuccess(config.provider);
    }
  } catch (primaryError) {
    promptError = primaryError;
    logger.warn(
      {
        step: "retry",
        err: primaryError,
        model: displayModel,
        attempt: 1,
        maxRetries,
        totalElapsedMs: clock.now() - retryStartMs,
        hint: "Primary model failed, attempting fallback",
        // Timeouts are their own failure class — booking them as
        // "dependency" misclassified every prompt timeout in system rollups.
        errorKind: (primaryError instanceof PromptTimeoutError ? "timeout" : "dependency") as ErrorKind,
      },
      "Primary model prompt error",
    );

    // A grammar-compile/schema 400 is deterministic — rotating auth or
    // burning fallback models cannot fix a schema the provider can't compile.
    // Short-circuit the ladder; the executor's withSession-scoped strip-retry
    // (silent-failure-handlers.ts) owns the single repair attempt. The raw body
    // already rode the WARN above via the `err` serializer — not repeated here.
    if (classifyError(primaryError).category === "tool_schema_unsupported") {
      logger.warn(
        {
          step: "retry",
          model: displayModel,
          hint: "Tool schema rejected by provider (grammar-compile failure); skipping fallback ladder — the executor performs one strip-pattern/format retry, durable fix: models[].comisCompat.toolSchemaProfile: \"gbnf\"",
          errorKind: "validation" as ErrorKind,
        },
        "Schema-unsupported error: fallback ladder skipped",
      );
      return { succeeded: false, error: primaryError };
    }

    // Emit prompt timeout event for observability (full attribution —
    // numbers + enum + the pre-rendered config-KEY string only, never delta
    // content or env values).
    if (primaryError instanceof PromptTimeoutError) {
      eventBus.emit("execution:prompt_timeout", {
        agentId: deps.agentId ?? "unknown",
        sessionKey: deps.sessionKey ?? "unknown",
        timeoutMs: primaryError.timeoutMs,
        timestamp: clock.now(),
        durationMs: clock.now() - retryStartMs,
        ...(primaryError.limit !== undefined && { limit: primaryError.limit }),
        ...(timeoutConfig.source !== undefined && { source: timeoutConfig.source }),
        bindingKnob: describeTimeoutKnob(timeoutConfig.source ?? "agent_config", deps.agentId, timeoutConfig.operationType),
        ...(timeoutConfig.operationType !== undefined && { operationType: timeoutConfig.operationType }),
        ...(primaryError.stallBudgetMs !== undefined && { stallBudgetMs: primaryError.stallBudgetMs }),
        ...(primaryError.makespanMs !== undefined && { makespanMs: primaryError.makespanMs }),
      });
    }

    // Feed failure into provider health monitor — EXCEPT makespan-kills.
    // A makespan-kill is the model streaming forever (runaway), not
    // the provider failing; booking it would let slow-prefill turns trip the
    // safety gate into provider_degraded skips. Stall-kills (indistinguishable
    // from a hung provider) still record.
    const isPrimaryMakespanKill =
      primaryError instanceof PromptTimeoutError && primaryError.limit === "makespan";
    if (isPrimaryMakespanKill) {
      logger.debug(
        {
          step: "retry",
          provider: config.provider,
          errorKind: "timeout" as ErrorKind,
          hint: "makespan kill suppressed from providerHealth (model runaway, not provider failure)",
        },
        "Provider-health recording suppressed for makespan kill",
      );
    } else {
      deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");
    }

    // Cache-aware short retry -- preserve model string for cache hit.
    // If the error is a rate limit (429/529) with a short retry-after,
    // sleep and retry once with the SAME model before key rotation or fallback.
    if (!promptSucceeded) {
      const status = getErrorStatus(primaryError);
      if (status === 429 || status === 529) {
        const retryAfterMs = parseRetryAfterMs(primaryError, clock);
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          logger.debug(
            { retryAfterMs, model: displayModel, sessionKey: deps.sessionKey },
            "Short retry -- preserving model for cache hit",
          );
          await new Promise<void>(r => { const h = timers.setTimeout(() => r(), retryAfterMs); void h; });
          try {
            // Scope decision: retry/fallback prompts KEEP whole-turn
            // retryPromptTimeoutMs semantics (non-resettable) — pinned
            // by test; extend only if local retries die spuriously in
            // practice. Applies to ALL withPromptTimeout sites in this function.
            await withPromptTimeout(
              session.prompt(messageText, { expandPromptTemplates: false, images: promptImages }),
              timeoutConfig.retryPromptTimeoutMs,
              () => session.abort(),
              timers,
            );
            promptSucceeded = true;
            promptError = undefined;
            effectiveModel = { provider: config.provider, model: config.model };
            // Record success for auth rotation tracking
            if (authRotation?.hasProfiles(config.provider)) {
              authRotation.recordSuccess(config.provider);
            }
            logger.info(
              { retryAfterMs, model: displayModel },
              "Short retry succeeded with same model",
            );
          } catch (shortRetryError) {
            logger.debug(
              { err: shortRetryError, retryAfterMs },
              "Short retry failed, falling through to rotation/fallback",
            );
            promptError = shortRetryError;
            // Fall through to existing auth rotation / model fallback
          }
        }
      }
    }

    // Try rotating API key before falling back to a different model
    if (!promptSucceeded && authRotation?.hasProfiles(config.provider)) {
      const rotated = authRotation.rotateKey(config.provider);
      if (rotated) {
        logger.info(
          { provider: config.provider },
          "Rotated API key for provider",
        );
        // Retry with the same model but rotated key
        try {
          await withPromptTimeout(
            session.prompt(messageText, { expandPromptTemplates: false, images: promptImages }),
            timeoutConfig.retryPromptTimeoutMs,
            () => session.abort(),
            timers,
          );
          promptSucceeded = true;
          promptError = undefined;
          effectiveModel = { provider: config.provider, model: config.model };
          authRotation.recordSuccess(config.provider);
          logger.info(
            { provider: config.provider },
            "Retry with rotated key succeeded",
          );
        } catch (rotatedKeyError) {
          promptError = rotatedKeyError;
          logger.warn(
            {
              err: rotatedKeyError,
              attempt: 2,
              maxRetries,
              totalElapsedMs: clock.now() - retryStartMs,
              hint: "Rotated key also failed, proceeding to model fallback",
              // A timeout on the rotated-key retry is a timeout, not
              // an auth failure — keep "auth" only for non-timeout errors.
              errorKind: (rotatedKeyError instanceof PromptTimeoutError ? "timeout" : "auth") as ErrorKind,
            },
            "Rotated key retry failed",
          );
          // Emit prompt timeout event on rotation retry timeout (full
          // attribution; `limit` absent ⇒ whole-turn retry semantics — the
          // kill that fired is the retryPromptTimeoutMs race, so the knob is
          // the RETRY key, never the promptTimeoutMs binding that
          // timeoutConfig.source describes).
          if (rotatedKeyError instanceof PromptTimeoutError) {
            eventBus.emit("execution:prompt_timeout", {
              agentId: deps.agentId ?? "unknown",
              sessionKey: deps.sessionKey ?? "unknown",
              timeoutMs: rotatedKeyError.timeoutMs,
              timestamp: clock.now(),
              durationMs: clock.now() - retryStartMs,
              ...(rotatedKeyError.limit !== undefined && { limit: rotatedKeyError.limit }),
              ...(timeoutConfig.source !== undefined && { source: timeoutConfig.source }),
              bindingKnob: rotatedKeyError.limit === undefined
                ? describeRetryTimeoutKnob(deps.agentId)
                : describeTimeoutKnob(timeoutConfig.source ?? "agent_config", deps.agentId, timeoutConfig.operationType),
              ...(timeoutConfig.operationType !== undefined && { operationType: timeoutConfig.operationType }),
              ...(rotatedKeyError.stallBudgetMs !== undefined && { stallBudgetMs: rotatedKeyError.stallBudgetMs }),
              ...(rotatedKeyError.makespanMs !== undefined && { makespanMs: rotatedKeyError.makespanMs }),
            });
          }
          // Feed rotation failure into provider health monitor — makespan-kill
          // suppression mirrors the primary site (structurally dead on
          // this whole-turn path today, but the gate keeps the split uniform).
          const isRotatedMakespanKill =
            rotatedKeyError instanceof PromptTimeoutError && rotatedKeyError.limit === "makespan";
          if (isRotatedMakespanKill) {
            logger.debug(
              {
                step: "retry",
                provider: config.provider,
                errorKind: "timeout" as ErrorKind,
                hint: "makespan kill suppressed from providerHealth (model runaway, not provider failure)",
              },
              "Provider-health recording suppressed for makespan kill",
            );
          } else {
            deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");
          }
          // Fall through to model fallback loop below
        }
      }
    }

    // Fallback retry loop (skipped if key rotation already succeeded)
    for (let i = 0; i < fallbackModels.length && !promptSucceeded; i++) {
      const fallbackModelStr = fallbackModels[i]!;
      try {
        // Emit model:fallback_attempt event
        const parsed = parseModelString(fallbackModelStr);
        eventBus.emit("model:fallback_attempt", {
          fromProvider: config.provider,
          fromModel: config.model,
          toProvider: parsed?.provider ?? "unknown",
          toModel: parsed?.modelId ?? fallbackModelStr,
          error: promptError instanceof Error ? promptError.message : "unknown",
          attemptNumber: i + 1,
          timestamp: clock.now(),
          ...turnIds,
        });
        logger.info(
          { fallbackModel: fallbackModelStr },
          "Model fallback attempt",
        );

        // Resolve and set the fallback model
        // Normalize fallback model ID before registry lookup
        if (parsed) {
          const normalizedFallback = normalizeModelId(parsed.provider, parsed.modelId);
          const fallbackModelObj = modelRegistry.find(
            parsed.provider,
            normalizedFallback.modelId,
          );
          if (fallbackModelObj) {
            await session.setModel(fallbackModelObj);
          }
        }

        await withPromptTimeout(
          session.prompt(messageText, {
            expandPromptTemplates: false,
            images: promptImages,
          }),
          timeoutConfig.retryPromptTimeoutMs,
          () => session.abort(),
          timers,
        );
        promptSucceeded = true;
        promptError = undefined;
        if (parsed) {
          effectiveModel = { provider: parsed.provider, model: parsed.modelId };
        }
        logger.info(
          { fallbackModel: fallbackModelStr },
          "Fallback model succeeded",
        );
        break;
      } catch (fallbackError) {
        promptError = fallbackError;
        // attempt = primary(1) + rotation(0 or 1) + fallback index(i+1)
        const attemptNum = (authRotation?.hasProfiles(config.provider) ? 2 : 1) + i + 1;
        logger.warn(
          {
            err: fallbackError,
            fallbackModel: fallbackModelStr,
            attempt: attemptNum,
            maxRetries,
            totalElapsedMs: clock.now() - retryStartMs,
            hint: "Fallback model also failed",
            // Timeout class for PromptTimeoutError (system rollups).
            errorKind: (fallbackError instanceof PromptTimeoutError ? "timeout" : "dependency") as ErrorKind,
          },
          "Fallback model prompt error",
        );
        // Emit prompt timeout event on fallback timeout (full attribution;
        // `limit` absent ⇒ whole-turn retry semantics — the knob is the RETRY
        // key, never the promptTimeoutMs binding).
        if (fallbackError instanceof PromptTimeoutError) {
          eventBus.emit("execution:prompt_timeout", {
            agentId: deps.agentId ?? "unknown",
            sessionKey: deps.sessionKey ?? "unknown",
            timeoutMs: fallbackError.timeoutMs,
            timestamp: clock.now(),
            durationMs: clock.now() - retryStartMs,
            ...(fallbackError.limit !== undefined && { limit: fallbackError.limit }),
            ...(timeoutConfig.source !== undefined && { source: timeoutConfig.source }),
            bindingKnob: fallbackError.limit === undefined
              ? describeRetryTimeoutKnob(deps.agentId)
              : describeTimeoutKnob(timeoutConfig.source ?? "agent_config", deps.agentId, timeoutConfig.operationType),
            ...(timeoutConfig.operationType !== undefined && { operationType: timeoutConfig.operationType }),
            ...(fallbackError.stallBudgetMs !== undefined && { stallBudgetMs: fallbackError.stallBudgetMs }),
            ...(fallbackError.makespanMs !== undefined && { makespanMs: fallbackError.makespanMs }),
          });
        }
        // Feed fallback failure into provider health monitor — makespan-kill
        // suppression mirrors the primary site (structurally dead on this
        // whole-turn path today, but the gate keeps the split uniform).
        const isFallbackMakespanKill =
          fallbackError instanceof PromptTimeoutError && fallbackError.limit === "makespan";
        if (isFallbackMakespanKill) {
          logger.debug(
            {
              step: "retry",
              provider: config.provider,
              errorKind: "timeout" as ErrorKind,
              hint: "makespan kill suppressed from providerHealth (model runaway, not provider failure)",
            },
            "Provider-health recording suppressed for makespan kill",
          );
        } else {
          deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");
        }
        // Continue to next fallback
      }
    }

    // Emit exhaustion event if all fallbacks failed
    if (!promptSucceeded && fallbackModels.length > 0) {
      eventBus.emit("model:fallback_exhausted", {
        provider: config.provider,
        model: config.model,
        totalAttempts: fallbackModels.length + 1,
        timestamp: clock.now(),
        ...turnIds,
      });
    }

    // Last-known-working model fallback: when all configured models fail
    // with an auth error, try a model that recently succeeded somewhere
    // on this daemon (per-agent first, then daemon-wide from a different provider).
    if (!promptSucceeded && isAuthError(promptError) && deps.lastKnownModel) {
      const lkw =
        deps.lastKnownModel.getLastKnown(deps.agentId ?? "") ??
        deps.lastKnownModel.getAnyKnown(config.provider);

      if (lkw && (lkw.provider !== config.provider || lkw.model !== config.model)) {
        eventBus.emit("model:lkw_fallback_attempt", {
          fromProvider: config.provider,
          fromModel: config.model,
          toProvider: lkw.provider,
          toModel: lkw.model,
          timestamp: clock.now(),
          ...turnIds,
        });
        logger.info(
          { lkwProvider: lkw.provider, lkwModel: lkw.model },
          "Attempting last-known-working model fallback",
        );

        try {
          const normalizedLkw = normalizeModelId(lkw.provider, lkw.model);
          const lkwModelObj = modelRegistry.find(lkw.provider, normalizedLkw.modelId);
          if (lkwModelObj) {
            await session.setModel(lkwModelObj);
          }

          await withPromptTimeout(
            session.prompt(messageText, {
              expandPromptTemplates: false,
              images: promptImages,
            }),
            timeoutConfig.retryPromptTimeoutMs,
            () => session.abort(),
            timers,
          );
          promptSucceeded = true;
          promptError = undefined;
          effectiveModel = { provider: lkw.provider, model: lkw.model };

          logger.info(
            { lkwProvider: lkw.provider, lkwModel: lkw.model },
            "Last-known-working model fallback succeeded",
          );
        } catch (lkwError) {
          promptError = lkwError;
          logger.warn(
            {
              err: lkwError,
              lkwProvider: lkw.provider,
              lkwModel: lkw.model,
              hint: "Last-known-working model also failed",
              // Timeout class for PromptTimeoutError (system rollups).
              errorKind: (lkwError instanceof PromptTimeoutError ? "timeout" : "dependency") as ErrorKind,
            },
            "Last-known-working model fallback failed",
          );
          // Emit prompt timeout event on LKW timeout:
          // the explain verdict consumes the LAST execution.prompt_timeout
          // record — without this emit, a terminal LKW timeout left the
          // prior rotation/fallback kill as the "terminal" record and its
          // numbers described the wrong attempt. `limit` absent ⇒ whole-turn
          // retry semantics (same shape as the rotation/fallback sites).
          if (lkwError instanceof PromptTimeoutError) {
            eventBus.emit("execution:prompt_timeout", {
              agentId: deps.agentId ?? "unknown",
              sessionKey: deps.sessionKey ?? "unknown",
              timeoutMs: lkwError.timeoutMs,
              timestamp: clock.now(),
              durationMs: clock.now() - retryStartMs,
              ...(lkwError.limit !== undefined && { limit: lkwError.limit }),
              ...(timeoutConfig.source !== undefined && { source: timeoutConfig.source }),
              bindingKnob: lkwError.limit === undefined
                ? describeRetryTimeoutKnob(deps.agentId)
                : describeTimeoutKnob(timeoutConfig.source ?? "agent_config", deps.agentId, timeoutConfig.operationType),
              ...(timeoutConfig.operationType !== undefined && { operationType: timeoutConfig.operationType }),
              ...(lkwError.stallBudgetMs !== undefined && { stallBudgetMs: lkwError.stallBudgetMs }),
              ...(lkwError.makespanMs !== undefined && { makespanMs: lkwError.makespanMs }),
            });
          }
          // providerHealth deliberately NOT recorded here:
          // the LKW attempt runs against a DIFFERENT provider
          // chosen as a desperation fallback after an auth failure on the
          // configured ladder — booking its failure would extend the safety
          // gate's input surface beyond the 3 configured-path recordFailure
          // sites without a decision record.
        }
      }
    }
  }

  return { succeeded: promptSucceeded, error: promptError, effectiveModel };
}
