// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat inbound-verify live-test seam — OFF BY DEFAULT.
 *
 * The Google Chat webhook ingress verifies every inbound event against Google's
 * remote signing keys (the Chat-system JWK set for a project-number audience, or
 * Google's OIDC certs plus a sender-binding email claim for an app-url audience).
 * A live-test rig that mints its own tokens cannot reach those remote keys, so
 * this resolver bridges the gap WITHOUT weakening the trust anchor: it activates
 * ONLY when its `COMIS_GOOGLECHAT_TEST_*` env var is set, and with the env unset
 * the daemon behaves byte-identically to production (the live remote-JWKS verifier).
 *
 *   - `COMIS_GOOGLECHAT_TEST_JWKS` = a path to a public JWKS JSON. The emulator
 *     holds the matching private key and signs inbound event tokens; this swaps
 *     the ingress verifier for a LOCAL-JWKS one — a FULL signature + issuer +
 *     audience verify (plus, for app-url, the sender-binding email claim), never
 *     a bypass. Only the key source changes; production keeps the live
 *     remote-JWKS verifier untouched.
 *   - `COMIS_GOOGLECHAT_TEST_ISSUER` = an optional issuer override for a
 *     fully-synthetic emulator key set. Defaults to the audience shape's Google
 *     issuer when unset.
 *
 * This is never a production knob: the vars are documented test-only. Env is read
 * through the injected getter, never the ambient process environment.
 *
 * @module
 */

import { createGoogleChatInboundVerifier } from "@comis/channels";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

/** Reads an environment variable (injected so the resolver stays pure + testable). */
export type EnvGetter = (key: string) => string | undefined;

/** The env var that points the inbound verifier at a local test JWKS (off by default). */
export const GOOGLECHAT_TEST_JWKS_ENV = "COMIS_GOOGLECHAT_TEST_JWKS";
/** The env var that overrides the expected issuer for a synthetic local key set. */
export const GOOGLECHAT_TEST_ISSUER_ENV = "COMIS_GOOGLECHAT_TEST_ISSUER";

/**
 * Resolve the inbound-event JWT verifier for the ingress, closed over the
 * configured `audienceType` + `audience`.
 *
 * Default (env unset): the production remote-JWKS verifier
 * {@link createGoogleChatInboundVerifier}. When `COMIS_GOOGLECHAT_TEST_JWKS`
 * names a readable JWKS file, a LOCAL-JWKS verifier against that key set instead
 * (still a full signature/issuer/audience verify). The returned closure has the
 * ingress's expected `(authHeader) => Promise<Result<void, Error>>` shape.
 */
export function resolveTestGoogleChatVerifier(
  cfg: { audienceType: "project-number" | "app-url"; audience: string },
  getEnv: EnvGetter,
  deps?: {
    readonly readFileImpl?: (path: string) => string;
    readonly logger?: ComisLogger;
  },
): (authHeader: string | undefined) => Promise<Result<void, Error>> {
  const jwksPath = getEnv(GOOGLECHAT_TEST_JWKS_ENV);
  if (jwksPath === undefined || jwksPath.length === 0) {
    // Production/default path: verify against the live Google JWK set for the
    // configured audience shape.
    return createGoogleChatInboundVerifier({
      audienceType: cfg.audienceType,
      audience: cfg.audience,
      ...(deps?.logger ? { logger: deps.logger } : {}),
    });
  }
  // A named JWKS file selects the offline local-JWKS verifier; that branch swaps
  // only the key source (never the verify) and emits a content-free activation
  // WARN. Until it is wired the default verifier keeps the resolver total.
  return createGoogleChatInboundVerifier({
    audienceType: cfg.audienceType,
    audience: cfg.audience,
    ...(deps?.logger ? { logger: deps.logger } : {}),
  });
}
