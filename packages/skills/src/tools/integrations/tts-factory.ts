// SPDX-License-Identifier: Apache-2.0
import type { TTSPort, TtsConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createOpenAITTSAdapter } from "./openai-tts-adapter.js";
import { createElevenLabsTTSAdapter } from "./elevenlabs-tts-adapter.js";
import { createEdgeTTSAdapter } from "./edge-tts-adapter.js";

/**
 * Create a TTS provider based on configuration.
 *
 * Selects the appropriate TTSPort adapter based on `config.provider`:
 * - "openai": OpenAI TTS API (requires OPENAI_API_KEY)
 * - "elevenlabs": ElevenLabs TTS (requires ELEVENLABS_API_KEY)
 * - "edge": Microsoft Edge TTS (free, no API key needed)
 *
 * @param config - TTS configuration with provider, voice, format, and optional model
 * @param secretManager - Credential access for API keys
 * @returns The configured TTSPort adapter, or an error for unknown providers
 */
export function createTTSProvider(
  config: TtsConfig,
  secretManager: SecretManager,
): Result<TTSPort, Error> {
  switch (config.provider) {
    case "openai":
      return ok(
        createOpenAITTSAdapter({
          apiKey: secretManager.get("OPENAI_API_KEY") ?? "",
          model: config.model,
        }),
      );

    case "elevenlabs":
      return ok(
        createElevenLabsTTSAdapter({
          apiKey: secretManager.get("ELEVENLABS_API_KEY") ?? "",
          modelId: config.model,
          defaultVoice: config.voice,
        }),
      );

    case "edge":
      return ok(
        createEdgeTTSAdapter({
          defaultVoice: config.voice,
        }),
      );

    default:
      return err(new Error(`Unknown TTS provider: ${config.provider as string}`));
  }
}
