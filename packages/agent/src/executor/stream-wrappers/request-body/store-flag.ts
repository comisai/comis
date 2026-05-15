// SPDX-License-Identifier: Apache-2.0
/**
 * store flag injection for OpenAI Responses API + storeCompletions
 * (Phase 42 split per EXEC-SPLIT-02).
 *
 * Concern 4 of createRequestBodyInjector: when the model uses the OpenAI
 * Responses API and `storeCompletions` is enabled, inject `store: true`
 * into the outgoing request body.
 *
 * Lifted verbatim from request-body-injector.ts:2107-2110.
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
