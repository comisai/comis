// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap types for workspace file loading and system prompt assembly.
 *
 * These types support workspace loading and typed prompt compilation.
 */

import type { WorkspaceFileName } from "@comis/core";

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
 * Every mode retains the engine kernel. Full and operational modes include
 * bounded runtime context. Minimal and compact-secure defer optional runtime
 * context, while none also defers operator policy for lightweight execution.
 */
export type PromptMode = "full" | "operational" | "minimal" | "none" | "compact-secure";

/**
 * Per-message metadata injected as trusted system-role context.
 * Changes on every message turn.
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
