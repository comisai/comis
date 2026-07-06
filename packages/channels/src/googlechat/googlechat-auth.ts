// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat auth — the two security-critical, transport-agnostic halves.
 *
 *  1. Inbound event JWT verification (webhook mode): a cheap Bearer-presence
 *     pre-gate that short-circuits the no-token case with no network, then
 *     library-backed (jose) signature + issuer + audience + expiry verification
 *     against Google's signing keys — dual-audience by config (`project-number`
 *     verifies against the Chat-system JWK set; `app-url` against Google's OIDC
 *     certs). Never hand-rolled crypto.
 *  2. Outbound service-account token mint: a per-scope expiry+skew-cached
 *     JWT-bearer access token.
 *
 * Every Chat API and Pub/Sub REST call rides a `Bearer` token minted by half (2).
 * On a cache miss the provider loads the service-account private key with `jose`
 * (`importPKCS8`, RS256), signs a short-lived assertion (`iss` = `sub` = the SA
 * client email, `aud` = the token endpoint, `scope` = the requested grant,
 * `exp - iat <= 1h`), and exchanges it at the OAuth2 token endpoint for an access
 * token via the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant. The Chat and
 * Pub/Sub scopes cache independently, so a token for one scope is never presented
 * to the other.
 *
 * The caching/skew/status-classification/completion scaffold is the outbound
 * Microsoft Teams token-provider shape; only the request builder (an RS256
 * service-account assertion) and the per-scope cache differ. `jose` is the crypto
 * layer — the JWT is never hand-assembled.
 *
 * Secret discipline: the private key, the signed assertion, the minted access
 * token, and every inbound token are only ever handed to `jose` or the request
 * body. They are NEVER placed in a log field — failure branches log only
 * `errorKind` + `hint` (+ `status` / `durationMs`).
 *
 * Framework-agnostic on purpose: no HTTP-framework import lives here, and the
 * logger is injected (this package must not import the infra logger).
 *
 * @module
 */

import { systemNowMs } from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import {
  importPKCS8,
  SignJWT,
  createRemoteJWKSet,
  jwtVerify,
} from "jose";
import { classifyGoogleChatError } from "./errors.js";

/** The Google OAuth2 endpoint that exchanges an SA assertion for an access token. */
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The grant type that presents a service-account assertion for exchange. */
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** The Chat API scope — authorizes `messages.create` and the Chat REST surface. */
export const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

/** The Pub/Sub scope — authorizes the subscription pull loop. */
export const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";

/** The two scopes an app-auth Google Chat adapter mints tokens for. */
export type GoogleChatScope = typeof CHAT_SCOPE | typeof PUBSUB_SCOPE;

/** Refresh a cached token this many ms before its stated expiry. */
const DEFAULT_SKEW_MS = 60_000;

/** The assertion's lifetime in seconds — the endpoint-imposed one-hour maximum. */
const ASSERTION_TTL_SEC = 3600;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Dependencies for the Google Chat token provider. */
export interface GoogleChatTokenDeps {
  /**
   * The resolved service-account key JSON string (a `SecretRef` resolved
   * upstream). Parsed once for `client_email` + `private_key`; never logged.
   */
  serviceAccountKey: string;
  /** Logger for the mint completion and each failure branch. */
  logger: ComisLogger;
  /** Injected fetch, defaulting to the global; lets a unit test stub the exchange. */
  fetchImpl?: typeof fetch;
  /** Injected clock in ms, defaulting to systemNowMs; makes expiry deterministic. */
  now?: () => number;
  /** Refresh margin before expiry, in ms. Defaults to 60s. */
  skewMs?: number;
  /**
   * Token-endpoint URL override — a test-only base-URL seam. Production uses the
   * fixed {@link TOKEN_URL} constant so the exchange only ever reaches Google.
   */
  tokenUrl?: string;
}

/** Provides a per-scope cached access token, minted on demand. */
export interface GoogleChatTokenProvider {
  /**
   * Return a valid access token for the scope, minting or refreshing as needed.
   * The chat.bot and pubsub scopes cache independently.
   */
  getToken(scope: GoogleChatScope): Promise<Result<string, Error>>;
  /**
   * A secret-free credential-parse failure hint, or undefined when the
   * service-account key parsed cleanly. Reuses the SINGLE parse done at
   * construction, so a start()-time precondition check need not re-parse the key.
   */
  credentialError(): { hint: string } | undefined;
}

/** The service-account fields the assertion mint needs. */
interface ServiceAccountFields {
  clientEmail: string;
  privateKey: string;
}

/**
 * Parse the service-account key JSON into the two fields the mint needs. Returns
 * a secret-free `hint` on a parse error or a missing field — the raw key string
 * is never read into the result, so no key material can leak through this path.
 */
function parseServiceAccountKey(
  raw: string,
): Result<ServiceAccountFields, { hint: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({
      hint: "The serviceAccountKey must be a service-account key JSON",
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    return err({
      hint: "The serviceAccountKey must be a service-account key JSON object",
    });
  }
  const key = parsed as { private_key?: unknown; client_email?: unknown };
  const privateKey =
    typeof key.private_key === "string" ? key.private_key : "";
  const clientEmail =
    typeof key.client_email === "string" ? key.client_email : "";
  if (privateKey.trim() === "") {
    return err({ hint: "The serviceAccountKey is missing 'private_key'" });
  }
  if (clientEmail.trim() === "") {
    return err({ hint: "The serviceAccountKey is missing 'client_email'" });
  }
  return ok({ clientEmail, privateKey });
}

/**
 * Build a service-account JWT-bearer token provider. The first `getToken(scope)`
 * mints an access token for that scope and caches it; subsequent same-scope calls
 * reuse the cache until expiry-minus-skew, then refresh. Distinct scopes cache in
 * independent slots.
 *
 * The service-account key is parsed once at construction; the private key, the
 * signed assertion, and the minted token are never logged.
 */
export function createGoogleChatTokenProvider(
  deps: GoogleChatTokenDeps,
): GoogleChatTokenProvider {
  const now = deps.now ?? systemNowMs;
  const doFetch = deps.fetchImpl ?? fetch;
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS;
  const tokenUrl = deps.tokenUrl ?? TOKEN_URL;

  // Parse the SA key once. The result — the two fields, or a secret-free failure
  // hint — is reused across scopes and calls; the key bytes are read only here
  // and only ever handed to jose.
  const keyParse = parseServiceAccountKey(deps.serviceAccountKey);

  // Per-scope token cache. The key space is the two-member GoogleChatScope union,
  // so the map is bounded at two entries — no eviction is needed.
  const cache = new Map<string, { token: string; expiresAtMs: number }>();

  return {
    credentialError(): { hint: string } | undefined {
      return keyParse.ok ? undefined : keyParse.error;
    },

    async getToken(scope: GoogleChatScope): Promise<Result<string, Error>> {
      // Cache hit for this scope while still comfortably before expiry.
      const hit = cache.get(scope);
      if (hit && now() < hit.expiresAtMs - skewMs) {
        return ok(hit.token);
      }

      if (!keyParse.ok) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: keyParse.error.hint,
            errorKind: "precondition" as const,
          },
          "Token mint blocked: the service-account key could not be parsed",
        );
        return err(new Error("invalid service-account key"));
      }
      const { clientEmail, privateKey } = keyParse.value;

      const startedAt = now();
      deps.logger.debug(
        { step: "googlechat-token-mint", channelType: "googlechat" as const },
        "Minting service-account token",
      );

      // Load the private key. A malformed key names the requirement, not bytes.
      const keyRes = await fromPromise(importPKCS8(privateKey, "RS256"));
      if (!keyRes.ok) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "The service-account private_key must be an unencrypted PKCS#8 PEM",
            errorKind: "precondition" as const,
          },
          "Token mint blocked: the service-account private key could not be loaded",
        );
        return err(keyRes.error);
      }

      // Sign the assertion: iss = sub = SA email, aud = token endpoint, the
      // requested scope, and a lifetime capped at one hour.
      const iatSec = Math.floor(now() / 1000);
      const signed = await fromPromise(
        new SignJWT({ scope })
          .setProtectedHeader({ alg: "RS256", typ: "JWT" })
          .setIssuer(clientEmail)
          .setSubject(clientEmail)
          .setAudience(tokenUrl)
          .setIssuedAt(iatSec)
          .setExpirationTime(iatSec + ASSERTION_TTL_SEC)
          .sign(keyRes.value),
      );
      if (!signed.ok) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "Confirm the service-account private key is a valid RS256 signing key",
            errorKind: "internal" as const,
          },
          "Token mint failed: the assertion could not be signed",
        );
        return err(signed.error);
      }

      // Exchange the assertion for an access token.
      const responded = await fromPromise(
        doFetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": FORM_CONTENT_TYPE },
          body: new URLSearchParams({
            grant_type: JWT_BEARER,
            assertion: signed.value,
          }),
        }),
      );
      if (!responded.ok) {
        // No response reached us: a transport-level fault (undefined status).
        const classified = classifyGoogleChatError(undefined, responded.error);
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Token mint failed: no response from the token endpoint",
        );
        return err(responded.error);
      }

      const res = responded.value;
      if (!res.ok) {
        const classified = classifyGoogleChatError(res.status);
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            status: res.status,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Token mint failed: the token endpoint returned an error status",
        );
        return err(new Error(`token endpoint returned status ${res.status}`));
      }

      const parsed = await fromPromise(
        res.json() as Promise<{ access_token?: string; expires_in?: number }>,
      );
      if (!parsed.ok) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "The token endpoint returned a body that is not valid JSON",
            errorKind: "platform" as const,
          },
          "Token mint failed: unreadable token response",
        );
        return err(parsed.error);
      }

      const accessToken = parsed.value.access_token;
      const inSec = parsed.value.expires_in;
      // Guard a NaN/0 expiry from poisoning the cache (typeof NaN === "number").
      const expiresAtMs =
        typeof inSec === "number" && Number.isFinite(inSec) && inSec > 0
          ? now() + inSec * 1000
          : undefined;
      if (!accessToken || expiresAtMs === undefined) {
        deps.logger.warn(
          {
            channelType: "googlechat" as const,
            hint: "The token endpoint response was missing access_token or a positive expiry",
            errorKind: "platform" as const,
          },
          "Token mint failed: incomplete token response",
        );
        return err(new Error("incomplete token response"));
      }

      cache.set(scope, { token: accessToken, expiresAtMs });
      deps.logger.info(
        {
          step: "googlechat-token-mint",
          channelType: "googlechat" as const,
          durationMs: now() - startedAt,
        },
        "Service-account token minted",
      );
      return ok(accessToken);
    },
  };
}

// --- Inbound event JWT verification (the webhook-mode trust anchor) ---

/**
 * The issuer of a project-number-audience Chat event token: Google's Chat system
 * service account. The same string appears as the `email` claim on an app-url
 * OIDC token — a distinct claim on a distinct token shape; the two are never
 * conflated, and an app-url token's issuer is Google's OIDC issuer, not this.
 */
const CHAT_SYSTEM_ISSUER = "chat@system.gserviceaccount.com";

/**
 * Accepted issuers for an app-url OIDC ID token — Google's OIDC issuer in both
 * the scheme-qualified and bare forms (jose's `issuer` option accepts an array).
 */
const GOOGLE_OIDC_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
];

/**
 * The Chat-system JWK set — verifies a project-number-audience token's signature.
 * A remote key set with jose's built-in caching and `kid` rotation; the accepted
 * signature algorithm is pinned separately as an explicit `algorithms` allowlist
 * on the verify call. Constructed once at module scope. The JWK endpoint (not the
 * x509/PEM one) is used because jose consumes a JWKS.
 */
const CHAT_SYSTEM_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com",
  ),
);

/**
 * Google's OIDC certificate JWK set — verifies an app-url OIDC token's signature.
 * Constructed once at module scope; the JWK endpoint (`/oauth2/v3/certs`), not the
 * x509/PEM one, so jose can consume it.
 */
const GOOGLE_OIDC_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

/** Options for building an inbound Chat-event JWT verifier. */
export interface GoogleChatInboundVerifierOpts {
  /**
   * Which audience shape the configured endpoint expects:
   *  - `project-number` → a self-signed Chat-system JWT (`aud` = the Cloud
   *    project number, `iss` = the Chat system SA), verified against the
   *    Chat-system JWK set.
   *  - `app-url` → a Google OIDC ID token (`aud` = the endpoint URL, `iss` =
   *    Google's OIDC issuer), verified against Google's OIDC certs.
   */
  audienceType: "project-number" | "app-url";
  /**
   * The expected `aud` claim — the project number or the endpoint URL. A blank
   * audience fails closed BEFORE any key-set access (jose treats an empty
   * `audience` as "no audience constraint", which would accept a token minted for
   * any project/endpoint).
   */
  audience: string;
  /**
   * Key set used to verify the signature. Defaults to the audienceType's remote
   * Google JWK set; injected with a local key set in tests so verification runs
   * offline.
   */
  jwks?: Parameters<typeof jwtVerify>[1];
  /** Expected issuer override. Defaults to the audienceType's Google issuer. */
  issuer?: string;
  /**
   * Optional logger for a rejection WARN carrying only `channelType` / `hint` /
   * `errorKind`. The token is never logged.
   */
  logger?: ComisLogger;
}

/**
 * Build an inbound Chat-event JWT verifier. The returned closure takes the raw
 * `Authorization` header and resolves to `ok(undefined)` for a token verified
 * against the configured audience shape, `err(...)` otherwise — the expected
 * audience is closed over at construction.
 *
 * A missing or non-Bearer header is rejected by a cheap pre-gate with no key-set
 * access (no network). A blank expected audience fails closed before any key-set
 * access. A present token is verified by jose against the issuer, the audience,
 * the signature, the expiry, and an `["RS256"]` algorithm allowlist. The verify
 * error stays here (the caller surfaces an opaque rejection); the token is never
 * logged.
 */
export function createGoogleChatInboundVerifier(
  opts: GoogleChatInboundVerifierOpts,
): (authHeader: string | undefined) => Promise<Result<void, Error>> {
  const isProjectNumber = opts.audienceType === "project-number";
  const keySet =
    opts.jwks ?? (isProjectNumber ? CHAT_SYSTEM_JWKS : GOOGLE_OIDC_JWKS);
  const issuer =
    opts.issuer ?? (isProjectNumber ? CHAT_SYSTEM_ISSUER : GOOGLE_OIDC_ISSUERS);
  const logger = opts.logger;

  return async (authHeader) => {
    // Fail closed on a blank expected audience before any key-set access: jose
    // treats an empty `audience` as "no audience constraint", which would accept
    // a token minted for any other project/endpoint.
    if (!opts.audience) {
      return err(new Error("missing expected audience"));
    }
    // Cheap pre-gate: no Bearer token → reject before any key-set access.
    if (!authHeader?.startsWith("Bearer ")) {
      return err(new Error("missing bearer token"));
    }
    const token = authHeader.slice("Bearer ".length);
    const verified = await fromPromise(
      jwtVerify(token, keySet, {
        issuer,
        audience: opts.audience,
        algorithms: ["RS256"],
      }),
    );
    if (!verified.ok) {
      logger?.warn(
        {
          channelType: "googlechat" as const,
          hint: "Reject the unverified inbound event; confirm the caller is Google Chat",
          errorKind: "auth" as const,
        },
        "Inbound event rejected: token verification failed",
      );
      return err(verified.error);
    }
    return ok(undefined);
  };
}
