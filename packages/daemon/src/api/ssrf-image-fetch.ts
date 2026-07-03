// SPDX-License-Identifier: Apache-2.0
// @allow-throw: helper for RPC handler modules — every throw is caught at the
// caller's `@allow-throw` boundary (image-handlers / media-handlers) and
// converted to a JSON-RPC error response by rpc-dispatch.ts.
/**
 * Shared DNS-pinned, SSRF-safe image byte fetch.
 *
 * Closes the DNS-rebinding time-of-check/time-of-use (TOCTOU) SSRF gap that a
 * bare `fetch(url, { redirect: "error" })` leaves open: `validateUrl` resolves
 * DNS and checks the IP against the blocklist, but a subsequent bare `fetch`
 * performs its OWN, independent DNS resolution — so a hostile DNS server can
 * return a public IP at validation and an internal IP (169.254.169.254,
 * 127.0.0.1, RFC-1918, …) at fetch. This helper PINS the connection to the IP
 * `validateUrl` already resolved, via an undici `Agent` whose `connect.lookup`
 * always returns that validated IP (preserving TLS SNI because the original
 * hostname stays in the URL). `redirect:"error"` additionally closes the
 * redirect-to-internal-IP vector.
 *
 * This is the daemon-side sibling of `@comis/skills`'s `ssrf-fetcher.ts`
 * `createSsrfGuardedFetcher` (which the per-platform media resolvers use): the
 * same hardened pattern, exposed as a plain `(source, maxBytes)` helper so the
 * two daemon RPC handlers that fetch agent-controlled image URLs
 * (`image.generate`'s `reference_image`, `image.analyze`'s `url`) share ONE
 * pinned path instead of each hand-rolling a bare `fetch`.
 *
 * Both `fetch` and `Agent` are imported from undici directly (NOT
 * `globalThis.fetch`): Node's bundled fetch ships an older undici whose
 * request-handler lifecycle is incompatible with the v8 `Agent` used for DNS
 * pinning (mixing the two throws `InvalidArgumentError: invalid onRequestStart
 * method`). Do not swap this back to `globalThis.fetch` — mirrors the same
 * constraint documented in `ssrf-fetcher.ts`.
 *
 * @module
 */
import { validateUrl } from "@comis/core";
import { suppressError } from "@comis/shared";
import { Agent, fetch } from "undici";

/** Bytes fetched from an SSRF-validated, DNS-pinned download. */
export interface FetchedImageBytes {
  /** Downloaded content. */
  readonly buffer: Buffer;
  /** Content-Type from the response headers (`null` → caller-defaults). */
  readonly mimeType: string | null;
}

/** Per-request fetch timeout (DoS cap on a slow/hung internal host probe). */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Create a one-shot undici `Agent` that pins DNS resolution to a specific IP.
 *
 * The Agent's `connect.lookup` callback always returns the pre-validated IP,
 * preventing DNS rebinding (TOCTOU) between validation and connection while
 * preserving TLS SNI (the original hostname stays in the URL). Mirrors
 * `ssrf-fetcher.ts`'s `createPinnedAgent`.
 */
function createPinnedAgent(ip: string): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const family = ip.includes(":") ? 6 : 4;
        // Node 22+ enables autoSelectFamily (Happy Eyeballs), which calls
        // lookup with {all:true} expecting an array of addresses.
        if (options && typeof options === "object" && "all" in options && options.all) {
          (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
            null,
            [{ address: ip, family }],
          );
        } else {
          callback(null, ip, family);
        }
      },
    },
  });
}

/**
 * Fetch the bytes at `source` SSRF-safely: validate the host (DNS + IP-range +
 * cloud-metadata blocklist), PIN the connection to the validated IP (no
 * rebind window), refuse redirects, and bound the download to `maxBytes`
 * (Content-Length pre-check AND streamed-byte enforcement, since a server can
 * lie about Content-Length).
 *
 * @param source   - The agent/operator-supplied http(s) URL.
 * @param maxBytes - Hard cap on the downloaded body size.
 * @returns The downloaded buffer + the response `content-type` (or `null`).
 * @throws `SSRF blocked: …` if `validateUrl` rejects (never fetches), `HTTP …`
 *   on a non-ok status, or `… exceeds the size limit` if over `maxBytes`.
 */
export async function fetchImageBytesSsrfSafe(
  source: string,
  maxBytes: number,
): Promise<FetchedImageBytes> {
  // 1. SSRF-validate BEFORE any connection (DNS resolution + IP-range/metadata
  //    blocklist). On reject, throw WITHOUT fetching.
  const urlCheck = await validateUrl(source);
  if (!urlCheck.ok) {
    throw new Error(`SSRF blocked: ${urlCheck.error.message}`);
  }

  // 2. Pin DNS to the IP validateUrl already resolved — closes the rebinding
  //    TOCTOU window. The original URL (hostname) is preserved for TLS SNI.
  const agent = createPinnedAgent(urlCheck.value.ip);
  try {
    const response = await fetch(source, {
      redirect: "error", // never follow a redirect to a (re-validated) internal IP
      dispatcher: agent,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    }

    // 3. Content-Length pre-check — abort before streaming if declared > cap.
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declared = parseInt(contentLength, 10);
      if (!isNaN(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new Error("Reference image exceeds the size limit");
      }
    }

    // 4. Stream with byte enforcement (the server may under-declare/omit length).
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body for reference image");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("Reference image exceeds the size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return { buffer: Buffer.concat(chunks), mimeType: response.headers.get("content-type") };
  } finally {
    suppressError(agent.close(), "ssrf-image-fetch agent cleanup");
  }
}
