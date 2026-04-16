/**
 * Agent identity step -- step 05 of the init wizard.
 *
 * Collects the agent name (validated alphanumeric + hyphens, max 64 chars)
 * and model selection from the provider's catalog. QuickStart auto-selects
 * the recommended model; Advanced shows the full catalog with a custom
 * model ID fallback.
 *
 * @module
 */

import type { WizardState, WizardStep, WizardPrompter } from "../index.js";
import {
  updateState,
  sectionSeparator,
  validateAgentName,
} from "../index.js";
import { createModelCatalog } from "@comis/agent";

// ---------- Recommended Models Per Provider ----------

const RECOMMENDED_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
  xai: "grok-2",
  together: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
  cerebras: "llama-3.3-70b",
  openrouter: "anthropic/claude-sonnet-4-5-20250929",
  ollama: "llama3",
};

// ---------- Helpers ----------

function formatModelHint(m: { contextWindow: number; reasoning: boolean }): string {
  const parts: string[] = [];
  if (m.contextWindow > 0) parts.push(`${Math.round(m.contextWindow / 1000)}k context`);
  if (m.reasoning) parts.push("reasoning");
  return parts.join(", ");
}

// ---------- Step Implementation ----------

export const agentStep: WizardStep = {
  id: "agent",
  label: "Agent Identity",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Agent Identity"));

    // 1. Agent name prompt
    const agentName = await prompter.text({
      message: "Agent name",
      placeholder: state.agentName ?? "my-agent",
      defaultValue: state.agentName ?? "comis-agent",
      required: true,
      validate: (value: string) => {
        if (typeof value !== "string") return undefined;
        const result = validateAgentName(value);
        return result ? result.message : undefined;
      },
    });

    // 2. Custom provider already set model in step 04 -- skip model selection
    if (state.provider?.id === "custom") {
      return updateState(state, { agentName });
    }

    // 3. Load model catalog
    let catalogModels: Array<{ modelId: string; displayName: string; contextWindow: number; reasoning: boolean }> = [];
    try {
      const catalog = createModelCatalog();
      catalog.loadStatic();
      catalogModels = catalog.getByProvider(state.provider?.id ?? "");
    } catch {
      // Fallback: empty catalog, will use recommended default only
    }

    const providerId = state.provider?.id ?? "";
    const recommended = RECOMMENDED_MODELS[providerId];

    // 4. QuickStart flow -- use "default" so the daemon picks the model at runtime
    if (state.flow === "quickstart") {
      prompter.log.info("Model: default");
      return updateState(state, { agentName, model: "default" });
    }

    // 5. Advanced flow -- show full catalog with custom option
    let selectedModel: string;

    if (catalogModels.length > 0) {
      const options = catalogModels.map((m) => ({
        value: m.modelId,
        label: m.displayName || m.modelId,
        hint: formatModelHint(m),
      }));

      options.push({
        value: "__custom__",
        label: "Custom model ID...",
        hint: "Enter a model ID manually",
      });

      const chosen = await prompter.select<string>({
        message: "Select a model",
        options,
        initialValue: state.model
          ?? (recommended && catalogModels.some((m) => m.modelId === recommended) ? recommended : undefined),
      });

      if (chosen === "__custom__") {
        selectedModel = await prompter.text({
          message: "Model ID",
          placeholder: "model-name",
        });
      } else {
        selectedModel = chosen;
      }
    } else {
      // Empty catalog -- go directly to custom text input
      selectedModel = await prompter.text({
        message: "Model ID",
        placeholder: recommended ?? "model-name",
        defaultValue: state.model ?? recommended,
      });
    }

    return updateState(state, { agentName, model: selectedModel });
  },
};
