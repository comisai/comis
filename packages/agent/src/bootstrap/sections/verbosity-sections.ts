// SPDX-License-Identifier: Apache-2.0
/**
 * Verbosity hint section builder for channel-aware response style.
 *
 * Follows the existing section builder pattern from core-sections.ts:
 * receives pre-resolved parameters, returns string[] for preamble assembly.
 *
 * .
 */
import type { VerbosityConfig, VerbosityLevel } from "@comis/core";

/** Resolved verbosity profile for a specific request context. */
export interface VerbosityProfile {
  level: VerbosityLevel;
  maxMessageChars?: number;
  maxResponseChars?: number;
  useMarkdown?: boolean;
  allowCodeBlocks?: boolean;
}

/**
 * Resolve a VerbosityProfile from config, channel type, and chat type.
 *
 * Precedence: per-channel override > threadLevel > defaultLevel.
 */
export function resolveVerbosityProfile(
  config: VerbosityConfig | undefined,
  channelType: string,
  chatType: string,
  maxMessageChars?: number,
): VerbosityProfile | undefined {
  if (!config?.enabled) return undefined;

  let level: VerbosityLevel = config.defaultLevel;

  // thread-level override
  if (chatType === "thread" && config.threadLevel) {
    level = config.threadLevel;
  }

  const channelOverride = config.overrides[channelType];

  // per-channel override has highest precedence
  if (channelOverride?.level) {
    level = channelOverride.level;
  }

  return {
    level,
    maxMessageChars,
    maxResponseChars: channelOverride?.maxResponseChars,
    useMarkdown: channelOverride?.useMarkdown,
    allowCodeBlocks: channelOverride?.allowCodeBlocks,
  };
}

/**
 * Build verbosity hint lines for the system prompt preamble.
 *
 * Auto mode emits only a platform character limit (no style opinion).
 * Explicit levels emit structured style instructions with optional sub-hints.
 */
export function buildVerbosityHintSection(
  profile: VerbosityProfile | undefined,
  _isMinimal: boolean,
): string[] {
  if (!profile || _isMinimal) return [];

  if (profile.level === "auto") {
    if (!profile.maxMessageChars) return [];
    return [
      `This platform has a ${profile.maxMessageChars} character message limit. Keep responses within that constraint.`,
    ];
  }

  const lines: string[] = ["## Response Style"];

  switch (profile.level) {
    case "terse":
      lines.push("Keep responses under 2-3 sentences. No formatting. Direct answers only.");
      break;
    case "concise":
      lines.push("Keep responses brief and focused. Use short paragraphs. Limit to key information.");
      break;
    case "standard":
      lines.push("Use clear, well-structured responses. Formatting and code blocks are fine.");
      break;
    case "detailed":
      lines.push("Provide thorough responses with context, examples, and formatting as needed.");
      break;
  }

  if (profile.maxResponseChars) {
    lines.push(`~${profile.maxResponseChars} characters target response length.`);
  }
  if (profile.useMarkdown === false) {
    lines.push("Do not use markdown formatting.");
  }
  if (profile.allowCodeBlocks === false) {
    lines.push("Do not use code blocks.");
  }

  return lines;
}
