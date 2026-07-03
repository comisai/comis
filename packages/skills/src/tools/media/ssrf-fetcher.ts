// SPDX-License-Identifier: Apache-2.0
// @allow-throw: media-tool boundary; throws caught by AgentTool wrapper (image/video/audio tools) or upstream fromPromise() converter.
/**
 * SSRF-guarded HTTP fetch utility.
 *
 * Wraps validateUrl() + fetch() into a single safe operation.
 * Per-platform MediaResolverPort adapters use this for all remote media fetches.
 *
 * Uses undici Agent-based DNS pinning: creates a per-request Agent whose
 * `connect.lookup` returns the pre-validated IP, then fetches the **original
 * URL** (preserving TLS SNI). This maintains SSRF protection while keeping
 * TLS certificate validation working correctly.
 *
 * Both `fetch` and `Agent` are imported from undici directly (NOT
 * `globalThis.fetch`): Node's bundled fetch ships an older undici whose
 * request-handler lifecycle is incompatible with the v8 `Agent` we use for
 * DNS pinning. Mixing the two throws `InvalidArgumentError: invalid
 * onRequestStart method` and breaks every channel's inbound media path. Do
 * not swap this back to `globalThis.fetch`.
 *
 * Every outbound media fetch MUST go through this utility.
 *
 * @module
 */

import { validateUrl, validateLocalServerUrl } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise, suppressError } from "@comis/shared";
import { fetch } from "undici";
import { createPinnedAgent } from "../integrations/pinned-fetch.js";

/**
 * Downloaded media from an SSRF-validated fetch.
 */
export interface FetchedMedia {
  /** Downloaded content. */
  readonly buffer: Buffer;
  /** Content-Type from response headers. */
  readonly mimeType: string;
  /** Actual buffer length in bytes. */
  readonly sizeBytes: number;
  /** The pinned IP used for the connection (from ValidatedUrl). */
  readonly resolvedIp: string;
}

/**
 * SSRF-safe HTTP fetch interface.
 */
export interface SsrfGuardedFetcher {
  /** Validate URL, fetch with DNS pinning, enforce size limit. */
  fetch(url: string): Promise<Result<FetchedMedia, Error>>;
}

/**
 * Configuration for the SSRF-guarded fetcher.
 */
export interface SsrfFetcherConfig {
  /** Maximum response body size (from MediaInfraConfigSchema.maxRemoteFetchBytes). */
  readonly maxBytes: number;
  /**
   * Operator-configured trusted fetch ORIGINS
   * (`scheme://host:port`, e.g. a self-hosted local Bot API server / the test emulator at
   * `http://127.0.0.1:38411`), normalized from the channel `apiRoot` config. A media URL whose
   * origin EXACTLY matches one of these is validated leniently (loopback/private-IP permitted)
   * so the file-byte download from a custom apiRoot works; EVERY other URL — including an
   * arbitrary loopback like `127.0.0.1:4766` — still goes through the strict `validateUrl`
   * SSRF firewall. Host:port-scoped, so the SSRF block is preserved. Default: none.
   */
  readonly trustedFetchOrigins?: ReadonlyArray<string>;
}

/**
 * Minimal logger interface for the SSRF-guarded fetcher.
 */
interface FetcherLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

interface ClassifiedError {
  errorKind: ErrorKind;
  hint: string;
}

/**
 * Classify a fetch error into an actionable errorKind + hint for structured logging.
 */
function classifyFetchError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("ssl") || lower.includes("tls") || lower.includes("certificate") || lower.includes("cert")) {
    return {
      errorKind: "network",
      hint: "TLS handshake failed — check that the remote host has a valid certificate and supports the expected hostname",
    };
  }

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
    return {
      errorKind: "timeout",
      hint: "Request timed out — the remote server may be slow or unreachable",
    };
  }

  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return {
      errorKind: "network",
      hint: "Connection refused — the remote server is not accepting connections on this port",
    };
  }

  if (lower.includes("redirect")) {
    return {
      errorKind: "network",
      hint: "Redirect blocked — SSRF guard does not follow redirects to prevent redirect-based bypass",
    };
  }

  if (lower.includes("dns") || lower.includes("getaddrinfo") || lower.includes("enotfound")) {
    return {
      errorKind: "network",
      hint: "DNS resolution failed — check that the hostname is correct and publicly resolvable",
    };
  }

  return {
    errorKind: "network",
    hint: "Network error during SSRF-guarded fetch — check remote host availability",
  };
}

// ---------------------------------------------------------------------------
// Agent-based DNS pinning — `createPinnedAgent` is the shared primitive in
// ../integrations/pinned-fetch.ts; this fetcher reuses it
// rather than hand-rolling its own copy.
// ---------------------------------------------------------------------------

/**
 * Create an SSRF-guarded HTTP fetch utility.
 *
 * Every request is validated through validateUrl() (DNS pinning, IP range
 * blocking, cloud metadata blocking). Content-Length is checked against
 * maxBytes before streaming. Actual streamed bytes are enforced against
 * the limit. Redirects are blocked to prevent redirect-based SSRF bypass.
 *
 * @param config - Fetch size limit configuration
 * @param logger - Logger for debug/warn/error output
 * @returns SsrfGuardedFetcher instance
 */
export function createSsrfGuardedFetcher(
  config: SsrfFetcherConfig,
  logger: FetcherLogger,
): SsrfGuardedFetcher {
  return {
    async fetch(url: string): Promise<Result<FetchedMedia, Error>> {
      return fromPromise(
        (async (): Promise<FetchedMedia> => {
          // 1. Validate URL via SSRF guard (DNS resolution + IP range check + DNS pinning).
          //    A URL whose ORIGIN exactly matches a configured trusted apiRoot
          //    (a self-hosted local Bot API server / the emulator) is validated leniently
          //    (loopback/private permitted via validateLocalServerUrl); everything else — incl. any
          //    other loopback URL — goes through strict validateUrl (the SSRF firewall).
          let urlOrigin: string | undefined;
          try {
            urlOrigin = new URL(url).origin;
          } catch {
            /* malformed URL → urlOrigin stays undefined → strict validateUrl rejects it below */
          }
          const isTrustedOrigin =
            urlOrigin !== undefined && (config.trustedFetchOrigins ?? []).includes(urlOrigin);
          const validated = isTrustedOrigin
            ? await validateLocalServerUrl(url, [new URL(url).hostname])
            : await validateUrl(url);
          if (!validated.ok) {
            logger.error(
              {
                url,
                err: validated.error,
                hint: "URL failed SSRF validation — ensure the target is a public host and not an internal/metadata IP",
                errorKind: "validation" as const,
              },
              "SSRF-guarded fetch failed — URL validation rejected",
            );
            throw validated.error;
          }

          const { hostname, ip } = validated.value;

          logger.debug(
            { hostname, resolvedIp: ip },
            "SSRF DNS validation passed",
          );

          // 2. Create a one-shot Agent that pins DNS to the validated IP.
          //    This prevents DNS rebinding (TOCTOU) while preserving TLS SNI
          //    because the original hostname stays in the URL.
          const agent = createPinnedAgent(ip);

          try {
            const response = await fetch(url, {
              signal: AbortSignal.timeout(30_000),
              redirect: "error", // Do not follow redirects — they could point to internal IPs
              dispatcher: agent,
            });

            if (!response.ok) {
              logger.error(
                {
                  url,
                  status: response.status,
                  resolvedIp: ip,
                  hint: "Check that the remote media URL is publicly accessible and returns a valid HTTP status",
                  errorKind: "network" as const,
                },
                "SSRF-guarded fetch failed — HTTP error response",
              );
              throw new Error(`HTTP ${response.status} fetching ${url}`);
            }

            // 3. Content-Length pre-check — abort before streaming if declared size exceeds limit
            const contentLength = response.headers.get("content-length");
            if (contentLength) {
              const declared = parseInt(contentLength, 10);
              if (!isNaN(declared) && declared > config.maxBytes) {
                // Consume and discard body to avoid socket leak
                await response.body?.cancel();
                throw new Error(
                  `Content-Length ${declared} exceeds limit of ${config.maxBytes} bytes`,
                );
              }
            }

            // 4. Stream body with size enforcement (server may lie about Content-Length)
            const chunks: Uint8Array[] = [];
            let totalBytes = 0;
            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                totalBytes += value.byteLength;
                if (totalBytes > config.maxBytes) {
                  await reader.cancel();
                  throw new Error(
                    `Response body exceeded limit of ${config.maxBytes} bytes (read ${totalBytes})`,
                  );
                }
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }

            const buffer = Buffer.concat(chunks);
            const mimeType =
              response.headers.get("content-type") ?? "application/octet-stream";

            logger.debug(
              { url, resolvedIp: ip, sizeBytes: buffer.length, mimeType },
              "SSRF-guarded fetch complete",
            );

            return { buffer, mimeType, sizeBytes: buffer.length, resolvedIp: ip };
          } catch (error) {
            // Re-throw errors we already logged (HTTP status errors)
            if (error instanceof Error && error.message.startsWith("HTTP ")) {
              throw error;
            }
            // Re-throw size limit errors (already clear enough)
            if (error instanceof Error && (error.message.includes("exceeds limit") || error.message.includes("exceeded limit"))) {
              throw error;
            }

            // Classify and warn about network-level fetch errors
            const classified = classifyFetchError(error);
            logger.warn(
              {
                url,
                resolvedIp: ip,
                err: error,
                errorKind: classified.errorKind,
                hint: classified.hint,
              },
              "SSRF-guarded fetch failed — network error",
            );
            throw error;
          } finally {
            suppressError(agent.close(), "ssrf-fetcher agent cleanup");
          }
        })(),
      ).then((result) => {
        // fromPromise wraps the inner throws into err(), but we also need to
        // unwrap the double-Result that would occur if inner code returns ok()
        // directly. Since our inner function returns FetchedMedia (not Result),
        // fromPromise produces Result<FetchedMedia, Error> — exactly what we want.
        return result;
      });
    },
  };
}
