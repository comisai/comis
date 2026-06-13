// SPDX-License-Identifier: Apache-2.0
/**
 * RESOLVE-01 (observability-excellence) — the provider↔model chimera detector.
 *
 * Pure: no I/O, no clock, no env (hexagonal I9). Classifies a model id into a
 * coarse provider FAMILY and flags a "chimera" — a NATIVE single-family provider
 * (anthropic/openai/google/…) paired with a model id from a DIFFERENT family.
 *
 * The incident this exists for (`ffe11736`): an agent configured `provider:
 * anthropic` with a qwen model ref resolved a phantom nano/8192 ModelProfile that
 * blocked Opus fallback — and nothing in `obs.explain`/`obs.fleet.health` named the
 * mismatch. The detector lets `config_posture` surface "N agent(s) with a chimeric
 * provider/model" in one `comis fleet` look.
 *
 * CONSERVATIVE BY DESIGN — false negatives are safe, false positives are noise:
 *   - Only NATIVE single-family providers (where the provider IS one model family)
 *     can flag a chimera. GATEWAY/aggregator providers (ollama, openrouter,
 *     amazon-bedrock, google-vertex, groq, together, …) legitimately serve models
 *     from MANY families, so they NEVER flag (the ffe11736 case is a native
 *     `anthropic` provider, not a gateway).
 *   - An unrecognized model family (`"unknown"`) NEVER flags (we only flag a
 *     KNOWN, mismatched family).
 *
 * @module
 */

/** A coarse model-family label, or `"unknown"` when the id matches no pattern. */
export type ModelFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "qwen"
  | "meta"
  | "mistral"
  | "deepseek"
  | "cohere"
  | "xai"
  | "unknown";

/**
 * Ordered family patterns. Order matters only where ids could overlap; these are
 * disjoint in practice. Matched with `.test()` against a lowercased id — never
 * executed/interpolated (T-182-05 string-safety precedent).
 */
const FAMILY_PATTERNS: ReadonlyArray<readonly [ModelFamily, RegExp]> = [
  ["anthropic", /claude/i],
  ["openai", /\bgpt|^o[1-5]\b|o[1-5]-|davinci|text-embedding-(ada|3)/i],
  ["google", /gemini|gemma|palm|bison/i],
  ["qwen", /qwen|qwq/i],
  ["meta", /llama/i],
  ["mistral", /mistral|mixtral|codestral|ministral/i],
  ["deepseek", /deepseek/i],
  ["cohere", /command-(r|a)\b|cohere/i],
  ["xai", /grok/i],
];

/**
 * NATIVE single-family providers: the provider id (post-`normalizeProviderId`) IS
 * a single model family, so a different model family is a genuine mismatch. Keyed
 * by the normalized provider id → its expected model family. Providers ABSENT from
 * this map are treated as gateways/aggregators (no chimera ever flagged).
 */
const NATIVE_PROVIDER_FAMILY: Readonly<Record<string, ModelFamily>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  mistral: "mistral",
  deepseek: "deepseek",
  cohere: "cohere",
  xai: "xai",
};

/**
 * Classify a model id into a coarse {@link ModelFamily}. Returns `"unknown"` when
 * no pattern matches (the safe default — an unknown family never flags a chimera).
 */
export function resolveModelFamily(modelRef: string): ModelFamily {
  for (const [family, pattern] of FAMILY_PATTERNS) {
    if (pattern.test(modelRef)) return family;
  }
  return "unknown";
}

/**
 * True when `providerFamily` is a NATIVE single-family provider AND `modelRef`
 * resolves to a KNOWN, DIFFERENT family — the `ffe11736` shape (anthropic+qwen).
 *
 * @param providerFamily - the normalized provider id (`resolveProviderFamily`).
 * @param modelRef       - the configured model id string.
 */
export function isProviderModelChimera(providerFamily: string, modelRef: string): boolean {
  const expected = NATIVE_PROVIDER_FAMILY[providerFamily.toLowerCase()];
  if (expected === undefined) return false; // gateway/aggregator — any family is legitimate
  const actual = resolveModelFamily(modelRef);
  if (actual === "unknown") return false; // unknown family never flags (conservative)
  return actual !== expected;
}
