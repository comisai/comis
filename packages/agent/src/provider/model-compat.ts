/**
 * Model compatibility auto-detection: per-model compat flag normalization.
 *
 * Currently handles xAI auto-detection -- xAI models require specific compat
 * flags (tool schema stripping, HTML-entity decoding, native web search) that
 * users should not need to configure manually.
 *
 * **Override precedence:** For xAI, auto-detected values ALWAYS override user
 * config. This is intentional -- xAI's API requirements are non-negotiable,
 * and user-supplied values for these fields would cause silent failures.
 * User fields that auto-detection does NOT touch (e.g., `supportsTools`) are
 * preserved via spread.
 *
 * **Extensibility:** Future providers with mandatory compat quirks can be
 * added as additional `if` branches. Each branch should document why
 * auto-detection is necessary (i.e., what breaks without it).
 *
 * @module
 */

import type { ModelCompatConfig } from "@comis/core";

/**
 * Normalize model compatibility flags, applying provider-specific
 * auto-detection where required.
 *
 * @param model - Model descriptor with provider, id, and optional user compat config
 * @returns Normalized compat config (with auto-detected overrides for xAI),
 *          the original comisCompat for non-xAI providers, or undefined if
 *          no compat config exists
 */
export function normalizeModelCompat(
  model: { provider: string; id: string; baseUrl?: string; comisCompat?: ModelCompatConfig },
): ModelCompatConfig | undefined {
  if (model.provider === "xai") {
    return {
      ...model.comisCompat,
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    };
  }
  return model.comisCompat;
}
