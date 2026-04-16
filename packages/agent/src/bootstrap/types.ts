/**
 * Bootstrap types for workspace file loading and system prompt assembly.
 *
 * These types support the workspace loader (loading all 7 workspace files
 * with truncation and missing-file markers) and the system prompt assembler
 * (composing rich multi-section prompts with verbosity modes).
 */

import type { WorkspaceFileName } from "../workspace/templates.js";

/**
 * A workspace file loaded (or attempted) from the agent workspace directory.
 *
 * - `missing: false` means the file was read successfully and `content` is set.
 * - `missing: true` means the file was not found; `content` is undefined.
 */
export interface BootstrapFile {
  /** Workspace file name (e.g. "SOUL.md", "AGENTS.md") */
  readonly name: WorkspaceFileName;
  /** Resolved absolute path on disk */
  readonly path: string;
  /** File content (present only when file exists) */
  readonly content?: string;
  /** Whether the file was missing from the workspace */
  readonly missing: boolean;
}

/**
 * Result of truncating a file's content to fit within maxChars.
 */
export interface TruncationResult {
  /** The (possibly truncated) content */
  readonly content: string;
  /** Whether truncation was applied */
  readonly truncated: boolean;
  /** Original content length before truncation */
  readonly originalLength: number;
}

/**
 * System prompt verbosity mode.
 *
 * - `"full"`: All workspace sections included (primary agents)
 * - `"minimal"`: Only AGENTS.md + TOOLS.md (sub-agents)
 * - `"none"`: Identity-only prompt (lightweight contexts)
 */
export type PromptMode = "full" | "minimal" | "none";

/**
 * Runtime metadata injected into the system prompt header.
 */
export interface RuntimeInfo {
  readonly agentId?: string;
  readonly host?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  /** Node.js version (e.g., "20.11.0") */
  readonly nodeVersion?: string;
  /** User's default shell (e.g., "/bin/zsh") */
  readonly shell?: string;
  /** Configured default model string */
  readonly defaultModel?: string;
  /** Current channel type (e.g., "telegram") */
  readonly channel?: string;
  /** Comma-separated capability summary (e.g., "reactions, threads, fetch") */
  readonly channelCapabilities?: string;
}

/**
 * Per-message metadata injected as trusted system-role context.
 * Changes on every message turn (unlike RuntimeInfo which is static per session).
 */
export interface InboundMetadata {
  readonly messageId: string;
  readonly senderId: string;
  readonly senderTrust?: string;
  readonly chatId: string;
  readonly channel: string;
  readonly chatType: string;
  readonly flags: Record<string, boolean>;
}

/**
 * Output format for assembled bootstrap context files.
 * Used by the system prompt assembler to compose sections.
 */
export interface BootstrapContextFile {
  /** Display path (typically the workspace file name) */
  readonly path: string;
  /** File content (possibly truncated or a [MISSING] marker) */
  readonly content: string;
}

/**
 * Workspace file names allowed in sub-agent bootstrap context.
 * Sub-agents only receive AGENTS.md (instructions) and TOOLS.md (tool notes).
 */
export const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set<WorkspaceFileName>([
  "AGENTS.md",
  "ROLE.md",
  "TOOLS.md",
]);

/** Head portion ratio for truncation (first 70% of maxChars) */
export const BOOTSTRAP_HEAD_RATIO = 0.7;

/** Tail portion ratio for truncation (last 20% of maxChars) */
export const BOOTSTRAP_TAIL_RATIO = 0.2;
