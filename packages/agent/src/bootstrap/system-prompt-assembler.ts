// SPDX-License-Identifier: Apache-2.0
/**
 * System prompt assembler with 3 verbosity modes.
 *
 * Composes 20 static section builders into a single system prompt string.
 * Dynamic sections (date/time, inbound metadata) relocated to user-message
 * preamble in prompt-assembly.ts for cache stability.
 * Supports "full" (all sections), "minimal" (7 sections), and "none"
 * (identity line only, no file I/O).
 */

import type { BootstrapContextFile, InboundMetadata, PromptMode, RuntimeInfo } from "./types.js";
import type { SubagentRoleParams } from "./sections/index.js";
import type { ModelTier } from "./sections/index.js";
import {
  buildIdentitySection,
  buildSafetySection,
  buildLanguageSection,
  buildToolingSection,
  buildToolCallStyleSection,
  buildSelfUpdateGatingSection,
  buildConfigSecretIntegritySection,
  buildPrivilegedToolsSection,
  buildTaskDelegationSection,
  buildCodingFallbackSection,
  buildCompactedOutputRecoverySection,
  buildPostCompactionRecoverySection,
  buildPersonaSection,
  buildSkillsSection,
  buildMemoryRecallSection,
  buildWorkspaceSection,
  buildMessagingSection,
  buildBackgroundTaskSection,
  buildSilentRepliesSection,
  buildHeartbeatsSection,
  buildReactionGuidanceSection,
  buildReasoningSection,
  buildRuntimeMetadataSection,
  buildProjectContextSection,
  buildSubagentContextSection,
  buildSubagentRoleSection,
  buildMediaFilesSection,
  buildAutonomousMediaSection,
  buildSenderTrustSection,
  buildDocumentationSection,
  buildTaskPlanningSection,
} from "./sections/index.js";

export type { SubagentRoleParams } from "./sections/index.js";
export type { InboundMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Section separator used between all sections and between the two blocks. */
export const SECTION_SEPARATOR = "\n\n---\n\n";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Multi-block system prompt for independent cache_control placement. */
export interface SystemPromptBlocks {
  /** Static prefix: identity + persona. Never changes per session. */
  staticPrefix: string;
  /** Attribution: safety + language. Changes per-user (language preference). */
  attribution: string;
  /** Semi-stable body: tooling, workspace, messaging, etc. Changes on MCP reconnect. */
  semiStableBody: string;
}

export interface AssemblerParams {
  agentName?: string;
  promptMode?: PromptMode;
  toolNames?: string[];
  skillsPrompt?: string;
  hasMemoryTools?: boolean;
  workspaceDir?: string;
  heartbeatPrompt?: string;
  reasoningEnabled?: boolean;
  runtimeInfo?: RuntimeInfo;
  /** Per-message metadata injected as trusted system-role context. */
  inboundMeta?: InboundMetadata;
  bootstrapFiles?: BootstrapContextFile[];
  extraSystemPrompt?: string;
  /** Backward-compatible additional sections (RAG memory, etc.) */
  additionalSections?: string[];
  // REMOVED: canarySecret and sessionKey — relocated to dynamic preamble
  /** Pre-rendered <available_skills> XML from formatAvailableSkillsXml(). */
  promptSkillsXml?: string;
  /** Pre-rendered active skill content from expandSkillForInvocation(). */
  activePromptSkillContent?: string;
  /** Current channel context for background task announcement routing. */
  channelContext?: { channelType: string; channelId: string };
  /** Optional tool summaries for MCP/external tools (merged with TOOL_SUMMARIES defaults). */
  toolSummaries?: Record<string, string>;
  /** Structured subagent role params. When provided, replaces extraSystemPrompt for subagent prompts. */
  subagentRole?: SubagentRoleParams;
  /** User's preferred language (BCP-47 code or display name, e.g., "Hebrew", "ar"). Used as default when ambiguous. */
  userLanguage?: string;
  /** Reaction frequency mode for emoji reactions. undefined = section omitted. */
  reactionLevel?: "minimal" | "extensive";
  /** When true, enforces <think>/<final> tag format for non-Anthropic models. */
  reasoningTagHint?: boolean;
  /** AGENTS.md section names for post-compaction recovery. */
  postCompactionSections?: string[];
  /** When true, include MEDIA: directive instructions in the prompt. */
  outboundMediaEnabled?: boolean;
  /** When true, agent prompt includes guidance about persisted media files in workspace. */
  mediaPersistenceEnabled?: boolean;
  /** When true, agent prompt includes guidance about processing attachment hints with on-demand tools. */
  autonomousMediaEnabled?: boolean;
  /** Tool names available to sub-agents, for delegation awareness in system prompt. */
  subAgentToolNames?: string[];
  /** Whether sub-agents inherit MCP tools from parent (default: false). */
  mcpToolsInherited?: boolean;
  /** Pre-resolved sender trust entries for display. */
  senderTrustEntries?: import("./sections/index.js").SenderTrustEntry[];
  /** Sender trust display mode for anti-injection warning. */
  senderTrustDisplayMode?: import("./sections/index.js").TrustDisplayMode;
  /** Documentation config for help links section. */
  documentationConfig?: import("@comis/core").DocumentationConfig;
  /** When true, exclude BOOTSTRAP.md from Project Context section. */
  excludeBootstrapFromContext?: boolean;
  /** Workspace profile controlling platform instruction verbosity ('full' or 'specialist'). */
  workspaceProfile?: "full" | "specialist";
  /** Whether Silent Execution Planner (SEP) is enabled for this agent. */
  sepEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Media Sharing section builder
// ---------------------------------------------------------------------------

/**
 * Build the Media Sharing section for outbound MEDIA: directives.
 *
 * Only included when outboundMediaEnabled is true and mode is not minimal.
 */
function buildMediaSharingSection(
  outboundMediaEnabled: boolean | undefined,
  isMinimal: boolean,
): string[] {
  if (isMinimal || !outboundMediaEnabled) return [];

  return [
    "## Media Sharing",
    "",
    "When you want to share an image or file with the user, include a line in your response with the format:",
    "",
    "MEDIA: <url>",
    "",
    "Where <url> is the direct link to the image or file. The system will automatically download the media and deliver it to the user. Guidelines:",
    "- Use one MEDIA: line per image/file, each on its own line.",
    "- The URL must be a direct link to the media (not a webpage containing media).",
    "- Supported: images (JPEG, PNG, GIF, WebP), documents, audio, video.",
    "- You can include text before or after MEDIA: lines for context/captions.",
    "- Multiple MEDIA: lines are supported in a single response.",
    "- MEDIA: lines will be removed from the text shown to the user.",
    "- MEDIA: directives are for web URLs only. To send local workspace files, use the `message` tool with action=attach.",
  ];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Join non-empty section arrays into a single string with SECTION_SEPARATOR between them. */
function joinSections(sections: string[][]): string {
  const nonEmpty = sections.filter((lines) => lines.length > 0);
  return nonEmpty.map((lines) => lines.join("\n")).join(SECTION_SEPARATOR);
}

/**
 * Build all section arrays in the canonical order (1-22).
 *
 * Shared by both `assembleRichSystemPrompt` and `assembleRichSystemPromptBlocks`
 * to guarantee identity by construction between both assembly functions.
 *
 * @returns Array of section line arrays in fixed order
 */
function buildAllSections(params: AssemblerParams, isMinimal: boolean): string[][] {
  const agentName = params.agentName ?? "Comis";
  const modelTier: ModelTier = isMinimal ? "small" : "large";

  return [
    // --- Static prefix sections (indices 0-1) ---
    buildIdentitySection(agentName),                                          // 1
    buildPersonaSection(params.bootstrapFiles ?? []),                          // 1b: Persona (SOUL.md) before Safety
    // --- Attribution sections (indices 2-3) ---
    buildSafetySection(isMinimal),                                            // 2
    buildLanguageSection(params.userLanguage),                                 // 2b
    // --- Semi-stable body sections (indices 4+) ---
    buildToolingSection(params.toolNames ?? [], modelTier, params.toolSummaries), // 3
    buildToolCallStyleSection(isMinimal, params.toolNames ?? []),              // 4
    buildSelfUpdateGatingSection(params.toolNames ?? [], isMinimal, true),    // 5: deferred to tool result
    buildConfigSecretIntegritySection(params.toolNames ?? [], isMinimal),     // 5a: always-present
    buildPrivilegedToolsSection(params.toolNames ?? [], isMinimal, true),     // 5b: deferred to tool result
    buildCompactedOutputRecoverySection(isMinimal),                           // 6
    buildPostCompactionRecoverySection(                                       // 6a
      params.bootstrapFiles ?? [],
      isMinimal,
      params.postCompactionSections,
    ),
    buildCodingFallbackSection(params.toolNames ?? [], isMinimal, true),      // 6b: deferred to tool result
    buildTaskDelegationSection(params.toolNames ?? [], isMinimal, params.subAgentToolNames, params.mcpToolsInherited, true), // 6c: deferred to tool result
    buildSkillsSection(params.skillsPrompt, isMinimal, params.promptSkillsXml, params.activePromptSkillContent), // 7: Merged filesystem + prompt skills
    buildMemoryRecallSection(params.hasMemoryTools ?? false, isMinimal),       // 8
    buildWorkspaceSection(params.workspaceDir, isMinimal),                    // 9
    params.documentationConfig
      ? buildDocumentationSection(params.documentationConfig, params.toolNames ?? [], isMinimal)
      : [],                                                                    // 9b: Documentation
    buildMessagingSection(params.toolNames ?? [], isMinimal, params.channelContext), // 10
    buildBackgroundTaskSection(params.toolNames ?? [], isMinimal, params.channelContext), // 11
    buildSilentRepliesSection(isMinimal),                                     // 14
    buildHeartbeatsSection(params.heartbeatPrompt, isMinimal),                // 15
    buildReactionGuidanceSection(params.reactionLevel, params.channelContext?.channelType, isMinimal), // 16
    buildMediaSharingSection(params.outboundMediaEnabled, isMinimal),                                // 16b
    buildMediaFilesSection(                                                                            // 16c
      params.hasMemoryTools ?? false,
      (params.toolNames ?? []).includes("message"),
      params.workspaceDir,
      params.mediaPersistenceEnabled ?? false,
      isMinimal,
    ),
    buildAutonomousMediaSection(params.autonomousMediaEnabled ?? false, isMinimal),                      // 16d
    buildReasoningSection(params.reasoningEnabled ?? false, isMinimal, params.reasoningTagHint ?? false), // 17
    buildTaskPlanningSection(params.sepEnabled ?? false, isMinimal),            // 17b: SEP task planning (static, cache-stable)
    // buildDateTimeSection() removed from system prompt (relocated to user-message preamble in prompt-assembly.ts)
    buildRuntimeMetadataSection(params.runtimeInfo ?? {}, isMinimal),          // 19
    // buildInboundMetadataSection() removed from system prompt (relocated to user-message preamble in prompt-assembly.ts)
    buildSenderTrustSection(params.senderTrustEntries ?? [], params.senderTrustDisplayMode ?? "raw", isMinimal), // 20b
    buildProjectContextSection(                                                 // 21
      params.bootstrapFiles ?? [],
      isMinimal,
      params.excludeBootstrapFromContext ? new Set(["BOOTSTRAP.md"]) : undefined,
      params.workspaceProfile,
    ),
    // Subagent: prefer structured params, fall back to raw extraSystemPrompt
    ...(params.subagentRole
      ? [buildSubagentRoleSection(params.subagentRole)]
      : [buildSubagentContextSection(params.extraSystemPrompt)]),              // 22
  ];
}

/**
 * Append additional sections (backward compat for RAG memory etc.) to a joined string.
 *
 * @param joined - Already-joined section string
 * @param additionalSections - Extra sections to append
 * @returns Final string with extras appended via SECTION_SEPARATOR
 */
function appendAdditionalSections(joined: string, additionalSections?: string[]): string {
  let result = joined;
  if (additionalSections && additionalSections.length > 0) {
    const extras = additionalSections.filter(Boolean);
    if (extras.length > 0) {
      result = result + SECTION_SEPARATOR + extras.join(SECTION_SEPARATOR);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble a rich multi-section system prompt.
 *
 * @param params - All optional parameters for section inclusion
 * @returns Assembled system prompt string
 */
export function assembleRichSystemPrompt(params: AssemblerParams): string {
  const agentName = params.agentName ?? "Comis";
  const mode: PromptMode = params.promptMode ?? "full";

  // "none" mode: identity line only, no other sections
  if (mode === "none") {
    return buildIdentitySection(agentName).join("\n");
  }

  const isMinimal = mode === "minimal";
  const allSections = buildAllSections(params, isMinimal);

  // Filter out empty arrays, join each section's lines, then join sections
  const joined = joinSections(allSections);

  // Append additional sections (backward compat for RAG memory etc.)
  const result = appendAdditionalSections(joined, params.additionalSections);

  // Canary token relocated to dynamic preamble in prompt-assembly.ts.
  // OutputGuard scans response text against deps.canaryToken (passed separately),
  // so the canary protects against leakage regardless of prompt placement.

  return result;
}

// ---------------------------------------------------------------------------
// Block assembler
// ---------------------------------------------------------------------------

/** Number of leading sections that form the static prefix (identity, persona). */
const STATIC_PREFIX_SECTION_COUNT = 2;

/** Number of attribution sections after static prefix (safety, language). */
const ATTRIBUTION_SECTION_COUNT = 2;

/**
 * Assemble a multi-block system prompt split into a static prefix, attribution, and semi-stable body.
 *
 * The static prefix (sections 1-1b: identity, persona) never changes per session.
 * The attribution (sections 2-2b: safety, language) changes per-user (language preference).
 * The semi-stable body (sections 3-22 + additionalSections) can change when MCP tools
 * reconnect or tool schemas evolve. Splitting enables independent Anthropic `cache_control`
 * placement so that per-user attribution changes do not invalidate the static identity prefix
 * cache entry.
 *
 * **Identity invariant:** For modes "full" and "minimal":
 * `blocks.staticPrefix + SECTION_SEPARATOR + blocks.attribution + SECTION_SEPARATOR + blocks.semiStableBody === assembleRichSystemPrompt(sameParams)`
 *
 * @param params - All optional parameters for section inclusion (same as assembleRichSystemPrompt)
 * @returns SystemPromptBlocks with staticPrefix, attribution, and semiStableBody
 */
export function assembleRichSystemPromptBlocks(params: AssemblerParams): SystemPromptBlocks {
  const agentName = params.agentName ?? "Comis";
  const mode: PromptMode = params.promptMode ?? "full";

  // "none" mode: identity line only in prefix, empty attribution and body
  if (mode === "none") {
    return {
      staticPrefix: buildIdentitySection(agentName).join("\n"),
      attribution: "",
      semiStableBody: "",
    };
  }

  const isMinimal = mode === "minimal";
  const allSections = buildAllSections(params, isMinimal);

  // Split at boundaries: identity+persona | safety+language | tooling+workspace+...
  const staticSections = allSections.slice(0, STATIC_PREFIX_SECTION_COUNT);
  const attributionSections = allSections.slice(
    STATIC_PREFIX_SECTION_COUNT,
    STATIC_PREFIX_SECTION_COUNT + ATTRIBUTION_SECTION_COUNT,
  );
  const bodySections = allSections.slice(STATIC_PREFIX_SECTION_COUNT + ATTRIBUTION_SECTION_COUNT);

  const staticPrefix = joinSections(staticSections);
  const attribution = joinSections(attributionSections);
  const semiStableBody = appendAdditionalSections(
    joinSections(bodySections),
    params.additionalSections,
  );

  return { staticPrefix, attribution, semiStableBody };
}
