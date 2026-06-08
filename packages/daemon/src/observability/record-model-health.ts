// SPDX-License-Identifier: Apache-2.0
/**
 * I2 — record a structured load-level `model_health` diagnostic at boot.
 *
 * Captures the three in-process load-level recall signals as a one-shot
 * `obs_diagnostics` row at startup, so a degraded-recall root cause (embedding
 * provider or reranker absent) is queryable cross-session via the fleet lens
 * (Phase 161) instead of living only as an ephemeral boot boolean + Pino line:
 *   - `embeddingAvailable`    — the cached embedding wrapper is present
 *                               (derived `!!cachedPort` at the boot site).
 *   - `rerankerModelPresent`  — the no-download GGUF presence probe.
 *   - `rerankerBuilt`         — the GGUF reranker provider loaded ok
 *                               (`rerankerPort !== undefined`).
 *
 * This is a boot-time SNAPSHOT — a direct `insertDiagnostic`, NOT an event. An
 * event would imply recurrence/streaming and go stale; a once-per-boot record
 * is the correct point-in-time model.
 *
 * `details` carries ONLY the three booleans — no provider secrets, no model
 * paths, no free text. Booleans cannot leak a credential (bounded-payload
 * discipline, §2.7). The native node-llama-cpp stdout tokenizer line is OUT of
 * scope; only the in-process flags we control are recorded.
 *
 * @module
 */
import type { ClockPort } from "@comis/core";
import type { ObservabilityStore } from "@comis/memory";

/** The three boot-time load-level model-health signals (booleans only). */
export interface ModelHealthSignals {
  /** The embedding provider/cached wrapper is available (else FTS5-only). */
  embeddingAvailable: boolean;
  /** The no-download reranker GGUF presence probe found the model. */
  rerankerModelPresent: boolean;
  /** The GGUF reranker provider loaded successfully (vs. unavailable). */
  rerankerBuilt: boolean;
}

/**
 * Write a one-shot `model_health` row to `obs_diagnostics` at boot.
 *
 * No-ops when `obsStore` is `undefined` (observability persistence disabled) —
 * the `?.` is mandatory so a disabled-persistence boot cannot crash startup
 * (Pitfall 5). Severity is `"info"` when the embedding provider is available,
 * `"warning"` when it is not (an absent embedding provider is the primary
 * degraded-recall cause). The timestamp comes from the injected `ClockPort` —
 * never `Date.now()` (globals gate).
 */
export function recordModelHealth(
  obsStore: ObservabilityStore | undefined,
  signals: ModelHealthSignals,
  clock: ClockPort,
): void {
  obsStore?.insertDiagnostic({
    timestamp: clock.now(),
    category: "model_health",
    severity: signals.embeddingAvailable ? "info" : "warning",
    message: "model_health",
    details: JSON.stringify({
      embeddingAvailable: signals.embeddingAvailable,
      rerankerModelPresent: signals.rerankerModelPresent,
      rerankerBuilt: signals.rerankerBuilt,
    }),
  });
}
