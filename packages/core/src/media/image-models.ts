// SPDX-License-Identifier: Apache-2.0
/**
 * IMAGE_MODELS_BY_PROVIDER — the Comis-side per-provider image-model
 * enumeration (IN-02). The single source of truth for "which model ids are
 * valid for a given resolved main provider", used to validate an agent-supplied
 * `model` arg and to build the reject hint that LISTS the valid models.
 *
 * Why a Comis-side list (not pi-ai's catalog): pi-ai's `getImageModels(...)`
 * only knows the `openrouter` provider — `getImageModels("openai")` returns `[]`
 * (RESEARCH Pitfall 4). So enumeration for the native `openai`/`google` paths
 * MUST come from here. (openrouter callers can still derive their list from
 * `getImageModels("openrouter").map(m => m.id)` at the call site; it is
 * deliberately NOT hardcoded here.)
 *
 * Model-id provenance (Phase 185 plan time):
 *   - openai: `gpt-image-1` (+ `gpt-image-1.5`/`gpt-image-2`/`dall-e-3`) are
 *     members of the installed `openai@6.39.1` `ImageModel` union
 *     (images.d.ts:310).
 *   - google: `gemini-2.5-flash-image` (+ `gemini-3.1-flash-image-preview`) are
 *     image members of the installed `@google/genai@1.52.0` `Model_2` union
 *     (genai.d.ts:8082).
 *
 * Mirrors the const-map shape + hygiene of the sibling `image-capability.ts` /
 * `resolve-image-provider.ts` (keyed by canonical resolved provider id; a
 * provider absent from the map → `undefined` on lookup → no models → not a
 * crash). The benign `security/detect-object-injection` warning on the dynamic
 * key lookup is the established baseline (same bare-lookup pattern as
 * `resolve-image-provider.ts:77/97/137`) — no suppression directive.
 *
 * @module
 */

export const IMAGE_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
  "openai": ["gpt-image-1", "gpt-image-1.5", "gpt-image-2", "dall-e-3"],
  "google": ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"],
  // openrouter is derived at the call site from getImageModels("openrouter").
  // anthropic / amazon-bedrock / groq / mistral / deepseek / default → undefined.
};

/**
 * True iff `model` is a known image model for `providerId`. A provider with no
 * Comis-side list (closed-map miss → `undefined`) yields `false` for every
 * model (never a crash, never a silent accept).
 */
export function isValidImageModel(providerId: string, model: string): boolean {
  const models = IMAGE_MODELS_BY_PROVIDER[providerId];
  return models !== undefined && models.includes(model);
}

/**
 * The valid image-model ids for `providerId`, or `[]` when the provider has no
 * Comis-side list. Used to build the IN-02 reject hint (lists the models the
 * agent may choose from).
 */
export function listImageModels(providerId: string): readonly string[] {
  return IMAGE_MODELS_BY_PROVIDER[providerId] ?? [];
}
