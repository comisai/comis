// SPDX-License-Identifier: Apache-2.0
import type { TTSPort, TTSOptions, TTSResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { EdgeTTS } from "edge-tts-universal";
import { sanitizeApiError } from "./media-adapter-shared.js";

/**
 * Configuration for the Edge TTS adapter.
 */
export interface EdgeTTSAdapterConfig {
  /** Default voice (default: "en-US-AvaMultilingualNeural"). */
  readonly defaultVoice?: string;
}

const DEFAULT_VOICE = "en-US-AvaMultilingualNeural";
const MAX_TEXT_LENGTH = 5000;

/**
 * Create an Edge TTS adapter implementing TTSPort.
 *
 * Uses Microsoft Edge's free TTS service via edge-tts-universal.
 * No API key required — this is the free fallback provider.
 */
export function createEdgeTTSAdapter(config: EdgeTTSAdapterConfig): TTSPort {
  const defaultVoice = config.defaultVoice ?? DEFAULT_VOICE;

  return {
    async synthesize(text: string, options?: TTSOptions): Promise<Result<TTSResult, Error>> {
      if (text.length === 0) {
        return err(new Error("Text is empty"));
      }

      if (text.length > MAX_TEXT_LENGTH) {
        return err(
          new Error(`Text length ${text.length} exceeds maximum of ${MAX_TEXT_LENGTH} characters`),
        );
      }

      const voice = options?.voice ?? defaultVoice;

      try {
        const tts = new EdgeTTS(text, voice, {
          rate: "+0%",
          volume: "+0%",
          pitch: "+0Hz",
        });

        const result = await tts.synthesize();

        // result.audio is a Blob — convert to Buffer
        const buffer = Buffer.from(await result.audio.arrayBuffer());

        return ok({
          audio: buffer,
          mimeType: "audio/mpeg",
        });
      } catch (error: unknown) {
        return err(new Error(sanitizeApiError(0, error instanceof Error ? error.message : String(error), "Edge TTS")));
      }
    },
  };
}
