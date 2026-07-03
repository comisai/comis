// SPDX-License-Identifier: Apache-2.0
// @allow-throw: media-input resolver — throws (SSRF block / oversized / unsafe
// mime / fetch error) are caught at the RPC handler's `@allow-throw` boundary
// (→ JSON-RPC error). The caller-input rejections throw a typed ValidationError.
/**
 * Shared media REFERENCE-input resolver for the image + video generation RPC
 * handlers (image `reference_image` / video `image_url`).
 *
 * Extracted from `image-handlers.ts` so BOTH `createImageHandlers`
 * (`reference_image`) and `createVideoHandlers` (`image_url`) resolve an
 * agent-supplied reference through the SAME SSRF + path-traversal + size guards
 * and the DNS-pinned fetcher — instead of a hand-rolled per-handler copy.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { safePath } from "@comis/core";
import { guessMimeFromExtension, detectMimeFromMagicBytes } from "../wiring/daemon-utils.js";
import { fetchImageBytesSsrfSafe } from "./ssrf-image-fetch.js";
import { ValidationError } from "./errors.js";

/** Max bytes for a resolved reference image (DoS cap). Enforced on
 *  ALL three source branches (URL download, data-uri decode, workspace-file
 *  read) so the bound is uniform regardless of how the agent supplies it. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/**
 * Strip an attacker-influenced/declared mime down to its bare media type and
 * reject obviously-dangerous types for generation INPUT. SVG is an XSS/script
 * vector (it can carry `<script>`), so it is refused here with an honest hint
 * rather than forwarded to a provider that might render it.
 */
function assertSafeReferenceMime(mediaType: string): void {
  const bare = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (bare === "image/svg+xml" || bare === "image/svg") {
    // ValidationError → classifies as validation/warn (not
    // internal/error) at the RPC boundary, and the message names the remedy so
    // the JSON-RPC error alone is actionable (the message is what reaches the
    // caller; classifyRpcError's hint only rides the daemon log line).
    throw new ValidationError(
      "SVG reference images are not supported (script/XSS vector); supply a raster image (PNG/JPEG/WebP).",
    );
  }
}

/**
 * Resolve an agent-supplied reference image (image-handlers `reference_image`
 * for edit/img2img; video-handlers `image_url` for image-to-video) to
 * `{ data(base64), mimeType }`. Adapts the SSRF + path-traversal guards from
 * `media-handlers.ts` — the security floor — and applies the
 * SAME `MAX_REFERENCE_BYTES` cap to EVERY branch:
 *   - data-uri (`data:<mime>[;params][;base64],<payload>`) → decode base64 only
 *     when the `;base64` flag is present, else URL-decode per RFC 2397;
 *     size-capped after decode;
 *   - `http(s)://` URL → the shared DNS-pinned SSRF fetcher
 *     (`fetchImageBytesSsrfSafe` validates → pins DNS to the validated IP →
 *     refuses redirects → bounded download — closing the rebinding TOCTOU gap a
 *     bare `fetch` left open);
 *   - workspace file path → `safePath(agentDir, source)` confinement + readFile,
 *     size-capped after read.
 *
 * Throws on any failure (SSRF block, oversized, unsafe mime, fetch error) —
 * caught by the RPC handler's `@allow-throw` boundary (→ JSON-RPC error). The
 * caller-input rejections (unsafe mime, oversized) throw a typed
 * `ValidationError` carrying an actionable message so the boundary classifies
 * them validation/warn and the JSON-RPC error alone is self-actionable.
 */
export async function resolveReferenceImage(
  source: string,
  deps: { workspaceDirs: Map<string, string>; defaultWorkspaceDir: string },
  callerAgentId: string | undefined,
): Promise<{ data: string; mimeType: string }> {
  // data-uri (data:<mediatype>[;params][;base64],<payload>). The mediatype may
  // carry parameters (e.g. `;charset=utf-8`) BEFORE the optional `;base64` flag
  // — `[^,]*?` (lazy, up to the comma) tolerates them; `(;base64)?` then matches
  // the flag if present (a `[^;,]+` mediatype pattern would miss the params).
  const dataUri = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(source);
  if (dataUri) {
    const mediaType = dataUri[1] || "image/png";
    assertSafeReferenceMime(mediaType);
    const mimeType = (mediaType.split(";")[0] || "image/png").trim(); // strip charset/params
    const payload = dataUri[3] ?? "";
    // RFC 2397: base64 ONLY when the `;base64` token is present; otherwise the
    // payload is URL-encoded text (do NOT base64-decode it to garbage).
    const buffer = dataUri[2]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    if (buffer.byteLength > MAX_REFERENCE_BYTES) {
      throw new ValidationError(
        "Reference image exceeds the size limit of 20 MB; supply a smaller raster image.",
      );
    }
    return { data: buffer.toString("base64"), mimeType };
  }
  // http(s) URL — route through the shared DNS-pinned SSRF fetcher: it
  // SSRF-validates BEFORE connecting, pins DNS to the validated IP (no rebind
  // window), refuses redirects, and bounds the download to MAX_REFERENCE_BYTES.
  if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchImageBytesSsrfSafe(source, MAX_REFERENCE_BYTES);
    const mediaType = fetched.mimeType ?? detectMimeFromMagicBytes(fetched.buffer) ?? "image/png";
    assertSafeReferenceMime(mediaType);
    const mimeType = (mediaType.split(";")[0] || "image/png").trim();
    return { data: fetched.buffer.toString("base64"), mimeType };
  }
  // Workspace file path — safePath confines it under the agent workspace dir
  // (the path-traversal floor). agentDir resolves from the caller's
  // workspace, falling back to the default workspace dir. Size-capped after
  // read — an agent can write a large file into its own workspace.
  const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
  const filePath = safePath(agentDir, source);
  const buffer = await readFile(filePath);
  if (buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("Reference image exceeds the size limit");
  }
  return { data: buffer.toString("base64"), mimeType: guessMimeFromExtension(filePath) };
}
