// SPDX-License-Identifier: Apache-2.0
/**
 * Video generation step -- step 08c of the init wizard.
 *
 * Presents a single-select of all supported video-generation providers
 * (auto / fal / google / xai, mirroring core's `VIDEO_PROVIDER_VALUES`) and
 * collects a credential ONLY when the choice needs one the wizard doesn't
 * already hold:
 *
 *   - `auto`   — provider-following (the recommended default): video generation
 *                follows the agent's main provider and reuses its key. No prompt.
 *   - `fal`    — the explicit FAL queue backend: always prompts for a `FAL_KEY`
 *                (no LLM provider ever supplies it).
 *   - `google` — Veo: reuses `GOOGLE_API_KEY`. Prompts ONLY when the agent's main
 *                provider isn't already `google` (CRED-01 — no video-specific key).
 *   - `xai`    — Grok Imagine: reuses `XAI_API_KEY`. Prompts ONLY when the main
 *                provider isn't already `xai`.
 *
 * The selection is written to `integrations.media.videoGeneration.provider` and
 * any collected key flows through the same managed-secrets path as the LLM key
 * (step 10). No live validation — these backends have no simple probe endpoint.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import {
  SUPPORTED_VIDEO_PROVIDERS,
  VIDEO_PROVIDER_ENV_KEYS,
  PROVIDER_ENV_KEYS,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

// ---------- Step Implementation ----------

export const videoProvidersStep: WizardStep = {
  id: "video-providers",
  label: "Video Generation",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Video Generation"));

    // 1. Single-select from supported video providers (auto / fal / google / xai).
    const provider = await prompter.select<string>({
      message: "Which provider should generate videos?",
      options: SUPPORTED_VIDEO_PROVIDERS.map((vp) => ({
        value: vp.id,
        label: vp.label,
        hint: vp.hint,
      })),
      initialValue: state.videoProvider?.provider ?? "auto",
    });

    // 2. `auto` — follow the agent's main provider; no credential to collect.
    const requiredEnvKey = VIDEO_PROVIDER_ENV_KEYS[provider];
    if (!requiredEnvKey) {
      prompter.log.info(
        "Video generation will follow your agent's main provider (reusing its key).",
      );
      return updateState(state, { videoProvider: { provider } });
    }

    // 3. CRED-01 reuse: if the agent's MAIN provider already supplies the exact
    //    env key this backend needs (e.g. a google main + google video → both
    //    GOOGLE_API_KEY), reuse it — no extra prompt, no video-specific secret.
    const mainProvidesKey =
      state.provider?.apiKey !== undefined &&
      state.provider.id !== undefined &&
      PROVIDER_ENV_KEYS[state.provider.id] === requiredEnvKey;

    if (mainProvidesKey) {
      prompter.log.info(
        `Reusing your ${state.provider!.id} API key (${requiredEnvKey}) for video generation.`,
      );
      return updateState(state, { videoProvider: { provider } });
    }

    // 4. Otherwise collect the credential (fal always; cross-provider google/xai).
    const label =
      SUPPORTED_VIDEO_PROVIDERS.find((vp) => vp.id === provider)?.label ?? provider;
    const apiKey = await prompter.password({
      message: `${label} API key (${requiredEnvKey})`,
      validate: (v: string) => {
        if (typeof v !== "string" || v.length === 0) return "API key is required";
        if (v.length < 10) return "API key seems too short (minimum 10 characters)";
        return undefined;
      },
    });

    return updateState(state, { videoProvider: { provider, apiKey } });
  },
};
