import type { TTSPort, TTSOptions, TTSResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { ElevenLabsClient, type ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { sanitizeApiError } from "./media-adapter-shared.js";

/**
 * Configuration for the ElevenLabs TTS adapter.
 */
export interface ElevenLabsTTSAdapterConfig {
  /** ElevenLabs API key (required). */
  readonly apiKey: string;
  /** Model ID (default: "eleven_multilingual_v2"). */
  readonly modelId?: string;
  /** Default voice ID (default: "Xb7hH8MSUJpSbSDYk0k2" — Rachel). */
  readonly defaultVoice?: string;
}

const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_VOICE_ID = "Xb7hH8MSUJpSbSDYk0k2";
const MAX_TEXT_LENGTH = 5000;

/**
 * Validate that a format string is a known ElevenLabs output format.
 * ElevenLabs formats always contain an underscore separator (e.g., "mp3_44100_128",
 * "opus_48000_64", "pcm_44100"). OpenAI formats like "opus", "mp3" do NOT contain
 * underscores and must be rejected to prevent API errors.
 */
function isValidElevenLabsFormat(format: string): boolean {
  return format.includes("_");
}

/**
 * Create an ElevenLabs TTS adapter implementing TTSPort.
 *
 * Uses the official @elevenlabs/elevenlabs-js SDK.
 * The SDK returns a Readable stream which is consumed to a Buffer.
 */
export function createElevenLabsTTSAdapter(config: ElevenLabsTTSAdapterConfig): TTSPort {
  const client = new ElevenLabsClient({ apiKey: config.apiKey });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;
  const defaultVoice = config.defaultVoice ?? DEFAULT_VOICE_ID;

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

      const voiceId = options?.voice ?? defaultVoice;

      // Determine output format: use options.format only if it's a valid ElevenLabs format
      const outputFmt = (options?.format && isValidElevenLabsFormat(options.format))
        ? options.format
        : "mp3_44100_128";

      try {
        const audio = await client.textToSpeech.convert(voiceId, {
          text,
          modelId,
          outputFormat: outputFmt as ElevenLabs.TextToSpeechConvertRequestOutputFormat,
        });

        // SDK returns a Readable stream — consume to Buffer
        const chunks: Buffer[] = [];
        for await (const chunk of audio) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);

        // Resolve MIME type dynamically from the actual output format
        const mimeType = outputFmt.startsWith("opus") ? "audio/opus"
          : outputFmt.startsWith("pcm") ? "audio/pcm"
          : "audio/mpeg";

        return ok({
          audio: buffer,
          mimeType,
        });
      } catch (error: unknown) {
        return err(new Error(sanitizeApiError(0, error instanceof Error ? error.message : String(error), "ElevenLabs TTS")));
      }
    },
  };
}
