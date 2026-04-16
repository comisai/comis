import type { TranscriptionPort, TranscriptionConfig, SecretManager } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createOpenAISttAdapter } from "./openai-stt-adapter.js";
import { createGroqSttAdapter } from "./groq-stt-adapter.js";
import { createDeepgramSttAdapter } from "./deepgram-stt-adapter.js";

/**
 * Logger interface for the fallback transcription wrapper.
 * Matches the subset of Pino logger used for structured logging.
 */
export interface SttFallbackLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Create an STT provider based on configuration.
 *
 * Selects the appropriate TranscriptionPort adapter based on `config.provider`:
 * - "openai": OpenAI gpt-4o-mini-transcribe (requires OPENAI_API_KEY)
 * - "groq": Groq whisper-large-v3-turbo (requires GROQ_API_KEY)
 * - "deepgram": Deepgram nova-3 (requires DEEPGRAM_API_KEY)
 *
 * @param config - Transcription configuration with provider, model, timeoutMs, maxFileSizeMb
 * @param secretManager - Credential access for API keys
 * @returns The configured TranscriptionPort adapter, or an error for unknown providers
 */
export function createSTTProvider(
  config: TranscriptionConfig,
  secretManager: SecretManager,
): Result<TranscriptionPort, Error> {
  switch (config.provider) {
    case "openai":
      return ok(
        createOpenAISttAdapter({
          apiKey: secretManager.get("OPENAI_API_KEY") ?? "",
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxFileSizeMb: config.maxFileSizeMb,
        }),
      );

    case "groq":
      return ok(
        createGroqSttAdapter({
          apiKey: secretManager.get("GROQ_API_KEY") ?? "",
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxFileSizeMb: config.maxFileSizeMb,
        }),
      );

    case "deepgram":
      return ok(
        createDeepgramSttAdapter({
          apiKey: secretManager.get("DEEPGRAM_API_KEY") ?? "",
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxFileSizeMb: config.maxFileSizeMb,
        }),
      );

    default:
      return err(new Error(`Unknown STT provider: ${config.provider as string}`));
  }
}

/**
 * Create a fallback-capable TranscriptionPort that tries providers in order.
 *
 * Iterates through the providers array, returning the first successful result.
 * Fallback ONLY triggers on `result.ok === false` (API error, timeout, etc.).
 * Empty transcription text is a valid result (silence) and does NOT trigger fallback.
 *
 * @param providers - Ordered array of TranscriptionPort adapters to try
 * @param logger - Optional structured logger for debug/warn output
 * @returns A TranscriptionPort that cascades through providers on failure
 */
export function createFallbackTranscription(
  providers: TranscriptionPort[],
  logger?: SttFallbackLogger,
): TranscriptionPort {
  return {
    async transcribe(audio, options) {
      if (providers.length === 0) {
        return err(new Error("No STT providers configured"));
      }

      let lastError: Error | undefined;

      for (let i = 0; i < providers.length; i++) {
        logger?.debug(
          { providerIndex: i, totalProviders: providers.length },
          "Attempting STT provider",
        );

        const result = await providers[i]!.transcribe(audio, options);

        if (result.ok) {
          return result;
        }

        lastError = result.error;
        const isLastProvider = i === providers.length - 1;
        logger?.warn(
          {
            providerIndex: i,
            err: result.error.message,
            hint: isLastProvider
              ? "All STT providers failed"
              : "Falling back to next STT provider",
            errorKind: "dependency" as const,
          },
          isLastProvider
            ? "All STT providers failed"
            : "STT provider failed, trying next",
        );
      }

      return err(lastError ?? new Error("No STT providers configured"));
    },
  };
}
