// SPDX-License-Identifier: Apache-2.0
/**
 * Tool providers step -- step 08b of the init wizard.
 *
 * Presents a multiselect of optional tool provider integrations
 * (Brave Search, ElevenLabs TTS, Perplexity, Tavily, Exa, Jina), collects
 * API keys for selected providers with basic length validation,
 * and stores ToolProviderConfig[] on wizard state.
 *
 * No live validation -- these APIs don't have simple /me endpoints.
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  ToolProviderConfig,
} from "../index.js";
import {
  updateState,
  sectionSeparator,
  SUPPORTED_TOOL_PROVIDERS,
} from "../index.js";

// ---------- Step Implementation ----------

export const toolProvidersStep: WizardStep = {
  id: "tool-providers",
  label: "Tool Providers",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Tool Providers"));

    // 1. Multiselect from supported tool providers
    const selected = await prompter.multiselect<string>({
      message: "Add optional tool providers (select all that apply)",
      options: SUPPORTED_TOOL_PROVIDERS.map((tp) => ({
        value: tp.id,
        label: tp.label,
        hint: tp.hint,
      })),
      required: false,
    });

    if (selected.length === 0) {
      if (state.toolProviders && state.toolProviders.length > 0) {
        prompter.log.info("Keeping existing tool provider configuration.");
      } else {
        prompter.log.info("No tool providers selected -- you can add them later.");
      }
      return state;
    }

    // 2. Collect API keys for each selected provider
    const configs: ToolProviderConfig[] = [];

    for (const providerId of selected) {
      const provider = SUPPORTED_TOOL_PROVIDERS.find((tp) => tp.id === providerId);
      if (!provider) continue;

      const apiKey = await prompter.password({
        message: `${provider.label} API key`,
        validate: (v: string) => {
          if (typeof v !== "string" || v.length === 0) return "API key is required";
          if (v.length < 10) return "API key seems too short (minimum 10 characters)";
          return undefined;
        },
      });

      configs.push({ id: providerId, apiKey });
    }

    // 3. Return state with collected tool provider configs
    return updateState(state, { toolProviders: configs });
  },
};
