// SPDX-License-Identifier: Apache-2.0
/**
 * buildMediaConfig — shared helper for the MEDIA scenario tests.
 *
 * Builds a temp YAML config file with an `integrations.media` block for any
 * combination of:
 *
 *   - tts.provider + tts.autoMode            (TtsConfigSchema)
 *   - transcription.provider + transcription.fallbackProviders (TranscriptionConfigSchema)
 *   - vision.providers                        (VisionConfigSchema)
 *   - imageGeneration.provider                (ImageGenerationConfigSchema)
 *
 * CRITICAL — schema-key fidelity: the transcription fallback chain key is
 * `fallbackProviders` (an array of "openai"|"groq"|"deepgram"), NOT `fallback`.
 * See packages/core/src/config/schema-integrations.ts → TranscriptionConfigSchema.
 * The media config nests under the TOP-LEVEL `integrations:` key (the same place
 * the daemon reads media settings from — schema-integrations.ts line ~560
 * `media: MediaConfigSchema`). Emitting an unknown key (e.g. `fallback:`) would
 * be rejected by the daemon's z.strictObject at boot.
 *
 * Only sub-blocks whose corresponding opt is provided are emitted, so callers
 * can build a minimal config (e.g. tts-only) without dragging in unrelated keys.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml (has no integrations: block, so the
 * media block is appended at end-of-file; if an integrations: block ever appears
 * in the base, the media block is nested under it instead).
 *
 * Mirrors tool-config.ts / mcp-config.ts structure.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const _here = dirname(fileURLToPath(import.meta.url));

/** TTS auto-mode — when to automatically synthesize speech (TtsAutoModeSchema). */
export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";
/** TTS provider (TtsConfigSchema.provider). */
export type TtsProvider = "openai" | "elevenlabs" | "edge";
/** STT/transcription provider (TranscriptionConfigSchema.provider). */
export type SttProvider = "openai" | "groq" | "deepgram";
/** Vision provider (VisionConfigSchema.providers items). */
export type VisionProvider = "openai" | "anthropic" | "google";
/** Image-generation provider (ImageGenerationConfigSchema.provider). */
export type ImageGenProvider = "fal" | "openai";

/**
 * Options for building a per-combo media config.
 *
 * Every field except `label` is optional — only the requested sub-blocks are
 * emitted under integrations.media.
 */
export interface MediaConfigOpts {
  /** integrations.media.tts.provider. Emits the tts block when set (with ttsAutoMode). */
  ttsProvider?: TtsProvider;
  /** integrations.media.tts.autoMode. Emits the tts block when set (with ttsProvider). */
  ttsAutoMode?: TtsAutoMode;
  /** integrations.media.transcription.provider. Emits the transcription block when set. */
  sttProvider?: SttProvider;
  /** When true, adds transcription.fallbackProviders: [groq] (the REAL schema key). */
  sttFallback?: boolean;
  /** integrations.media.vision.providers. Emits the vision block when non-empty. */
  visionProviders?: VisionProvider[];
  /** integrations.media.imageGeneration.provider. Emits the imageGeneration block when set. */
  imageGenProvider?: ImageGenProvider;
  /** Human-readable label used in the output filename (sanitised). */
  label: string;
  /** Short prefix for the temp filename. Defaults to "media". */
  filePrefix?: string;
}

/**
 * Build the `integrations.media` YAML body (the lines under `  media:`), indented
 * for nesting beneath a top-level `integrations:` key. Returns an empty string
 * when no media opts are provided.
 */
function buildMediaBody(opts: MediaConfigOpts): string {
  const lines: string[] = [];

  // tts block — emit when either ttsProvider or ttsAutoMode is set.
  if (opts.ttsProvider !== undefined || opts.ttsAutoMode !== undefined) {
    lines.push("    tts:");
    if (opts.ttsProvider !== undefined) lines.push(`      provider: ${opts.ttsProvider}`);
    if (opts.ttsAutoMode !== undefined) lines.push(`      autoMode: ${opts.ttsAutoMode}`);
  }

  // transcription block — emit when sttProvider is set.
  if (opts.sttProvider !== undefined) {
    lines.push("    transcription:");
    lines.push(`      provider: ${opts.sttProvider}`);
    if (opts.sttFallback === true) {
      // REAL schema key: fallbackProviders (NOT fallback). Default fallback is groq.
      lines.push("      fallbackProviders:");
      lines.push("        - groq");
    }
  }

  // vision block — emit when visionProviders is set and non-empty.
  if (opts.visionProviders !== undefined && opts.visionProviders.length > 0) {
    lines.push("    vision:");
    lines.push("      providers:");
    for (const provider of opts.visionProviders) {
      lines.push(`        - ${provider}`);
    }
  }

  // imageGeneration block — emit when imageGenProvider is set.
  if (opts.imageGenProvider !== undefined) {
    lines.push("    imageGeneration:");
    lines.push(`      provider: ${opts.imageGenProvider}`);
  }

  return lines.join("\n");
}

/**
 * Build a temp YAML config patching integrations.media.* for the given combo.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildMediaConfig(opts: MediaConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  const mediaBody = buildMediaBody(opts);

  if (mediaBody.length > 0) {
    if (/^integrations:/m.test(content)) {
      // A top-level integrations: block already exists — append the media block
      // immediately after the `integrations:` line.
      content = content.replace(
        /(^integrations:\s*\n)/m,
        `$1  media:\n${mediaBody}\n`,
      );
    } else {
      // No integrations: block — append the full block at end-of-file.
      content = `${content.trimEnd()}\nintegrations:\n  media:\n${mediaBody}\n`;
    }
  }

  const prefix = opts.filePrefix ?? "media";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
