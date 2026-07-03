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

import { type Api, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

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

/**
 * Build the `temperature` slice of a `completeSimple` options object, honoring the model's capability.
 *
 * Reasoning models (gpt-5.x, o-series, Claude Opus 4.7+ — `model.reasoning === true`) REJECT the
 * `temperature` request field. pi's openai/codex providers forward it unconditionally, so the upstream
 * returns HTTP 400 "Unsupported parameter: temperature" → an EMPTY response → the seam silently degrades
 * (memory.ask abstained on EVERY query for an openai-codex gpt-5.4 agent until this gate — verified live
 * 2026-06-22). The daemon's executor path already gates on `!model.reasoning` (stream-wrappers/
 * config-resolver); the memory/judge seams call `completeSimple` directly and must do the SAME. Spread it:
 *   `{ apiKey, ...temperatureOption(model, 0.2), maxTokens, signal }`
 * Non-reasoning models keep their deterministic temperature; reasoning models omit it (they ignore it
 * upstream anyway). One source of truth so every seam stays correct across pi's broad provider/model set.
 */
export function temperatureOption(model: Model<Api>, value: number): { temperature?: number } {
  return model.reasoning ? {} : { temperature: value };
}
