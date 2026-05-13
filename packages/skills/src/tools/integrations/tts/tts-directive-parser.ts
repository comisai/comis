// SPDX-License-Identifier: Apache-2.0
/**
 * Parsed TTS directive extracted from response text.
 *
 * Represents the key=value pairs found in a [[tts:...]] tag.
 * An empty object (no keys) means "use defaults but do synthesize."
 */
export interface TtsDirective {
  /** Voice override (e.g., "nova", "Xb7hH8MSUJpSbSDYk0k2") */
  readonly voice?: string;
  /** Provider override (e.g., "openai", "elevenlabs", "edge") */
  readonly provider?: "openai" | "elevenlabs" | "edge";
  /** Format override (e.g., "mp3", "opus") */
  readonly format?: string;
  /** Speed override (e.g., 1.5) */
  readonly speed?: number;
}

/**
 * Result of parsing a TTS directive from text.
 */
export interface TtsDirectiveResult {
  /** Parsed directive, or null if no directive was found */
  readonly directive: TtsDirective | null;
  /** Text with all TTS directives stripped and trimmed */
  readonly cleanText: string;
}

/**
 * Regex to match [[tts]] or [[tts:key=value key2=value2]] directives.
 *
 * Uses named capture groups for clarity:
 * - The full match is the directive tag to strip
 * - The "params" group captures the key=value pairs (may be empty)
 *
 * Pattern: [[tts]] or [[tts:key=value key2=value2]]
 */
const DIRECTIVE_REGEX = /\[\[tts(?::(?<params>[^\]]*))?\]\]/;
const DIRECTIVE_GLOBAL_REGEX = /\[\[tts(?::[^\]]*?)?\]\]/g;

/**
 * Regex to match individual key=value pairs within the params string.
 *
 * Named capture groups: key and value
 * Values can be unquoted words or quoted strings.
 */
const PARAM_REGEX = /(?<key>\w+)=(?<value>"[^"]*"|'[^']*'|\S+)/g;

/** Valid provider values */
const VALID_PROVIDERS = new Set(["openai", "elevenlabs", "edge"]);

/**
 * Parse a TTS directive from response text.
 *
 * Extracts the FIRST [[tts:...]] directive found in the text,
 * parses its key=value parameters, and strips ALL directive
 * occurrences from the text.
 *
 * Supported keys: voice, provider, format, speed
 *
 * Examples:
 * - `"Hello [[tts]] world"` -> directive: {}, cleanText: "Hello  world" (trimmed)
 * - `"[[tts:voice=nova provider=openai]] Hi"` -> directive: { voice: "nova", provider: "openai" }, cleanText: "Hi"
 * - `"No directive here"` -> directive: null, cleanText: "No directive here"
 *
 * @param text - The response text that may contain TTS directives
 * @returns Parsed directive (or null) and cleaned text
 */
export function parseTtsDirective(text: string): TtsDirectiveResult {
  const match = DIRECTIVE_REGEX.exec(text);

  if (!match) {
    return { directive: null, cleanText: text };
  }

  // Parse key=value params from the first directive
  const paramsStr = match.groups?.params ?? "";
  const directive: Record<string, string | number> = {};

  let paramMatch: RegExpExecArray | null;
  // Reset lastIndex since PARAM_REGEX is global
  PARAM_REGEX.lastIndex = 0;
  while ((paramMatch = PARAM_REGEX.exec(paramsStr)) !== null) {
    const key = paramMatch.groups?.key;
    const rawValue = paramMatch.groups?.value;

    if (!key || rawValue === undefined) continue;

    // Strip surrounding quotes from value
    const value = rawValue.replace(/^["']|["']$/g, "");

    switch (key) {
      case "voice":
        directive.voice = value;
        break;
      case "provider":
        if (VALID_PROVIDERS.has(value)) {
          directive.provider = value;
        }
        break;
      case "format":
        directive.format = value;
        break;
      case "speed": {
        const num = parseFloat(value);
        if (!isNaN(num) && num > 0) {
          directive.speed = num;
        }
        break;
      }
      // Unknown keys are silently ignored
    }
  }

  // Strip ALL directive occurrences from text
  const cleanText = text.replace(DIRECTIVE_GLOBAL_REGEX, "").trim();

  return { directive: directive as TtsDirective, cleanText };
}

/**
 * Strip all TTS directives from text without parsing them.
 *
 * Removes all [[tts]] and [[tts:...]] patterns from the text
 * and trims the result.
 *
 * @param text - Text that may contain TTS directives
 * @returns Text with all directives removed and trimmed
 */
export function stripTtsDirectives(text: string): string {
  return text.replace(DIRECTIVE_GLOBAL_REGEX, "").trim();
}
