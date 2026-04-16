import type { TtsAutoMode } from "@comis/core";

/**
 * Configuration needed for auto-TTS decision.
 */
export interface AutoTtsConfig {
  /** Auto mode setting: off, always, inbound, or tagged */
  readonly autoMode: TtsAutoMode;
  /** Regex pattern string to detect TTS tags in response text */
  readonly tagPattern: string;
}

/**
 * Context about the current message/response for auto-TTS evaluation.
 */
export interface AutoTtsContext {
  /** The LLM response text to potentially synthesize */
  readonly responseText: string;
  /** Whether the inbound user message contained audio (voice note) */
  readonly hasInboundAudio: boolean;
  /** Whether the response contains a media URL (image, file, etc.) */
  readonly hasMediaUrl: boolean;
}

/**
 * Result of the auto-TTS decision.
 */
export interface AutoTtsResult {
  /** Whether TTS synthesis should proceed */
  readonly shouldSynthesize: boolean;
  /** Text with TTS tags stripped (only present for "tagged" mode when match found) */
  readonly strippedText?: string;
}

/**
 * Determine whether to automatically synthesize speech for a response.
 *
 * Decision logic by mode:
 * - "off": Never synthesize
 * - "always": Always synthesize, unless response has media (skip TTS for media responses)
 * - "inbound": Synthesize only when user sent audio (reply with voice), skip if media
 * - "tagged": Synthesize only when response contains [[tts]] directive, strip tag from text
 *
 * @param config - Auto-TTS configuration with mode and tag pattern
 * @param context - Current message context (response text, audio/media flags)
 * @returns Decision result with shouldSynthesize flag and optional stripped text
 */
export function shouldAutoTts(
  config: AutoTtsConfig,
  context: AutoTtsContext,
): AutoTtsResult {
  switch (config.autoMode) {
    case "off":
      return { shouldSynthesize: false };

    case "always":
      // Skip TTS when response contains media (images, files, etc.)
      // TTS + media attachment in same response creates confusion
      if (context.hasMediaUrl) {
        return { shouldSynthesize: false };
      }
      return { shouldSynthesize: true };

    case "inbound":
      // Only reply with voice when user sent voice, skip if response has media
      if (!context.hasInboundAudio || context.hasMediaUrl) {
        return { shouldSynthesize: false };
      }
      return { shouldSynthesize: true };

    case "tagged": {
      // Check if response text matches the tag pattern (e.g., [[tts]] or [[tts:voice=nova]])
      const regex = new RegExp(config.tagPattern);
      if (!regex.test(context.responseText)) {
        return { shouldSynthesize: false };
      }
      // Strip all TTS tag occurrences from the text
      const globalRegex = new RegExp(config.tagPattern, "g");
      const strippedText = context.responseText.replace(globalRegex, "").trim();
      return { shouldSynthesize: true, strippedText };
    }

    default: {
      // Exhaustive check — should never reach here
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = config.autoMode;
      return { shouldSynthesize: false };
    }
  }
}
