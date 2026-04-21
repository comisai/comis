// SPDX-License-Identifier: Apache-2.0
/**
 * QuickStart wizard flow.
 *
 * Collects provider, API key, and agent name in 3 prompts (skipping
 * API key for Ollama). Uses ModelCatalog from @comis/agent for
 * dynamic model selection instead of hardcoded lists.
 *
 * @module
 */

import * as p from "@clack/prompts";
import * as os from "node:os";
import { ok, err, type Result } from "@comis/shared";
import { createModelCatalog } from "@comis/agent";
import type { WizardResult } from "./flow-types.js";
import { PROVIDERS, MIN_KEY_LENGTHS } from "./flow-types.js";
import { writeWizardConfig, writeWizardEnv } from "./config-writer.js";

/**
 * Run the QuickStart wizard flow.
 *
 * Collects provider + API key + agent name, picks the first model
 * from ModelCatalog for the provider, writes config and .env.
 *
 * @param configDir - Override config directory (default ~/.comis)
 * @returns The wizard result or an error
 */
export async function runQuickStartFlow(
  configDir?: string,
): Promise<Result<WizardResult, Error>> {
  const targetDir = configDir ?? os.homedir() + "/.comis";

  p.intro("Comis Quick Setup");

  const result = await p.group(
    {
      provider: () =>
        p.select({
          message: "Select your LLM provider:",
          options: PROVIDERS,
        }),
      apiKey: ({ results }) => {
        if (results.provider === "ollama") {
          p.log.info("Ollama runs locally -- no API key needed.");
          return Promise.resolve("" as string | symbol);
        }
        const minLen = MIN_KEY_LENGTHS[results.provider as string] ?? 20;
        return p.password({
          message: `Enter your ${results.provider} API key:`,
          validate: (value) => {
            if (!value || value.length < minLen) {
              return `API key must be at least ${minLen} characters`;
            }
            return undefined;
          },
        });
      },
      agentName: () =>
        p.text({
          message: "Name your agent:",
          placeholder: "Comis",
          defaultValue: "Comis",
          validate: (value) => {
            if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value)) {
              return "Name must be alphanumeric with optional hyphens (no leading hyphen)";
            }
            if (value.length > 64) {
              return "Name must be at most 64 characters";
            }
            return undefined;
          },
        }),
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    },
  );

  // Use ModelCatalog for dynamic model selection
  let model: string;
  try {
    const catalog = createModelCatalog();
    catalog.loadStatic();
    const models = catalog.getByProvider(result.provider);
    model = models.length > 0 ? models[0]!.modelId : getDefaultModel(result.provider);
  } catch {
    // Fallback if pi-ai loading fails
    model = getDefaultModel(result.provider);
  }

  const wizardResult: WizardResult = {
    provider: result.provider,
    apiKey: result.apiKey as string,
    agentName: result.agentName,
    model,
    dataDir: targetDir,
  };

  // Write config files
  const configResult = writeWizardConfig(wizardResult, targetDir);
  if (!configResult.ok) {
    p.log.error(`Failed to write config: ${configResult.error.message}`);
    return err(configResult.error);
  }

  if (wizardResult.apiKey) {
    const envResult = writeWizardEnv(wizardResult, targetDir);
    if (!envResult.ok) {
      p.log.error(`Failed to write .env: ${envResult.error.message}`);
      return err(envResult.error);
    }
  }

  p.log.success(`Configuration saved to ${configResult.value}`);
  p.outro(
    "Setup complete! Next: comis daemon start",
  );

  return ok(wizardResult);
}

/** Fallback default model per provider. */
function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-5-20250929",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
    groq: "llama-3.3-70b-versatile",
    ollama: "llama3",
  };
  return defaults[provider] ?? "default";
}
