// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix credential + homeserver validation boundary.
 *
 * Two transport-free guards run before the adapter ever connects:
 *
 *  - `validateHomeserverUrl` is the SSRF boundary for the operator-supplied
 *    homeserver URL. By default it delegates to the audited core guard, which
 *    blocks non-http(s) schemes, private + loopback ranges, and the cloud
 *    metadata service. When `allowPrivateHomeserver` is enabled — the opt-in
 *    that makes a self-hosted or loopback homeserver reachable — it relaxes
 *    ONLY the private/loopback range block: it still requires http(s) and
 *    STILL denies the cloud metadata addresses, reusing the same exported
 *    blocklist so the opt-in can never become a metadata SSRF hole. Relaxing
 *    the range check emits a loud, operator-actionable warning that names the
 *    knob responsible.
 *
 *  - `validateMatrixCredentials` is a synchronous field-presence precondition:
 *    it names any missing required field in the error and never echoes the
 *    access token or password value.
 *
 * The opt-in path performs its own structured checks rather than retrying the
 * strict guard and admitting on failure: the guard's error is opaque, so a
 * "retry then admit" would silently admit a metadata address. Instead it
 * re-parses, re-checks the protocol, resolves the host, and denies against the
 * exported metadata list directly.
 *
 * @module
 */

import { lookup } from "node:dns/promises";
import type { Result } from "@comis/shared";
import { ok, err, tryCatch, fromPromise } from "@comis/shared";
import type { ComisLogger, ValidatedUrl } from "@comis/core";
import { validateUrl, CLOUD_METADATA_IPS } from "@comis/core";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate an operator-supplied homeserver URL for SSRF safety.
 *
 * - `allowPrivate` false (default): delegate to the audited core guard, which
 *   blocks non-http(s), private, loopback, link-local, and cloud-metadata
 *   targets.
 * - `allowPrivate` true (opt-in): permit private + loopback ranges so a
 *   self-hosted or loopback homeserver is reachable, but STILL require http(s)
 *   and STILL deny the cloud metadata addresses. A loud warning is logged
 *   whenever the range check is relaxed.
 *
 * @param url - The configured homeserver URL.
 * @param allowPrivate - Whether the private/loopback range block is relaxed.
 * @param logger - Logger used for the loud opt-in warning.
 * @returns ok with the resolved host on success; err on any blocked or
 *   malformed URL. Never throws.
 */
export async function validateHomeserverUrl(
  url: string,
  allowPrivate: boolean,
  logger: ComisLogger,
): Promise<Result<ValidatedUrl, Error>> {
  if (!allowPrivate) {
    // Default path: the audited guard blocks non-http(s), private, loopback,
    // link-local, and cloud-metadata targets.
    return validateUrl(url);
  }

  // Opt-in path: relax ONLY the private/loopback range block. Still require
  // http(s), and STILL deny cloud metadata by reusing the exported blocklist.
  const parsedResult = tryCatch(() => new URL(url));
  if (!parsedResult.ok) {
    return err(new Error("Invalid homeserver URL — expected an absolute http(s) URL"));
  }
  const parsed = parsedResult.value;

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return err(
      new Error(
        `Blocked homeserver protocol: ${parsed.protocol} — only http and https are allowed`,
      ),
    );
  }

  // Resolve the host (strip IPv6 literal brackets exactly as the core guard
  // does) so the resolved address can be checked against the metadata list.
  const hostname = parsed.hostname;
  const lookupHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const resolved = await fromPromise(lookup(lookupHost));
  if (!resolved.ok) {
    return err(new Error("Homeserver hostname did not resolve"));
  }
  const address = resolved.value.address;

  if (CLOUD_METADATA_IPS.includes(address)) {
    // Never relaxed: a cloud metadata target is denied even with the opt-in on.
    return err(
      new Error(
        `Blocked: homeserver resolves to cloud metadata address ${address} — never permitted, even when private homeservers are enabled`,
      ),
    );
  }

  logger.warn(
    {
      channelType: "matrix",
      errorKind: "config" as const,
      hint: "Private or loopback homeserver permitted because allowPrivateHomeserver is enabled — disable it in production so the SSRF range check is enforced",
    },
    "Private homeserver SSRF range check relaxed",
  );
  return ok({ hostname, ip: address, url: parsed });
}

/** Credentials required to authenticate the Matrix adapter. */
export interface MatrixCredentialInput {
  /** Homeserver base URL — always required. */
  homeserverUrl?: string;
  /** Full MXID, required for password login (token login carries identity). */
  userId?: string;
  /** Bot access token — never echoed into errors or logs. */
  accessToken?: string;
  /** Password — never echoed into errors or logs. Requires a userId. */
  password?: string;
}

/** A credential is missing when it is absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * Verify the Matrix credentials required to authenticate are present.
 *
 * homeserverUrl is always required; at least one of accessToken or password
 * must be provided; a password login additionally requires a userId. The error
 * names the missing field and never interpolates a secret value.
 *
 * @param deps.homeserverUrl - Homeserver base URL.
 * @param deps.userId - Full MXID (required for password login).
 * @param deps.accessToken - Bot access token (never named by value).
 * @param deps.password - Password (never named by value).
 * @returns ok when the required fields are present; err naming the first
 *   missing field.
 */
export function validateMatrixCredentials(
  deps: MatrixCredentialInput,
): Result<void, Error> {
  if (isBlank(deps.homeserverUrl)) {
    return err(new Error("Matrix credentials invalid: homeserverUrl must not be empty"));
  }
  if (isBlank(deps.accessToken) && isBlank(deps.password)) {
    return err(
      new Error(
        "Matrix credentials invalid: one of accessToken or password must be provided",
      ),
    );
  }
  if (!isBlank(deps.password) && isBlank(deps.userId)) {
    return err(
      new Error("Matrix credentials invalid: userId must not be empty for password login"),
    );
  }
  return ok(undefined);
}
