// SPDX-License-Identifier: Apache-2.0
/**
 * Media file persistence with UUID naming, sidecar metadata, and TTL cleanup.
 *
 * All path construction uses safePath() from @comis/core/security --
 * NEVER path.join(). All methods return Result<T, Error> and never throw.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";

/** Media ID validation pattern: letters, digits, dots, hyphens, underscores. */
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;

/** Maximum characters in a media ID. */
const MAX_MEDIA_ID_CHARS = 200;

/** Default time-to-live for stored media files (2 minutes). */
const DEFAULT_TTL_MS = 120_000;

/** Default maximum bytes per saved file (5 MB). */
const DEFAULT_MAX_BYTES = 5_242_880;

/** Sidecar metadata persisted alongside each media file. */
interface SidecarMeta {
  readonly contentType?: string;
  readonly savedAt: number;
  readonly size: number;
}

/** Zod schema for validating sidecar metadata after JSON.parse. */
const SidecarMetaSchema = z.object({
  contentType: z.string().optional(),
  savedAt: z.number(),
  size: z.number(),
});

/** Dependencies for the media store factory. */
export interface MediaStoreDeps {
  /** Base directory for media file storage. */
  readonly mediaDir: string;
  /** Default TTL in ms for stored files (default: 120,000). */
  readonly defaultTtlMs?: number;
  /** Maximum file size in bytes (default: 5,242,880). */
  readonly maxBytes?: number;
  /** Logger for warnings. */
  readonly logger: {
    warn(msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** Metadata about a successfully saved media file. */
export interface SavedMedia {
  /** UUID-based media identifier. */
  readonly id: string;
  /** Absolute path to the saved file. */
  readonly path: string;
  /** File size in bytes. */
  readonly size: number;
  /** MIME content type (if known). */
  readonly contentType?: string;
  /** Unix timestamp (ms) when saved. */
  readonly savedAt: number;
}

/** Media store interface for file persistence with TTL. */
export interface MediaStore {
  /**
   * Save a buffer to disk with a generated UUID name.
   * Optionally places the file in a subdirectory under mediaDir.
   */
  save(
    buffer: Buffer,
    contentType?: string,
    subdir?: string,
  ): Promise<Result<SavedMedia, Error>>;

  /**
   * Retrieve a saved file by its media ID.
   */
  get(
    id: string,
    subdir?: string,
  ): Promise<Result<{ buffer: Buffer; contentType?: string; savedAt: number }, Error>>;

  /**
   * Remove expired files older than TTL. Returns count of files removed.
   */
  cleanup(ttlMs?: number): Promise<Result<number, Error>>;

  /**
   * Delete a specific file and its sidecar metadata.
   */
  delete(id: string, subdir?: string): Promise<Result<void, Error>>;
}

/**
 * Validate a media ID for safe filesystem use.
 */
function validateId(id: string): string | undefined {
  if (!id || id.length > MAX_MEDIA_ID_CHARS) {
    return "Media ID too long or empty";
  }
  if (id === "." || id === "..") {
    return "Media ID cannot be . or ..";
  }
  if (!MEDIA_ID_PATTERN.test(id)) {
    return "Media ID contains invalid characters";
  }
  return undefined;
}

/**
 * Create a media store with UUID naming, sidecar metadata, and TTL cleanup.
 */
export function createMediaStore(deps: MediaStoreDeps): MediaStore {
  const { mediaDir, logger } = deps;
  const ttl = deps.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async save(
      buffer: Buffer,
      contentType?: string,
      subdir?: string,
    ): Promise<Result<SavedMedia, Error>> {
      try {
        if (buffer.length > maxBytes) {
          return err(
            new Error(
              `File exceeds max size: ${buffer.length} > ${maxBytes} bytes`,
            ),
          );
        }

        const id = crypto.randomUUID();
        const dir = subdir ? safePath(mediaDir, subdir) : mediaDir;
        const filePath = safePath(dir, id);
        const metaPath = safePath(dir, `${id}.meta`);

        // Ensure directory exists
        await fs.mkdir(dir, { recursive: true });

        const savedAt = Date.now();
        const meta: SidecarMeta = { contentType, savedAt, size: buffer.length };

        // Write file and metadata atomically
        await Promise.all([
          fs.writeFile(filePath, buffer),
          fs.writeFile(metaPath, JSON.stringify(meta)),
        ]);

        return ok({ id, path: filePath, size: buffer.length, contentType, savedAt });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "Check filesystem permissions and disk space for the media storage directory", errorKind: "resource" as const }, "Media store save failed");
        return err(error);
      }
    },

    async get(
      id: string,
      subdir?: string,
    ): Promise<
      Result<{ buffer: Buffer; contentType?: string; savedAt: number }, Error>
    > {
      try {
        const idError = validateId(id);
        if (idError) {
          return err(new Error(idError));
        }

        const dir = subdir ? safePath(mediaDir, subdir) : mediaDir;
        const filePath = safePath(dir, id);
        const metaPath = safePath(dir, `${id}.meta`);

        // Read file and metadata in parallel
        const [buffer, metaRaw] = await Promise.all([
          fs.readFile(filePath),
          fs.readFile(metaPath, "utf-8").catch(() => undefined),
        ]);

        let contentType: string | undefined;
        let savedAt = 0;

        if (metaRaw) {
          const metaResult = SidecarMetaSchema.safeParse(JSON.parse(metaRaw));
          if (metaResult.success) {
            contentType = metaResult.data.contentType;
            savedAt = metaResult.data.savedAt;
          }
        }

        return ok({ buffer, contentType, savedAt });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      }
    },

    async cleanup(customTtl?: number): Promise<Result<number, Error>> {
      try {
        const effectiveTtl = customTtl ?? ttl;
        const now = Date.now();
        let removed = 0;

        let entries: string[];
        try {
          entries = await fs.readdir(mediaDir);
        } catch {
          // Directory doesn't exist yet -- nothing to clean
          return ok(0);
        }

        for (const entry of entries) {
          // Skip .meta files (they're cleaned up with their parent)
          if (entry.endsWith(".meta")) continue;

          const filePath = safePath(mediaDir, entry);
          try {
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > effectiveTtl) {
              const metaPath = safePath(mediaDir, `${entry}.meta`);
              try { await fs.unlink(filePath); } catch { /* cleanup best-effort */ }
              try { await fs.unlink(metaPath); } catch { /* cleanup best-effort */ }
              removed++;
            }
          } catch {
            // File disappeared between readdir and stat -- skip
          }
        }

        return ok(removed);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn({ err: error.message, hint: "Stale media files may accumulate; check filesystem permissions", errorKind: "resource" as const }, "Media store cleanup failed");
        return err(error);
      }
    },

    async delete(id: string, subdir?: string): Promise<Result<void, Error>> {
      try {
        const idError = validateId(id);
        if (idError) {
          return err(new Error(idError));
        }

        const dir = subdir ? safePath(mediaDir, subdir) : mediaDir;
        const filePath = safePath(dir, id);
        const metaPath = safePath(dir, `${id}.meta`);

        try { await fs.unlink(filePath); } catch { /* delete best-effort */ }
        try { await fs.unlink(metaPath); } catch { /* delete best-effort */ }

        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      }
    },
  };
}
