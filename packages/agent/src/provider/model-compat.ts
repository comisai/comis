// SPDX-License-Identifier: Apache-2.0
/**
 * Model compatibility auto-detection: per-model compat flag normalization.
 *
 * Handles two provider-specific auto-detections:
 *
 * - **xAI** -- gated on provider name "xai" OR declared config `type: "xai"`
 *   (so custom-keyed entries like `providers.entries.my-xai` are covered).
 *   xAI models require specific compat flags (tool schema stripping,
 *   HTML-entity decoding, native web search) that users should not need to
 *   configure manually.
 * - **Ollama** -- gated on declared config `type: "ollama"`. The
 *   llama.cpp-family GBNF grammar compiler rejects common MCP schema shapes
 *   (`pattern`/`format`, nullable unions, type arrays, free-form objects);
 *   the "gbnf" profile conservatively rewrites them before dispatch
 *   (GBNF-01). Without auto-detection, local-model operators hit opaque
 *   grammar-compile 400s on third-party MCP toolsets.
 *
 * **Override precedence (deliberately INVERTED between the two branches):**
 * For xAI, auto-detected values ALWAYS override user config -- xAI's API
 * requirements are non-negotiable, and user-supplied values for these fields
 * would cause silent failures. For gbnf, the profile is a compat DEFAULT,
 * not an API requirement: an explicit user `toolSchemaProfile` (e.g.
 * "default") ALWAYS wins, preserving the operator debugging escape hatch.
 * In both branches, user fields that auto-detection does NOT touch (e.g.,
 * `supportsTools`) are preserved via spread.
 *
 * **D-08:** `baseUrl` is part of the signature but must NEVER be consulted
 * for detection. Detection keys ONLY on provider name / declared config
 * `type` / explicit profile -- a provider cannot self-elect into a different
 * profile via its endpoint.
 *
 * **Extensibility:** Future providers with mandatory compat quirks can be
 * added as additional `if` branches. Each branch should document why
 * auto-detection is necessary (i.e., what breaks without it) and which
 * precedence doctrine (force-override vs default) it follows.
 *
 * @module
 */

import type { ModelCompatConfig } from "@comis/core";

/**
 * Normalize model compatibility flags, applying provider-specific
 * auto-detection where required.
 *
 * @param model - Model descriptor with provider, id, optional declared
 *                provider config `type` (providerType), and optional user
 *                compat config
 * @returns Normalized compat config (auto-detected overrides for xAI,
 *          gbnf default for ollama when the user set no explicit profile),
 *          the original comisCompat for other providers, or undefined if
 *          no compat config exists
 */
export function normalizeModelCompat(
  model: { provider: string; id: string; baseUrl?: string; providerType?: string; comisCompat?: ModelCompatConfig },
): ModelCompatConfig | undefined {
  if (model.provider === "xai" || model.providerType === "xai") {
    return {
      ...model.comisCompat,
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    };
  }
  if (model.providerType === "ollama" && model.comisCompat?.toolSchemaProfile === undefined) {
    return { ...model.comisCompat, toolSchemaProfile: "gbnf" };
  }
  return model.comisCompat;
}
