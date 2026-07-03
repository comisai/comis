// SPDX-License-Identifier: Apache-2.0
/**
 * Shared JSONL append + rotation helper.
 *
 * The api-payload-trace writer relies on this rotation logic
 * — kept in this module so both the api-payload trace and any future
 * sync-fs JSONL trace can share the size/rotation handling.
 *
 * Use `@comis/observability/cache-trace/*` for new artifacts. This helper
 * is intentionally a thin wrapper around sync fs primitives — the
 * substrate path is recommended for new code (it offers queued I/O,
 * payload bounding, and credential sanitization).
 *
 * @module
 */

import { appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";

import type { ComisLogger } from "@comis/core";

/**
 * Parse a human-readable size string (e.g. "5m", "1g", "500k") into bytes.
 *
 * Supports k (1024), m (1024^2), g (1024^3) suffixes (case-insensitive).
 * Returns 0 if the string cannot be parsed (which disables rotation by
 * convention).
 *
 * @internal
 */
export function parseSizeBytes(sizeStr: string): number {
  const match = /^(\d+)([kmg])?$/i.exec(sizeStr);
  if (!match) return 0;

  const num = parseInt(match[1], 10);
  const suffix = (match[2] ?? "").toLowerCase();

  switch (suffix) {
    case "k":
      return num * 1024;
    case "m":
      return num * 1024 * 1024;
    case "g":
      return num * 1024 * 1024 * 1024;
    default:
      return num;
  }
}

/**
 * Rotate a trace file if it exceeds the configured maximum size.
 *
 * Rotation scheme: foo.jsonl -> foo.jsonl.1 -> foo.jsonl.2 -> ...
 * Files beyond `maxFiles` are deleted.
 *
 * Rotation failure is logged at WARN but never throws — rotation must
 * not block tracing.
 *
 * @internal
 */
export function rotateJsonlIfNeeded(
  filePath: string,
  maxSize: string | undefined,
  maxFiles: number | undefined,
  logger: ComisLogger,
): void {
  if (maxSize === undefined || maxFiles === undefined) return;

  const maxSizeBytes = parseSizeBytes(maxSize);
  if (maxSizeBytes === 0) return;

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    // File doesn't exist or stat failed — nothing to rotate.
    return;
  }

  if (fileSize < maxSizeBytes) return;

  try {
    // Delete oldest file if it would exceed maxFiles after rotation.
    const oldestPath = `${filePath}.${maxFiles}`;
    try {
      unlinkSync(oldestPath);
    } catch {
      /* may not exist */
    }

    // Shift existing rotated files: .N-1 -> .N
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      try {
        renameSync(from, to);
      } catch {
        /* may not exist */
      }
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
 * Sync I/O is acceptable — one line per LLM call, not a hot path. Errors
 * are silently logged to prevent trace I/O from breaking execution.
 *
 * If `maxSize` and `maxFiles` are both provided, rotates the file before
 * writing when it exceeds the configured size threshold.
 *
 * @internal
 */
export function appendJsonlLine(
  filePath: string,
  entry: Record<string, unknown>,
  logger: ComisLogger,
  maxSize?: string,
  maxFiles?: number,
): void {
  try {
    rotateJsonlIfNeeded(filePath, maxSize, maxFiles, logger);
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
