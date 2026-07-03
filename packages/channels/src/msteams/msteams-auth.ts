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

import { systemNowMs } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { classifyMsTeamsError } from "./errors.js";

/** Bot Framework activity issuer (verified against the live issuer metadata). */
const BF_ISSUER = "https://api.botframework.com";

/**
 * Bot Framework JWKS — a remote key set with jose's built-in caching and key-id
 * rotation. `createRemoteJWKSet` performs key selection (by `kid`), not
 * verification-algorithm pinning; the accepted signature algorithm is pinned
 * separately as an explicit `algorithms` allowlist on the verify call below.
 * Constructed once at module scope.
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
    // Fail closed on a falsy expected audience: jose treats an empty `audience`
    // as "no audience constraint", which would accept a token minted for any
    // other bot. Reject before any key-set access rather than trust the caller.
    if (!appId) {
      return err(new Error("missing expected audience (appId)"));
    }
    // Cheap pre-gate: no Bearer token → reject before any key-set access.
    if (!authHeader?.startsWith("Bearer ")) {
      return err(new Error("missing bearer token"));
    }
    const token = authHeader.slice("Bearer ".length);
    const verified = await fromPromise(
      jwtVerify(token, keySet, { issuer, audience: appId, algorithms: ["RS256"] }),
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

// --- Outbound Connector token mint (client-credentials, cached) ---

/**
 * A host-safe single-tenant id: a GUID or a verified domain. Must start with an
 * alphanumeric and carry only alphanumerics, dots and hyphens — so it can never
 * introduce a `/` (or a leading-dot traversal) into the token endpoint path.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** Refresh a cached token this many ms before its stated expiry. */
const DEFAULT_SKEW_MS = 60_000;

/** The OAuth2 scope that yields a Bot Framework Connector token. */
const CONNECTOR_SCOPE = "https://api.botframework.com/.default";

/** Dependencies for the outbound Connector token provider. */
export interface ConnectorTokenDeps {
  /** Bot application (client) id. */
  appId: string;
  /** Bot application secret — sent only in the request body, never logged. */
  appPassword: string;
  /** Single-tenant directory id — validated before it reaches the token URL. */
  tenantId: string;
  /** Logger for the mint completion and each failure branch. */
  logger: ComisLogger;
  /** Injected fetch, defaulting to the global; lets a unit test stub the mint. */
  fetchImpl?: typeof fetch;
  /** Injected clock in ms, defaulting to systemNowMs; makes expiry deterministic. */
  now?: () => number;
  /** Refresh margin before expiry, in ms. Defaults to 60s. */
  skewMs?: number;
}

/** Provides a cached Connector access token, minted on demand. */
export interface ConnectorTokenProvider {
  /** Return a valid access token, minting or refreshing as needed. */
  getToken(): Promise<Result<string, Error>>;
}

/** The token-endpoint success fields consumed here. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Build a Connector token provider. The first `getToken()` mints a token via
 * the client-credentials grant against the single-tenant token endpoint and
 * caches it; subsequent calls reuse the cache until expiry-minus-skew, then
 * refresh.
 *
 * The app-password is sent only in the request body and is never logged; the
 * minted token is never logged either. Every failure branch returns a `Result`
 * and logs a WARN carrying the classified `hint` + `errorKind`.
 */
export function createConnectorTokenProvider(
  deps: ConnectorTokenDeps,
): ConnectorTokenProvider {
  const now = deps.now ?? systemNowMs;
  const doFetch = deps.fetchImpl ?? fetch;
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
  const tokenUrl = `https://login.microsoftonline.com/${deps.tenantId}/oauth2/v2.0/token`;

  let cache: { token: string; expiresAtMs: number } | undefined;

  return {
    async getToken(): Promise<Result<string, Error>> {
      // Path-safety gate: never interpolate an unvalidated tenant id into the URL.
      if (!TENANT_ID_PATTERN.test(deps.tenantId)) {
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "Set msteams.tenantId to the single-tenant directory id (a GUID or verified domain)",
            errorKind: "precondition" as const,
          },
          "Connector token mint blocked: tenant id is not host-safe",
        );
        return err(new Error("invalid tenant id"));
      }

      // Cache hit while still comfortably before expiry.
      if (cache && now() < cache.expiresAtMs - skewMs) {
        return ok(cache.token);
      }

      const startedAt = now();
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: deps.appId,
        client_secret: deps.appPassword,
        scope: CONNECTOR_SCOPE,
      });
      deps.logger.debug(
        { step: "msteams-token-mint", channelType: "msteams" as const },
        "Minting Connector token",
      );

      const responded = await fromPromise(
        doFetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      if (!responded.ok) {
        // No response reached us: a transport-level fault (undefined status).
        const classified = classifyMsTeamsError(undefined, responded.error);
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Connector token mint failed: no response from the token endpoint",
        );
        return err(responded.error);
      }

      const res = responded.value;
      if (!res.ok) {
        const classified = classifyMsTeamsError(res.status);
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            status: res.status,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Connector token mint failed: token endpoint returned an error status",
        );
        return err(new Error(`token endpoint returned status ${res.status}`));
      }

      const parsed = await fromPromise(res.json() as Promise<TokenResponse>);
      if (!parsed.ok) {
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "The token endpoint returned a body that is not valid JSON",
            errorKind: "platform" as const,
          },
          "Connector token mint failed: unreadable token response",
        );
        return err(parsed.error);
      }

      const accessToken = parsed.value.access_token;
      const expiresInSec = parsed.value.expires_in;
      if (!accessToken || typeof expiresInSec !== "number") {
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "The token endpoint response was missing access_token or expires_in",
            errorKind: "platform" as const,
          },
          "Connector token mint failed: incomplete token response",
        );
        return err(new Error("incomplete token response"));
      }

      cache = { token: accessToken, expiresAtMs: now() + expiresInSec * 1000 };
      deps.logger.info(
        {
          step: "msteams-token-mint",
          channelType: "msteams" as const,
          durationMs: now() - startedAt,
        },
        "Connector token minted",
      );
      return ok(accessToken);
    },
  };
}
