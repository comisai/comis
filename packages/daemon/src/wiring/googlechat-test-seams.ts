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
 *   - `COMIS_GOOGLECHAT_TEST_API` = a loopback base (`http://127.0.0.1:PORT`).
 *     This redirects the adapter's OUTBOUND egress — the Chat REST API, the
 *     Pub/Sub pull endpoint, and the OAuth token mint — onto that one base under
 *     distinct path prefixes, so a single emulator answers all three. With it
 *     unset the adapter keeps Google's real endpoints (production, unchanged).
 *
 * This is never a production knob: the vars are documented test-only. Env is read
 * through the injected getter, never the ambient process environment.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import {
  createGoogleChatInboundVerifier,
  createLocalGoogleChatInboundVerifier,
} from "@comis/channels";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";

/** Reads an environment variable (injected so the resolver stays pure + testable). */
export type EnvGetter = (key: string) => string | undefined;

/** The env var that points the inbound verifier at a local test JWKS (off by default). */
export const GOOGLECHAT_TEST_JWKS_ENV = "COMIS_GOOGLECHAT_TEST_JWKS";
/** The env var that overrides the expected issuer for a synthetic local key set. */
export const GOOGLECHAT_TEST_ISSUER_ENV = "COMIS_GOOGLECHAT_TEST_ISSUER";
/** The env var that redirects the daemon's Google Chat outbound egress to a loopback emulator (off by default). */
export const GOOGLECHAT_TEST_API_ENV = "COMIS_GOOGLECHAT_TEST_API";

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
  // Test-only offline path: verify against a local JWKS the emulator wrote. This
  // swaps only the key source — a FULL signature + issuer + audience verify (plus
  // the app-url sender-binding email claim) still runs, so it is never a bypass.
  const readFileImpl =
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- jwksPath is an operator-set test-only env var, not user input
    deps?.readFileImpl ?? ((path: string) => readFileSync(path, "utf8"));
  // The read + parse can throw (ENOENT/EACCES from the read, SyntaxError from a
  // malformed file). This resolver runs inside the unwrapped bootstrapAdapters,
  // so an uncaught throw would fail daemon boot. Contain it: warn (config) naming
  // the env var and fall closed to the production remote-JWKS verifier. The seam
  // is off-by-default and test-only, so a bad file must degrade to production, not
  // crash — the very misconfiguration the activation WARN below warns against.
  let jwks: Parameters<typeof createLocalGoogleChatInboundVerifier>[0];
  try {
    jwks = JSON.parse(readFileImpl(jwksPath)) as Parameters<
      typeof createLocalGoogleChatInboundVerifier
    >[0];
  } catch (readErr) {
    deps?.logger?.warn(
      {
        channelType: "googlechat" as const,
        err: readErr,
        hint: "COMIS_GOOGLECHAT_TEST_JWKS is set but its JWKS file could not be read or parsed — falling back to the production remote-JWKS verifier; unset it in production",
        errorKind: "config" as const,
      },
      "Google Chat test JWKS unreadable; falling back to the production remote-JWKS verifier",
    );
    return createGoogleChatInboundVerifier({
      audienceType: cfg.audienceType,
      audience: cfg.audience,
      ...(deps?.logger ? { logger: deps.logger } : {}),
    });
  }
  const issuer = getEnv(GOOGLECHAT_TEST_ISSUER_ENV);
  const verifier = createLocalGoogleChatInboundVerifier(jwks, {
    audienceType: cfg.audienceType,
    audience: cfg.audience,
    ...(issuer !== undefined && issuer.length > 0 ? { issuer } : {}),
  });
  deps?.logger?.warn(
    {
      channelType: "googlechat" as const,
      hint: "Unset COMIS_GOOGLECHAT_TEST_JWKS in production — the Google Chat ingress is verifying inbound tokens against a LOCAL test JWKS, not Google's signing keys",
      errorKind: "config" as const,
    },
    "Google Chat ingress using a LOCAL test JWKS (test-only seam)",
  );
  return verifier;
}

/**
 * Resolve the OFF-BY-DEFAULT outbound-egress base-URL overrides for the adapter.
 *
 * Default (env unset): `undefined` — the adapter keeps Google's real Chat REST,
 * Pub/Sub, and OAuth token endpoints (production, byte-identical). When
 * `COMIS_GOOGLECHAT_TEST_API` names a loopback base, the three outbound legs are
 * redirected onto that one base under distinct path prefixes — `…/chat/v1` (the
 * Chat REST API), `…/pubsub/v1` (the Pub/Sub pull endpoint), and `…/token` (the
 * service-account token mint) — so a single emulator serves all three. Activation
 * emits one content-free WARN naming the env var (never the loopback value).
 *
 * Env is read only through the injected getter, never the ambient process
 * environment. A malformed base fails closed to production (returns `undefined`)
 * with a config WARN rather than throwing out of the unwrapped bootstrapAdapters
 * and failing daemon boot — the seam is off-by-default and test-only, so a bad
 * value must degrade to production, not crash.
 */
export function resolveTestGoogleChatEgress(
  getEnv: EnvGetter,
  deps?: { readonly logger?: ComisLogger },
): { chatBaseUrl: string; pubsubBaseUrl: string; tokenUrl: string } | undefined {
  const loopback = getEnv(GOOGLECHAT_TEST_API_ENV);
  if (loopback === undefined || loopback.length === 0) return undefined;
  let base: string;
  try {
    // Validate + normalize the loopback base; strip any trailing slash so the
    // derived path suffixes join cleanly. A non-URL value throws here and degrades
    // to production below rather than crashing boot.
    base = new URL(loopback).href.replace(/\/+$/, "");
  } catch {
    deps?.logger?.warn(
      {
        channelType: "googlechat" as const,
        hint: "COMIS_GOOGLECHAT_TEST_API is set but is not a valid URL — ignoring it and using the production Google Chat/Pub-Sub/token endpoints; unset it in production",
        errorKind: "config" as const,
      },
      "Google Chat test egress base URL invalid; using production endpoints",
    );
    return undefined;
  }
  deps?.logger?.warn(
    {
      channelType: "googlechat" as const,
      hint: "Unset COMIS_GOOGLECHAT_TEST_API in production — the Google Chat outbound Chat, Pub/Sub, and token egress is redirected to a local test endpoint, not Google",
      errorKind: "config" as const,
    },
    "Google Chat outbound egress redirected to a local test endpoint (test-only seam)",
  );
  return {
    chatBaseUrl: `${base}/chat/v1`,
    pubsubBaseUrl: `${base}/pubsub/v1`,
    tokenUrl: `${base}/token`,
  };
}
