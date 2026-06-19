// SPDX-License-Identifier: Apache-2.0
/**
 * store flag injection for OpenAI Responses API + storeCompletions.
 *
 * Concern 4 of createRequestBodyInjector: when the model uses the OpenAI
 * Responses API and `storeCompletions` is enabled, inject `store: true`
 * into the outgoing request body.
 *
 * @module
 */

/**
 * Inject `store: true` when the model uses an OpenAI Responses API and
 * storeCompletions is enabled. Mutates `result` in place.
 *
 * @param result - The request body being mutated by the injector
 * @param needsResponsesApiInjection - Whether the model is a Responses API provider
 * @param storeCompletions - Whether storeCompletions is enabled in config
 */
export function injectStoreFlag(
  result: Record<string, unknown>,
  needsResponsesApiInjection: boolean,
  storeCompletions: boolean | undefined,
): void {
  if (needsResponsesApiInjection && storeCompletions) {
    result.store = true;
  }
}

/** Check if a model uses the OpenAI Responses API. */
export function isResponsesApiProvider(model: { api?: string }): boolean {
  return model.api === "openai-responses" || model.api === "azure-openai-responses";
}

/**
 * True when the model speaks an OpenAI Responses-family API whose request body is an `input`
 * item array: native openai (`openai-responses`), Azure (`azure-openai-responses`), or codex
 * (`openai-codex-responses`, also matched by `provider:"openai-codex"` as a fallback since the
 * codex model's `api` is not tagged `openai-responses`).
 *
 * Broader than {@link isResponsesApiProvider} — which intentionally covers only the two
 * providers that take service_tier/store injection. The recall-defer prefix stabilizer
 * (cache #C4-OAI) must run for ALL Responses providers: it was originally gated
 * `provider === "openai-codex"` only, so switching the agent to the native `openai` provider
 * (gpt-5.5 → `openai-responses`) silently left the defer OFF and the per-turn inline-recall
 * poisoned the auto-cached prefix again. Callers gate the actual mutation on
 * `Array.isArray(result.input)`, so this only needs to decide onPayload installation + intent.
 */
export function usesResponsesInputApi(model: { api?: string; provider?: string }): boolean {
  return model.api === "openai-responses"
    || model.api === "azure-openai-responses"
    || model.api === "openai-codex-responses"
    || model.provider === "openai-codex";
}
