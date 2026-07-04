// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComisLogger } from "@comis/core";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  decodeProtectedHeader,
  decodeJwt,
} from "jose";
import { createFakeEnv } from "../../../../../test/support/fake-env.js";
import {
  createActivityJwtValidator,
  createConnectorTokenProvider,
  createConnectorTokenProviderFor,
  type ActivityJwtValidatorOpts,
  type ConnectorTokenDeps,
} from "../msteams-auth.js";

// Bot Framework issuer + a stand-in bot app id used as the audience claim.
const BF_ISSUER = "https://api.botframework.com";
const APP_ID = "bot-app-client-id";

/**
 * A local RS256 keypair + local JWKS stands in for the Bot Framework signing
 * keys, so the validator runs fully offline — no network to real metadata.
 */
async function makeKeyContext(): Promise<{
  privateKey: CryptoKey;
  jwks: ActivityJwtValidatorOpts["jwks"];
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey: privateKey as CryptoKey, jwks };
}

function mintToken(
  privateKey: CryptoKey,
  opts: { iss?: string; aud?: string; exp?: number | string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? BF_ISSUER)
    .setAudience(opts.aud ?? APP_ID)
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

describe("createActivityJwtValidator — Bearer pre-gate (no network on reject)", () => {
  it("rejects an undefined Authorization header without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate(undefined, APP_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("missing bearer token");
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer authorization scheme without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate("Basic dXNlcjpwYXNz", APP_ID);
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("rejects a bare Bearer scheme carrying no token without touching the key set", async () => {
    const jwksSpy = vi.fn();
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate("Bearer", APP_ID);
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });

  it("fails closed on an empty expected audience instead of accepting any bot's token", async () => {
    // jose treats a falsy `audience` as "no audience constraint", so an empty
    // appId would accept a token minted for a different bot. The validator must
    // reject before it ever consults the key set.
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey, { aud: "some-other-app-id" });
    const jwksSpy = vi.fn(jwks as never);
    const validate = createActivityJwtValidator({
      jwks: jwksSpy as unknown as ActivityJwtValidatorOpts["jwks"],
      issuer: BF_ISSUER,
    });
    const result = await validate(`Bearer ${token}`, "");
    expect(result.ok).toBe(false);
    expect(jwksSpy).not.toHaveBeenCalled();
  });
});

describe("createActivityJwtValidator — jose signature + claim verification", () => {
  it("accepts a correctly-signed token with the expected issuer and audience", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey);
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(true);
  });

  it("rejects a token whose audience is not the bot app id", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey, { aud: "some-other-app-id" });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose issuer is not the expected issuer", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    const token = await mintToken(privateKey, { iss: "https://spoofed.example.com" });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose expiry is in the past", async () => {
    const { privateKey, jwks } = await makeKeyContext();
    // Absolute epoch second 2 (1970) — unambiguously expired, no wall-clock read.
    const token = await mintToken(privateKey, { exp: 2 });
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a token signed by a key absent from the trusted key set", async () => {
    const { jwks } = await makeKeyContext(); // trusted key set
    const foreign = await generateKeyPair("RS256"); // a DIFFERENT, untrusted signer
    const token = await mintToken(foreign.privateKey as CryptoKey);
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-RS256 token (RS384) even when signed by a trusted key", async () => {
    // A trusted RS384 keypair whose public key is in the key set. Without an
    // explicit RS256 allowlist on the verify call, jose accepts this RS384
    // signature; pinning algorithms: ["RS256"] must reject any other algorithm.
    const { publicKey, privateKey } = await generateKeyPair("RS384", {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS384" })
      .setIssuer(BF_ISSUER)
      .setAudience(APP_ID)
      .setExpirationTime("5m")
      .sign(privateKey);
    const validate = createActivityJwtValidator({ jwks, issuer: BF_ISSUER });
    const result = await validate(`Bearer ${token}`, APP_ID);
    expect(result.ok).toBe(false);
  });
});

// --- Outbound Connector token mint (client-credentials, cached) ---

const TENANT = "00000000-1111-2222-3333-444444444444";
const APP_PASSWORD = "super-secret-pw";
const MINTED_TOKEN = "connector-access-token-xyz";

/** A logger whose spies record every argument to every level for redaction asserts. */
function makeLoggerSpy() {
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  const noop = vi.fn();
  const logger = {
    level: "debug",
    trace: noop,
    debug,
    info,
    warn,
    error,
    fatal: noop,
    audit: noop,
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
  const serialized = () =>
    JSON.stringify([
      ...info.mock.calls,
      ...warn.mock.calls,
      ...debug.mock.calls,
      ...error.mock.calls,
    ]);
  return { logger, serialized, info, warn };
}

/** A fetch stub returning a successful token response; captures its calls. */
function makeTokenFetch(token = MINTED_TOKEN, expiresIn = 3600) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
  }));
  return { fetchImpl: spy as unknown as typeof fetch, spy };
}

function makeTokenDeps(overrides: Partial<ConnectorTokenDeps> = {}) {
  const loggerSpy = makeLoggerSpy();
  const { fetchImpl, spy } = makeTokenFetch();
  const deps: ConnectorTokenDeps = {
    appId: "app-client-id",
    appPassword: APP_PASSWORD,
    tenantId: TENANT,
    logger: loggerSpy.logger,
    fetchImpl,
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, spy, loggerSpy };
}

describe("createConnectorTokenProvider — client-credentials mint", () => {
  it("mints against the single-tenant endpoint with the client-credentials grant and connector scope", async () => {
    const { deps, spy } = makeTokenDeps();
    const provider = createConnectorTokenProvider(deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("app-client-id");
    expect(body.get("client_secret")).toBe(APP_PASSWORD);
    expect(body.get("scope")).toBe("https://api.botframework.com/.default");
  });

  it("reuses the cached token on a second call before the expiry-minus-skew boundary", async () => {
    const { deps, spy } = makeTokenDeps();
    const provider = createConnectorTokenProvider(deps);
    const first = await provider.getToken();
    const second = await provider.getToken();
    expect(first.ok && second.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once the clock passes the expiry-minus-skew boundary", async () => {
    const loggerSpy = makeLoggerSpy();
    const { fetchImpl, spy } = makeTokenFetch(MINTED_TOKEN, 3600);
    let clock = 1_000_000;
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl,
      now: () => clock,
      skewMs: 60_000,
    });
    await provider.getToken();
    expect(spy).toHaveBeenCalledTimes(1);
    // expiresAt = 1_000_000 + 3_600_000; refresh boundary = expiresAt - 60_000.
    clock = 1_000_000 + 3_600_000 - 60_000 + 1;
    await provider.getToken();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns a classified error and warns when the token endpoint responds non-2xx", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    const warnPayloads = loggerSpy.warn.mock.calls.map((c) => c[0]);
    const platformWarn = warnPayloads.find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        (p as { errorKind?: string }).errorKind === "platform",
    );
    expect(platformWarn).toBeDefined();
  });

  it("logs a durationMs completion but never the app-password or the minted token", async () => {
    const { deps, loggerSpy } = makeTokenDeps();
    const provider = createConnectorTokenProvider(deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    const blob = loggerSpy.serialized();
    expect(blob).not.toContain(APP_PASSWORD);
    expect(blob).not.toContain(MINTED_TOKEN);
    const infoPayloads = loggerSpy.info.mock.calls.map((c) => c[0]);
    const mintLine = infoPayloads.find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        (p as { step?: string }).step === "msteams-token-mint",
    );
    expect(mintLine).toBeDefined();
    expect(typeof (mintLine as { durationMs?: unknown }).durationMs).toBe("number");
  });

  it("rejects a path-unsafe tenant id with a precondition error and no network call", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn();
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: "../evil-tenant",
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const warnPayloads = loggerSpy.warn.mock.calls.map((c) => c[0]);
    const preconditionWarn = warnPayloads.find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        (p as { errorKind?: string }).errorKind === "precondition",
    );
    expect(preconditionWarn).toBeDefined();
  });

  it("treats a non-finite expires_in as an incomplete response and never caches it", async () => {
    // typeof NaN === "number", so a NaN/0 expiry would pass a bare typeof guard
    // and poison the cache (expiresAtMs = NaN), forcing a re-mint on every call.
    const loggerSpy = makeLoggerSpy();
    let call = 0;
    const spy = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "tok",
          expires_in: call === 1 ? Number.NaN : 3600,
        }),
      };
    });
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    // NaN expiry → incomplete token response (error); nothing is cached.
    const first = await provider.getToken();
    expect(first.ok).toBe(false);
    // The next mint returns a valid expiry and succeeds, then caches.
    const second = await provider.getToken();
    expect(second.ok).toBe(true);
    const third = await provider.getToken();
    expect(third.ok).toBe(true);
    // Two network mints (failed NaN + valid); the third is served from cache.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats a zero/negative expires_in as an incomplete token response", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "tok", expires_in: 0 }),
    }));
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
  });

  it("returns an error and warns as network when the token fetch rejects at the transport level", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const provider = createConnectorTokenProvider({
      appId: "app-client-id",
      appPassword: APP_PASSWORD,
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl: spy as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    const warnPayloads = loggerSpy.warn.mock.calls.map((c) => c[0]);
    const networkWarn = warnPayloads.find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        (p as { errorKind?: string }).errorKind === "network",
    );
    expect(networkWarn).toBeDefined();
  });
});

// --- 3-mode token factory: secret (done) + certificate + managed-identity ---

const FACTORY_APP_ID = "app-client-id";
const MI_CLIENT_ID = "mi-user-assigned-client-id";
const CONNECTOR_SCOPE = "https://api.botframework.com/.default";
const MI_RESOURCE = "https://api.botframework.com";

/**
 * Mint a throwaway self-signed RSA cert + PKCS#8 key at runtime and bundle them
 * into one PEM the way an operator's certificate file bundles key + cert. Never a
 * pasted real cert — the subject is a neutral placeholder and the material lives
 * only for the test's lifetime. openssl mirrors the gateway mTLS test's cert-gen,
 * so no new dependency is pulled in.
 */
function generateSelfSignedPemBundle(): {
  combinedPem: string;
  bundlePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "comis-msteams-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const bundlePath = join(dir, "bundle.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=comis-msteams-test",
    ],
    { stdio: "pipe" },
  );
  const combinedPem = `${readFileSync(keyPath, "utf8")}\n${readFileSync(certPath, "utf8")}`;
  writeFileSync(bundlePath, combinedPem);
  return {
    combinedPem,
    bundlePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("createConnectorTokenProviderFor — certificate mode (AUTH-02)", () => {
  let pem: ReturnType<typeof generateSelfSignedPemBundle>;
  beforeAll(() => {
    pem = generateSelfSignedPemBundle();
  });
  afterAll(() => {
    pem.cleanup();
  });

  function makeCertDeps(overrides: Partial<ConnectorTokenDeps> = {}) {
    const loggerSpy = makeLoggerSpy();
    const { fetchImpl, spy } = makeTokenFetch();
    const deps: ConnectorTokenDeps = {
      appId: FACTORY_APP_ID,
      appPassword: "", // certificate mode carries no client secret
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl,
      now: () => 1_000_000,
      certPath: pem.bundlePath,
      readFileImpl: async () => pem.combinedPem, // hermetic — no real fs read
      ...overrides,
    };
    return { deps, spy, loggerSpy };
  }

  it("mints via a signed client-assertion whose body carries the assertion type, a JWT, the connector scope, and no client_secret", async () => {
    const { deps, spy } = makeCertDeps();
    const provider = createConnectorTokenProviderFor("certificate", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    );
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    const assertion = body.get("client_assertion") ?? "";
    expect(assertion.length).toBeGreaterThan(0);
    expect(assertion.split(".")).toHaveLength(3); // a compact JWS
    expect(body.get("scope")).toBe(CONNECTOR_SCOPE);
    expect(body.get("client_secret")).toBeNull();
  });

  it("signs the assertion with an x5t#S256 thumbprint header and iss=sub=appId, aud=token endpoint, plus a jti", async () => {
    const { deps, spy } = makeCertDeps();
    const provider = createConnectorTokenProviderFor("certificate", deps);
    await provider.getToken();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const assertion =
      new URLSearchParams(String(init.body)).get("client_assertion") ?? "";
    const header = decodeProtectedHeader(assertion);
    expect(typeof header["x5t#S256"]).toBe("string");
    // base64url — no +, /, or = padding
    expect(header["x5t#S256"] as string).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(["PS256", "RS256"]).toContain(header.alg);
    const claims = decodeJwt(assertion);
    expect(claims.iss).toBe(FACTORY_APP_ID);
    expect(claims.sub).toBe(FACTORY_APP_ID);
    expect(claims.aud).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    );
    expect(typeof claims.jti).toBe("string");
  });

  it("never records the PEM private key, the signed assertion, or the minted token in any log field", async () => {
    const { deps, spy, loggerSpy } = makeCertDeps();
    const provider = createConnectorTokenProviderFor("certificate", deps);
    await provider.getToken();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const assertion =
      new URLSearchParams(String(init.body)).get("client_assertion") ?? "";
    const blob = loggerSpy.serialized();
    expect(blob).not.toContain(MINTED_TOKEN);
    expect(blob).not.toContain(assertion);
    // A stable needle from the private-key body (armor + whitespace stripped).
    const keyNeedle = pem.combinedPem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "")
      .slice(0, 40);
    expect(keyNeedle.length).toBeGreaterThan(0);
    expect(blob).not.toContain(keyNeedle);
  });

  it("serves the cached assertion-minted token on a second call inside the skew window", async () => {
    const { deps, spy } = makeCertDeps();
    const provider = createConnectorTokenProviderFor("certificate", deps);
    const first = await provider.getToken();
    const second = await provider.getToken();
    expect(first.ok && second.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reads the certificate bundle through the default filesystem reader when no readFileImpl is injected", async () => {
    const { deps, spy } = makeCertDeps({ readFileImpl: undefined });
    const provider = createConnectorTokenProviderFor("certificate", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns a precondition error and no network call when certPath is absent", async () => {
    const { deps, spy, loggerSpy } = makeCertDeps({ certPath: undefined });
    const provider = createConnectorTokenProviderFor("certificate", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
  });

  it("returns an error and no network call when the certificate PEM is malformed", async () => {
    const { deps, spy } = makeCertDeps({
      readFileImpl: async () => "not a valid pem file",
    });
    const provider = createConnectorTokenProviderFor("certificate", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createConnectorTokenProviderFor — managed-identity mode (AUTH-03)", () => {
  function makeMiDeps(
    overrides: Partial<ConnectorTokenDeps> = {},
    envRecord: Record<string, string | undefined> = {},
  ) {
    const loggerSpy = makeLoggerSpy();
    const { fetchImpl, spy } = makeTokenFetch();
    const deps: ConnectorTokenDeps = {
      appId: FACTORY_APP_ID,
      appPassword: "", // managed identity carries no client secret
      tenantId: TENANT,
      logger: loggerSpy.logger,
      fetchImpl,
      now: () => 1_000_000,
      managedIdentityClientId: MI_CLIENT_ID,
      env: createFakeEnv(envRecord),
      ...overrides,
    };
    return { deps, spy, loggerSpy };
  }

  it("mints from IMDS with a Metadata header and the botframework resource when no IDENTITY_ENDPOINT is present", async () => {
    const { deps, spy } = makeMiDeps({}, {}); // no IDENTITY_ENDPOINT → IMDS path
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("169.254.169.254/metadata/identity/oauth2/token");
    expect(url).toContain(`resource=${MI_RESOURCE}`);
    expect(url).toContain(`client_id=${MI_CLIENT_ID}`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Metadata).toBe("true");
  });

  it("mints from the App Service identity endpoint carrying the live X-IDENTITY-HEADER when IDENTITY_ENDPOINT is present", async () => {
    const nowSec = Math.floor(1_000_000 / 1000);
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: MINTED_TOKEN,
        expires_on: String(nowSec + 3600), // App Service returns absolute epoch seconds
      }),
    }));
    const { deps } = makeMiDeps(
      { fetchImpl: spy as unknown as typeof fetch, logger: loggerSpy.logger },
      {
        IDENTITY_ENDPOINT: "https://appservice.local/msi/token",
        IDENTITY_HEADER: "header-v1",
      },
    );
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://appservice.local/msi/token?");
    expect(url).toContain("api-version=2019-08-01");
    expect(url).toContain(`resource=${MI_RESOURCE}`);
    expect(url).toContain(`client_id=${MI_CLIENT_ID}`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-IDENTITY-HEADER"]).toBe(
      "header-v1",
    );
  });

  it("reads a rotated IDENTITY_HEADER live on each mint rather than a boot snapshot", async () => {
    const envRecord: Record<string, string | undefined> = {
      IDENTITY_ENDPOINT: "https://appservice.local/msi/token",
      IDENTITY_HEADER: "header-v1",
    };
    let clock = 1_000_000;
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: MINTED_TOKEN, expires_in: 3600 }),
    }));
    const { deps } = makeMiDeps(
      {
        fetchImpl: spy as unknown as typeof fetch,
        now: () => clock,
        skewMs: 60_000,
      },
      envRecord,
    );
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    await provider.getToken();
    envRecord.IDENTITY_HEADER = "header-v2"; // rotate between mints
    clock = 1_000_000 + 3_600_000 - 60_000 + 1; // advance past skew → re-mint
    await provider.getToken();
    expect(spy).toHaveBeenCalledTimes(2);
    const h1 = (spy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    const h2 = (spy.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(h1["X-IDENTITY-HEADER"]).toBe("header-v1");
    expect(h2["X-IDENTITY-HEADER"]).toBe("header-v2");
  });

  it("never records the minted managed-identity token in any log field", async () => {
    const { deps, loggerSpy } = makeMiDeps({}, {});
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    expect(loggerSpy.serialized()).not.toContain(MINTED_TOKEN);
  });

  it("returns a classified auth error when the identity endpoint responds non-2xx", async () => {
    const loggerSpy = makeLoggerSpy();
    const spy = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const { deps } = makeMiDeps(
      { fetchImpl: spy as unknown as typeof fetch, logger: loggerSpy.logger },
      {},
    );
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    const authWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "auth",
      );
    expect(authWarn).toBeDefined();
  });

  it("returns a precondition error and no network call when managedIdentityClientId is absent", async () => {
    const { deps, spy, loggerSpy } = makeMiDeps(
      { managedIdentityClientId: undefined },
      {},
    );
    const provider = createConnectorTokenProviderFor("managedIdentity", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const preconditionWarn = loggerSpy.warn.mock.calls
      .map((c) => c[0])
      .find(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          (p as { errorKind?: string }).errorKind === "precondition",
      );
    expect(preconditionWarn).toBeDefined();
  });
});

describe("createConnectorTokenProviderFor — secret mode routing", () => {
  it("routes secret mode to the unchanged client-credentials mint (client_secret present, no client_assertion)", async () => {
    const { deps, spy } = makeTokenDeps();
    const provider = createConnectorTokenProviderFor("secret", deps);
    const result = await provider.getToken();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(MINTED_TOKEN);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_secret")).toBe(APP_PASSWORD);
    expect(body.get("client_assertion")).toBeNull();
  });
});
