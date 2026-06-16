// SPDX-License-Identifier: Apache-2.0
/**
 * Voice transcription (STT) step -- step 08e of the init wizard.
 *
 * Presents a single-select of all supported speech-to-text providers
 * (auto / local / openai / groq / deepgram, mirroring core's
 * `TranscriptionConfigSchema` enum) and collects a credential ONLY when the
 * choice needs a STATIC one the wizard doesn't already hold (CRED-01):
 *
 *   - `auto`     — keyless-first (the recommended default): a keyless local
 *                  engine, or reuse the agent's main audio key. No prompt.
 *   - `local`    — in-process whisper (downloads a small model): keyless, no
 *                  prompt.
 *   - `openai`   — Whisper: reuses `OPENAI_API_KEY`; prompts only when the main
 *                  provider isn't `openai`.
 *   - `groq`     — Groq Whisper: reuses `GROQ_API_KEY`; prompts only when the
 *                  main provider isn't `groq`.
 *   - `deepgram` — Nova-3: always prompts for `DEEPGRAM_API_KEY` (no LLM provider
 *                  supplies it).
 *
 * Voice auto-transcription is ON by default, so this choice matters even for a
 * non-OpenAI main. Written to `integrations.media.transcription.provider`; the
 * key flows through the same managed-secrets path as the LLM key (step 10).
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import {
  SUPPORTED_TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_PROVIDER_ENV_KEYS,
  PROVIDER_ENV_KEYS,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator } from "../theme.js";

// ---------- Step Implementation ----------

export const transcriptionStep: WizardStep = {
  id: "transcription",
  label: "Voice Transcription",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Voice Transcription"));

    const provider = await prompter.select<string>({
      message: "Which provider should transcribe voice messages?",
      options: SUPPORTED_TRANSCRIPTION_PROVIDERS.map((tp) => ({
        value: tp.id,
        label: tp.label,
        hint: tp.hint,
      })),
      initialValue: state.transcriptionProvider?.provider ?? "auto",
    });

    const requiredEnvKey = TRANSCRIPTION_PROVIDER_ENV_KEYS[provider];

    // No static env key for this choice: `auto` (keyless-first / follow-main) or
    // `local` (in-process whisper). Neither prompts for a key here.
    if (!requiredEnvKey) {
      prompter.log.info("Transcription will use a keyless local engine (no API key needed).");
      return updateState(state, { transcriptionProvider: { provider } });
    }

    // CRED-01 reuse: main provider already supplies the matching key (e.g. an
    // openai main + openai STT → both OPENAI_API_KEY).
    const mainProvidesKey =
      state.provider?.apiKey !== undefined &&
      state.provider.id !== undefined &&
      requiredEnvKey !== undefined &&
      PROVIDER_ENV_KEYS[state.provider.id] === requiredEnvKey;

    if (mainProvidesKey) {
      prompter.log.info(
        `Reusing your ${state.provider!.id} API key (${requiredEnvKey}) for transcription.`,
      );
      return updateState(state, { transcriptionProvider: { provider } });
    }

    const label =
      SUPPORTED_TRANSCRIPTION_PROVIDERS.find((tp) => tp.id === provider)?.label ?? provider;
    const apiKey = await prompter.password({
      message: `${label} API key (${requiredEnvKey})`,
      validate: (v: string) => {
        if (typeof v !== "string" || v.length === 0) return "API key is required";
        if (v.length < 10) return "API key seems too short (minimum 10 characters)";
        return undefined;
      },
    });

    return updateState(state, { transcriptionProvider: { provider, apiKey } });
  },
};
