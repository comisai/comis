// SPDX-License-Identifier: Apache-2.0
/**
 * Provider selection step -- step 03 of the init wizard.
 *
 * Presents the providers from the live pi-ai catalog (loaded via
 * `loadProvidersWithFallback` -- daemon RPC first, local pi-ai catalog
 * fallback for the pre-init use case) plus a synthetic "custom" option
 * appended last for OpenAI-compatible endpoints. A category overview
 * note is shown before selection to help the user orient. Anthropic is
 * pre-selected as the recommended default.
 *
 * Provider IDs not in `PROVIDER_UI_HINTS` render with a capitalize-
 * fallback label and no hint -- new providers added by future pi-ai
 * upgrades flow through automatically with no comis code change.
 *
 * This step only captures the provider choice. API credentials are
 * collected in step 04 (credentials).
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  ProviderConfig,
} from "../index.js";
import { updateState, sectionSeparator } from "../index.js";
import { loadProvidersWithFallback } from "../../client/provider-list.js";

// ---------- UX Hint Map ----------

interface ProviderUiHint {
  label: string;
  hint?: string;
  category: "recommended" | "other" | "local" | "custom";
}

/**
 * UX-only labels and hints for known providers.
 *
 * Keys here are NOT a closed set of supported providers -- the actual
 * supported set is whatever the pi-ai catalog exposes via
 * `loadProvidersWithFallback()`. This map provides nicer labels for
 * commonly-known providers; unknown providers use the capitalize-
 * fallback path in `getProviderHint`.
 *
 * Excluded: `together` and `ollama`. Neither is in pi-ai 0.71.0's
 * `getProviders()` catalog (`getModels(p)[0]?.baseUrl` is undefined for
 * both), so an entry here would be dead code -- the live catalog
 * never returns those IDs. The capitalize-fallback handles them if
 * pi-ai adds them in a future release.
 */
const PROVIDER_UI_HINTS: Record<string, ProviderUiHint> = {
  anthropic: { label: "Anthropic (Claude)", hint: "Recommended for agents", category: "recommended" },
  openai: { label: "OpenAI (GPT)", hint: "GPT-4o, o1, o3 models", category: "recommended" },
  google: { label: "Google (Gemini)", hint: "Gemini models", category: "other" },
  groq: { label: "Groq", hint: "Fast inference (Llama, Mixtral)", category: "other" },
  mistral: { label: "Mistral", hint: "Mistral models", category: "other" },
  deepseek: { label: "DeepSeek", hint: "DeepSeek models", category: "other" },
  xai: { label: "xAI (Grok)", hint: "Grok models", category: "other" },
  cerebras: { label: "Cerebras", hint: "Fast inference", category: "other" },
  openrouter: { label: "OpenRouter", hint: "Multi-provider routing", category: "other" },
};

/**
 * Resolve the UX hint for a provider id. Returns the static hint when
 * present, otherwise computes a capitalize-fallback (matches the web
 * wizard's pattern at packages/web/src/views/setup-wizard.ts:180-193).
 */
function getProviderHint(id: string): ProviderUiHint {
  // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against literal record (mirrors web wizard pattern)
  if (Object.hasOwn(PROVIDER_UI_HINTS, id)) return PROVIDER_UI_HINTS[id]!;
  return {
    label: id.charAt(0).toUpperCase() + id.slice(1),
    hint: undefined,
    category: "other",
  };
}

// ---------- Category Overview ----------

/**
 * Static overview note shown before the provider select.
 *
 * May drift from the live catalog (e.g., if pi-ai adds a new provider,
 * users still see the same note). Computing this from
 * PROVIDER_UI_HINTS + the loaded catalog is a future enhancement;
 * static is acceptable for v1 since the categories rarely change.
 */
const CATEGORY_NOTE = [
  "Recommended: Anthropic, OpenAI",
  "Other: Google, Groq, Mistral, DeepSeek, xAI, Cerebras, OpenRouter",
  "Local: Ollama (no API key)",
  "Custom: Your own endpoint",
].join("\n");

// ---------- Step Implementation ----------

export const providerStep: WizardStep = {
  id: "provider",
  label: "LLM Provider",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("LLM Provider"));

    // Show category grouping overview before selection
    prompter.note(CATEGORY_NOTE, "Available Providers");

    // Build option list from live catalog (RPC-first, local fallback)
    const providerIds = await loadProvidersWithFallback();
    const options = providerIds.map((id) => {
      const hint = getProviderHint(id);
      return { value: id, label: hint.label, hint: hint.hint };
    });

    // Synthetic Custom option (always last, never in catalog)
    options.push({
      value: "custom",
      label: "Custom endpoint",
      hint: "OpenAI-compatible API",
    });

    const selectedId = await prompter.select<string>({
      message: "Which LLM provider will you use?",
      options,
      initialValue: state.provider?.id ?? "anthropic",
    });

    return updateState(state, {
      provider: { id: selectedId } as ProviderConfig,
    });
  },
};
