// SPDX-License-Identifier: Apache-2.0
/**
 * Provider selection step -- step 03 of the init wizard.
 *
 * Presents all supported LLM providers in a flat select list
 * with per-provider hints. A category overview note is shown
 * before the selection to help the user orient. Anthropic is
 * pre-selected as the recommended default.
 *
 * This step only captures the provider choice. API credentials
 * are collected in step 04 (credentials).
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  ProviderConfig,
} from "../index.js";
import { updateState, sectionSeparator, SUPPORTED_PROVIDERS } from "../index.js";

// ---------- Category Overview ----------

const CATEGORY_NOTE = [
  "Recommended: Anthropic, OpenAI",
  "Other: Google, Groq, Mistral, DeepSeek, xAI, Together, Cerebras, OpenRouter",
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

    // Build flat options list from SUPPORTED_PROVIDERS
    const options = SUPPORTED_PROVIDERS.map((p) => ({
      value: p.id,
      label: p.label,
      hint: p.hint,
    }));

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
