// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat MediaResolverPort adapter.
 *
 * Resolves `googlechat-attachment://<encodeURIComponent(resourceName)>` attachments
 * (emitted by the message mapper) to downloaded media buffers over the supported
 * bot path: the resource name is decoded, the download URL is built from a FIXED
 * host, a service-account Bearer is minted, and the bytes are fetched through the
 * INJECTED auth-capable SSRF-guarded fetcher — never a bare `fetch`. The fetcher
 * DNS-pins each hop and attaches the Bearer only to the single allowlisted host,
 * dropping it on any cross-host redirect.
 *
 * The request is pinned to `chat.googleapis.com/v1/media/…` and carries only
 * `alt=media`. The attachment's browser-facing download link is never read or
 * fetched — it is a human-user URL that rejects a service-account Bearer.
 *
 * Dependency-clean by construction: this file pulls in neither the SSRF-fetcher's
 * home package nor its underlying HTTP transport. The fetcher arrives as a local
 * structural interface, so the DNS-pinning + redirect machinery stays in the
 * package that owns the transport.
 *
 * The returned MIME is sniffed (the port contract mandates a verified type; a
 * platform can mislabel bytes and the model vision API rejects a declared/actual
 * mismatch). Raw bytes are returned — the pipeline applies the external-content
 * fence on the DERIVED text (transcription/vision/doc-extract), not this resolver.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import { systemNowMs } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, tryCatch } from "@comis/shared";
import { fileTypeFromBuffer } from "file-type";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural interface for the auth-capable SSRF-guarded fetcher (avoids a
 * circular dep on the package that owns the HTTP transport). It is the auth
 * superset of the plain `fetch(url)` seam: `opts` carries the Authorization
 * header value and the host allowlist the header may ride, and the fetcher
 * enforces the per-hop attach/drop decision.
 */
interface SsrfFetcher {
  fetch(
    url: string,
    opts?: { authHeader?: string; authAllowHosts?: readonly string[] },
  ): Promise<Result<{ buffer: Buffer; mimeType: string; sizeBytes: number }, Error>>;
}

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GoogleChatResolverDeps {
  /** Auth-capable SSRF-guarded fetcher; the only path media bytes are fetched through. */
  ssrfFetcher: SsrfFetcher;
  /** Mint the service-account Bearer for the download. A mint failure is fatal — the download always needs it. */
  getToken: () => Promise<Result<string, Error>>;
  /** Reject a fetched body whose reported size exceeds this many bytes. */
  maxBytes: number;
  logger: ResolverLogger;
}

/**
 * The single host that may receive the service-account Bearer on a media download.
 * There is no config escape hatch: the Bearer rides this host only and is dropped
 * on any cross-host redirect by the injected fetcher.
 */
const CHAT_MEDIA_HOST = "chat.googleapis.com";

const GOOGLECHAT_ATTACHMENT_SCHEME = /^googlechat-attachment:\/\//;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Google Chat media resolver implementing MediaResolverPort.
 *
 * Decodes `googlechat-attachment://` attachments, builds the download URL from the
 * fixed host, mints the service-account Bearer, and drives the injected auth-capable
 * SSRF-guarded fetcher pinned to the single host. Returns raw bytes with a sniffed
 * MIME type.
 */
export function createGoogleChatResolver(deps: GoogleChatResolverDeps): MediaResolverPort {
  return {
    schemes: ["googlechat-attachment"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      // Decode the exact inverse of the mapper's encodeURIComponent. decodeURIComponent
      // throws on malformed percent-encoding and the payload is attacker-influenced, so
      // the decode is guarded rather than trusted.
      const decoded = tryCatch(() =>
        decodeURIComponent(attachment.url.replace(GOOGLECHAT_ATTACHMENT_SCHEME, "")),
      );
      if (!decoded.ok) return err(decoded.error);
      const resourceName = decoded.value;

      // Build the download URL via the URL API from the FIXED host. The multi-segment
      // resource name goes into the path; `alt=media` is the only query parameter.
      const built = tryCatch(() => new URL(`https://${CHAT_MEDIA_HOST}/v1/media/${resourceName}`));
      if (!built.ok) return err(built.error);
      built.value.searchParams.set("alt", "media");
      const url = built.value.toString();

      const tok = await deps.getToken();
      const token = tok.ok ? tok.value : undefined;
      const authHeader = token !== undefined ? `Bearer ${token}` : undefined;

      const startMs = systemNowMs();
      const fetched = await deps.ssrfFetcher.fetch(url, {
        authHeader,
        authAllowHosts: [CHAT_MEDIA_HOST],
      });
      const durationMs = systemNowMs() - startMs;
      if (!fetched.ok) return err(fetched.error);

      const { buffer, mimeType: fetchedMime, sizeBytes } = fetched.value;

      // Secondary size cap at the resolver (defense-in-depth over the fetcher's own cap).
      if (sizeBytes > deps.maxBytes) {
        return err(new Error(`media size ${sizeBytes} exceeds limit of ${deps.maxBytes} bytes`));
      }

      // The port contract mandates a VERIFIED (sniffed) MIME; the recognized type is
      // authoritative, else fall back to the fetched header.
      const sniffed = await fileTypeFromBuffer(buffer);
      const mimeType = sniffed?.mime ?? fetchedMime;

      deps.logger.debug(
        { platform: "googlechat", sizeBytes, durationMs },
        "Google Chat media resolved",
      );

      // Raw bytes only — the pipeline fences the DERIVED text, not the media bytes here.
      return ok({ buffer, mimeType, sizeBytes });
    },
  };
}
