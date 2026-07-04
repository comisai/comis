// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams MediaResolverPort adapter.
 *
 * Resolves `msteams-file://<encodeURIComponent(realUrl)>` attachments (emitted by
 * the message mapper) to downloaded media buffers. The scheme is decoded back to
 * the real https URL, the Bot Framework Connector Bearer is minted once, and the
 * bytes are fetched through the INJECTED auth-capable SSRF-guarded fetcher — never
 * a bare `fetch`. The fetcher DNS-pins each hop and decides per-hop whether to
 * attach the Bearer against the allowlist this resolver supplies, so the token is
 * transmitted only to a Connector/attachment host and dropped on a cross-host
 * redirect.
 *
 * Dependency-clean by construction: this file pulls in neither the SSRF-fetcher's
 * home package nor its underlying HTTP-transport dependency. The fetcher is received
 * as a local structural interface, so the DNS-pinning + redirect machinery stays in
 * the package that owns the transport.
 *
 * The returned MIME is sniffed (the port contract mandates a verified type; Teams
 * can mislabel bytes and the model vision API rejects a declared/actual mismatch).
 * Raw bytes are returned — the pipeline applies the external-content fence on the
 * DERIVED text (transcription/vision/doc-extract), not this resolver.
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
 * circular dep on the package that owns the HTTP transport). It is the auth superset of the
 * plain `fetch(url)` seam: `opts` carries the Authorization header value and the
 * host allowlist the header may ride, and the fetcher enforces the per-hop
 * attach/drop decision.
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

export interface MsTeamsResolverDeps {
  /** Auth-capable SSRF-guarded fetcher; the only path media bytes are fetched through. */
  ssrfFetcher: SsrfFetcher;
  /**
   * Mint the Connector client-credentials Bearer. A mint failure is non-fatal —
   * the fetch proceeds with no header, since a pre-authed downloadUrl needs none.
   */
  getToken: () => Promise<Result<string, Error>>;
  /** Config passthrough of the token-attach host allowlist; empty → {@link DEFAULT_MEDIA_AUTH_ALLOW_HOSTS}. */
  mediaAuthAllowHosts: readonly string[];
  /** Reject a fetched body whose reported size exceeds this many bytes. */
  maxBytes: number;
  logger: ResolverLogger;
}

/**
 * Bot Framework Connector/attachment hosts that may receive the Connector Bearer
 * on an inbound media fetch. A pre-authed SharePoint downloadUrl needs no token and
 * its storage redirect must not carry one, so `*.sharepoint.com` is excluded; the
 * inbound path mints the Connector token only (no Graph token), so
 * `graph.microsoft.com` is excluded too. A leading-dot entry matches that domain
 * and any subdomain; the fetcher drops the Bearer for any host outside this list
 * and on a cross-host redirect.
 */
export const DEFAULT_MEDIA_AUTH_ALLOW_HOSTS = [
  "smba.trafficmanager.net",
  ".botframework.com",
] as const;

/**
 * Teams attachment hosts an inbound media fetch may target at HOP 0 (the initial,
 * pre-redirect attachment URL). BROADER than {@link DEFAULT_MEDIA_AUTH_ALLOW_HOSTS}
 * (the token-attach set): a SharePoint or Graph download host receives NO Connector
 * bearer but IS a legitimate initial attachment host, so it is fetch-allowed here
 * while staying token-excluded there.
 *
 * The gate is HOP-0 ONLY. The injected fetcher re-validates every hop against the
 * SSRF firewall (private/loopback/link-local/cloud-metadata IPs) but does NOT
 * restrict arbitrary PUBLIC hosts — so without this list an attacker-influenced
 * `contentUrl` could drive a blind GET to any public host (egress-IP disclosure,
 * attacker-log ping, a fetch-proxy) and hand the response bytes to the
 * vision/STT/doc-extract pipeline. A REDIRECT target is deliberately NOT re-checked
 * against this list: a pre-authed SharePoint `downloadUrl` 302-redirects to blob
 * storage, and that hop must still be followed (token-free, re-validated for SSRF by
 * the fetcher). Only the INITIAL host is gated here.
 *
 * A leading-dot entry matches that apex domain and any subdomain (anchored on the
 * dot, so `evilbotframework.com` never matches `.botframework.com`); a dotless entry
 * is an exact host match.
 */
export const DEFAULT_MEDIA_FETCH_ALLOW_HOSTS = [
  "smba.trafficmanager.net",
  ".botframework.com",
  ".sharepoint.com",
  "graph.microsoft.com",
] as const;

const MSTEAMS_FILE_SCHEME = /^msteams-file:\/\//;

/**
 * Case-insensitive host match against an allowlist. A leading-dot entry matches
 * that apex domain OR any subdomain of it — anchored on the dot, so a look-alike
 * host (e.g. `evilbotframework.com`) never matches `.botframework.com`; any other
 * entry is an exact host match. Mirrors the fetcher's auth-host suffix semantics.
 */
function matchesHostSuffix(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith(".") ? h === e.slice(1) || h.endsWith(e) : h === e;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Microsoft Teams media resolver implementing MediaResolverPort.
 *
 * Decodes `msteams-file://` attachments, mints the Connector Bearer, and drives the
 * injected auth-capable SSRF-guarded fetcher with the config-or-DEFAULT host
 * allowlist. Returns raw bytes with a sniffed MIME type.
 */
export function createMsTeamsResolver(deps: MsTeamsResolverDeps): MediaResolverPort {
  /** Strip the decoded URL and the Connector token from an error message, then sanitize free-text. */
  function sanitizeError(message: string, realUrl: string, token: string | undefined): string {
    let stripped = message;
    if (realUrl.length > 0) stripped = stripped.replaceAll(realUrl, "[REDACTED_URL]");
    if (token && token.length > 0) stripped = stripped.replaceAll(token, "[REDACTED_TOKEN]");
    return sanitizeLogString(stripped);
  }

  return {
    schemes: ["msteams-file"],

    async resolve(attachment: Attachment): Promise<Result<ResolvedMedia, Error>> {
      // Decode msteams-file://<encodeURIComponent(realUrl)> — the exact inverse of the
      // mapper's encode. decodeURIComponent throws on malformed percent-encoding, and the
      // URL is attacker-influenced, so the decode is guarded rather than trusted.
      const decoded = tryCatch(() =>
        decodeURIComponent(attachment.url.replace(MSTEAMS_FILE_SCHEME, "")),
      );
      if (!decoded.ok) {
        deps.logger.warn(
          {
            platform: "msteams",
            errorKind: "validation" as const,
            hint: "Drop the attachment: its msteams-file:// payload is not valid percent-encoding",
          },
          "Teams media resolve failed: malformed attachment URL",
        );
        return err(new Error("Invalid msteams-file:// URL: malformed percent-encoding"));
      }
      const realUrl = decoded.value;

      const allowHosts =
        deps.mediaAuthAllowHosts.length > 0
          ? deps.mediaAuthAllowHosts
          : DEFAULT_MEDIA_AUTH_ALLOW_HOSTS;

      // Hop-0 fetch-host allowlist: the INITIAL attachment host must be a known
      // Teams/SharePoint/Bot-Framework/Graph attachment host before any GET. The
      // fetcher re-validates every hop for SSRF (private/metadata IPs) but does NOT
      // restrict arbitrary PUBLIC hosts, so an attacker-influenced contentUrl pointing
      // at a non-Teams host is dropped here — closing the blind-public-SSRF residual.
      // REDIRECTS are not gated (the fetcher follows a SharePoint 302 → blob-storage
      // hop token-free); only hop 0 is checked. Any operator-configured Connector host
      // in the auth allowlist is fetch-trusted too (a host trusted to receive the
      // bearer is trusted to fetch from), so it is unioned in.
      const fetchHost = tryCatch(() => new URL(realUrl).hostname);
      if (
        !fetchHost.ok ||
        !matchesHostSuffix(fetchHost.value, [
          ...DEFAULT_MEDIA_FETCH_ALLOW_HOSTS,
          ...allowHosts,
        ])
      ) {
        deps.logger.warn(
          {
            platform: "msteams",
            errorKind: "validation" as const,
            hint: "Drop the attachment: its URL host is not a Teams/SharePoint/Bot-Framework/Graph attachment host",
          },
          "Teams media resolve blocked: off-allowlist fetch host",
        );
        return err(new Error("attachment host not permitted"));
      }

      // Mint the Bearer once; the fetcher decides per-hop whether to attach it. A mint
      // failure is non-fatal — a pre-authed downloadUrl fetches with no Authorization header.
      const tok = await deps.getToken();
      const token = tok.ok ? tok.value : undefined;
      const authHeader = token !== undefined ? `Bearer ${token}` : undefined;

      const startMs = systemNowMs();
      const fetched = await deps.ssrfFetcher.fetch(realUrl, { authHeader, authAllowHosts: allowHosts });
      const durationMs = systemNowMs() - startMs;

      if (!fetched.ok) {
        deps.logger.warn(
          {
            platform: "msteams",
            durationMs,
            errorKind: "platform" as const,
            hint: "Teams media fetch failed — verify the attachment URL is reachable and the Connector app has access",
          },
          "Teams media fetch failed",
        );
        // The decoded URL / Bearer must never surface in the returned error.
        const msg = fetched.error instanceof Error ? fetched.error.message : String(fetched.error);
        return err(new Error(sanitizeError(msg, realUrl, token)));
      }

      const { buffer, mimeType: fetchedMime, sizeBytes } = fetched.value;

      // Secondary size cap at the resolver (defense-in-depth over the fetcher's own cap).
      if (sizeBytes > deps.maxBytes) {
        deps.logger.warn(
          {
            platform: "msteams",
            sizeBytes,
            maxBytes: deps.maxBytes,
            durationMs,
            errorKind: "precondition" as const,
            hint: "Raise the Teams media size limit or ask the sender to shrink the file",
          },
          "Teams media rejected: body exceeds the configured size cap",
        );
        return err(new Error(`Teams media size ${sizeBytes} exceeds limit of ${deps.maxBytes} bytes`));
      }

      // The port contract mandates a VERIFIED (sniffed) MIME. Teams/Bot Framework can
      // mislabel bytes (e.g. an image/jpeg header on PNG bytes) and the model vision API
      // rejects a declared type that mismatches the actual bytes — sniff the downloaded
      // bytes; the recognized type is authoritative, else fall back to the fetched header.
      const sniffed = await fileTypeFromBuffer(buffer);
      const mimeType = sniffed?.mime ?? fetchedMime;
      if (sniffed && sniffed.mime !== fetchedMime) {
        deps.logger.debug(
          { platform: "msteams", declaredMime: fetchedMime, sniffedMime: sniffed.mime },
          "Teams media MIME corrected from sniffed bytes (declared type mismatched)",
        );
      }

      deps.logger.debug(
        { platform: "msteams", sizeBytes, durationMs },
        "Teams media resolved",
      );

      // Raw bytes only — the pipeline fences the DERIVED text, not the media bytes here.
      return ok({ buffer, mimeType, sizeBytes });
    },
  };
}
