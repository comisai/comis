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
 * The resource name is untrusted inbound JSON, so it is guarded twice before it can
 * steer a request: a cheap denylist rejects genuine injection/traversal
 * metacharacters before any mint or fetch, and the URL is then built via the URL
 * API with its host and `/v1/media/` pathname asserted — the authoritative control.
 * The guard is format-agnostic on purpose: an opaque base64/token resource name is
 * NOT dropped by a charset allowlist.
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
 * Secret discipline: the service-account Bearer and the constructed URL are never
 * placed in a log field, and are stripped from a returned Error before it surfaces.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import { sanitizeLogString, systemNowMs } from "@comis/core";
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

/**
 * Reject a resource name carrying a genuine injection or traversal metacharacter,
 * WITHOUT constraining its charset. The media.download resource name is an OPAQUE
 * token — it may legitimately carry base64 (`+`, `=`), `~`, `:`, and `/` for a
 * multi-segment name — so a strict character allowlist would silently drop a valid
 * attachment. This denylist rejects only `?`, `#`, `&`, whitespace, any control
 * character, and `..`, while permitting opaque token characters. The authoritative
 * control remains the host + `/v1/media/` pathname assertion built in `resolve`;
 * this is the cheap pre-check that keeps a hostile ref from ever being minted for
 * or fetched. A char-code scan avoids a control-character regex.
 */
function hasResourceNameInjection(id: string): boolean {
  if (id.includes("..")) return true;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true; // whitespace + all control chars
    if (c === 0x3f || c === 0x23 || c === 0x26) return true; // ? # &
  }
  return false;
}

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
  /** Strip the constructed URL and the Bearer from an error message, then sanitize free-text. */
  function sanitizeError(message: string, url: string, token: string | undefined): string {
    let stripped = message;
    if (url.length > 0) stripped = stripped.replaceAll(url, "[REDACTED_URL]");
    if (token && token.length > 0) stripped = stripped.replaceAll(token, "[REDACTED_TOKEN]");
    return sanitizeLogString(stripped);
  }

  return {
    schemes: ["googlechat-attachment"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      // Decode the exact inverse of the mapper's encodeURIComponent. decodeURIComponent
      // throws on malformed percent-encoding and the payload is attacker-influenced, so
      // the decode is guarded rather than trusted.
      const decoded = tryCatch(() =>
        decodeURIComponent(attachment.url.replace(GOOGLECHAT_ATTACHMENT_SCHEME, "")),
      );
      if (!decoded.ok || decoded.value.length === 0) {
        deps.logger.warn(
          {
            platform: "googlechat",
            errorKind: "validation" as const,
            hint: "Drop the attachment: its googlechat-attachment:// payload is not valid percent-encoding",
          },
          "Google Chat media resolve failed: malformed attachment ref",
        );
        return err(new Error("Invalid googlechat-attachment:// URL"));
      }
      const resourceName = decoded.value;

      // Injection/traversal pre-check — BEFORE any mint or fetch. Permits opaque token
      // characters; rejects only genuine query/fragment/traversal injection.
      if (hasResourceNameInjection(resourceName)) {
        deps.logger.warn(
          {
            platform: "googlechat",
            errorKind: "validation" as const,
            hint: "Drop the attachment: its resource name carries a disallowed metacharacter (query, fragment, whitespace, control, or ..)",
          },
          "Google Chat media resolve blocked: unsafe resource name",
        );
        return err(new Error("attachment resource name not permitted"));
      }

      // Build the download URL via the URL API from the FIXED host, then ASSERT the host
      // and `/v1/media/` pathname — the authoritative control. A traversal that slips the
      // pre-check would collapse the pathname off `/v1/media/` and be caught here; the
      // injected fetcher re-pins the host per hop as defense-in-depth.
      const built = tryCatch(() => new URL(`https://${CHAT_MEDIA_HOST}/v1/media/${resourceName}`));
      if (
        !built.ok ||
        built.value.hostname !== CHAT_MEDIA_HOST ||
        !built.value.pathname.startsWith("/v1/media/")
      ) {
        deps.logger.warn(
          {
            platform: "googlechat",
            errorKind: "validation" as const,
            hint: "Drop the attachment: the resource name did not resolve to a chat.googleapis.com /v1/media/ path",
          },
          "Google Chat media resolve blocked: off-host or off-path ref",
        );
        return err(new Error("attachment host not permitted"));
      }
      built.value.searchParams.set("alt", "media");
      const url = built.value.toString();

      // The download ALWAYS needs the Bearer, so a mint failure is fatal — never a
      // header-less fetch. The token provider already logged a secret-free WARN.
      const tok = await deps.getToken();
      if (!tok.ok) return err(tok.error);
      const authHeader = `Bearer ${tok.value}`;

      const startMs = systemNowMs();
      const fetched = await deps.ssrfFetcher.fetch(url, {
        authHeader,
        authAllowHosts: [CHAT_MEDIA_HOST],
      });
      const durationMs = systemNowMs() - startMs;

      if (!fetched.ok) {
        deps.logger.warn(
          {
            platform: "googlechat",
            durationMs,
            errorKind: "platform" as const,
            hint: "Google Chat media fetch failed — verify the service account has the chat.bot scope and the attachment is uploaded content, not a Drive file",
          },
          "Google Chat media fetch failed",
        );
        // The constructed URL / Bearer must never surface in the returned error.
        const msg = fetched.error instanceof Error ? fetched.error.message : String(fetched.error);
        return err(new Error(sanitizeError(msg, url, tok.value)));
      }

      const { buffer, mimeType: fetchedMime, sizeBytes } = fetched.value;

      // Secondary size cap at the resolver (defense-in-depth over the fetcher's own cap).
      if (sizeBytes > deps.maxBytes) {
        deps.logger.warn(
          {
            platform: "googlechat",
            sizeBytes,
            maxBytes: deps.maxBytes,
            durationMs,
            errorKind: "precondition" as const,
            hint: "Raise the Google Chat media size limit or ask the sender to shrink the file",
          },
          "Google Chat media rejected: body exceeds the configured size cap",
        );
        return err(new Error(`media size ${sizeBytes} exceeds limit of ${deps.maxBytes} bytes`));
      }

      // The port contract mandates a VERIFIED (sniffed) MIME. The platform can mislabel
      // bytes and the model vision API rejects a declared type that mismatches the actual
      // bytes — sniff the downloaded bytes; the recognized type is authoritative, else
      // fall back to the fetched header.
      const sniffed = await fileTypeFromBuffer(buffer);
      const mimeType = sniffed?.mime ?? fetchedMime;
      if (sniffed && sniffed.mime !== fetchedMime) {
        deps.logger.debug(
          { platform: "googlechat", declaredMime: fetchedMime, sniffedMime: sniffed.mime },
          "Google Chat media MIME corrected from sniffed bytes (declared type mismatched)",
        );
      }

      deps.logger.debug(
        { platform: "googlechat", sizeBytes, durationMs },
        "Google Chat media resolved",
      );

      // Raw bytes only — the pipeline fences the DERIVED text, not the media bytes here.
      return ok({ buffer, mimeType, sizeBytes });
    },
  };
}
