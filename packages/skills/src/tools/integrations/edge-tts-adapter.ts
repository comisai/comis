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
 * OpenAI TTS voice names. The shared `media.tts.voice` config default is "alloy"
 * (an OpenAI voice) but applies across ALL providers — so when the keyless-default
 * provider is "edge", "alloy" leaks here and Edge rejects it ("Invalid voice
 * 'alloy'"), breaking keyless TTS out-of-the-box (v2.25 keyless-default-voice
 * regression, live 2026-06-20). Mapping a known OpenAI voice name to the Edge
 * default keeps keyless TTS working while an explicit *Edge* voice still passes through.
 */
const OPENAI_VOICE_NAMES: ReadonlySet<string> = new Set([
  "alloy", "echo", "fable", "onyx", "nova", "shimmer",
  "ash", "ballad", "coral", "sage", "verse",
]);

/**
 * Resolve the Edge voice. The candidate is the per-call voice, else the configured
 * default (which the TTS factory sets from `media.tts.voice` — and that may itself be
 * the leaked OpenAI default "alloy"). If the candidate is an OpenAI voice name (invalid
 * for Edge), fall back to the hardcoded Edge {@link DEFAULT_VOICE} — NOT the configured
 * default, since that is the very value that may be "alloy". An explicit valid Edge voice
 * (per-call or configured) passes through unchanged.
 */
export function resolveEdgeVoice(requested: string | undefined, configuredDefault: string): string {
  const candidate = requested ?? configuredDefault;
  if (candidate && !OPENAI_VOICE_NAMES.has(candidate.toLowerCase())) return candidate;
  return DEFAULT_VOICE;
}

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

      const voice = resolveEdgeVoice(options?.voice, defaultVoice);

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
