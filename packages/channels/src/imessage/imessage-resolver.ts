// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage MediaResolverPort adapter.
 *
 * Resolves file:// URIs to local file buffers. Uses safePath() from
 * @comis/core/security to prevent directory traversal attacks against
 * the macOS ~/Library/Messages/Attachments directory.
 *
 * Pre-read size check using fs.stat().
 * Emits a DEBUG log with platform, filePath, sizeBytes, and durationMs.
 * CRITICAL SECURITY: safePath() validation, NOT path.join().
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import { safePath } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface IMessageResolverDeps {
  /** Allowed base paths for local file access (e.g., [os.homedir() + "/Library/Messages/Attachments"]) */
  allowedBasePaths: string[];
  maxBytes: number;
  logger: ResolverLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an iMessage media resolver implementing MediaResolverPort.
 *
 * Resolves file://{path} URIs by validating the file path against
 * allowed base directories using safePath(), then reading the file.
 */
export function createIMessageResolver(deps: IMessageResolverDeps): MediaResolverPort {
  return {
    schemes: ["file"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      return fromPromise(
        (async (): Promise<ResolvedMedia> => {
          // Extract local file path from file://{path}
          const rawPath = attachment.url.replace(/^file:\/\//, "");
          if (!rawPath) {
            throw new Error("Invalid file:// URL: missing path");
          }

          // CRITICAL SECURITY: Validate path against allowed base directories
          let validatedPath: string | undefined;
          for (const basePath of deps.allowedBasePaths) {
            try {
              // safePath() throws PathTraversalError if path escapes base
              validatedPath = safePath(basePath, rawPath);
              break; // Found a valid base
            } catch {
              // Path doesn't match this base, try next
            }
          }

          if (!validatedPath) {
            throw new Error(
              `iMessage file path rejected: "${rawPath}" does not resolve within any allowed base directory`,
            );
          }

          // Pre-read size check via stat
          const stat = await fs.stat(validatedPath);
          if (stat.size > deps.maxBytes) {
            throw new Error(
              `iMessage file size ${stat.size} exceeds limit of ${deps.maxBytes} bytes`,
            );
          }

          // Read file
          const startMs = Date.now();
          const buffer = await fs.readFile(validatedPath);
          const durationMs = Date.now() - startMs;

          // Use attachment mimeType if available, otherwise default
          const mimeType = attachment.mimeType ?? "application/octet-stream";

          // Debug log for media pipeline visibility
          deps.logger.debug(
            { platform: "imessage", filePath: validatedPath, sizeBytes: buffer.length, durationMs },
            "iMessage media resolved",
          );

          return {
            buffer,
            mimeType,
            sizeBytes: buffer.length,
          };
        })(),
      );
    },
  };
}
