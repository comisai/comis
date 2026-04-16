/**
 * Cache break diff file writer: persists structured JSON diagnostics
 * to ~/.comis/cache-breaks/ on each cache break event.
 *
 * Subscribes to observability:cache_break via TypedEventBus.
 * File rotation: 50-file cap, oldest-first deletion.
 * Fault-tolerant: I/O errors logged at WARN, never propagated.
 *
 * @module
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createPatch } from "diff";
import { safePath } from "@comis/core";

const MAX_DIFF_FILES = 50;

/** DIFF-CONTENT: Maximum chars per category (system, tools) for snapshot content before diffing. */
const MAX_SNAPSHOT_CHARS = 50_000;

/**
 * Payload shape for cache break events. Uses `string` for reason/ttlCategory
 * to match the event bus payload type (which is wider than CacheBreakReason).
 * Structurally compatible with both CacheBreakEvent and the event bus payload.
 */
export interface CacheBreakDiffPayload {
  provider: string;
  reason: string;
  tokenDrop: number;
  tokenDropRelative: number;
  previousCacheRead: number;
  currentCacheRead: number;
  callCount: number;
  changes: {
    systemChanged: boolean;
    toolsChanged: boolean;
    metadataChanged: boolean;
    modelChanged: boolean;
    retentionChanged: boolean;
    addedTools: string[];
    removedTools: string[];
    changedSchemaTools: string[];
    headersChanged: boolean;
    extraBodyChanged: boolean;
    /** Effort value (params.thinking) changed between turns. */
    effortChanged?: boolean;
    /** cache_control markers changed on system blocks. */
    cacheControlChanged?: boolean;
  };
  toolsChanged: string[];
  ttlCategory: string | undefined;
  agentId: string;
  sessionKey: string;
  timestamp: number;
  /** DIFF-CONTENT: Serialized previous system prompt content (for diff generation). Capped at 50K chars. */
  previousSystem?: string;
  /** DIFF-CONTENT: Serialized current system prompt content (for diff generation). Capped at 50K chars. */
  currentSystem?: string;
  /** DIFF-CONTENT: Serialized previous tools JSON (for diff generation). Capped at 50K chars. */
  previousTools?: string;
  /** DIFF-CONTENT: Serialized current tools JSON (for diff generation). Capped at 50K chars. */
  currentTools?: string;
  /** Effort value from detection pipeline for downstream analytics. */
  effortValue?: string;
  /** Breakpoint budget context at time of break. */
  breakpointBudget?: {
    total: number;
    system: number;
    tool: number;
    message: number;
    sdkAuto: number;
  };
}

export interface CacheBreakDiffWriterConfig {
  /** Directory for diff files (e.g., ~/.comis/cache-breaks) */
  outputDir: string;
  /** Logger for WARN on I/O errors */
  logger: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * Build a combined diffable text snapshot from system prompt and tools content.
 * Produces a single unified text block for quick visual scanning of all cache-relevant
 * content. Used to generate combined diffs before per-category diffs.
 *
 * @param system - Serialized system prompt text, or undefined for empty
 * @param tools - Serialized tools JSON, or undefined for empty
 * @param model - Optional model identifier for the snapshot header
 * @returns Combined text snapshot with labeled sections
 */
export function buildDiffableContent(
  system: string | undefined,
  tools: string | undefined,
  model?: string,
): string {
  const header = model ? `Model: ${model}\n\n` : "";
  const systemSection = `=== System Prompt ===\n\n${system ?? "(empty)"}\n\n`;
  const toolsSection = `=== Tools ===\n\n${tools ?? "(empty)"}\n`;
  return `${header}${systemSection}${toolsSection}`;
}

/**
 * Create a cache break diff writer handler.
 * Returns a function suitable for eventBus.on("observability:cache_break", handler).
 *
 * @param config - outputDir and logger
 * @returns Handler function that writes a structured JSON diff file per cache break event
 */
export function createCacheBreakDiffWriter(
  config: CacheBreakDiffWriterConfig,
): (event: CacheBreakDiffPayload) => void {
  let dirEnsured = false;

  return (event: CacheBreakDiffPayload): void => {
    try {
      if (!dirEnsured) {
        mkdirSync(config.outputDir, { recursive: true });
        dirEnsured = true;
      }

      pruneOldestFiles(config.outputDir, MAX_DIFF_FILES);

      const ts = new Date(event.timestamp).toISOString().replace(/[:.]/g, "-");
      const filename = `${ts}_${event.agentId}_${event.reason}.json`;
      const filePath = safePath(config.outputDir, filename);

      const diff = {
        timestamp: new Date(event.timestamp).toISOString(),
        agentId: event.agentId,
        sessionKey: event.sessionKey,
        provider: event.provider,
        reason: event.reason,
        tokenImpact: {
          drop: event.tokenDrop,
          dropRelative: event.tokenDropRelative,
          previousCacheRead: event.previousCacheRead,
          currentCacheRead: event.currentCacheRead,
        },
        attribution: {
          systemChanged: event.changes.systemChanged,
          toolsChanged: event.changes.toolsChanged,
          modelChanged: event.changes.modelChanged,
          retentionChanged: event.changes.retentionChanged,
          metadataChanged: event.changes.metadataChanged,
          headersChanged: event.changes.headersChanged,
          extraBodyChanged: event.changes.extraBodyChanged,
          // New attribution fields (use ?? false for backward compat with older payloads)
          effortChanged: event.changes.effortChanged ?? false,
          cacheControlChanged: event.changes.cacheControlChanged ?? false,
        },
        toolDiffs: {
          added: event.changes.addedTools,
          removed: event.changes.removedTools,
          schemaChanged: event.changes.changedSchemaTools,
        },
        callCount: event.callCount,
        ttlCategory: event.ttlCategory,
        // Thread effort value for analytics
        effortValue: event.effortValue,
        // Breakpoint budget context
        ...(event.breakpointBudget && { breakpointBudget: event.breakpointBudget }),
      };

      writeFileSync(filePath, JSON.stringify(diff, null, 2) + "\n");

      // DIFF-CONTENT: Generate unified diff file alongside JSON
      const diffSections: string[] = [];

      // Generate diffs for ANY break event that has serialized content available
      // (not just system/tools changes). Effort, retention, header changes etc. now also
      // produce diffs when content was materialized by the lazy getter.
      const hasAnyContent =
        event.previousSystem !== undefined || event.currentSystem !== undefined ||
        event.previousTools !== undefined || event.currentTools !== undefined;

      // Combined diffable content snapshot -- single unified diff for
      // quick visual scanning of all cache-relevant content changes at a glance.
      // Placed first so the combined snapshot appears before per-category detail diffs.
      if (hasAnyContent) {
        const prevCombined = buildDiffableContent(
          event.previousSystem?.slice(0, MAX_SNAPSHOT_CHARS),
          event.previousTools?.slice(0, MAX_SNAPSHOT_CHARS),
        );
        const currCombined = buildDiffableContent(
          event.currentSystem?.slice(0, MAX_SNAPSHOT_CHARS),
          event.currentTools?.slice(0, MAX_SNAPSHOT_CHARS),
        );
        if (prevCombined !== currCombined) {
          diffSections.push(createPatch(
            "combined",
            prevCombined,
            currCombined,
            "previous-turn",
            "current-turn",
            { context: 3 },
          ));
        }
      }

      // Per-category detail diffs (after combined) -- check content availability, not change flag
      if (event.previousSystem !== undefined || event.currentSystem !== undefined) {
        const prevSys = (event.previousSystem ?? "").slice(0, MAX_SNAPSHOT_CHARS);
        const currSys = (event.currentSystem ?? "").slice(0, MAX_SNAPSHOT_CHARS);
        if (prevSys !== currSys) {
          diffSections.push(createPatch(
            "system-prompt",
            prevSys,
            currSys,
            "previous-turn",
            "current-turn",
            { context: 3 },
          ));
        }
      }
      if (event.previousTools !== undefined || event.currentTools !== undefined) {
        const prevTools = (event.previousTools ?? "").slice(0, MAX_SNAPSHOT_CHARS);
        const currTools = (event.currentTools ?? "").slice(0, MAX_SNAPSHOT_CHARS);
        if (prevTools !== currTools) {
          diffSections.push(createPatch(
            "tools",
            prevTools,
            currTools,
            "previous-turn",
            "current-turn",
            { context: 3 },
          ));
        }
      }
      if (diffSections.length > 0) {
        const diffFilename = filename.replace(".json", ".diff");
        const diffFilePath = safePath(config.outputDir, diffFilename);
        writeFileSync(diffFilePath, diffSections.join("\n\n") + "\n");
      }
    } catch (err) {
      // Never propagate I/O errors
      config.logger.warn(
        { err, hint: "Cache break diff file write failed; detection flow unaffected", errorKind: "resource" as const },
        "Cache break diff write failed",
      );
    }
  };
}

/**
 * Delete oldest JSON files when directory exceeds maxFiles.
 * Non-fatal: readdir/unlink errors are silently caught.
 *
 * @param dir - Directory path containing diff files
 * @param maxFiles - Maximum number of files allowed after pruning + new write
 */
function pruneOldestFiles(dir: string, maxFiles: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f): f is string => typeof f === "string" && (f.endsWith(".json") || f.endsWith(".diff")))
      .sort(); // ISO timestamps sort lexicographically
    const excess = files.length - maxFiles + 1; // +1 to make room for new file
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        try { unlinkSync(safePath(dir, files[i]!)); } catch { /* may already be deleted */ }
      }
    }
  } catch {
    // readdir failure is non-fatal
  }
}
