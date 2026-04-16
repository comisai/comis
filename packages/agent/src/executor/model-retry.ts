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

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { TypedEventBus } from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import type { AuthRotationAdapter } from "../model/auth-rotation-adapter.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import { withPromptTimeout, withResettablePromptTimeout, PromptTimeoutError } from "./prompt-timeout.js";
import { normalizeModelId } from "../provider/model-id-normalize.js";

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
  config: { provider: string; model: string };
  /** Session-resolved model string ("provider:modelId") for diagnostic logging. */
  resolvedModel?: string;
  timeoutConfig: {
    promptTimeoutMs: number;
    retryPromptTimeoutMs: number;
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
    /** Callback to receive the resetTimer function from the resettable prompt timeout. */
    onResetTimer?: (resetFn: () => void) => void;
  };
}

/** Result of the model failover pipeline. */
export interface ModelRetryResult {
  succeeded: boolean;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers (moved from pi-executor.ts -- only used by fallback loop)
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
function parseRetryAfterMs(error: unknown): number | null {
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
    return Math.max(0, dateMs - Date.now());
  }

  return null;
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
  const { eventBus, logger, authRotation, modelRegistry } = deps;
  const fallbackModels = deps.fallbackModels ?? [];
  // Use session-resolved model for diagnostic logs, falling back to agent config default
  const displayModel = params.resolvedModel ?? `${config.provider}:${config.model}`;
  // Track total elapsed time across all retry attempts
  const retryStartMs = Date.now();
  const maxRetries = 1 + (authRotation?.hasProfiles(config.provider) ? 1 : 0) + fallbackModels.length;

  let promptError: unknown = undefined;
  let promptSucceeded = false;

  try {
    // Primary prompt uses resettable timeout so tool completions can reset the
    // deadline. Retry/fallback paths use the original withPromptTimeout (fresh timeout).
    const resettable = withResettablePromptTimeout(
      session.prompt(messageText, {
        expandPromptTemplates: false,
        images: promptImages,
      }),
      timeoutConfig.promptTimeoutMs,
      () => session.abort(),
    );
    // Expose resetTimer to the caller (pi-executor) for wiring to tool execution events
    deps.onResetTimer?.(resettable.resetTimer);
    await resettable.promise;
    promptSucceeded = true;
    // Record success for auth rotation cooldown tracking
    if (authRotation?.hasProfiles(config.provider)) {
      authRotation.recordSuccess(config.provider);
    }
  } catch (primaryError) {
    promptError = primaryError;
    logger.warn(
      {
        err: primaryError,
        model: displayModel,
        attempt: 1,
        maxRetries,
        totalElapsedMs: Date.now() - retryStartMs,
        hint: "Primary model failed, attempting fallback",
        errorKind: "dependency" as ErrorKind,
      },
      "Primary model prompt error",
    );

    // Emit prompt timeout event for observability
    if (primaryError instanceof PromptTimeoutError) {
      eventBus.emit("execution:prompt_timeout", {
        agentId: deps.agentId ?? "unknown",
        sessionKey: deps.sessionKey ?? "unknown",
        timeoutMs: primaryError.timeoutMs,
        timestamp: Date.now(),
      });
    }

    // Feed failure into provider health monitor
    deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");

    // Cache-aware short retry -- preserve model string for cache hit.
    // If the error is a rate limit (429/529) with a short retry-after,
    // sleep and retry once with the SAME model before key rotation or fallback.
    if (!promptSucceeded) {
      const status = getErrorStatus(primaryError);
      if (status === 429 || status === 529) {
        const retryAfterMs = parseRetryAfterMs(primaryError);
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          logger.debug(
            { retryAfterMs, model: displayModel, sessionKey: deps.sessionKey },
            "Short retry -- preserving model for cache hit",
          );
          await new Promise(r => setTimeout(r, retryAfterMs));
          try {
            await withPromptTimeout(
              session.prompt(messageText, { expandPromptTemplates: false, images: promptImages }),
              timeoutConfig.retryPromptTimeoutMs,
              () => session.abort(),
            );
            promptSucceeded = true;
            promptError = undefined;
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
          );
          promptSucceeded = true;
          promptError = undefined;
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
              totalElapsedMs: Date.now() - retryStartMs,
              hint: "Rotated key also failed, proceeding to model fallback",
              errorKind: "auth" as ErrorKind,
            },
            "Rotated key retry failed",
          );
          // Emit prompt timeout event on rotation retry timeout
          if (rotatedKeyError instanceof PromptTimeoutError) {
            eventBus.emit("execution:prompt_timeout", {
              agentId: deps.agentId ?? "unknown",
              sessionKey: deps.sessionKey ?? "unknown",
              timeoutMs: rotatedKeyError.timeoutMs,
              timestamp: Date.now(),
            });
          }
          // Feed rotation failure into provider health monitor
          deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");
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
          timestamp: Date.now(),
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
        );
        promptSucceeded = true;
        promptError = undefined;
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
            totalElapsedMs: Date.now() - retryStartMs,
            hint: "Fallback model also failed",
            errorKind: "dependency" as ErrorKind,
          },
          "Fallback model prompt error",
        );
        // Emit prompt timeout event on fallback timeout
        if (fallbackError instanceof PromptTimeoutError) {
          eventBus.emit("execution:prompt_timeout", {
            agentId: deps.agentId ?? "unknown",
            sessionKey: deps.sessionKey ?? "unknown",
            timeoutMs: fallbackError.timeoutMs,
            timestamp: Date.now(),
          });
        }
        // Feed fallback failure into provider health monitor
        deps.providerHealth?.recordFailure(config.provider, deps.agentId ?? "unknown");
        // Continue to next fallback
      }
    }

    // Emit exhaustion event if all fallbacks failed
    if (!promptSucceeded && fallbackModels.length > 0) {
      eventBus.emit("model:fallback_exhausted", {
        provider: config.provider,
        model: config.model,
        totalAttempts: fallbackModels.length + 1,
        timestamp: Date.now(),
      });
    }
  }

  return { succeeded: promptSucceeded, error: promptError };
}
