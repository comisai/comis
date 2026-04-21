// SPDX-License-Identifier: Apache-2.0
import type { TtsOutputFormat } from "@comis/core";

/**
 * Resolved output format for all three TTS providers.
 *
 * Each provider has its own format string convention:
 * - OpenAI: "opus", "mp3", "aac", "flac", "wav", "pcm"
 * - ElevenLabs: "opus_48000_64", "mp3_44100_128", etc.
 * - Edge TTS: SSML output format strings like "audio-24khz-48kbitrate-mono-mp3"
 */
export interface ResolvedOutputFormat {
  /** OpenAI format string (e.g., "opus", "mp3") */
  readonly openai: string;
  /** ElevenLabs format string (e.g., "opus_48000_64", "mp3_44100_128") */
  readonly elevenlabs: string;
  /** Edge TTS output format string */
  readonly edge: string;
  /** File extension including the dot (e.g., ".opus", ".mp3") */
  readonly extension: string;
  /** Whether the format is compatible with voice notes (Telegram OGG/Opus) */
  readonly voiceCompatible: boolean;
}

/**
 * Format mapping per abstract format name.
 *
 * Maps a provider-agnostic format string (e.g., "opus", "mp3") to
 * concrete format strings for each provider.
 */
const FORMAT_MAP: Record<string, ResolvedOutputFormat> = {
  opus: {
    openai: "opus",
    // Note: Edge TTS does not output Opus directly. For Telegram with Edge provider,
    // output is MP3 (not a true voice note). The edge field here uses MP3 as a fallback
    // since Edge lacks Opus output support.
    elevenlabs: "opus_48000_64",
    edge: "audio-24khz-48kbitrate-mono-mp3",
    extension: ".opus",
    voiceCompatible: true,
  },
  mp3: {
    openai: "mp3",
    elevenlabs: "mp3_44100_128",
    edge: "audio-24khz-48kbitrate-mono-mp3",
    extension: ".mp3",
    voiceCompatible: false,
  },
  aac: {
    openai: "aac",
    elevenlabs: "mp3_44100_128",
    edge: "audio-24khz-48kbitrate-mono-mp3",
    extension: ".aac",
    voiceCompatible: false,
  },
  wav: {
    openai: "wav",
    elevenlabs: "pcm_44100",
    edge: "audio-24khz-48kbitrate-mono-mp3",
    extension: ".wav",
    voiceCompatible: false,
  },
};

/** Default format (MP3) used when channel or format is not recognized. */
const DEFAULT_FORMAT = FORMAT_MAP["mp3"]!;

/**
 * Channel-to-format defaults (before user overrides).
 */
const CHANNEL_DEFAULTS: Record<string, string> = {
  telegram: "opus",
  discord: "mp3",
  whatsapp: "mp3",
  slack: "mp3",
};

/**
 * Resolve the output format for a specific channel, with optional user overrides.
 *
 * Resolution order:
 * 1. If `outputFormats` has a channel-specific override, use that format
 * 2. Otherwise, use the channel default (Opus for Telegram, MP3 for others)
 * 3. Look up the format name in FORMAT_MAP for provider-specific strings
 * 4. Fall back to MP3 if the format name is not recognized
 *
 * @param channelType - The channel type string (e.g., "telegram", "discord"), or undefined
 * @param outputFormats - Optional per-channel format overrides from TTS config
 * @returns Resolved format with provider-specific strings, extension, and voice compatibility
 */
export function resolveOutputFormat(
  channelType: string | undefined,
  outputFormats?: TtsOutputFormat,
): ResolvedOutputFormat {
  // Determine the abstract format name for this channel
  let formatName: string;

  if (outputFormats && channelType && channelType in outputFormats) {
    // User override for this specific channel
    formatName = outputFormats[channelType as keyof TtsOutputFormat];
  } else if (outputFormats && !channelType && outputFormats.default) {
    // No channel specified, use the user's default override
    formatName = outputFormats.default;
  } else if (channelType && channelType in CHANNEL_DEFAULTS) {
    // Built-in channel default
    formatName = CHANNEL_DEFAULTS[channelType]!;
  } else if (outputFormats?.default) {
    // Fall through to user's default
    formatName = outputFormats.default;
  } else {
    // Absolute fallback
    formatName = "mp3";
  }

  return FORMAT_MAP[formatName] ?? DEFAULT_FORMAT;
}

/**
 * Infer MIME type from a file extension.
 *
 * @param extension - File extension (with or without leading dot)
 * @returns MIME type string
 */
export function inferMimeType(extension: string): string {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;

  switch (ext) {
    case ".opus":
    case ".ogg":
      return "audio/opus";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".pcm":
      return "audio/pcm";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}
