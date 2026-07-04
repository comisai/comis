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

import { X509Certificate, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { systemNowMs } from "@comis/core";
import type { ComisLogger, EnvPort } from "@comis/core";
import { ok, err, fromPromise, tryCatch, type Result } from "@comis/shared";
import {
  createRemoteJWKSet,
  createLocalJWKSet,
  jwtVerify,
  importPKCS8,
  SignJWT,
  type JSONWebKeySet,
} from "jose";
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

/**
 * Build an inbound activity JWT validator over a LOCAL JWKS (a `{ keys: [...] }`
 * set) instead of the default remote Bot Framework JWKS — verification runs with
 * NO network, against a key set the caller supplies. The offline analog of
 * {@link validateActivityJwt}, for a test rig / the live-test emulator that holds
 * its own signing key. Production keeps the default remote-JWKS
 * {@link validateActivityJwt} untouched: this is only reached when a caller opts
 * in with a local key set (e.g. the daemon's off-by-default `COMIS_MSTEAMS_TEST_JWKS`
 * seam). The issuer defaults to the Bot Framework issuer (so an emulator can mint
 * maximally-real tokens) and can be overridden for a fully-synthetic issuer.
 */
export function createLocalActivityJwtValidator(
  jwks: JSONWebKeySet,
  opts?: { issuer?: string },
): (authHeader: string | undefined, appId: string) => Promise<Result<void, Error>> {
  return createActivityJwtValidator({
    jwks: createLocalJWKSet(jwks),
    ...(opts?.issuer !== undefined ? { issuer: opts.issuer } : {}),
  });
}

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
  /**
   * Certificate mode: an absolute path to a PEM that bundles the private key and
   * the certificate. The key signs the client assertion; the certificate's
   * SHA-256 thumbprint becomes the assertion's `x5t#S256` header.
   */
  certPath?: string;
  /**
   * Injected PEM reader, defaulting to `node:fs/promises` readFile. Lets a unit
   * test supply the certificate bundle without touching the filesystem.
   */
  readFileImpl?: (path: string) => Promise<string>;
  /**
   * Managed-identity mode: the user-assigned identity's client id. Selects which
   * identity mints the token at the local metadata endpoint.
   */
  managedIdentityClientId?: string;
  /**
   * Live environment accessor for the App-Service identity endpoint and header.
   * Read on every mint (the header rotates), never snapshotted at construction.
   */
  env?: EnvPort;
}

/** Provides a cached Connector access token, minted on demand. */
export interface ConnectorTokenProvider {
  /** Return a valid access token, minting or refreshing as needed. */
  getToken(): Promise<Result<string, Error>>;
}

/** The token-endpoint success fields consumed here. */
interface TokenResponse {
  access_token?: string;
  /** Relative lifetime in seconds (AAD token endpoint + IMDS). */
  expires_in?: number;
  /** Absolute expiry as epoch seconds (App-Service managed identity). */
  expires_on?: number | string;
}

/** The three ways an enterprise bot mints a Bot Connector token. */
export type ConnectorAuthMode = "secret" | "certificate" | "managedIdentity";

/** A planned token request: the URL to call and the fetch init (verb/headers/body). */
interface TokenRequestPlan {
  url: string;
  init: RequestInit;
}

/**
 * Build the mode-specific token request. Returns a `Result` because certificate
 * signing can fail before any network call; a failing builder has already logged
 * its own actionable WARN.
 */
type BuildTokenRequest = (
  tokenUrl: string,
) => Promise<Result<TokenRequestPlan, Error>>;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** The resource a managed identity requests to obtain a Bot Connector token. */
const MANAGED_IDENTITY_RESOURCE = "https://api.botframework.com";

/** The two PEM blocks a certificate bundle must carry. */
const PEM_KEY_BLOCK =
  /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/;
const PEM_CERT_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;

/**
 * Resolve a token response's expiry to an absolute epoch-ms deadline. Accepts
 * both a relative `expires_in` (seconds) and an absolute `expires_on` (epoch
 * seconds, possibly a string). Returns undefined for a missing/non-positive
 * value so a NaN/0 expiry can never poison the cache.
 */
function resolveExpiresAtMs(
  parsed: TokenResponse,
  nowMs: number,
): number | undefined {
  const on = parsed.expires_on;
  const onSec = typeof on === "string" ? Number(on) : on;
  if (typeof onSec === "number" && Number.isFinite(onSec) && onSec > 0) {
    return onSec * 1000;
  }
  const inSec = parsed.expires_in;
  if (typeof inSec === "number" && Number.isFinite(inSec) && inSec > 0) {
    return nowMs + inSec * 1000;
  }
  return undefined;
}

/**
 * The shared POST/GET-and-cache half every auth mode reuses: the tenant
 * path-safety gate, the cache-hit-with-skew short-circuit, the fetch, the
 * transport and status failure branches, response validation, and the cache-set
 * + completion INFO line. Only request construction differs per mode, injected
 * as `buildRequest`. No token, assertion, key, or identity header is ever placed
 * in a log field.
 */
function createCachingTokenProvider(
  deps: ConnectorTokenDeps,
  buildRequest: BuildTokenRequest,
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
      deps.logger.debug(
        { step: "msteams-token-mint", channelType: "msteams" as const },
        "Minting Connector token",
      );

      const planned = await buildRequest(tokenUrl);
      if (!planned.ok) {
        // The builder logged the actionable WARN for its precondition/signing failure.
        return err(planned.error);
      }

      const responded = await fromPromise(
        doFetch(planned.value.url, planned.value.init),
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
      const expiresAtMs = resolveExpiresAtMs(parsed.value, now());
      if (!accessToken || expiresAtMs === undefined) {
        deps.logger.warn(
          {
            channelType: "msteams" as const,
            hint: "The token endpoint response was missing access_token or a positive expiry",
            errorKind: "platform" as const,
          },
          "Connector token mint failed: incomplete token response",
        );
        return err(new Error("incomplete token response"));
      }

      cache = { token: accessToken, expiresAtMs };
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

/**
 * Build a secret-mode (client-credentials) Connector token provider. The first
 * `getToken()` mints a token against the single-tenant token endpoint and caches
 * it; subsequent calls reuse the cache until expiry-minus-skew, then refresh.
 *
 * The app-password is sent only in the request body and is never logged; the
 * minted token is never logged either.
 */
export function createConnectorTokenProvider(
  deps: ConnectorTokenDeps,
): ConnectorTokenProvider {
  return createCachingTokenProvider(deps, (tokenUrl) =>
    Promise.resolve(
      ok({
        url: tokenUrl,
        init: {
          method: "POST",
          headers: { "content-type": FORM_CONTENT_TYPE },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: deps.appId,
            client_secret: deps.appPassword,
            scope: CONNECTOR_SCOPE,
          }),
        },
      }),
    ),
  );
}

/**
 * Build the certificate-mode request: read the PEM bundle at `certPath`, sign a
 * client-assertion JWT with the private key (carrying the certificate's SHA-256
 * thumbprint as the `x5t#S256` header), and present it as `client_assertion` in
 * a client-credentials grant. The key and the signed assertion never leave the
 * request body — they are never logged.
 */
async function buildCertAssertionRequest(
  deps: ConnectorTokenDeps,
  tokenUrl: string,
): Promise<Result<TokenRequestPlan, Error>> {
  if (!deps.certPath) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "Set msteams.certPath to a PEM bundling the private key and the certificate",
        errorKind: "precondition" as const,
      },
      "Connector token mint blocked: certificate mode requires certPath",
    );
    return err(new Error("certificate mode requires certPath"));
  }

  const readPem =
    deps.readFileImpl ??
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- certPath is an operator-configured absolute path, not user input
    ((path: string) => readFile(path, "utf8"));
  const pemRes = await fromPromise(readPem(deps.certPath));
  if (!pemRes.ok) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "Ensure msteams.certPath points to a readable PEM file",
        errorKind: "precondition" as const,
      },
      "Connector token mint failed: certificate file is not readable",
    );
    return err(pemRes.error);
  }

  const keyBlock = pemRes.value.match(PEM_KEY_BLOCK)?.[0];
  const certBlock = pemRes.value.match(PEM_CERT_BLOCK)?.[0];
  if (!keyBlock || !certBlock) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "The certPath PEM must contain both a PRIVATE KEY and a CERTIFICATE block",
        errorKind: "precondition" as const,
      },
      "Connector token mint failed: certificate bundle is missing a key or certificate block",
    );
    return err(new Error("certificate bundle missing key or certificate block"));
  }

  const keyRes = await fromPromise(importPKCS8(keyBlock, "PS256"));
  if (!keyRes.ok) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "The private key must be an unencrypted PKCS#8 PEM",
        errorKind: "precondition" as const,
      },
      "Connector token mint failed: private key could not be loaded",
    );
    return err(keyRes.error);
  }

  const certRes = tryCatch(() => new X509Certificate(certBlock));
  if (!certRes.ok) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "The certificate block is not a valid X.509 certificate",
        errorKind: "precondition" as const,
      },
      "Connector token mint failed: certificate could not be parsed",
    );
    return err(certRes.error);
  }

  // x5t#S256 = base64url(SHA-256(DER(cert))). node:crypto yields colon-hex; convert.
  const thumbprint = Buffer.from(
    certRes.value.fingerprint256.replace(/:/g, ""),
    "hex",
  ).toString("base64url");

  const signed = await fromPromise(
    new SignJWT({})
      .setProtectedHeader({ alg: "PS256", typ: "JWT", "x5t#S256": thumbprint })
      .setIssuer(deps.appId) // iss = sub = the bot (client) app id
      .setSubject(deps.appId)
      .setAudience(tokenUrl) // aud = the single-tenant token endpoint
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(keyRes.value),
  );
  if (!signed.ok) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "The client assertion could not be signed with the certificate key",
        errorKind: "internal" as const,
      },
      "Connector token mint failed: client assertion signing failed",
    );
    return err(signed.error);
  }

  return ok({
    url: tokenUrl,
    init: {
      method: "POST",
      headers: { "content-type": FORM_CONTENT_TYPE },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: deps.appId,
        scope: CONNECTOR_SCOPE,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: signed.value,
      }),
    },
  });
}

/** Build a certificate-mode (client-assertion) Connector token provider. */
function createCertAssertionTokenProvider(
  deps: ConnectorTokenDeps,
): ConnectorTokenProvider {
  return createCachingTokenProvider(deps, (tokenUrl) =>
    buildCertAssertionRequest(deps, tokenUrl),
  );
}

/**
 * Build the managed-identity-mode request: a single authenticated GET to the
 * local identity endpoint, no signing. Two environments, detected by the
 * presence of `IDENTITY_ENDPOINT`:
 *
 *  - App Service / Container Apps: GET `$IDENTITY_ENDPOINT` with the
 *    `X-IDENTITY-HEADER` secret. That header rotates several times a day, so it
 *    is read live on every mint (never snapshotted at construction).
 *  - VM / AKS: GET the fixed `169.254.169.254` instance-metadata endpoint with
 *    a `Metadata: true` header (no env needed).
 *
 * The minted token is only ever in the response body — never logged.
 */
async function buildManagedIdentityRequest(
  deps: ConnectorTokenDeps,
): Promise<Result<TokenRequestPlan, Error>> {
  const clientId = deps.managedIdentityClientId;
  if (!clientId) {
    deps.logger.warn(
      {
        channelType: "msteams" as const,
        hint: "Set msteams.managedIdentityClientId to the user-assigned identity's client id",
        errorKind: "precondition" as const,
      },
      "Connector token mint blocked: managed-identity mode requires managedIdentityClientId",
    );
    return err(new Error("managed-identity mode requires managedIdentityClientId"));
  }
  const encodedClientId = encodeURIComponent(clientId);
  const idEndpoint = deps.env?.get("IDENTITY_ENDPOINT");
  if (idEndpoint) {
    // App Service / Container Apps — the identity header rotates; read it live.
    const idHeader = deps.env?.get("IDENTITY_HEADER") ?? "";
    return ok({
      url: `${idEndpoint}?api-version=2019-08-01&resource=${MANAGED_IDENTITY_RESOURCE}&client_id=${encodedClientId}`,
      init: { method: "GET", headers: { "X-IDENTITY-HEADER": idHeader } },
    });
  }
  // VM / AKS instance metadata service — a fixed link-local endpoint, no env.
  return ok({
    url: `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${MANAGED_IDENTITY_RESOURCE}&client_id=${encodedClientId}`,
    init: { method: "GET", headers: { Metadata: "true" } },
  });
}

/** Build a managed-identity-mode Connector token provider. */
function createManagedIdentityTokenProvider(
  deps: ConnectorTokenDeps,
): ConnectorTokenProvider {
  return createCachingTokenProvider(deps, () =>
    buildManagedIdentityRequest(deps),
  );
}

/**
 * Build a Connector token provider for the configured auth mode. All modes share
 * the same cache/skew/tenant-guard/logging scaffold; they differ only in how the
 * token request is constructed (`secret` sends a client secret, `certificate`
 * sends a signed client assertion, `managedIdentity` GETs the local identity
 * endpoint).
 */
export function createConnectorTokenProviderFor(
  authMode: ConnectorAuthMode,
  deps: ConnectorTokenDeps,
): ConnectorTokenProvider {
  switch (authMode) {
    case "secret":
      return createConnectorTokenProvider(deps);
    case "certificate":
      return createCertAssertionTokenProvider(deps);
    case "managedIdentity":
      return createManagedIdentityTokenProvider(deps);
    default: {
      const _exhaustive: never = authMode;
      return _exhaustive;
    }
  }
}
