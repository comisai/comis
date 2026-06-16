// SPDX-License-Identifier: Apache-2.0
/**
 * Text-to-speech (TTS) step -- step 08f of the init wizard.
 *
 * Presents a single-select of all supported TTS providers (openai / elevenlabs
 * / edge, mirroring core's `TtsConfigSchema` enum) and collects the credential,
 * reusing the agent's MAIN provider key when it already supplies the matching
 * one (CRED-01):
 *
 *   - `openai`     — reuses `OPENAI_API_KEY`; prompts only when the main
 *                    provider isn't `openai`.
 *   - `elevenlabs` — always prompts for `ELEVENLABS_API_KEY`.
 *   - `edge`       — Microsoft Edge TTS: free, NO key, no prompt.
 *
 * Written to `integrations.media.tts.provider`; the key flows through the same
 * managed-secrets path as the LLM key (step 10). This is the authoritative TTS
 * setup — the tool-providers step (08b) is now search-only, so the ElevenLabs /
 * OpenAI key is collected here exactly once.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import {
  SUPPORTED_TTS_PROVIDERS,
  TTS_PROVIDER_ENV_KEYS,
  PROVIDER_ENV_KEYS,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

// ---------- Step Implementation ----------

export const ttsStep: WizardStep = {
  id: "tts",
  label: "Text-to-Speech",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Text-to-Speech"));

    const provider = await prompter.select<string>({
      message: "Which provider should synthesize speech?",
      options: SUPPORTED_TTS_PROVIDERS.map((tp) => ({
        value: tp.id,
        label: tp.label,
        hint: tp.hint,
      })),
      initialValue: state.ttsProvider?.provider ?? "openai",
    });

    // `edge` is free — no credential to collect.
    const requiredEnvKey = TTS_PROVIDER_ENV_KEYS[provider];
    if (!requiredEnvKey) {
      prompter.log.info("Edge TTS is free — no API key needed.");
      return updateState(state, { ttsProvider: { provider } });
    }

    // CRED-01 reuse: main provider already supplies the matching key (openai).
    const mainProvidesKey =
      state.provider?.apiKey !== undefined &&
      state.provider.id !== undefined &&
      PROVIDER_ENV_KEYS[state.provider.id] === requiredEnvKey;

    if (mainProvidesKey) {
      prompter.log.info(
        `Reusing your ${state.provider!.id} API key (${requiredEnvKey}) for text-to-speech.`,
      );
      return updateState(state, { ttsProvider: { provider } });
    }

    const label =
      SUPPORTED_TTS_PROVIDERS.find((tp) => tp.id === provider)?.label ?? provider;
    const apiKey = await prompter.password({
      message: `${label} API key (${requiredEnvKey})`,
      validate: (v: string) => {
        if (typeof v !== "string" || v.length === 0) return "API key is required";
        if (v.length < 10) return "API key seems too short (minimum 10 characters)";
        return undefined;
      },
    });

    return updateState(state, { ttsProvider: { provider, apiKey } });
  },
};
