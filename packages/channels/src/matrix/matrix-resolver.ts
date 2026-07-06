// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix MediaResolverPort adapter.
 *
 * Resolves an inbound `mxc://` attachment to downloaded media bytes. The
 * authenticated download URL is built by the client (mxcUrlToHttp with
 * authentication enabled), which always targets the OWN homeserver — the
 * homeserver proxies federated content, so a remote server-name inside the mxc is
 * NOT a cross-host fetch and must never be SSRF-blocked or re-routed on. The bytes
 * ride only the INJECTED SSRF-guarded fetcher — never a bare `fetch`. The fetcher
 * DNS-pins each hop, re-validates every redirect, and attaches the access token
 * only to the homeserver host, dropping it on any cross-host hop; the sole real
 * cross-host hop is a homeserver redirect to a CDN, which that token-drop covers.
 *
 * When the mxc is encrypted (a cached encrypted-file record exists), the downloaded
 * bytes are ciphertext and are decrypted through the audited codec BEFORE the MIME
 * sniff. Decryption is fail-closed: a tampered blob throws on the internal integrity
 * check and returns a sanitized error, never partial plaintext.
 *
 * Dependency-clean by construction: the fetcher is received as a local structural
 * interface, so the DNS-pinning + redirect machinery stays in the package that owns
 * the HTTP transport (this file imports neither that package nor its transport dep).
 *
 * The returned MIME is sniffed from the resolved bytes (the port contract mandates a
 * verified type; a mislabeled declared header is overridden). Raw bytes are returned
 * — the pipeline fences the DERIVED text (transcription/vision/doc-extract), not the
 * media bytes here.
 *
 * @module
 */

import type { Attachment, MediaResolverPort, ResolvedMedia } from "@comis/core";
import { sanitizeLogString, systemNowMs } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { fileTypeFromBuffer } from "file-type";
import { decryptAttachment, type EncryptedFileLike } from "./media-handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural interface for the auth-capable SSRF-guarded fetcher (avoids a circular
 * dep on the package that owns the HTTP transport). `opts` carries the Authorization
 * header value and the host allowlist it may ride; the fetcher enforces the per-hop
 * attach/drop decision, re-validates every redirect, and caps the body size. Declared
 * as a property (not a method) so the module has no bare download seam of its own.
 */
interface SsrfFetcher {
  fetch: (
    url: string,
    opts?: { authHeader?: string; authAllowHosts?: readonly string[] },
  ) => Promise<Result<{ buffer: Buffer; mimeType: string; sizeBytes: number }, Error>>;
}

/** Minimal logger interface for resolver logging. */
interface ResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The started media client this resolver reads the authed URL, token, and homeserver
 * host from. `undefined` before the adapter has started.
 */
interface MatrixMediaClient {
  /**
   * Build the authenticated download URL for an mxc. Returns `null` for a malformed
   * mxc. Positional args mirror the SDK: `(mxc, width?, height?, resizeMethod?,
   * allowDirectLinks?, allowRedirects?, useAuthentication?)`.
   */
  mxcUrlToHttp: (...a: unknown[]) => string | null;
  /** The current access token, or `null` when unauthenticated. */
  getAccessToken: () => string | null;
  /** The homeserver host the token is scoped to. */
  homeserverHost: string;
}

export interface MatrixResolverDeps {
  /** Auth-capable SSRF-guarded fetcher; the only path media bytes are downloaded through. */
  ssrfFetcher: SsrfFetcher;
  /** Reject a resolved body whose length exceeds this many bytes (secondary cap). */
  maxBytes: number;
  logger: ResolverLogger;
  /**
   * The started media client, or `undefined` before the adapter has started —
   * `resolve` returns a clean error rather than crashing when it is absent.
   */
  getMediaClient: () => MatrixMediaClient | undefined;
  /**
   * The encrypted-file record for an mxc (an E2EE room), or `undefined` for a
   * plaintext room. Populated off-band by the inbound mapper; the record is the
   * decryption secret and cannot ride the strict attachment schema.
   */
  getEncryptedFile: (mxc: string) => EncryptedFileLike | undefined;
}

/** IPv4 dotted-quad literal. */
const IPV4_LITERAL = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
/**
 * IPv6 literal — hex groups joined by colons, including the `::` compressed form
 * (`::1`, `fe80::dead:beef`, `2001:db8::1`). Requires at least two colons so a lone
 * `word:word` (a non-address) is not matched.
 */
const IPV6_LITERAL = /(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9]{0,4}/g;

/** Replace bare IPv4/IPv6 literals with a placeholder (no resolved address leaks out). */
function redactIpLiterals(message: string): string {
  return message.replace(IPV4_LITERAL, "[REDACTED_IP]").replace(IPV6_LITERAL, "[REDACTED_IP]");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Matrix media resolver implementing MediaResolverPort.
 *
 * Builds the authenticated download URL from the client, drives the injected
 * SSRF-guarded fetcher with a homeserver-scoped token, decrypts E2EE'd media
 * fail-closed, enforces a secondary byte cap, and returns raw bytes with a sniffed
 * MIME type. The download URL and token never surface in a returned error or log field.
 */
export function createMatrixResolver(deps: MatrixResolverDeps): MediaResolverPort {
  /**
   * Strip the download URL, the access token, then any bare IP literal from an error
   * message, and sanitize the remaining free-text. The IP redaction covers a
   * homeserver redirect to an internal host: the SSRF-guarded fetcher reports the
   * blocked resolved IP (`resolved IP 10.x.x.x …`), which must not surface across the
   * port as a topology disclosure. Covers IPv4 and IPv6 literals.
   */
  function sanitizeError(message: string, url: string, token: string | undefined): string {
    let stripped = message;
    if (url.length > 0) stripped = stripped.replaceAll(url, "[REDACTED_URL]");
    if (token && token.length > 0) stripped = stripped.replaceAll(token, "[REDACTED_TOKEN]");
    stripped = redactIpLiterals(stripped);
    return sanitizeLogString(stripped);
  }

  return {
    schemes: ["mxc"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      const mxc = attachment.url;

      // The client is undefined until the adapter start()s — return a clean err, never crash.
      const media = deps.getMediaClient();
      if (media === undefined) {
        deps.logger.warn(
          {
            platform: "matrix",
            errorKind: "precondition" as const,
            hint: "Matrix media resolve deferred — the channel has not finished starting; retry once connected",
          },
          "Matrix media resolve failed: client not started",
        );
        return err(new Error("Matrix media client not started"));
      }

      // Build the authed download URL from the client (it validates the server-name/media-id
      // and sets the authenticated path + allow_redirect). Never string-concat: the URL always
      // targets the OWN homeserver, which proxies federated content, so a remote mxc
      // server-name is not a cross-host fetch and must not be re-routed or blocked here.
      const url = media.mxcUrlToHttp(
        mxc,
        undefined,
        undefined,
        undefined,
        /* allowDirectLinks */ false,
        /* allowRedirects */ true,
        /* useAuthentication */ true,
      );
      if (url === null || url === undefined || url.length === 0) {
        deps.logger.warn(
          {
            platform: "matrix",
            errorKind: "validation" as const,
            hint: "Drop the attachment: its mxc URI is malformed and cannot be turned into a download URL",
          },
          "Matrix media resolve failed: unresolvable mxc URI",
        );
        return err(new Error("invalid mxc URI"));
      }

      const token = media.getAccessToken() ?? undefined;
      const authHeader = token !== undefined ? `Bearer ${token}` : undefined;

      // Every media byte rides THIS injected, DNS-pinning, SSRF-guarded fetcher: each
      // hop is re-validated, the socket is pinned to the validated IP (the rebinding
      // window is closed), and the token is scoped to the homeserver host — dropped the
      // instant a redirect crosses to another host (a CDN).
      //
      // Residual, stated honestly rather than hidden: the matrix client's OWN HTTP
      // transport — the sync long-poll and content upload — is a SEPARATE,
      // operator-configured stack. Its homeserver URL is validated once at connect
      // time, but that connection is NOT DNS-pinned here the way these media bytes
      // are. Pinning the client transport (a streaming, redirect- and long-poll-aware
      // fetch) is a client-lifecycle concern outside this media path's scope; the media
      // download is fully pinned regardless.
      const startMs = systemNowMs();
      const fetched = await deps.ssrfFetcher.fetch(url, {
        authHeader,
        authAllowHosts: [media.homeserverHost],
      });
      const durationMs = systemNowMs() - startMs;

      if (!fetched.ok) {
        deps.logger.warn(
          {
            platform: "matrix",
            durationMs,
            errorKind: "platform" as const,
            hint: "Matrix media fetch failed — verify the attachment is reachable and within the media size limit",
          },
          "Matrix media fetch failed",
        );
        // The download URL / access token must never surface in the returned error.
        const msg = fetched.error instanceof Error ? fetched.error.message : String(fetched.error);
        return err(new Error(sanitizeError(msg, url, token)));
      }

      // E2EE decrypt (BEFORE the sniff): a cached encrypted-file record means the downloaded
      // buffer is ciphertext. Decryption is fail-closed — a tampered blob throws on the
      // internal integrity check and returns a sanitized err, never partial plaintext.
      let bytes: Buffer;
      const encFile = deps.getEncryptedFile(mxc);
      if (encFile !== undefined) {
        const decrypted = await fromPromise(decryptAttachment(fetched.value.buffer, encFile));
        if (!decrypted.ok) {
          deps.logger.warn(
            {
              platform: "matrix",
              durationMs,
              errorKind: "validation" as const,
              hint: "Drop the attachment: its encrypted payload failed the integrity check (tampered or wrong key)",
            },
            "Matrix media decrypt failed",
          );
          return err(new Error(sanitizeError(decrypted.error.message, url, token)));
        }
        bytes = decrypted.value;
      } else if (attachment.encrypted === true) {
        // The inbound event indicated E2EE for this attachment (it carried a
        // content.file structure) but its decryption key is unavailable — evicted
        // from the bounded key cache under load, or the record was structurally
        // incomplete. FAIL CLOSED: never hand back the undecryptable ciphertext as
        // if it were plaintext media. (A genuinely-plaintext attachment is not marked
        // encrypted, so its cache miss resolves as plaintext in the branch below.)
        deps.logger.warn(
          {
            platform: "matrix",
            durationMs,
            errorKind: "validation" as const,
            hint: "Drop the attachment: its decryption key is unavailable; re-request the media so its key is re-cached",
          },
          "Matrix media resolve failed: encrypted attachment key unavailable",
        );
        return err(new Error("encrypted attachment key unavailable"));
      } else {
        bytes = fetched.value.buffer;
      }

      // Secondary size cap on the RESOLVED (post-decrypt) length — defense-in-depth over the
      // fetcher's own download cap; a byte count alone is not the whole bound (the decode-side
      // pixel cap lives downstream in the shared pipeline).
      if (bytes.length > deps.maxBytes) {
        deps.logger.warn(
          {
            platform: "matrix",
            sizeBytes: bytes.length,
            maxBytes: deps.maxBytes,
            durationMs,
            errorKind: "precondition" as const,
            hint: "Raise the Matrix media size limit or ask the sender to shrink the file",
          },
          "Matrix media rejected: body exceeds the configured size cap",
        );
        return err(
          new Error(`Matrix media size ${bytes.length} exceeds limit of ${deps.maxBytes} bytes`),
        );
      }

      // The port contract mandates a VERIFIED (sniffed) MIME. A sender or homeserver can
      // mislabel bytes and the model vision API rejects a declared/actual mismatch — sniff the
      // resolved bytes; the recognized type is authoritative, else fall back to the declared one.
      const sniffed = await fileTypeFromBuffer(bytes);
      const mimeType = sniffed?.mime ?? fetched.value.mimeType;
      if (sniffed && sniffed.mime !== fetched.value.mimeType) {
        deps.logger.debug(
          { platform: "matrix", declaredMime: fetched.value.mimeType, sniffedMime: sniffed.mime },
          "Matrix media MIME corrected from sniffed bytes (declared type mismatched)",
        );
      }

      deps.logger.debug(
        { platform: "matrix", sizeBytes: bytes.length, durationMs },
        "Matrix media resolved",
      );

      // Raw bytes only — the pipeline fences the DERIVED text, not the media bytes here.
      return ok({ buffer: bytes, mimeType, sizeBytes: bytes.length });
    },
  };
}
