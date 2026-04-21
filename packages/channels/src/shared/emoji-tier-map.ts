// SPDX-License-Identifier: Apache-2.0
/**
 * Emoji tier mapping for lifecycle reactions.
 *
 * Provides three emoji sets (unicode, platform, custom) that map each
 * displayable lifecycle phase to a distinct emoji character. Also provides
 * a tool-to-phase classifier for routing tool names to lifecycle phases.
 */

import type { LifecyclePhase } from "./lifecycle-state-machine.js";

/**
 * Emoji tier selection matching LifecycleReactionsConfigSchema.emojiTier.
 *
 * - unicode: Cross-platform standard Unicode emoji
 * - platform: Channel-native variants (Discord/Telegram optimized)
 * - custom: Placeholder for user-configured emoji (defaults to unicode)
 */
export type EmojiTier = "unicode" | "platform" | "custom";

/**
 * Maps displayable lifecycle phases to emoji strings.
 * "idle" is excluded -- idle has no visible emoji.
 */
export type DisplayablePhase = Exclude<LifecyclePhase, "idle">;

/** Emoji set mapping each displayable phase to an emoji string. */
export type EmojiSet = Record<DisplayablePhase, string>;

/**
 * Three-tier emoji sets for lifecycle reactions.
 *
 * Each set maps all displayable phases (everything except "idle")
 * to a distinct emoji character.
 */
export const EMOJI_SETS: Record<EmojiTier, EmojiSet> = {
  unicode: {
    queued: "\u{1F440}",          // eyes
    thinking: "\u{1F914}",        // thinking face
    memory: "\u{1F50D}",          // magnifying glass (left)
    tool: "\u{1F527}",            // wrench
    coding: "\u{1F4BB}",          // laptop
    web: "\u{1F310}",             // globe with meridians
    media: "\u{1F3A8}",           // artist palette
    done: "\u{2705}",             // green check mark
    error: "\u{274C}",            // red cross mark
    stall_soft: "\u{23F3}",       // hourglass flowing sand
    stall_hard: "\u{26A0}\u{FE0F}", // warning sign
  },
  platform: {
    queued: "\u{1F440}",          // eyes
    thinking: "\u{1F9E0}",        // brain
    memory: "\u{1F50E}",          // magnifying glass (right)
    tool: "\u{2699}\u{FE0F}",     // gear
    coding: "\u{1F4DD}",          // memo
    web: "\u{1F578}\u{FE0F}",     // spider web
    media: "\u{1F5BC}\u{FE0F}",   // framed picture
    done: "\u{2705}",             // green check mark
    error: "\u{274C}",            // red cross mark
    stall_soft: "\u{23F3}",       // hourglass flowing sand
    stall_hard: "\u{1F6A8}",      // rotating light
  },
  custom: {
    // Identical to unicode -- placeholder for user-configured emoji
    queued: "\u{1F440}",
    thinking: "\u{1F914}",
    memory: "\u{1F50D}",
    tool: "\u{1F527}",
    coding: "\u{1F4BB}",
    web: "\u{1F310}",
    media: "\u{1F3A8}",
    done: "\u{2705}",
    error: "\u{274C}",
    stall_soft: "\u{23F3}",
    stall_hard: "\u{26A0}\u{FE0F}",
  },
};

/**
 * Returns the emoji for a given phase and tier.
 * Returns undefined for the "idle" phase (no visible emoji).
 */
export function getEmojiForPhase(phase: LifecyclePhase, tier: EmojiTier): string | undefined {
  if (phase === "idle") return undefined;
  return EMOJI_SETS[tier][phase as DisplayablePhase];
}

/**
 * Classifies a tool name into a lifecycle phase.
 *
 * Uses prefix/keyword matching with priority order:
 * 1. bash/file_ops/write/edit/read/create_file/apply_diff -> coding
 * 2. web_search/browse/fetch/http/url/scrape -> web
 * 3. image/vision/audio/transcribe/tts/speech/video/media/sharp -> media
 * 4. memory_search/memory_write/memory_delete/remember/recall -> memory
 * 5. everything else -> tool
 */
export function classifyToolPhase(toolName: string): LifecyclePhase {
  const lower = toolName.toLowerCase();

  if (/^(bash|file_ops|write|edit|read|create_file|apply_diff)/i.test(lower)) return "coding";
  if (/^(web_search|browse|fetch|http|url|scrape)/i.test(lower)) return "web";
  if (/^(image|vision|audio|transcribe|tts|speech|video|media|sharp)/i.test(lower)) return "media";
  if (/^(memory_search|memory_write|memory_delete|remember|recall)/i.test(lower)) return "memory";

  return "tool";
}
