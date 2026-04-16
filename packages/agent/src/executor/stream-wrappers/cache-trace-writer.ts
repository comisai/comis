/**
 * Cache trace writer stream wrapper.
 *
 * Writes a JSONL trace line per LLM call with model ID, message count,
 * and a truncated SHA-256 digest of the system prompt.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the cache trace JSONL writer wrapper.
 */
export interface CacheTraceConfig {
  /** Absolute path to the JSONL trace output file */
  filePath: string;
  /** Agent ID for trace attribution */
  agentId?: string;
  /** Session ID for trace correlation */
  sessionId?: string;
  /** Max file size before rotation (k/m/g suffix). Undefined = no rotation. */
  maxSize?: string;
  /** Number of rotated files to keep. Undefined = no rotation. */
  maxFiles?: number;
}

// ---------------------------------------------------------------------------
// JSONL trace utilities
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable size string (e.g. "5m", "1g", "500k") into bytes.
 *
 * Supports k (1024), m (1024^2), g (1024^3) suffixes (case-insensitive).
 * Returns 0 if the string cannot be parsed (disables rotation).
 *
 * @internal Exported for testing only.
 */
export function parseSize(sizeStr: string): number {
  const match = /^(\d+)([kmg])?$/i.exec(sizeStr);
  if (!match) return 0;

  const num = parseInt(match[1], 10);
  const suffix = (match[2] ?? "").toLowerCase();

  switch (suffix) {
    case "k": return num * 1024;
    case "m": return num * 1024 * 1024;
    case "g": return num * 1024 * 1024 * 1024;
    default:  return num;
  }
}

/**
 * Rotate a trace file if it exceeds the configured maximum size.
 *
 * Rotation scheme: foo.jsonl -> foo.jsonl.1 -> foo.jsonl.2 -> ...
 * Files beyond maxFiles are deleted.
 *
 * Rotation failure is logged at WARN but never throws -- rotation must not
 * block tracing.
 */
export function rotateIfNeeded(
  filePath: string,
  maxSize: string | undefined,
  maxFiles: number | undefined,
  logger: ComisLogger,
): void {
  if (maxSize === undefined || maxFiles === undefined) return;

  const maxSizeBytes = parseSize(maxSize);
  if (maxSizeBytes === 0) return;

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    // File doesn't exist or stat failed -- nothing to rotate
    return;
  }

  if (fileSize < maxSizeBytes) return;

  try {
    // Delete oldest file if it would exceed maxFiles after rotation
    const oldestPath = `${filePath}.${maxFiles}`;
    try { unlinkSync(oldestPath); } catch { /* may not exist */ }

    // Shift existing rotated files: .N-1 -> .N
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      try { renameSync(from, to); } catch { /* may not exist */ }
    }

    // Rename current file to .1
    renameSync(filePath, `${filePath}.1`);
  } catch (rotateErr) {
    logger.warn(
      {
        err: rotateErr,
        filePath,
        hint: "Trace file rotation failed; tracing continues to current file",
        errorKind: "resource" as const,
      },
      "Trace file rotation failed",
    );
  }
}

/**
 * Append a single JSONL line to the given file path.
 *
 * Sync I/O is acceptable -- one line per LLM call, not a hot path.
 * Errors are silently logged to prevent trace I/O from breaking execution.
 *
 * If maxSize and maxFiles are provided, rotates the file before writing
 * when it exceeds the configured size threshold.
 */
export function appendJsonlLine(
  filePath: string,
  entry: Record<string, unknown>,
  logger: ComisLogger,
  maxSize?: string,
  maxFiles?: number,
): void {
  try {
    rotateIfNeeded(filePath, maxSize, maxFiles, logger);
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch (writeErr) {
    logger.warn(
      {
        err: writeErr,
        filePath,
        hint: "Check trace output directory permissions and disk space",
        errorKind: "resource" as const,
      },
      "JSONL trace write failed",
    );
  }
}

/**
 * Create a wrapper that writes a JSONL trace line per LLM call with
 * model ID, message count, and a truncated SHA-256 digest of the system prompt.
 *
 * Purpose: Per-call observability for cache-hit analysis.
 *
 * @param config - Cache trace configuration (file path, optional agent ID)
 * @param logger - Logger for debug output
 * @returns A named StreamFnWrapper ("cacheTraceWriter")
 */
export function createCacheTraceWriter(
  config: CacheTraceConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function cacheTraceWriter(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const systemPromptDigest = context.systemPrompt
        ? createHash("sha256")
            .update(context.systemPrompt)
            .digest("hex")
            .slice(0, 16)
        : undefined;

      appendJsonlLine(
        config.filePath,
        {
          ts: new Date().toISOString(),
          type: "cache_trace",
          agentId: config.agentId,
          sessionId: config.sessionId,
          modelId: model.id,
          provider: model.provider,
          messageCount: context.messages.length,
          systemPromptDigest,
          toolCount: context.tools?.length ?? 0,
        },
        logger,
        config.maxSize,
        config.maxFiles,
      );

      return next(model, context, options);
    };
  };
}
