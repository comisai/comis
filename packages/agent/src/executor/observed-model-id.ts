// SPDX-License-Identifier: Apache-2.0
/**
 * `observedModelId` — the model id to RECORD for observability (the live turn's
 * `token_usage` event → `obs_token_usage` → the cost/token Prometheus metrics →
 * per-turn pricing resolution).
 *
 * When Comis's `ModelRegistry` resolved the configured model, the pi session's
 * model id is authoritative — it also reflects an in-session `setModel` switch
 * (and a model-retry fallback), which a static `config.model` would miss. But
 * when the configured model is NOT in pi's registry (a custom/unregistered model
 * — e.g. an Ollama `qwen3.6:35b`), pi-coding-agent silently falls back to its OWN
 * default model OBJECT (e.g. `gemini-3.1-pro-preview`) for the session, while the
 * provider API is still sent the configured model string. Recording
 * `session.model.id` in that case mislabels EVERY token_usage / cost row as the
 * catalog default — a `provider=ollama` + `model=gemini` chimera. So when the
 * model did not resolve, record the CONFIGURED model (the id actually sent to the
 * provider). This mirrors the sibling `resolvedModel?.id ?? config.model` sites
 * in `pi-executor.ts`.
 *
 * @module
 */

/** The minimal shape of a resolved pi model this helper reads. */
export type ResolvedModelLike = { readonly id: string } | undefined;

/**
 * Resolve the model id to record for the live turn's observability.
 *
 * @param resolvedModel - the model Comis resolved via its `ModelRegistry`
 *   (`undefined` when the configured model is unregistered and pi fell back).
 * @param sessionModelId - the live pi session model id (`session.model?.id`).
 * @param configModel - the agent's configured model string (`config.model`).
 */
export function observedModelId(
  resolvedModel: ResolvedModelLike,
  sessionModelId: string | undefined,
  configModel: string,
): string {
  return resolvedModel ? (sessionModelId ?? resolvedModel.id) : configModel;
}
