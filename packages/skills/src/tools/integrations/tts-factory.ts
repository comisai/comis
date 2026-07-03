// SPDX-License-Identifier: Apache-2.0
import type { TTSPort, TtsConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createOpenAITTSAdapter } from "./openai-tts-adapter.js";
import { createElevenLabsTTSAdapter } from "./elevenlabs-tts-adapter.js";
import { createEdgeTTSAdapter } from "./edge-tts-adapter.js";
import { createLocalTtsAdapter } from "./local-tts-adapter.js";

/**
 * Create a TTS provider based on configuration.
 *
 * Selects the appropriate TTSPort adapter based on `config.provider`:
 * - "openai": OpenAI TTS API (requires OPENAI_API_KEY)
 * - "elevenlabs": ElevenLabs TTS (requires ELEVENLABS_API_KEY)
 * - "edge": Microsoft Edge TTS (free, no API key needed)
 * - "local"/"piper": keyless in-process transformers.js text-to-audio.
 *     Auto-downloads a small single-speaker ONNX voice model into the scoped
 *     `<dataDir>/models/tts/` cache, then synthesizes offline (no key, no
 *     network after the first load). `local` and `piper` are aliases for the
 *     same adapter (the resolver's `VOICE_KEYLESS` already includes both).
 *
 * @param config - TTS configuration with provider, voice, format, and optional model
 * @param secretManager - Credential access for API keys
 * @param dataDir - Data directory root; the in-process `local`/`piper` adapter
 *   caches its model under `<dataDir>/models/tts/`. Required (the daemon always
 *   has `container.config.dataDir`) so a caller cannot silently drop the cache
 *   scope — mirrors `createSTTProvider`.
 * @returns The configured TTSPort adapter, or an error for unknown providers
 */
export function createTTSProvider(
  config: TtsConfig,
  secretManager: SecretManager,
  dataDir: string,
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

    // Keyless in-process transformers.js text-to-audio. `piper` is a
    // resolver-rung alias for the same in-process adapter (both are in
    // VOICE_KEYLESS) — it reaches here via the resolver's chosen provider; the
    // schema enum carries `local`, so the cast covers the `piper` alias.
    case "local":
    case "piper":
      return ok(
        createLocalTtsAdapter({
          model: config.model,
          dataDir,
          voice: config.voice,
          format: config.format,
        }),
      );

    default:
      return err(new Error(`Unknown TTS provider: ${config.provider as string}`));
  }
}
