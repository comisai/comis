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

// ---------------------------------------------------------------------------
// Typed section descriptor (design §1b)
//
// Replaces scattered `skipForOp ? [] :` calls. Each SECTIONS entry declares
// which PromptModes include it via `includeIn`. Any new section MUST declare
// an includeIn set -- there is no "default" fall-through. The test at
// system-prompt-assembler.test.ts asserts every descriptor has a non-empty
// includeIn + unique id, which catches accidental omissions.
//
// "none" mode is NOT in the inclusion matrix; the assembler short-circuits
// early and emits only identity.
// ---------------------------------------------------------------------------

/**
 * Internal descriptor for a system prompt section.
 *
 * Engineering notes:
 *  - `id` must be unique across SECTIONS and stable (used by tests).
 *  - `includeIn` must be non-empty.
 *  - `build` receives `(params, mode)` and is responsible for forwarding
 *    `mode === "minimal"` as the existing builders' `isMinimal` parameter.
 *
 * @internal exported for tests only
 */
export interface SectionDescriptor {
  readonly id: string;
  readonly includeIn: ReadonlySet<PromptMode>;
  readonly build: (params: AssemblerParams, mode: PromptMode) => string[];
}

/** Sections present in full, operational, and minimal modes.
 *  NB: builders may still self-filter to `[]` when their isMinimal flag is set. */
const MODES_ALL: ReadonlySet<PromptMode> = new Set<PromptMode>(["full", "operational", "minimal"]);
/** Sections present in full and minimal modes (stripped in operational).
 *  Interactive-only guidance that doesn't apply to autonomous cron/heartbeat runs
 *  but that minimal sub-agent contexts historically saw before this refactor.
 *  Minimal-mode builders typically self-filter to [] via their own isMinimal flag;
 *  membership here preserves pre-refactor behavior without changing minimal output. */
const MODES_FULL_MIN: ReadonlySet<PromptMode> = new Set<PromptMode>(["full", "minimal"]);
/** Sections present only in full mode (stripped in operational AND minimal).
 *  Reserved for sections whose builder is cheap but whose output is not desired
 *  in either non-interactive context. Currently unused; MODES_FULL_MIN is
 *  preferred to preserve pre-refactor minimal output. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future use
const MODES_FULL: ReadonlySet<PromptMode> = new Set<PromptMode>(["full"]);

/**
 * Canonical section list in emission order.
 *
 * Order MUST match the previous hand-written `buildAllSections` so the
 * `staticPrefix`/`attribution` index boundaries (2 + 2) continue to enclose
 * identity+persona and safety+language respectively.
 *
 * @internal exported for tests only
 */
export const SECTIONS: ReadonlyArray<SectionDescriptor> = [
  // --- Static prefix block (indices 0-1 in every mode that includes them) ---
  { id: "identity",         includeIn: MODES_ALL,      build: (p) => buildIdentitySection(p.agentName ?? "Comis") },
  { id: "persona",          includeIn: MODES_ALL,      build: (p) => buildPersonaSection(p.bootstrapFiles ?? []) },
  // --- Attribution block (safety self-filters in minimal) ---
  { id: "safety",           includeIn: MODES_ALL,      build: (p, m) => buildSafetySection(m === "minimal") },
  { id: "language",         includeIn: MODES_ALL,      build: (p) => buildLanguageSection(p.userLanguage) },
  // --- Semi-stable body: operational-kept sections (MODES_ALL -- builders self-filter for minimal) ---
  { id: "tooling",          includeIn: MODES_ALL,      build: (p, m) => buildToolingSection(p.toolNames ?? [], m === "minimal" ? "small" as ModelTier : "large" as ModelTier, p.toolSummaries) },
  { id: "tool-call-style",  includeIn: MODES_ALL,      build: (p, m) => buildToolCallStyleSection(m === "minimal", p.toolNames ?? []) },
  // --- Operational-stripped sections (MODES_FULL_MIN -- dropped in "operational") ---
  { id: "self-update",      includeIn: MODES_FULL_MIN, build: (p, m) => buildSelfUpdateGatingSection(p.toolNames ?? [], m === "minimal", true) },
  { id: "config-secret",    includeIn: MODES_FULL_MIN, build: (p, m) => buildConfigSecretIntegritySection(p.toolNames ?? [], m === "minimal") },
  { id: "privileged",       includeIn: MODES_FULL_MIN, build: (p, m) => buildPrivilegedToolsSection(p.toolNames ?? [], m === "minimal", true) },
  { id: "compact-recover",  includeIn: MODES_FULL_MIN, build: (p, m) => buildCompactedOutputRecoverySection(m === "minimal") },
  { id: "post-compact",     includeIn: MODES_FULL_MIN, build: (p, m) => buildPostCompactionRecoverySection(p.bootstrapFiles ?? [], m === "minimal", p.postCompactionSections) },
  { id: "coding-fallback",  includeIn: MODES_FULL_MIN, build: (p, m) => buildCodingFallbackSection(p.toolNames ?? [], m === "minimal", true) },
  { id: "task-delegation",  includeIn: MODES_FULL_MIN, build: (p, m) => buildTaskDelegationSection(p.toolNames ?? [], m === "minimal", p.subAgentToolNames, p.mcpToolsInherited, true) },
  // --- Operational-kept body (MODES_ALL) ---
  { id: "skills",           includeIn: MODES_ALL,      build: (p, m) => buildSkillsSection(p.skillsPrompt, m === "minimal", p.promptSkillsXml, p.activePromptSkillContent) },
  { id: "memory-recall",    includeIn: MODES_ALL,      build: (p, m) => buildMemoryRecallSection(p.hasMemoryTools ?? false, m === "minimal") },
  { id: "workspace",        includeIn: MODES_ALL,      build: (p, m) => buildWorkspaceSection(p.workspaceDir, m === "minimal") },
  // --- Operational-stripped body ---
  { id: "documentation",    includeIn: MODES_FULL_MIN, build: (p, m) => p.documentationConfig
                                                          ? buildDocumentationSection(p.documentationConfig, p.toolNames ?? [], m === "minimal")
                                                          : [] },
  { id: "messaging",        includeIn: MODES_ALL,      build: (p, m) => buildMessagingSection(p.toolNames ?? [], m === "minimal", p.channelContext) },
  { id: "background",       includeIn: MODES_FULL_MIN, build: (p, m) => buildBackgroundTaskSection(p.toolNames ?? [], m === "minimal", p.channelContext) },
  { id: "silent-replies",   includeIn: MODES_FULL_MIN, build: (p, m) => buildSilentRepliesSection(m === "minimal") },
  { id: "heartbeats",       includeIn: MODES_FULL_MIN, build: (p, m) => buildHeartbeatsSection(p.heartbeatPrompt, m === "minimal") },
  { id: "reactions",        includeIn: MODES_FULL_MIN, build: (p, m) => buildReactionGuidanceSection(p.reactionLevel, p.channelContext?.channelType, m === "minimal") },
  { id: "media-sharing",    includeIn: MODES_FULL_MIN, build: (p, m) => buildMediaSharingSection(p.outboundMediaEnabled, m === "minimal") },
  { id: "media-files",      includeIn: MODES_FULL_MIN, build: (p, m) => buildMediaFilesSection(p.hasMemoryTools ?? false, (p.toolNames ?? []).includes("message"), p.workspaceDir, p.mediaPersistenceEnabled ?? false, m === "minimal") },
  { id: "autonomous-media", includeIn: MODES_FULL_MIN, build: (p, m) => buildAutonomousMediaSection(p.autonomousMediaEnabled ?? false, m === "minimal") },
  { id: "reasoning",        includeIn: MODES_ALL,      build: (p, m) => buildReasoningSection(p.reasoningEnabled ?? false, m === "minimal", p.reasoningTagHint ?? false) },
  { id: "sep",              includeIn: MODES_FULL_MIN, build: (p, m) => buildTaskPlanningSection(p.sepEnabled ?? false, m === "minimal") },
  { id: "runtime-meta",     includeIn: MODES_ALL,      build: (p, m) => buildRuntimeMetadataSection(p.runtimeInfo ?? {}, m === "minimal") },
  { id: "sender-trust",     includeIn: MODES_FULL_MIN, build: (p, m) => buildSenderTrustSection(p.senderTrustEntries ?? [], p.senderTrustDisplayMode ?? "raw", m === "minimal") },
  { id: "project-context",  includeIn: MODES_ALL,      build: (p, m) => buildProjectContextSection(
                                                          p.bootstrapFiles ?? [],
                                                          m === "minimal",
                                                          p.excludeBootstrapFromContext ? new Set(["BOOTSTRAP.md"]) : undefined,
                                                          p.workspaceProfile,
                                                        ) },
];

/**
 * Build all section arrays in the canonical order.
 *
 * Filters `SECTIONS` by mode inclusion, then builds each included descriptor.
 * Subagent context is appended unconditionally as the last entry (matches the
 * previous behavior).
 *
 * Shared by both `assembleRichSystemPrompt` and `assembleRichSystemPromptBlocks`
 * to guarantee identity by construction between both assembly functions.
 *
 * @returns Array of section line arrays in fixed order
 */
function buildAllSections(params: AssemblerParams, mode: PromptMode): string[][] {
  const base = SECTIONS
    .filter((s) => s.includeIn.has(mode))
    .map((s) => s.build(params, mode));

  // Subagent section: prefer structured params, fall back to raw extraSystemPrompt.
  // Unconditional; matches the previous hand-written emission.
  const subagent = params.subagentRole
    ? buildSubagentRoleSection(params.subagentRole)
    : buildSubagentContextSection(params.extraSystemPrompt);

  return [...base, subagent];
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

  const allSections = buildAllSections(params, mode);

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

  const allSections = buildAllSections(params, mode);

  // Split at boundaries: identity+persona | safety+language | tooling+workspace+...
  // Boundaries are index-based on the filtered section list. In `"full"` and
  // `"operational"` modes the first 2 entries are identity+persona (both are
  // in MODES_FULL_OP) and the next 2 are safety+language (MODES_ALL). In
  // `"minimal"` mode persona is dropped, so the prefix shrinks by one and the
  // byte-identity between full/operational is NOT expected in minimal mode.
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
