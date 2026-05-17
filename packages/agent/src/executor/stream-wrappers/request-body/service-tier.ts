// SPDX-License-Identifier: Apache-2.0
/**
 * service_tier flag injection for OpenAI Responses API + fastMode.
 *
 * When the model uses the OpenAI Responses API and `fastMode` is enabled,
 * inject `service_tier: "auto"` into the outgoing request body.
 *
 * @module
 */

/**
 * Inject `service_tier: "auto"` when the model uses an OpenAI Responses API
 * and fastMode is enabled. Mutates `result` in place.
 *
 * @param result - The request body being mutated by the injector
 * @param needsResponsesApiInjection - Whether the model is a Responses API provider
 * @param fastMode - Whether fastMode is enabled in config
 */
export function injectServiceTier(
  result: Record<string, unknown>,
  needsResponsesApiInjection: boolean,
  fastMode: boolean | undefined,
): void {
  if (needsResponsesApiInjection && fastMode) {
    result.service_tier = "auto";
  }
}
