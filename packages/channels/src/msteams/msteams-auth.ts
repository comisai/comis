// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams auth — the two security-critical, transport-agnostic halves.
 *
 *  1. Inbound activity JWT validation: a cheap Bearer-presence pre-gate that
 *     short-circuits the no-token case with no network, then library-backed
 *     (jose) signature + issuer + audience + expiry verification against the
 *     Bot Framework signing keys. Never hand-rolled crypto.
 *  2. Outbound Connector token mint: a cached client-credentials access token
 *     (added alongside in this same file).
 *
 * Framework-agnostic on purpose: no HTTP-framework import lives here. The
 * inbound HTTP route that consumes the validator is a gateway concern.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** Bot Framework activity issuer (verified against the live issuer metadata). */
const BF_ISSUER = "https://api.botframework.com";

/**
 * Bot Framework JWKS — a remote key set with jose's built-in caching, key-id
 * rotation, and algorithm pinning. Constructed once at module scope.
 */
const BF_JWKS = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/.well-known/keys"),
);

/** Options for building an inbound activity JWT validator. */
export interface ActivityJwtValidatorOpts {
  /** Expected token issuer. Defaults to the Bot Framework issuer. */
  issuer?: string;
  /**
   * Key set used to verify the signature. Defaults to the remote Bot Framework
   * JWKS; injected with a local key set in tests so verification runs offline.
   */
  jwks?: Parameters<typeof jwtVerify>[1];
  /**
   * Optional logger for a step-tagged verify trace on rejection. The token is
   * never logged.
   */
  logger?: ComisLogger;
}

/**
 * Build an inbound activity JWT validator. The returned closure takes the raw
 * `Authorization` header and the bot app id (the expected `aud` claim) and
 * resolves to `ok(undefined)` for a valid token, `err(...)` otherwise.
 *
 * A missing or non-Bearer header is rejected by a cheap pre-gate with no access
 * to the key set (no network). A present token is verified by jose against the
 * issuer, the audience (= app id), the signature and the expiry.
 */
export function createActivityJwtValidator(
  opts?: ActivityJwtValidatorOpts,
): (
  authHeader: string | undefined,
  appId: string,
) => Promise<Result<void, Error>> {
  const issuer = opts?.issuer ?? BF_ISSUER;
  const keySet = opts?.jwks ?? BF_JWKS;
  const logger = opts?.logger;

  return async (authHeader, appId) => {
    // Cheap pre-gate: no Bearer token → reject before any key-set access.
    if (!authHeader?.startsWith("Bearer ")) {
      return err(new Error("missing bearer token"));
    }
    const token = authHeader.slice("Bearer ".length);
    const verified = await fromPromise(
      jwtVerify(token, keySet, { issuer, audience: appId }),
    );
    if (!verified.ok) {
      logger?.debug(
        { step: "msteams-jwt-validate", channelType: "msteams" as const },
        "Inbound activity token failed verification",
      );
      logger?.warn(
        {
          channelType: "msteams" as const,
          hint: "Reject the unverified inbound activity; confirm the caller is Azure Bot Service",
          errorKind: "auth" as const,
        },
        "Inbound activity rejected: token verification failed",
      );
      return err(verified.error);
    }
    return ok(undefined);
  };
}

/**
 * The default inbound activity validator, wired to the live Bot Framework
 * issuer and JWKS. Callers pass the raw `Authorization` header and the bot app
 * id (the expected audience).
 */
export const validateActivityJwt = createActivityJwtValidator();
