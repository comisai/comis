/**
 * Media file serving routes -- Hono sub-app for serving stored media files.
 *
 * Routes:
 *   GET /media/:id      — Serve media file with correct Content-Type
 *   GET /media/:id/meta — Serve JSON metadata for a media file
 *
 * All path construction uses safePath() from @comis/core (no path.join).
 * Media ID validation prevents path traversal via pattern and safePath.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { safePath, PathTraversalError } from "@comis/core";
import { extractBearerToken } from "../auth/token-auth.js";
import type { TokenStore } from "../auth/token-auth.js";

/** Media ID validation pattern: letters, digits, dots, hyphens, underscores. */
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;

/** Maximum characters in a media ID. */
const MAX_MEDIA_ID_CHARS = 200;

/** Simple extension-to-MIME mapping for fallback when sidecar meta absent. */
const FALLBACK_MIMES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
} as const;

/** Dependencies for creating media routes. */
export interface MediaRoutesDeps {
  /** Base directory where media files are stored. */
  readonly mediaDir: string;
  /** TTL in ms for media files (files older than this return 410 Gone). */
  readonly ttlMs?: number;
  /** Optional token store for bearer token authentication. When provided, all routes require auth. */
  readonly tokenStore?: TokenStore;
}

/** Zod schema for validating sidecar metadata after JSON.parse. */
const SidecarMetaSchema = z.object({
  contentType: z.string().optional(),
  savedAt: z.number(),
  size: z.number(),
});

/**
 * Validate a media ID for safe filesystem use.
 * Returns an error string or undefined if valid.
 */
function validateMediaId(id: string): string | undefined {
  if (!id) return "Media ID required";
  if (id.length > MAX_MEDIA_ID_CHARS) return "Media ID too long";
  if (id === "." || id === "..") return "Invalid media ID";
  if (!MEDIA_ID_PATTERN.test(id)) return "Media ID contains invalid characters";
  return undefined;
}

/**
 * Create a Hono sub-app with media serving routes.
 *
 * Mount at /media on the gateway:
 *   app.route("/media", createMediaRoutes({ mediaDir }));
 */
export function createMediaRoutes(deps: MediaRoutesDeps): Hono {
  const { mediaDir, ttlMs, tokenStore } = deps;
  const app = new Hono();

  // Bearer token auth middleware (when tokenStore is provided)
  if (tokenStore) {
    app.use("*", async (c, next) => {
      const token =
        extractBearerToken(c.req.header("authorization") ?? "") ??
        (c.req.query("token") || null);
      if (!token || !tokenStore.verify(token)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    });
  }

  // GET /:id -- serve media file
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const idError = validateMediaId(id);
    if (idError) {
      return c.json({ error: idError }, 400);
    }

    let filePath: string;
    try {
      filePath = safePath(mediaDir, id);
    } catch (e) {
      if (e instanceof PathTraversalError) {
        return c.json({ error: "Invalid media ID" }, 400);
      }
      throw e;
    }

    // Check file exists
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }

    // Check TTL expiration
    if (ttlMs !== undefined) {
      const age = Math.max(0, Date.now() - stat.mtimeMs);
      if (age >= ttlMs) {
        return c.json({ error: "Media expired" }, 410);
      }
    }

    // Read sidecar metadata for content type
    let contentType = "application/octet-stream";
    try {
      const metaPath = safePath(mediaDir, `${id}.meta`);
      const metaRaw = await fs.readFile(metaPath, "utf-8");
      const parsed = SidecarMetaSchema.safeParse(JSON.parse(metaRaw));
      if (parsed.success && parsed.data.contentType) {
        contentType = parsed.data.contentType;
      }
    } catch {
      // No sidecar meta -- try extension-based fallback
      const dotIdx = id.lastIndexOf(".");
      if (dotIdx !== -1) {
        const ext = id.slice(dotIdx).toLowerCase();
        contentType = FALLBACK_MIMES[ext] ?? contentType;
      }
    }

    // Serve the file
    const buffer = await fs.readFile(filePath);
    c.header("Content-Type", contentType);
    c.header("Content-Length", String(buffer.length));
    c.header("Cache-Control", "no-cache");
    return c.body(buffer);
  });

  // GET /:id/meta -- serve JSON metadata
  app.get("/:id/meta", async (c) => {
    const id = c.req.param("id");
    const idError = validateMediaId(id);
    if (idError) {
      return c.json({ error: idError }, 400);
    }

    let metaPath: string;
    try {
      metaPath = safePath(mediaDir, `${id}.meta`);
    } catch (e) {
      if (e instanceof PathTraversalError) {
        return c.json({ error: "Invalid media ID" }, 400);
      }
      throw e;
    }

    try {
      const metaRaw = await fs.readFile(metaPath, "utf-8");
      const parsed = SidecarMetaSchema.safeParse(JSON.parse(metaRaw));
      if (!parsed.success) {
        return c.json({ error: "Invalid metadata" }, 500);
      }
      return c.json(parsed.data);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
  });

  return app;
}
