// SPDX-License-Identifier: Apache-2.0
/**
 * Shared model resolution for the memory/learning JUDGE seams (outcome,
 * correction, usefulness).
 *
 * pi-ai's `getModel` resolves only its BUILT-IN catalog (anthropic / openai /
 * google / …). Custom YAML providers (ollama, lm-studio, vLLM, llama.cpp, …) are
 * registered on the daemon's ModelRegistry INSTANCE via `registerCustomProviders`
 * and are invisible to the global `getModel`. So a keyless/local deployment's
 * judge resolved "model not found" and SKIPPED on every turn — the
 * verified-learning judge half was effectively DEAD for local models (live
 * 2026-06-20: `getModel("ollama","qwen3.6:35b")` → undefined → "Outcome judge
 * model not found (non-fatal)").
 *
 * This resolver keeps the catalog path byte-identical for built-in providers and
 * ADDS a config-backed construction path: when the catalog misses and the caller
 * supplies a {@link CustomCompletionsModelSpec} (the provider's resolved baseUrl),
 * build the openai-completions Model so the judge runs against the local endpoint
 * too. The judge's "never the agent's primary" cost guard is moot for keyless
 * local — there is no separate cheap model and no cost — so running the primary
 * model as the judge is both correct and free.
 *
 * @module
 */

import { getModel, type Api, type Model } from "@earendil-works/pi-ai";

/**
 * Minimal spec to construct a Model for a custom OpenAI-compatible provider the
 * pi-ai catalog does not know. `baseUrl` MUST already be the OpenAI-compat mount
 * (`…/v1`); the caller normalizes it (see `normalizeOpenAICompatBaseUrl`).
 */
export interface CustomCompletionsModelSpec {
  /** Normalized OpenAI-compat base (e.g. `http://127.0.0.1:11434/v1`). */
  baseUrl: string;
  /** The served context window (defaults to a conservative 32k — judge prompts are tiny). */
  contextWindow?: number;
  /** Output bound for the constructed model (the seam also caps via maxOutputTokens). */
  maxTokens?: number;
  /** Whether the model is a reasoning model (so pi-ai threads thinking correctly). */
  reasoning?: boolean;
}

/**
 * Resolve a Model for a judge seam: pi-ai catalog first, else construct an
 * openai-completions Model from `customSpec`. Returns `undefined` only when the
 * catalog misses AND no custom spec is supplied (the legacy skip).
 */
export function resolveJudgeModel(
  provider: string,
  modelId: string,
  customSpec?: CustomCompletionsModelSpec,
): Model<Api> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
    const catalog = getModel(provider as any, modelId as any);
    if (catalog) return catalog as Model<Api>;
  } catch {
    /* not in the built-in catalog — fall through to custom construction */
  }
  if (!customSpec) return undefined;
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom provider id is a dynamic string
    provider: provider as any,
    baseUrl: customSpec.baseUrl,
    reasoning: customSpec.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: customSpec.contextWindow ?? 32_000,
    maxTokens: customSpec.maxTokens ?? 4_096,
  };
  return model as Model<Api>;
}
