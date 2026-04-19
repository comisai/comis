/**
 * Workspace file loader for bootstrap context injection.
 *
 * Loads 8 workspace files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md,
 * TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md, BOOT.md) with per-file truncation
 * and missing-file markers. BOOT.md is excluded from bootstrap loading
 * (injected separately via prompt-assembly on first session message).
 * Uses safePath for path traversal prevention.
 */

import * as fs from "node:fs/promises";
import {
  safePath,
  PathTraversalError,
  stripInvisible,
  detectSuspiciousPatterns,
  WORKSPACE_SCANNER_PATTERNS,
} from "@comis/core";
import { WORKSPACE_FILE_NAMES } from "../workspace/templates.js";
import type { WorkspaceFileName } from "../workspace/templates.js";
import { BOOT_FILE_NAME } from "../workspace/boot-file.js";
import type { BootstrapFile, BootstrapContextFile, TruncationResult } from "./types.js";
import {
  BOOTSTRAP_HEAD_RATIO,
  BOOTSTRAP_TAIL_RATIO,
  SUBAGENT_BOOTSTRAP_ALLOWLIST,
} from "./types.js";

/**
 * Options for workspace file injection scanning.
 */
export interface WorkspaceScanOptions {
  /** When true, scan workspace files for injection patterns (default: true). */
  enabled?: boolean;
  /** When true, replace file content with [BLOCKED] marker on critical findings (default: true). */
  blockOnCritical?: boolean;
  /** Callback fired when injection patterns are detected in a workspace file. */
  onScanResult?: (info: {
    fileName: string;
    patterns: string[];
    blocked: boolean;
    invisibleCharsStripped: boolean;
  }) => void;
}

/**
 * Scan workspace file content for invisible characters and injection patterns.
 *
 * Combines stripInvisible() for zero-width/tag block char removal with
 * detectSuspiciousPatterns() for the 17 base patterns and the 5
 * workspace-specific scanner patterns.
 *
 * @param content - Raw file content
 * @returns Cleaned content, detected pattern sources, and whether invisible chars were stripped
 */
export function scanWorkspaceContent(content: string): {
  cleaned: string;
  patterns: string[];
  invisibleStripped: boolean;
} {
  const { text, tagBlockDetected } = stripInvisible(content);

  // Base 17 patterns from external-content.ts
  const baseMatches = detectSuspiciousPatterns(text);

  // 5 workspace-specific scanner patterns
  const workspaceMatches: string[] = [];
  for (const pattern of WORKSPACE_SCANNER_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      workspaceMatches.push(pattern.source);
    }
  }

  const combinedPatterns = [...baseMatches, ...workspaceMatches];
  const invisibleStripped = tagBlockDetected || text !== content;

  return { cleaned: text, patterns: combinedPatterns, invisibleStripped };
}

/**
 * Truncate file content to fit within maxChars using a head+tail strategy.
 *
 * Keeps the first 70% and last 20% of the allowed character budget,
 * inserting a truncation marker in the middle that tells the agent how
 * to read the full file.
 *
 * @param content - Raw file content
 * @param fileName - File name for the truncation marker
 * @param maxChars - Maximum allowed characters
 * @returns Truncation result with content, truncated flag, and original length
 */
export function truncateFileContent(
  content: string,
  fileName: string,
  maxChars: number,
): TruncationResult {
  const trimmed = content.trimEnd();

  if (trimmed.length <= maxChars) {
    return { content: trimmed, truncated: false, originalLength: trimmed.length };
  }

  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker =
    `\n[...truncated, read ${fileName} for full content...]\n` +
    `...(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})...\n`;

  return {
    content: head + marker + tail,
    truncated: true,
    originalLength: trimmed.length,
  };
}

/**
 * Load workspace bootstrap files from the agent workspace directory.
 *
 * Iterates over all 8 WORKSPACE_FILE_NAMES, resolving each path with
 * safePath for traversal prevention. Missing files are included in the
 * result with `missing: true` and no content field. BOOT.md is excluded
 * from the returned array (injected separately via prompt-assembly).
 *
 * @param workspaceDir - Absolute path to the agent workspace directory
 * @param maxChars - Per-file character limit (default 20000, used for info only here)
 * @returns Array of BootstrapFile objects (BOOT.md excluded from bootstrap loading)
 */
export async function loadWorkspaceBootstrapFiles(
  workspaceDir: string,
   
  _maxChars?: number,
): Promise<BootstrapFile[]> {
  const files: BootstrapFile[] = [];

  for (const name of WORKSPACE_FILE_NAMES) {
    let filePath: string;
    try {
      filePath = safePath(workspaceDir, name);
    } catch (error) {
      // Path traversal detected -- skip this file entirely
      if (error instanceof PathTraversalError) {
        continue;
      }
      throw error;
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      files.push({ name, path: filePath, content, missing: false });
    } catch {
      // File doesn't exist or not readable -- mark as missing
      files.push({ name, path: filePath, missing: true });
    }
  }

  return files.filter(f => f.name !== BOOT_FILE_NAME);
}

/**
 * Filter bootstrap files to only those allowed for sub-agents.
 *
 * Sub-agents receive a minimal bootstrap context containing only
 * AGENTS.md (operating instructions) and TOOLS.md (tool notes).
 *
 * @param files - Full array of loaded bootstrap files
 * @returns Filtered array containing only AGENTS.md and TOOLS.md
 */
export function filterBootstrapFilesForSubAgent(
  files: BootstrapFile[],
): BootstrapFile[] {
  return files.filter((f) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(f.name));
}

/**
 * Allowlist for lightweight heartbeat context mode.
 * Retains ONLY HEARTBEAT.md, stripping all other workspace files.
 */
const HEARTBEAT_LIGHT_ALLOWLIST = new Set<WorkspaceFileName>(["HEARTBEAT.md"]);

/**
 * Filter bootstrap files for lightweight heartbeat context mode.
 *
 * When heartbeat.lightContext is true, only HEARTBEAT.md is injected into
 * the system prompt -- SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md,
 * and BOOTSTRAP.md are all stripped. This reduces token usage for routine
 * heartbeat ticks where personality and full context are not needed.
 *
 * @param files - Full array of loaded bootstrap files
 * @returns Filtered array containing only HEARTBEAT.md
 */
export function filterBootstrapFilesForLightContext(
  files: BootstrapFile[],
): BootstrapFile[] {
  return files.filter((f) => HEARTBEAT_LIGHT_ALLOWLIST.has(f.name));
}

/**
 * Excludelist for group chat context mode.
 * Excludes USER.md (privacy protection: personal preferences
 * should not be exposed in multi-user contexts).
 */
const GROUP_CHAT_EXCLUDELIST = new Set<WorkspaceFileName>(["USER.md"]);

/**
 * Filter bootstrap files for group chat context.
 *
 * When group chat filtering is enabled, USER.md is excluded from
 * the bootstrap context to protect user privacy in multi-user
 * conversations.
 *
 * @param files - Full array of loaded bootstrap files
 * @returns Filtered array with USER.md removed
 */
export function filterBootstrapFilesForGroupChat(
  files: BootstrapFile[],
): BootstrapFile[] {
  return files.filter((f) => !GROUP_CHAT_EXCLUDELIST.has(f.name));
}

/**
 * Build bootstrap context files from loaded workspace files.
 *
 * For each file:
 * - Missing files produce a `[MISSING] Expected at: <path>` marker
 * - Present files are scanned for injection patterns when `scan` is provided
 * - Critical findings replace content with `[BLOCKED: ...]` marker
 * - Present files are truncated to maxChars using head+tail strategy
 * - An optional warn callback is called when truncation occurs
 *
 * Scanning is opt-in: omitting `scan` preserves backward-compatible behavior.
 *
 * @param files - Loaded bootstrap files
 * @param opts - Options: maxChars limit, warn callback, and scan options
 * @returns Array of context files ready for system prompt injection
 */
export function buildBootstrapContextFiles(
  files: BootstrapFile[],
  opts?: { maxChars?: number; warn?: (msg: string) => void; scan?: WorkspaceScanOptions },
): BootstrapContextFile[] {
  const maxChars = opts?.maxChars ?? 20_000;
  const result: BootstrapContextFile[] = [];

  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }

    let content = file.content!;

    // Injection scanning (opt-in via scan parameter)
    if (opts?.scan && opts.scan.enabled !== false) {
      const { cleaned, patterns, invisibleStripped } = scanWorkspaceContent(content);

      if (patterns.length > 0) {
        const blocked = opts.scan.blockOnCritical !== false;
        opts.scan.onScanResult?.({
          fileName: file.name,
          patterns,
          blocked,
          invisibleCharsStripped: invisibleStripped,
        });

        if (blocked) {
          const patternSummary = patterns.slice(0, 3).join(", ") + (patterns.length > 3 ? "..." : "");
          result.push({
            path: file.name,
            content: `[BLOCKED: ${file.name} contained potential prompt injection (${patterns.length} pattern(s): ${patternSummary}). Content not loaded.]`,
          });
          continue;
        }

        // blockOnCritical is false: use cleaned text but don't block
        content = cleaned;
      } else if (invisibleStripped) {
        // No patterns but invisible chars were stripped
        opts.scan.onScanResult?.({
          fileName: file.name,
          patterns: [],
          blocked: false,
          invisibleCharsStripped: true,
        });
        content = cleaned;
      }
      // No patterns and no invisible chars: proceed with original content unchanged
    }

    const truncated = truncateFileContent(content, file.name, maxChars);
    if (truncated.truncated) {
      opts?.warn?.(
        `${file.name} truncated: ${truncated.originalLength} -> ${truncated.content.length} chars`,
      );
    }
    result.push({ path: file.name, content: truncated.content });
  }

  return result;
}
