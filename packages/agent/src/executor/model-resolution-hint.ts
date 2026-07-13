// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostic for a configured model that the `ModelRegistry` could not resolve.
 *
 * When `modelRegistry.find(provider, modelId)` returns undefined the executor
 * falls the whole ModelProfile back to {@link FAIL_CLOSED_PROFILE} — the
 * most-locked nano profile with a minimal context window (see model-profile.ts).
 * That fallback is SILENT to the operator except for a WARN, and the WARN used
 * to blame provider registration unconditionally ("check providers.entries…").
 *
 * But there are two DISTINCT failure classes, and the provider-registration hint
 * only fits one of them:
 *   - the provider is genuinely absent from the registry (no models for it), OR
 *   - the provider IS registered and serving other models, but THIS model id is
 *     not one of its catalog ids (a typo, or a family alias the API accepts but
 *     the SDK catalog doesn't list — e.g. `gpt-5.6` where the real ids are
 *     `gpt-5.6-terra` / `-luna` / `-sol`).
 *
 * In the second class the provider hint misdirects, and the operator's first
 * real signal is a downstream `context_exhausted` on the fail-closed nano window
 * — mis-hinted as "raise effectiveContextCapNano / reset the conversation" when
 * the true fix is "use a valid model id". This helper names the failure class so
 * each gets the hint that fits: the model-id class lists the provider's available
 * ids and points at the nano fallback as the cause of the context exhaustion.
 *
 * Pure; deterministic for equal inputs; does not mutate its arguments.
 *
 * @module
 */

import { FAIL_CLOSED_PROFILE } from "./model-profile.js";

export type UnresolvedModelReason = "provider_unregistered" | "model_id_unknown";

export interface UnresolvedModelDiagnostic {
  readonly reason: UnresolvedModelReason;
  readonly hint: string;
}

const PROVIDER_UNREGISTERED_HINT =
  "Provider not registered in pi ModelRegistry. Check providers.entries.<name> in config.yaml has " +
  "type/baseUrl/apiKeyName set, the API key resolves via SecretManager, and the provider is enabled. " +
  "Without a match, pi-coding-agent silently falls back to whatever built-in provider has env-var credentials.";

/**
 * Classify an unresolved (provider, modelId) and return the hint that fits.
 *
 * @param provider - the configured provider key.
 * @param modelId - the configured (normalized) model id that did not resolve.
 * @param availableModelIdsForProvider - every model id the registry HAS for this
 *   provider (empty ⇒ the provider is genuinely unregistered). The caller derives
 *   this from `modelRegistry.getAll()` filtered to the provider.
 */
export function diagnoseUnresolvedModel(
  provider: string,
  modelId: string,
  availableModelIdsForProvider: readonly string[],
): UnresolvedModelDiagnostic {
  if (availableModelIdsForProvider.length === 0) {
    return { reason: "provider_unregistered", hint: PROVIDER_UNREGISTERED_HINT };
  }
  // Copy-then-sort so the message is stable regardless of registry iteration
  // order, without mutating the caller's array.
  const available = [...availableModelIdsForProvider].sort().join(", ");
  return {
    reason: "model_id_unknown",
    hint:
      `Model '${modelId}' not found for provider '${provider}' — the provider IS registered, ` +
      `but has no model with that id. Available '${provider}' models: ${available}. ` +
      `Until you set agents.<id>.model (or the model override) to one of those, the agent falls back ` +
      `to the fail-closed nano profile (${FAIL_CLOSED_PROFILE.contextWindow}-token context window), ` +
      `which exhausts context on any non-trivial turn (finishReason:context_exhausted) — that is the ` +
      `cause of a context-exhausted turn here, not effectiveContextCapNano or conversation length.`,
  };
}
