/**
 * Media file persistence service -- saves incoming media buffers to organized
 * workspace subdirectories (photos/, videos/, documents/, audio/, files/) with
 * MIME-detected extensions and UUID-based filenames.
 *
 * All path construction uses safePath() from @comis/core/security --
 * NEVER path.join(). All methods return Result<T, Error> and never throw.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";
import { detectMime, getExtensionForMime } from "./mime-detection.js";
import type { MediaKind } from "./constants.js";

/** Default maximum bytes per persisted file (50 MB). */
const DEFAULT_MAX_BYTES = 52_428_800;

/** Map media kind to workspace subdirectory name. */
const KIND_TO_SUBDIR: Readonly<Record<string, string>> = {
  image: "photos",
  video: "videos",
  document: "documents",
  audio: "audio",
  binary: "files",
};

/** Dependencies for the media persistence service factory. */
export interface MediaPersistenceDeps {
  /** Base workspace directory for media file storage. */
  readonly workspaceDir: string;
  /** Logger for persistence operations. */
  readonly logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    debug?(obj: Record<string, unknown>, msg: string): void;
  };
  /** Maximum file size in bytes (default: 50 MB). */
  readonly maxBytes?: number;
}

/** Metadata about a successfully persisted media file. */
export interface PersistedFile {
  /** Absolute path to the saved file. */
  readonly filePath: string;
  /** Workspace-relative path (e.g., "photos/a1b2c3d4.jpg"). */
  readonly relativePath: string;
  /** Detected MIME type. */
  readonly mimeType: string;
  /** File size in bytes. */
  readonly sizeBytes: number;
  /** Media kind classification. */
  readonly mediaKind: MediaKind;
  /** Unix timestamp (ms) when saved. */
  readonly savedAt: number;
}

/** Options for the persist() method. */
export interface PersistOptions {
  /** MIME type hint from platform/HTTP header (binary sniff takes priority). */
  readonly mimeType?: string;
  /** Original filename hint for extension-based MIME fallback. */
  readonly fileName?: string;
  /** Media kind classification for subdirectory routing. */
  readonly mediaKind: MediaKind;
  /** Override the default KIND_TO_SUBDIR mapping (e.g., "screenshots" instead of "photos"). */
  readonly subdirOverride?: string;
}

/** Media persistence service interface. */
export interface MediaPersistenceService {
  /**
   * Persist a buffer to the workspace with MIME-detected extension.
   * Returns PersistedFile on success, Error on failure (never throws).
   */
  persist(
    buffer: Buffer,
    opts: PersistOptions,
  ): Promise<Result<PersistedFile, Error>>;
}

/**
 * Create a media persistence service that saves buffers to organized
 * workspace subdirectories with MIME-detected file extensions.
 */
export function createMediaPersistenceService(
  deps: MediaPersistenceDeps,
): MediaPersistenceService {
  const { workspaceDir, logger } = deps;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async persist(
      buffer: Buffer,
      opts: PersistOptions,
    ): Promise<Result<PersistedFile, Error>> {
      try {
        // 1. Check buffer size against limit
        if (buffer.length > maxBytes) {
          return err(
            new Error(
              `File exceeds max size: ${buffer.length} > ${maxBytes} bytes`,
            ),
          );
        }

        // 2. Detect MIME type from binary magic bytes (highest priority)
        const mimeResult = await detectMime({
          buffer,
          headerMime: opts.mimeType,
          filePath: opts.fileName,
        });

        let mimeType: string;
        if (mimeResult.ok && mimeResult.value) {
          mimeType = mimeResult.value;
        } else if (opts.mimeType) {
          mimeType = opts.mimeType;
        } else {
          mimeType = "application/octet-stream";
        }

        // 3. Determine file extension from detected MIME
        const ext = getExtensionForMime(mimeType) ?? ".bin";

        // 4. Determine subdirectory from media kind
        const subdir = opts.subdirOverride ?? KIND_TO_SUBDIR[opts.mediaKind] ?? "files";

        // 5. Generate UUID-based filename
        const fileName = `${crypto.randomUUID()}${ext}`;

        // 6. Build safe paths (NEVER path.join)
        const dir = safePath(workspaceDir, subdir);
        const filePath = safePath(dir, fileName);
        const relativePath = `${subdir}/${fileName}`;

        // 7. Ensure directory exists
        await fs.mkdir(dir, { recursive: true });

        // 8. Write file to disk
        await fs.writeFile(filePath, buffer);

        const savedAt = Date.now();
        const result: PersistedFile = {
          filePath,
          relativePath,
          mimeType,
          sizeBytes: buffer.length,
          mediaKind: opts.mediaKind,
          savedAt,
        };

        logger.debug?.(
          { relativePath, sizeBytes: buffer.length, mimeType, mediaKind: opts.mediaKind },
          "Media file persisted to workspace",
        );

        return ok(result);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn(
          {
            err: error.message,
            mediaKind: opts.mediaKind,
            hint: "File persistence failed; message processing continues",
            errorKind: "resource" as const,
          },
          "Media file persistence failed",
        );
        return err(error);
      }
    },
  };
}
