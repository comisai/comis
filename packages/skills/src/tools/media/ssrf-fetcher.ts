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
import { fromPromise, suppressError, tryCatch } from "@comis/shared";
import { fetch, type Response } from "undici";
import { createPinnedAgent, fetchPinned } from "../integrations/pinned-fetch.js";

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
 * Opt-in options that turn the single-shot guarded fetch into an authenticated,
 * redirect-following fetch. Passing NO options preserves the exact single-shot
 * behavior (redirect blocked, no auth header) so existing callers are unaffected.
 */
export interface SsrfFetchOptions {
  /**
   * The Authorization header value to attach — but ONLY on a hop whose validated
   * host matches {@link authAllowHosts}. It is dropped the instant a redirect
   * crosses to an off-allowlist host, so a minted bearer cannot leak to an
   * attacker-influenced redirect target.
   */
  readonly authHeader?: string;
  /**
   * Hosts the {@link authHeader} may be transmitted to. An entry beginning with
   * `.` matches that domain and any subdomain of it (anchored on the leading dot);
   * any other entry is an exact, case-insensitive host match.
   */
  readonly authAllowHosts?: readonly string[];
  /** Maximum redirect hops to follow before rejecting (default 5). */
  readonly maxHops?: number;
}

/**
 * SSRF-safe HTTP fetch interface.
 */
export interface SsrfGuardedFetcher {
  /**
   * Validate URL, fetch with DNS pinning, enforce size limit.
   *
   * With no `opts`, redirects are blocked and no auth header is sent (the
   * single-shot path). With `opts`, an authenticated redirect-following path is
   * used: the auth header rides only an allowlisted host, is dropped on a
   * cross-host redirect, and every hop is re-validated through the SSRF firewall.
   */
  fetch(url: string, opts?: SsrfFetchOptions): Promise<Result<FetchedMedia, Error>>;
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
 * Case-insensitive host match against an allowlist. An entry beginning with `.`
 * matches that domain and any subdomain of it — anchored on the leading dot, so a
 * look-alike host (e.g. `evilexample.com`) never matches `.example.com`; any other
 * entry is an exact host match. Mirrors the host-suffix allowlist semantics used
 * for service-host checks elsewhere.
 */
function matchesSuffix(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith(".") ? h === e.slice(1) || h.endsWith(e) : h === e;
  });
}

/**
 * Read a response body into a Buffer, enforcing `maxBytes` against BOTH the
 * declared Content-Length (pre-stream) and the actual streamed size (a server
 * may under-declare). Shared by the single-shot and redirect-following paths.
 */
async function collectCappedBody(response: Response, maxBytes: number): Promise<Buffer> {
  // Content-Length pre-check — abort before streaming if declared size exceeds limit
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = parseInt(contentLength, 10);
    if (!isNaN(declared) && declared > maxBytes) {
      // Consume and discard body to avoid socket leak
      await response.body?.cancel();
      throw new Error(`Content-Length ${declared} exceeds limit of ${maxBytes} bytes`);
    }
  }

  // Stream body with size enforcement (server may lie about Content-Length)
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeded limit of ${maxBytes} bytes (read ${totalBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Opt-in authenticated + redirect-revalidating fetch path
// ---------------------------------------------------------------------------

/**
 * The authenticated, redirect-following fetch used when `opts` is supplied.
 *
 * Every hop (the initial URL and each redirect target) is re-validated through
 * `validateUrl` — a DNS-resolve + IP-range/cloud-metadata classification — and the
 * socket is pinned to the validated IP, so a DNS-rebind or a redirect to an
 * internal/metadata address is rejected before a connection is opened. The auth
 * header is recomputed per hop and attached ONLY when the validated host is on
 * `authAllowHosts`, so it is dropped the moment a redirect crosses to an
 * off-allowlist host. The chain is bounded by `maxHops`. The auth header and the
 * raw URL/Location are never written to a log field.
 */
async function runAuthenticatedFetch(
  config: SsrfFetcherConfig,
  logger: FetcherLogger,
  url: string,
  opts: SsrfFetchOptions,
): Promise<Result<FetchedMedia, Error>> {
  const maxHops = opts.maxHops ?? 5;
  const allowHosts = opts.authAllowHosts ?? [];

  return fromPromise(
    (async (): Promise<FetchedMedia> => {
      let current = url;

      for (let hop = 0; hop <= maxHops; hop++) {
        // Per-hop SSRF firewall: DNS-resolve + IP-range/metadata classification.
        // A hop whose ORIGIN exactly matches a configured trusted origin (a
        // self-hosted homeserver / the test emulator on loopback) is validated
        // leniently via validateLocalServerUrl (loopback permitted) — mirroring the
        // single-shot path — so an authed download from a private/loopback media
        // host is reachable; EVERY other hop stays on strict validateUrl. This
        // allowance is INDEPENDENT of the token-drop below: the bearer still rides
        // only an authAllowHosts hop, so a trusted-but-off-allowlist redirect target
        // (a CDN on another host) is reached WITHOUT the token.
        let hopOrigin: string | undefined;
        try {
          hopOrigin = new URL(current).origin;
        } catch {
          /* malformed URL → hopOrigin stays undefined → strict validateUrl rejects it below */
        }
        const isTrustedOrigin =
          hopOrigin !== undefined && (config.trustedFetchOrigins ?? []).includes(hopOrigin);
        const validated = isTrustedOrigin
          ? await validateLocalServerUrl(current, [new URL(current).hostname])
          : await validateUrl(current);
        if (!validated.ok) {
          logger.error(
            {
              hop,
              err: validated.error,
              errorKind: "validation" as const,
              hint: "A fetch hop resolved to a blocked or internal address and was stopped before connecting — the redirect target failed SSRF validation",
            },
            "SSRF-guarded auth fetch failed — hop rejected by SSRF validation",
          );
          throw validated.error;
        }

        const { hostname, ip } = validated.value;
        const authAttached = opts.authHeader !== undefined && matchesSuffix(hostname, allowHosts);
        const headers: Record<string, string> = authAttached
          ? { authorization: opts.authHeader! }
          : {};

        logger.debug(
          { hop, resolvedIp: ip, authAttached, step: "ssrf-auth-hop" },
          "SSRF-guarded auth fetch — hop validated",
        );

        // Socket pinned to the validated IP (rebinding TOCTOU closed); redirects
        // returned to us so the NEXT hop re-enters the firewall above.
        let response: Response;
        try {
          response = await fetchPinned(current, ip, {
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          const classified = classifyFetchError(error);
          logger.warn(
            { hop, err: error, errorKind: classified.errorKind, hint: classified.hint },
            "SSRF-guarded auth fetch failed — network error",
          );
          throw error;
        }

        // A 3xx is followed manually; the bearer is recomputed (and dropped) on the next hop.
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) {
            throw new Error("Redirect response missing a Location header");
          }
          // Parse the redirect target under the per-hop failure contract: a
          // malformed Location must carry the same classified hint+errorKind as
          // every other failure branch (§2.7), not a bare TypeError that reaches
          // the caller stripped of which hop failed and why.
          const next = tryCatch(() => new URL(location, current).toString());
          if (!next.ok) {
            logger.warn(
              {
                hop,
                errorKind: "validation" as const,
                hint: "Redirect Location was not a parseable URL — the hop was stopped before re-validation",
              },
              "SSRF-guarded auth fetch failed — malformed redirect target",
            );
            throw next.error;
          }
          current = next.value;
          continue;
        }

        if (!response.ok) {
          logger.error(
            {
              hop,
              status: response.status,
              errorKind: "network" as const,
              hint: "The remote host returned an HTTP error — check that the media URL is reachable and the auth header is accepted",
            },
            "SSRF-guarded auth fetch failed — HTTP error response",
          );
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await collectCappedBody(response, config.maxBytes);
        const mimeType = response.headers.get("content-type") ?? "application/octet-stream";

        logger.debug(
          { hop, resolvedIp: ip, sizeBytes: buffer.length, step: "ssrf-auth-complete" },
          "SSRF-guarded auth fetch complete",
        );

        return { buffer, mimeType, sizeBytes: buffer.length, resolvedIp: ip };
      }

      throw new Error(`Redirect hop limit (${maxHops}) exceeded`);
    })(),
  );
}

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
    async fetch(
      url: string,
      opts?: SsrfFetchOptions,
    ): Promise<Result<FetchedMedia, Error>> {
      // Opt-in authenticated + redirect-revalidating path. When no opts are
      // supplied the single-shot path below runs unchanged (redirect blocked,
      // no auth header) so existing callers are byte-for-byte unaffected.
      if (opts !== undefined) {
        return runAuthenticatedFetch(config, logger, url, opts);
      }

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

            // 3. Content-Length pre-check + streamed-byte cap (shared with the auth path).
            const buffer = await collectCappedBody(response, config.maxBytes);
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
