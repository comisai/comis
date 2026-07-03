// SPDX-License-Identifier: Apache-2.0
/**
 * Image generation step -- step 08d of the init wizard.
 *
 * Presents a single-select of all supported image-generation providers
 * (auto / fal / openai / openai-codex / google / openrouter, mirroring core's
 * `IMAGE_PROVIDER_VALUES`) and collects a credential ONLY when the choice needs
 * a STATIC one the wizard doesn't already hold:
 *
 *   - `auto`         — provider-following (the recommended default): image
 *                      generation follows the agent's main provider and reuses
 *                      its key. No prompt.
 *   - `fal`          — the explicit FAL queue backend: always prompts for a
 *                      `FAL_KEY` (no LLM provider supplies it).
 *   - `openai`       — OpenAI Images: reuses `OPENAI_API_KEY`. Prompts ONLY when
 *                      the main provider isn't already `openai` (key reuse).
 *   - `google`       — Gemini image: reuses `GOOGLE_API_KEY`. Prompts ONLY when
 *                      the main provider isn't already `google`.
 *   - `openrouter`   — FLUX via OpenRouter: reuses `OPENROUTER_API_KEY`. Prompts
 *                      ONLY when the main provider isn't already `openrouter`.
 *   - `openai-codex` — OAuth bearer, NOT a static key. No prompt; relies on a
 *                      logged-in Codex profile (`comis auth login --provider
 *                      openai-codex`), which step 04 already establishes when
 *                      the main provider is openai-codex.
 *
 * The selection is written to `integrations.media.imageGeneration.provider` and
 * any collected key flows through the same managed-secrets path as the LLM key
 * (step 10). Mirror of the video step (08c); the two co-exist under
 * `integrations.media`.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import {
  SUPPORTED_IMAGE_PROVIDERS,
  IMAGE_PROVIDER_ENV_KEYS,
  PROVIDER_ENV_KEYS,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

// ---------- Step Implementation ----------

export const imageProvidersStep: WizardStep = {
  id: "image-providers",
  label: "Image Generation",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Image Generation"));

    // 1. Single-select from supported image providers.
    const provider = await prompter.select<string>({
      message: "Which provider should generate images?",
      options: SUPPORTED_IMAGE_PROVIDERS.map((ip) => ({
        value: ip.id,
        label: ip.label,
        hint: ip.hint,
      })),
      initialValue: state.imageProvider?.provider ?? "auto",
    });

    // 2. No static env key for this choice: `auto` (follow-main) or
    //    `openai-codex` (OAuth bearer). Neither prompts for a key here.
    const requiredEnvKey = IMAGE_PROVIDER_ENV_KEYS[provider];
    if (!requiredEnvKey) {
      if (provider === "openai-codex") {
        prompter.log.info(
          'Codex image generation uses your "openai-codex" OAuth login ' +
            '(run "comis auth login --provider openai-codex" if you have not).',
        );
      } else {
        prompter.log.info(
          "Image generation will follow your agent's main provider (reusing its key).",
        );
      }
      return updateState(state, { imageProvider: { provider } });
    }

    // 3. Key reuse: if the agent's MAIN provider already supplies the exact
    //    env key this backend needs (e.g. an openai main + openai images → both
    //    OPENAI_API_KEY), reuse it — no extra prompt.
    const mainProvidesKey =
      state.provider?.apiKey !== undefined &&
      state.provider.id !== undefined &&
      PROVIDER_ENV_KEYS[state.provider.id] === requiredEnvKey;

    if (mainProvidesKey) {
      prompter.log.info(
        `Reusing your ${state.provider!.id} API key (${requiredEnvKey}) for image generation.`,
      );
      return updateState(state, { imageProvider: { provider } });
    }

    // 4. Otherwise collect the credential (fal always; cross-provider others).
    const label =
      SUPPORTED_IMAGE_PROVIDERS.find((ip) => ip.id === provider)?.label ?? provider;
    const apiKey = await prompter.password({
      message: `${label} API key (${requiredEnvKey})`,
      validate: (v: string) => {
        if (typeof v !== "string" || v.length === 0) return "API key is required";
        if (v.length < 10) return "API key seems too short (minimum 10 characters)";
        return undefined;
      },
    });

    return updateState(state, { imageProvider: { provider, apiKey } });
  },
};
